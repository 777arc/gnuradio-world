// GNU Radio flowgraph runner (WASM). Parses a native .grc flowgraph (grc_yaml),
// lowers it to a runnable block/connection list (grc_lower: drops disabled
// blocks, hops bypassed ones, inlines plain variables), builds blocks via the
// registry, connects them, runs the GR scheduler, and shows any GUI sink widgets
// on the Qt canvas. Entry point gr_run_json(const char*) takes .grc text.
#include "registry.hpp"
#include "grc_yaml.hpp"
#include "grc_lower.hpp"
#include <gnuradio/blocks/probe_signal.h>
#include <gnuradio/top_block.h>
#include <gnuradio/block.h>
#include <gnuradio/logger.h>
#include <gnuradio/prefs.h>
#include <QApplication>
#include <QLabel>
#include <QPointer>
#include <QScreen>
#include <QWidget>
#include <QVBoxLayout>
#include <QTimer>
#include <spdlog/sinks/base_sink.h>
#include <emscripten.h>
#include <emscripten/heap.h>
#include <dlfcn.h>
#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <functional>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <vector>

static gr::top_block_sptr g_tb;
static QWidget* g_container = nullptr;

struct VariableControl {
    double value;
    BuiltBlock built;
};

// Variable controls (Range/Chooser/Button) are built once up front so their
// value is resolvable regardless of graph order. (Definition in grc_lower.hpp.)
using grc_lower::is_variable_control;

static bool is_runtime_object(const std::string& id)
{
    return id == "variable_constellation" ||
           id == "variable_constellation_rect";
}

static nlohmann::json resolve_variables(
    const nlohmann::json& params,
    const std::map<std::string, VariableControl>& variables)
{
    nlohmann::json resolved = params;
    for (auto& item : resolved.items()) {
        if (!item.value().is_string())
            continue;
        const std::string expression = item.value().get<std::string>();
        auto variable = variables.find(expression);
        if (variable != variables.end())
            item.value() = variable->second.value;
    }
    return resolved;
}

// --- diagnostics: snapshot of the running graph for gr_stats_json() ----------
struct StatBlock {
    std::string name, id;
    gr::block_sptr blk;
    bool has_out = false;  // appears as a source in some connection
    bool has_in = false;   // appears as a sink in some connection
    bool is_ref = false;   // the reference point for the realtime factor
};
static std::vector<StatBlock> g_stats;
static double g_ref_samp_rate = 0.0;
static std::chrono::steady_clock::time_point g_run_start;

// Show an error inside the flowgraph window. Without this a failure is invisible:
// the #result div lives under Qt's canvas, and a graph that dies during
// construction just leaves an empty window (no sink widget was ever added). The
// banner is reused, and run_now() clears it with the rest of the layout, so a
// later successful run starts clean. Main thread only.
static QPointer<QLabel> g_error_banner;
static void show_error_in_window(const QString& title, const std::string& msg) {
    if (!g_container || !g_container->layout())
        return;
    if (!g_error_banner) {
        g_error_banner = new QLabel(g_container);
        g_error_banner->setWordWrap(true);
        g_error_banner->setAlignment(Qt::AlignCenter);
        g_error_banner->setTextInteractionFlags(Qt::TextSelectableByMouse);
        g_error_banner->setStyleSheet(QStringLiteral(
            "color:#b00020; background:#fff3f3; border:1px solid #f0c0c0;"
            "padding:12px; font-size:14px;"));
        g_container->layout()->addWidget(g_error_banner);
    }
    g_error_banner->setText(title + QStringLiteral("\n\n") + QString::fromStdString(msg));
    g_error_banner->show();
}

// Mirror a message to the editor (parent frame), which logs it next to the Run
// that produced it.
static void post_error_to_editor(const std::string& msg) {
    EM_ASM({
        if (window.parent && window.parent !== window) {
            var m = {};
            m.type = 'gr-error';
            m.message = UTF8ToString($0);
            window.parent.postMessage(m, '*');
        }
    }, msg.c_str());
}

