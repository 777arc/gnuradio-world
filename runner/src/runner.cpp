// JSON-driven GNU Radio flowgraph runner (WASM). Parses a flowgraph JSON, builds
// blocks via the registry, connects them, runs the GR scheduler, and shows any
// GUI sink widgets on the Qt canvas. Exposed to JS as gr_run_json(const char*).
#include "registry.hpp"
#include <gnuradio/top_block.h>
#include <gnuradio/block.h>
#include <gnuradio/prefs.h>
#include <QApplication>
#include <QWidget>
#include <QVBoxLayout>
#include <QTimer>
#include <emscripten.h>
#include <emscripten/heap.h>
#include <algorithm>
#include <chrono>
#include <cstdlib>
#include <map>
#include <string>
#include <thread>
#include <vector>

static gr::top_block_sptr g_tb;
static QWidget* g_container = nullptr;

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

static void report(bool ok, const std::string& msg) {
    // marshalled to the browser main thread by Qt/emscripten as needed
    EM_ASM({
        var d = document.getElementById('result') ||
            document.body.appendChild(Object.assign(document.createElement('div'), {id:'result'}));
        d.setAttribute('data-status', $0 ? 'pass' : 'fail');
        d.textContent = ($0 ? 'RESULT: RUNNER_PASS ' : 'RESULT: RUNNER_FAIL ') + UTF8ToString($1);
    }, ok ? 1 : 0, msg.c_str());
}

extern "C" EMSCRIPTEN_KEEPALIVE
int gr_run_json(const char* json_str) {
    try {
        auto j = nlohmann::json::parse(json_str);
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
        std::map<std::string, gr::basic_block_sptr> byname;
        int nblocks = 0, nsinks = 0;

        // Reset the diagnostics snapshot for this run.
        g_stats.clear();
        g_ref_samp_rate = 0.0;
        std::string ref_widget_name, ref_throttle_name, ref_maxrate_name;

        for (const auto& blk : j.at("blocks")) {
            std::string id = blk.at("id").get<std::string>();
            std::string name = blk.at("name").get<std::string>();
            auto it = block_registry().find(id);
            if (it == block_registry().end())
                throw std::runtime_error("unknown block id: " + id);
            nlohmann::json params = blk.value("params", nlohmann::json::object());
            BuiltBlock bb = it->second(params);
            byname[name] = bb.block;
            ++nblocks;
            if (bb.widget) { g_container->layout()->addWidget(bb.widget); bb.widget->show(); ++nsinks; }

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
            g_tb->connect(byname.at(src), c[1].get<int>(), byname.at(dst), c[3].get<int>());
            for (auto& sb : g_stats) {
                if (sb.name == src) sb.has_out = true;
                if (sb.name == dst) sb.has_in = true;
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
        return 0;
    } catch (const std::exception& e) {
        report(false, std::string("exception: ") + e.what());
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

// For the Phase-A first proof: an embedded flowgraph (the Artifact-1 graph) so we
// verify the JSON->registry->run->plot path without JS plumbing yet.
static const char* kEmbeddedFlowgraph = R"JSON({
  "blocks": [
    {"name":"src","id":"analog_sig_source_x","params":{"samp_rate":32000,"waveform":"cos","frequency":1500,"amplitude":1.0}},
    {"name":"noise","id":"analog_noise_source_x","params":{"amplitude":0.25,"seed":42}},
    {"name":"add","id":"blocks_add_xx","params":{}},
    {"name":"thr","id":"blocks_throttle","params":{"itemsize":8,"samp_rate":32000}},
    {"name":"snk","id":"qtgui_time_sink_x","params":{"size":1024,"samp_rate":32000,"name":"MULTI-SOURCE: signal + noise","nconnections":1}}
  ],
  "connections": [ ["src",0,"add",0], ["noise",0,"add",1], ["add",0,"thr",0], ["thr",0,"snk",0] ]
})JSON";

// Read a flowgraph JSON from the URL hash (editor sets runner.html#<encoded json>).
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
    g_container = new QWidget();
    g_container->setLayout(new QVBoxLayout());
    g_container->resize(820, 520);
    g_container->show();
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