// GNU Radio logs scheduler/block failures — notably the exception
// thread_body_wrapper catches when a block's work() throws — through spdlog. In
// this build its default backend has NO sinks: gr::logging reads the sink from
// the "log_file" pref, which is empty because there is no config file in the
// browser, so every message is dropped. (Emscripten's stdout/stderr are not
// visible here either.) Forward errors to the same places a failed run goes.
class BrowserLogSink : public spdlog::sinks::base_sink<std::mutex> {
protected:
    void sink_it_(const spdlog::details::log_msg& msg) override {
        if (msg.level < spdlog::level::err)
            return;
        const std::string text(msg.payload.begin(), msg.payload.end());
        // Emscripten has no thread-naming API. GNU Radio logs the unavailable
        // cosmetic operation as an error once per scheduler thread even though
        // the threads and flowgraph continue normally.
        if (text.find("set_thread_name(gr_thread_t, string) not implemented") !=
            std::string::npos)
            return;
        // Sinks run on GR's per-block threads; widgets and the DOM are main-thread
        // only, so hop across via the Qt event loop.
        QMetaObject::invokeMethod(
            qApp,
            [text] {
                show_error_in_window(QStringLiteral("Runtime error"), text);
                post_error_to_editor(text);
            },
            Qt::QueuedConnection);
    }
    void flush_() override {}
};

static void report(bool ok, const std::string& msg) {
    // marshalled to the browser main thread by Qt/emscripten as needed
    EM_ASM({
        var d = document.getElementById('result') ||
            document.body.appendChild(Object.assign(document.createElement('div'), {id:'result'}));
        d.setAttribute('data-status', $0 ? 'pass' : 'fail');
        d.textContent = ($0 ? 'RESULT: RUNNER_PASS ' : 'RESULT: RUNNER_FAIL ') + UTF8ToString($1);
    }, ok ? 1 : 0, msg.c_str());
    if (!ok) {
        show_error_in_window(QStringLiteral("Flowgraph error"), msg);
        post_error_to_editor(msg);  // lands in the editor's log
    }
}

static void run_now(const std::string& json_source) {
    try {
        auto j = nlohmann::json::parse(json_source);
        if (g_tb) { g_tb->stop(); g_tb->wait(); g_tb.reset(); }
        // clear previous sink widgets
        if (g_container->layout()) {
            QLayoutItem* item;
            while ((item = g_container->layout()->takeAt(0)) != nullptr) {
                if (item->widget()) item->widget()->deleteLater();
                delete item;
            }
        }

        // Turn on GR's per-block performance counters (compiled in, off by
        // default). The scheduler reads this pref when it builds each block's
        // executor at start(), so it must be set before run() below.
        gr::prefs::singleton()->set_bool("PerfCounters", "on", true);

        g_tb = gr::make_top_block("wasm_runner");
        clear_runtime_objects();
        std::map<std::string, gr::basic_block_sptr> byname;
        std::map<std::string, VariableControl> variables;
        int nblocks = 0, nsinks = 0;

        // Reset the diagnostics snapshot for this run.
        g_stats.clear();
        g_ref_samp_rate = 0.0;
        std::string ref_widget_name, ref_throttle_name, ref_maxrate_name;

        // Construct controls first so references such as frequency="freq" can
        // be resolved regardless of where the control appears in the graph JSON.
        for (const auto& blk : j.at("blocks")) {
            const std::string id = blk.at("id").get<std::string>();
            if (!is_variable_control(id))
                continue;
            const std::string name = blk.at("name").get<std::string>();
            nlohmann::json params = blk.value("params", nlohmann::json::object());
            params["__name"] = name;
            BuiltBlock built = block_registry().at(id)(params);
            variables.emplace(name, VariableControl{ built.variable_value, std::move(built) });
        }

        // Typed GRC variables such as constellation objects are not scheduler
        // blocks, but downstream hierarchy factories need their C++ objects.
        // Construct all of them first so references work regardless of file order.
        for (const auto& blk : j.at("blocks")) {
            const std::string id = blk.at("id").get<std::string>();
            if (!is_runtime_object(id))
                continue;
            const std::string name = blk.at("name").get<std::string>();
            nlohmann::json params =
                blk.value("params", nlohmann::json::object());
            params["__name"] = name;
            block_registry().at(id)(params);
        }

        for (const auto& blk : j.at("blocks")) {
            std::string id = blk.at("id").get<std::string>();
            std::string name = blk.at("name").get<std::string>();
            if (is_runtime_object(id)) {
                ++nblocks;
                continue;
            }
            auto it = block_registry().find(id);
            if (it == block_registry().end())
                throw std::runtime_error("unknown block id: " + id);
            nlohmann::json source_params =
                blk.value("params", nlohmann::json::object());
            nlohmann::json params = resolve_variables(source_params, variables);
            BuiltBlock bb;
            if (is_variable_control(id)) {
                bb = variables.at(name).built;
            } else {
                bb = it->second(params);
            }
            if (bb.block)
                byname[name] = bb.block;
            ++nblocks;
            if (bb.widget) { g_container->layout()->addWidget(bb.widget); bb.widget->show(); ++nsinks; }

            // Bind parameters whose expression is exactly a Range variable ID.
            // GRC's common `frequency: freq` form now updates the live block.
            for (const auto& source_param : source_params.items()) {
                if (!source_param.value().is_string())
                    continue;
                const std::string variable_name =
                    source_param.value().get<std::string>();
                auto variable = variables.find(variable_name);
                auto setter = bb.numeric_setters.find(source_param.key());
                if (variable != variables.end() && setter != bb.numeric_setters.end())
                    variable->second.built.subscribe(setter->second);
            }

            // Record a stats entry for any block that is a gr::block (all our
            // registry blocks are). has_in/has_out are filled from connections.
            if (auto b = std::dynamic_pointer_cast<gr::block>(bb.block)) {
                g_stats.push_back({ name, id, b, false, false, false });
                if (bb.widget) ref_widget_name = name;         // prefer a GUI sink
                if (id.find("throttle") != std::string::npos) ref_throttle_name = name;
            }
            // Track the highest configured samp_rate as the realtime reference rate.
            if (params.contains("samp_rate")) {
                double sr = params.value("samp_rate", 0.0);
                if (sr > g_ref_samp_rate) { g_ref_samp_rate = sr; ref_maxrate_name = name; }
            }
        }

        for (const auto& c : j.at("connections")) {
            std::string src = c[0].get<std::string>(), dst = c[2].get<std::string>();
            const bool message = c.size() > 4 && c[4].get<std::string>() == "message";
            if (message) {
                g_tb->msg_connect(byname.at(src),
                                  c[1].get<std::string>(),
                                  byname.at(dst),
                                  c[3].get<std::string>());
            } else {
                g_tb->connect(
                    byname.at(src), c[1].get<int>(), byname.at(dst), c[3].get<int>());
            }
            for (auto& sb : g_stats) {
                if (!message && sb.name == src) sb.has_out = true;
                if (!message && sb.name == dst) sb.has_in = true;
            }
        }

        // Reference point for the realtime factor: a GUI sink if present, else a
        // throttle, else the block that set the highest samp_rate.
        std::string ref = !ref_widget_name.empty() ? ref_widget_name
                        : !ref_throttle_name.empty() ? ref_throttle_name : ref_maxrate_name;
        for (auto& sb : g_stats) sb.is_ref = (sb.name == ref);
        g_run_start = std::chrono::steady_clock::now();

        // Run the flowgraph on its OWN thread. If we called start() here (on the
        // main browser thread, before/around app.exec()), GR's per-block worker
        // creations would block the main thread because Emscripten needs the main
        // event loop to spawn workers — deadlock for graphs that exhaust the pool.
        // From a worker thread, those creations are serviced by the running loop.
        auto tb = g_tb;
        std::thread([tb] { tb->run(); }).detach();

        std::string msg = "blocks=" + std::to_string(nblocks) + " sinks=" + std::to_string(nsinks);
        QTimer::singleShot(2500, [msg] { report(true, msg); });
    } catch (const std::exception& e) {
        report(false, std::string("exception: ") + e.what());
    }
}

// ---- on-demand category loading -------------------------------------------
// A flowgraph may reference blocks whose C++ lives in a category side module
// (digital/dtv/network/pdu/vocoder). Those modules are fetched over the network
// and dlopen'd the first time they're needed; their file-scope registrars then
// populate the block registry (see registry.cpp wasm_registry_add). Loading is
// asynchronous, so gr_run_json kicks off a load chain that ends by calling
// run_now() once every required module is present.
static std::set<std::string> g_loaded_modules;

// Tell the editor (parent frame) about a category's load state so it can color
// the palette. Also stashed on window for same-page inspection/tests.
static void notify_module(const std::string& module, const char* state) {
    // NOTE: EM_ASM splits its macro arguments on commas that are not inside
    // parentheses, so the JS body must avoid bare commas (no `{a:1, b:2}` object
    // literals, no `var a, b`). Build the message object field by field instead.
    EM_ASM({
        try {
            var name = UTF8ToString($0);
            var st = UTF8ToString($1);
            window.__grModules = window.__grModules || {};
            window.__grModules[name] = st;
            if (window.parent && window.parent !== window) {
                var m = {};
                m.type = 'gr-module';
                m.module = name;
                m.state = st;
                window.parent.postMessage(m, '*');
            }
        } catch (e) {}
    }, module.c_str(), state);
}

// Deferred modules a flowgraph needs, dependencies first (topological order).
static std::vector<std::string> modules_needed(const nlohmann::json& j) {
    std::set<std::string> need;
    const auto& map = block_module_map();
    for (const auto& blk : j.at("blocks")) {
        auto it = map.find(blk.at("id").get<std::string>());
        if (it != map.end())
            need.insert(it->second);
    }
    std::vector<std::string> order;
    std::set<std::string> seen;
    std::function<void(const std::string&)> visit = [&](const std::string& m) {
        if (!seen.insert(m).second)
            return;
        auto d = module_deps().find(m);
        if (d != module_deps().end())
            for (const auto& dep : d->second)
                visit(dep);
        order.push_back(m);
    };
    for (const auto& m : need)
        visit(m);
    return order;
}

struct LoadCtx {
    std::vector<std::string> mods;
    std::size_t idx;
    std::string fgs;
};

static void load_next(LoadCtx* ctx);

static void on_module_loaded(void* user, void* /*handle*/) {
    auto* ctx = static_cast<LoadCtx*>(user);
    const std::string& m = ctx->mods[ctx->idx];
    g_loaded_modules.insert(m);
    notify_module(m, "loaded");
    ++ctx->idx;
    load_next(ctx);
}

static void on_module_error(void* user) {
    auto* ctx = static_cast<LoadCtx*>(user);
    const std::string module = ctx->mods[ctx->idx];
    delete ctx;
    const char* err = dlerror();
    notify_module(module, "error");
    report(false, "failed to load category module: " + module + ".wasm" +
                      (err ? std::string(" — ") + err : std::string()));
}

static void load_next(LoadCtx* ctx) {
    while (ctx->idx < ctx->mods.size() && g_loaded_modules.count(ctx->mods[ctx->idx]))
        ++ctx->idx;  // already fetched in a previous run
    if (ctx->idx >= ctx->mods.size()) {
        const std::string fgs = std::move(ctx->fgs);
        delete ctx;
        run_now(fgs);
        return;
    }
    const std::string& m = ctx->mods[ctx->idx];
    notify_module(m, "loading");
    const std::string path = m + ".wasm";  // served next to runner.html
    emscripten_dlopen(path.c_str(), RTLD_NOW | RTLD_GLOBAL, ctx,
                      on_module_loaded, on_module_error);
}


extern "C" EMSCRIPTEN_KEEPALIVE
int gr_run_json(const char* grc_text) {
    try {
        nlohmann::json lowered = grc_lower::lower(grc_yaml::parse(grc_text));
        auto* ctx = new LoadCtx{ modules_needed(lowered), 0, lowered.dump() };
        load_next(ctx);  // fetch missing category modules, then run_now()
        return 0;
    } catch (const std::exception& e) {
        report(false, std::string("flowgraph error: ") + e.what());
        return 1;
    } catch (...) {
        report(false, "flowgraph error: unrecognized exception");
        return 1;
    }
}

// Build the diagnostics snapshot the panel renders. Reads GR's per-block
// performance counters plus cumulative item counts; the JS panel derives
// throughput, realtime factor, CPU share and the bottleneck from successive
// snapshots. Published to the page via a main-thread QTimer (see below) rather
// than a JS->C++ call, because Qt overrides Emscripten's exported runtime
// methods (ccall/cwrap are not reliably available on this build).
static std::string build_stats_json() {
    nlohmann::json out;
    out["uptime_s"] = std::chrono::duration<double>(
                          std::chrono::steady_clock::now() - g_run_start).count();
    out["ref_samp_rate"] = g_ref_samp_rate;
    // Host metrics gathered here (not from JS): Qt's WASM build drops most of
    // Emscripten's Module runtime symbols, and touching a non-exported one
    // (Module.PThread, Module.HEAP8, ...) aborts the whole runtime.
    out["wasm_heap"] = (double)emscripten_get_heap_size();
    out["dsp_threads"] = (int)g_stats.size();  // GR runs one thread per block
    out["pool"] = 64;                          // matches -sPTHREAD_POOL_SIZE

    auto vmax = [](const std::vector<float>& v) {
        return v.empty() ? 0.0f : *std::max_element(v.begin(), v.end());
    };

    nlohmann::json arr = nlohmann::json::array();
    for (auto& sb : g_stats) {
        nlohmann::json b;
        b["name"] = sb.name;
        b["id"] = sb.id;
        b["ref"] = sb.is_ref;
        // Cumulative item count at a representative port; JS differentiates it
        // over the poll interval to get items/s (true flow, indep. of counters).
        uint64_t items = 0;
        if (sb.has_out)      items = sb.blk->nitems_written(0);
        else if (sb.has_in)  items = sb.blk->nitems_read(0);
        b["items"] = items;
        // Per-block performance counters.
        b["work_us"] = sb.blk->pc_work_time_avg() / 1000.0;      // ns -> us
        b["work_total_s"] = sb.blk->pc_work_time_total() / 1e9;  // ns -> s
        b["in_full"] = vmax(sb.blk->pc_input_buffers_full());    // 0..1
        b["out_full"] = vmax(sb.blk->pc_output_buffers_full());  // 0..1
        // Probe Signal is deliberately observable in the diagnostics snapshot.
        // Besides being useful in the debug panel, this lets browser tests verify
        // sample values after they have passed through the WASM scheduler.
        if (sb.id == "blocks_probe_signal_x") {
            if (auto probe =
                    std::dynamic_pointer_cast<gr::blocks::probe_signal_b>(sb.blk))
                b["value"] = static_cast<unsigned int>(probe->level());
            else if (auto probe =
                         std::dynamic_pointer_cast<gr::blocks::probe_signal_s>(sb.blk))
                b["value"] = probe->level();
            else if (auto probe =
                         std::dynamic_pointer_cast<gr::blocks::probe_signal_i>(sb.blk))
                b["value"] = probe->level();
            else if (auto probe =
                         std::dynamic_pointer_cast<gr::blocks::probe_signal_f>(sb.blk))
                b["value"] = probe->level();
            else if (auto probe =
                         std::dynamic_pointer_cast<gr::blocks::probe_signal_c>(sb.blk)) {
                const gr_complex value = probe->level();
                b["value"] = { value.real(), value.imag() };
            }
        }
        arr.push_back(b);
    }
    out["blocks"] = arr;
    return out.dump();
}

// Publish the snapshot onto window.__grstats for the diagnostics panel. Runs on
// the Qt main thread (QTimer), so reading counters + touching the DOM is safe.
static void publish_stats() {
    std::string s = build_stats_json();
    EM_ASM({ if (typeof window !== 'undefined') window.__grstats = UTF8ToString($0); }, s.c_str());
}

// A self-contained demo flowgraph (.grc) used when no flowgraph is supplied via
// the URL hash, so the runner still shows the signal+noise scope on its own.
static const char* kEmbeddedFlowgraph = R"GRC(options:
    parameters:
        generate_options: qt_gui
        id: embedded_demo
    states:
        coordinate: [10, 10]
        rotation: 0
        state: enabled
blocks:
-   name: src
    id: analog_sig_source_x
    parameters:
        type: complex
        samp_rate: '32000'
        waveform: analog.GR_COS_WAVE
        frequency: '1500'
        amplitude: '1'
    states:
        coordinate: [50, 70]
        rotation: 0
        state: enabled
-   name: noise
    id: analog_noise_source_x
    parameters:
        type: complex
        amplitude: '0.25'
        seed: '42'
    states:
        coordinate: [50, 250]
        rotation: 0
        state: enabled
-   name: add
    id: blocks_add_xx
    parameters:
        type: complex
    states:
        coordinate: [300, 130]
        rotation: 0
        state: enabled
-   name: thr
    id: blocks_throttle
    parameters:
        type: complex
        samp_rate: '32000'
    states:
        coordinate: [490, 130]
        rotation: 0
        state: enabled
-   name: snk
    id: qtgui_time_sink_x
    parameters:
        type: complex
        size: '1024'
        samp_rate: '32000'
        name: MULTI-SOURCE
    states:
        coordinate: [700, 80]
        rotation: 0
        state: enabled
connections:
- [src, '0', add, '0']
- [noise, '0', add, '1']
- [add, '0', thr, '0']
- [thr, '0', snk, '0']
)GRC";

// Read a flowgraph .grc from the URL hash (editor sets runner.html#<encoded grc>).
// Returns a malloc'd C string, or nullptr if no hash.
static char* flowgraph_from_url() {
    return (char*)EM_ASM_PTR({
        var h = (typeof window !== 'undefined') ? window.location.hash : '';
        if (h && h.length > 1) {
            try { return stringToNewUTF8(decodeURIComponent(h.substring(1))); }
            catch (e) { return 0; }
        }
        return 0;
    });
}

int main(int argc, char** argv) {
    QApplication app(argc, argv);

    // Give GR's logger somewhere to go (see BrowserLogSink): without this every
    // runtime error, including a block throwing out of work(), is discarded.
    gr::logging::singleton().add_default_sink(std::make_shared<BrowserLogSink>());

    // Be explicit about the top-level window decorations. Qt's WASM platform
    // implements its draggable title bar and resize handles from these flags;
    // relying on QWidget's implicit defaults can leave the canvas looking like
    // an undecorated, fixed panel instead of an interactive window.
    const Qt::WindowFlags window_flags = Qt::Window | Qt::WindowTitleHint |
                                         Qt::WindowSystemMenuHint |
                                         Qt::WindowMaximizeButtonHint |
                                         Qt::WindowCloseButtonHint;
    g_container = new QWidget(nullptr, window_flags);
    g_container->setWindowTitle(QStringLiteral("GNU Radio Flowgraph"));
    g_container->setMinimumSize(320, 240);
    g_container->setMaximumSize(QWIDGETSIZE_MAX, QWIDGETSIZE_MAX);
    g_container->setLayout(new QVBoxLayout());

    // Keep the initial frame and its resize handles inside the browser-backed
    // QScreen, including when the runner is opened in a relatively small tab.
    const QRect available = app.primaryScreen()->availableGeometry();
    const QSize initial_size(qMin(820, qMax(320, available.width() - 48)),
                             qMin(520, qMax(240, available.height() - 48)));
    g_container->resize(initial_size);
    g_container->move(available.topLeft() + QPoint(24, 24));
    // showNormal() is important on WASM: a fullscreen/maximized window has no
    // non-client frame, so Qt hides the draggable title bar and resize handles.
    g_container->showNormal();
    // Editor passes the flowgraph via the URL hash; fall back to the embedded demo.
    char* fg = flowgraph_from_url();
    std::string fgs = fg ? fg : kEmbeddedFlowgraph;
    if (fg) free(fg);
    // Defer the first run until the Qt event loop is running, so GR's worker
    // creation is serviced by the main loop (see gr_run_json).
    QTimer::singleShot(0, [fgs] { gr_run_json(fgs.c_str()); });

    // Publish diagnostics to window.__grstats ~3 Hz for the panel (diag.js).
    static QTimer stats_timer;
    QObject::connect(&stats_timer, &QTimer::timeout, [] { publish_stats(); });
    stats_timer.start(333);

    return app.exec();
}
