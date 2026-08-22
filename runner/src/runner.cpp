// GNU Radio flowgraph runner (WASM). Parses a native .grc flowgraph (grc_yaml),
// lowers it to a runnable block/connection list (grc_lower: drops disabled
// blocks, hops bypassed ones, inlines plain variables), builds blocks via the
// registry, connects them, runs the GR scheduler, and shows any GUI sink widgets
// on the Qt canvas. Entry point gr_run_json(const char*) takes .grc text.
#include "registry.hpp"
#include "grc_yaml.hpp"
#include "grc_lower.hpp"
#include "gui_layout.hpp"
#include "flat_flowgraph.h"
#include <gnuradio/blocks/probe_signal.h>
#include <gnuradio/top_block.h>
#include <gnuradio/block.h>
#include <gnuradio/logger.h>
#include <gnuradio/prefs.h>
#include <QApplication>
#include <QLabel>
#include <QPointer>
#include <QFontInfo>
#include <QScreen>
#include <QSize>
#include <QWidget>
#include <QGridLayout>
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
#include <cstdio>
#include <map>
#include <memory>
#include <mutex>
#include <set>
#include <string>
#include <thread>
#include <vector>

static gr::top_block_sptr g_tb;
// The top-level flowgraph window. Its own layout is fixed: an error banner (when
// there is one) above g_gui_area, which is the part a flowgraph arranges.
static QWidget* g_container = nullptr;
// Every GUI widget this run built lives in here, in the layout the flowgraph's
// GUI Layout block asked for. Kept separate from g_container so the layout
// object can be swapped per run -- and per live Arrange drag -- without the
// banner or the window's own geometry being caught up in it.
static QWidget* g_gui_area = nullptr;
static unsigned int g_run_generation = 0;
static std::string g_pending_success_message;

// This run's widgets, in flowgraph order, for the layout pass and for re-laying
// out on the fly when the editor sends a new spec. QPointer because run_now()
// deleteLater()s the previous run's widgets: a stale entry nulls itself rather
// than dangling.
struct PlacedWidget {
    std::string name;              // block ID, which is what a tile is keyed by
    std::string id;                // GRC block id, for the editor's palette
    QPointer<QWidget> widget;
    // Where it actually ended up, which is not always what the spec asked for:
    // a widget the spec says nothing about is given a row of its own.
    gui_layout::Tile tile;
};
static std::vector<PlacedWidget> g_widgets;

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
           id == "variable_constellation_rect" ||
           // gr-fec's coder definitions: GRC variables holding a coder object
           // (or a list of them) for an FEC block to name.
           id == "variable_cc_decoder_def" ||
           id == "variable_cc_encoder_def" ||
           id == "variable_ccsds_encoder_def" ||
           id == "variable_dummy_decoder_def" ||
           id == "variable_dummy_encoder_def" ||
           id == "variable_repetition_decoder_def" ||
           id == "variable_repetition_encoder_def" ||
           id == "variable_tag_object" ||
           // Files the window's grid spec; see gui_layout.hpp.
           id == "wasm_gui_layout";
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
static int g_scheduler_workers = 0;
static double g_ref_samp_rate = 0.0;
static std::chrono::steady_clock::time_point g_run_start;

// Show an error inside the flowgraph window. Without this a failure is invisible:
// the #result div lives under Qt's canvas, and a graph that dies during
// construction just leaves an empty window (no sink widget was ever added). The
// banner is reused, and run_now() hides it, so a later successful run starts
// clean. Main thread only.
//
// It sits in g_container's own fixed layout, above the arranged area, rather
// than in the arrangement: a flowgraph that failed to build has no widgets and
// therefore no grid to put a banner in, and a run that replaces the grid must
// not take the reason the last one failed with it.
static QPointer<QLabel> g_error_banner;
static void show_error_in_window(const QString& title, const std::string& msg) {
    auto* outer = g_container ? qobject_cast<QVBoxLayout*>(g_container->layout()) : nullptr;
    if (!outer)
        return;
    if (!g_error_banner) {
        g_error_banner = new QLabel(g_container);
        g_error_banner->setWordWrap(true);
        g_error_banner->setAlignment(Qt::AlignCenter);
        g_error_banner->setTextInteractionFlags(Qt::TextSelectableByMouse);
        g_error_banner->setStyleSheet(QStringLiteral(
            "color:#b00020; background:#fff3f3; border:1px solid #f0c0c0;"
            "padding:12px; font-size:14px;"));
        outer->insertWidget(0, g_error_banner);
    }
    g_error_banner->setText(title + QStringLiteral("\n\n") + QString::fromStdString(msg));
    g_error_banner->show();
}

// Tell the editor which widgets this run actually built and where they ended up,
// so its designer can offer them as tiles and its Arrange overlay can draw
// handles over them. Sent as one JSON string because EM_ASM splits its macro
// arguments on top-level commas, which rules out building the object in JS.
static void post_widgets_to_editor(const std::string& payload) {
    EM_ASM({
        if (window.parent && window.parent !== window) {
            var m = {};
            m.type = 'gr-widgets';
            m.payload = UTF8ToString($0);
            window.parent.postMessage(m, '*');
        }
    }, payload.c_str());
}

// Lay this run's widgets out in g_gui_area, replacing whatever arrangement was
// there. Called once per run and again for every live Arrange edit, so it has to
// be idempotent: it builds a fresh layout object each time rather than mutating
// one, which is also the only way to change a QGridLayout's spans.
static void apply_gui_layout() {
    if (!g_gui_area)
        return;
    // Detach the widgets before the layout that holds them is destroyed; they
    // belong to this run, not to the arrangement, and are re-added below.
    if (auto* previous = g_gui_area->layout()) {
        QLayoutItem* item;
        while ((item = previous->takeAt(0)) != nullptr)
            delete item;
        delete previous;
    }
    const gui_layout::Spec& spec = gui_layout::runtime_spec();
    if (!spec.present) {
        // No GUI Layout block: the full-width vertical stack every flowgraph got
        // before this existed, which is what an older .grc still deserves.
        auto* column = new QVBoxLayout(g_gui_area);
        int row = 0;
        for (auto& placed : g_widgets) {
            if (!placed.widget)
                continue;
            column->addWidget(placed.widget);
            placed.widget->show();
            placed.tile = { 0, row++, gui_layout::kDefaultColumns, 1 };
        }
        return;
    }

    auto* grid = new QGridLayout(g_gui_area);
    grid->setContentsMargins(4, 4, 4, 4);
    grid->setSpacing(4);
    // Every column and row stretches equally, which is what makes a tile's w and
    // h proportional rather than absolute: the window's width is shared between
    // `columns` columns, so a 6-wide tile is half of any window.
    for (int c = 0; c < spec.columns; ++c)
        grid->setColumnStretch(c, 1);

    int next_row = gui_layout::rows_used(spec);
    int last_row = 0;
    for (auto& placed : g_widgets) {
        if (!placed.widget)
            continue;
        auto found = spec.tiles.find(placed.name);
        // A widget with no tile of its own -- a sink added since the flowgraph
        // was last arranged -- goes full width under everything that has one, so
        // it is never invisible. The editor gives it a real tile on the next
        // edit; until then this is where it appears, and where the Arrange
        // overlay draws its handle.
        const int rows = is_variable_control(placed.id) ? gui_layout::kControlRows
                                                        : gui_layout::kSinkRows;
        placed.tile = found != spec.tiles.end()
            ? found->second
            : gui_layout::Tile{ 0, next_row, spec.columns, rows };
        if (found == spec.tiles.end())
            next_row += rows;
        grid->addWidget(placed.widget, placed.tile.row, placed.tile.col,
                        placed.tile.h, placed.tile.w);
        placed.widget->show();
        last_row = std::max(last_row, placed.tile.row + placed.tile.h);
    }
    // Columns already scale down with the window (equal stretch above), so a
    // narrow tab shrinks every tile's width for free. Rows don't: a fixed
    // per-row minimum is exactly what makes an arrangement taller than the
    // window clip at the bottom instead of shrinking to fit, which is normally
    // fine (there's a scrollable tab behind it) but is the wrong call for a
    // window too small to scroll at all -- an embedded flowgraph a few rows of
    // widgets and a hundred-odd pixels tall. Scale row_height down so the whole
    // arrangement fits vertically instead, floored so a widget never collapses
    // to nothing.
    constexpr int kMinRowHeight = 8;
    int row_height = spec.row_height;
    if (last_row > 0) {
        const int available = g_gui_area->height();
        if (available > 0 && available < last_row * row_height)
            row_height = std::max(kMinRowHeight, available / last_row);
    }
    for (int r = 0; r < last_row; ++r) {
        grid->setRowStretch(r, 1);
        grid->setRowMinimumHeight(r, row_height);
    }
    // Shrink the whole arrangement's text along with its rows: a QwtPlot reads
    // its axis tick-label font from the widget's own font() (DisplayPlot.cc),
    // and every widget below g_gui_area that never called setFont() itself
    // inherits whatever is set here -- so one setFont() on the shared parent is
    // enough to shrink labels, buttons and plot axes together, with no per-sink
    // code. Scaled from the same base font every time (never from the last
    // scaled result), so repeated calls at a since-grown size recover it.
    static const QFont kBaseFont = g_gui_area->font();
    QFont font = kBaseFont;
    if (row_height < spec.row_height) {
        const double scale = double(row_height) / double(spec.row_height);
        const double base_pt =
            kBaseFont.pointSizeF() > 0 ? kBaseFont.pointSizeF() : QFontInfo(kBaseFont).pointSizeF();
        font.setPointSizeF(std::max(6.0, base_pt * scale));
    }
    g_gui_area->setFont(font);
}

// What the editor needs to draw handles over the live widgets: the tiles as
// placed, and the on-screen rectangle the grid occupies inside the iframe. Qt's
// global coordinates are relative to the browser-backed QScreen, which is the
// container div filling the runner page, so they are the iframe's own CSS
// pixels and the editor can position an overlay with them directly.
//
// Sent only when something changes, from the same timer that publishes
// diagnostics: the rectangle moves whenever the window is dragged, resized or
// maximized, and none of those is an event this file otherwise hears about.
static std::string g_last_layout_payload;
static void publish_gui_layout(bool force) {
    if (!g_gui_area)
        return;
    const gui_layout::Spec& spec = gui_layout::runtime_spec();
    const QPoint origin = g_gui_area->mapToGlobal(QPoint(0, 0));
    nlohmann::json payload;
    payload["columns"] = spec.present ? spec.columns : gui_layout::kDefaultColumns;
    payload["rowHeight"] = spec.present ? spec.row_height : gui_layout::kDefaultRowHeight;
    payload["arranged"] = spec.present;
    payload["rect"] = { { "x", origin.x() }, { "y", origin.y() },
                        { "width", g_gui_area->width() },
                        { "height", g_gui_area->height() } };
    nlohmann::json widgets = nlohmann::json::array();
    for (const auto& placed : g_widgets) {
        if (!placed.widget)
            continue;
        widgets.push_back({ { "name", placed.name }, { "id", placed.id },
                            { "col", placed.tile.col }, { "row", placed.tile.row },
                            { "w", placed.tile.w }, { "h", placed.tile.h } });
    }
    payload["widgets"] = std::move(widgets);
    std::string text = payload.dump();
    if (!force && text == g_last_layout_payload)
        return;
    g_last_layout_payload = std::move(text);
    post_widgets_to_editor(g_last_layout_payload);
}

// Re-arrange a running flowgraph from a spec the editor just edited, without
// restarting it: the Arrange overlay drags a live plot around and the plot keeps
// plotting. Called from runner.html when the parent frame posts a new spec.
extern "C" EMSCRIPTEN_KEEPALIVE void gr_apply_gui_layout(const char* tiles_json,
                                                         int columns,
                                                         int row_height) {
    if (!tiles_json)
        return;
    gui_layout::runtime_spec() = gui_layout::parse(tiles_json, columns, row_height);
    apply_gui_layout();
    // The tiles changed, so the editor's own overlay geometry is stale; it will
    // not hear about it from the change it just made.
    publish_gui_layout(true);
}

// Ask the flowgraph to finish, so a block with something to finish gets to.
//
// SigMF Sink is why this exists. Pressing Stop in the editor unloads this frame,
// and unloading it kills the writer worker with the tail of the recording still
// in shared memory -- or, where the browser has no File System Access API and the
// recording is buffered rather than streamed, with the whole of it. The editor
// asks for this first, for a flowgraph that needs it, and waits for the
// acknowledgement runner.html posts back.
//
// **This signals and returns; it must not join.** The browser main thread calls
// it, and every block's stop() runs on that block's own scheduler thread -- where
// BrowserFileSink's makes a proxied MAIN_THREAD_EM_ASM call to reach its writer.
// Blocking here (top_block::wait(), the way run_now() tears down for a re-run)
// deadlocks outright: the block waits for the main thread to run its JS, and the
// main thread waits for the block to exit. What runner.html waits for instead is
// the writers reporting their files closed, which is the only part of a shutdown
// that unloading the frame would actually lose.
extern "C" EMSCRIPTEN_KEEPALIVE void gr_shutdown_flowgraph() {
    if (!g_tb)
        return;
    try {
        g_tb->stop();
    } catch (...) {
        // Nothing useful is left to do about a block that throws on the way
        // down, and the caller is about to discard this frame regardless.
    }
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

// Informational runner messages use their own event rather than stdout so they
// appear promptly and individually in the editor console. Keep console.log as
// well so direct runner pages and the browser smoke suite can inspect them.
static void post_info_to_editor(const std::string& msg) {
    EM_ASM({
        var text = UTF8ToString($0);
        console.log(text);
        if (window.parent && window.parent !== window) {
            var m = {};
            m.type = 'gr-info';
            m.message = text;
            window.parent.postMessage(m, '*');
        }
    }, msg.c_str());
}

// GNU Radio logs scheduler/block failures — notably the exception
// thread_body_wrapper catches when a block's work() throws — through spdlog. In
// this build its default backend has NO sinks: gr::logging reads the sink from
// the "log_file" pref, which is empty because there is no config file in the
// browser, so every message is dropped.
//
// Both halves of the logger have to reach the user, and they are not the same
// kind of event:
//
//   * error and above is a failure. It gets the in-window banner and the
//     editor's `gr-error` channel, the same places a failed run goes.
//   * everything below is a block reporting on itself — Message Debug's `log`
//     port, Print Header, a filter announcing its taps. Natively that goes to
//     the console; here it goes to *stdout*, because runner.html already hooks
//     Emscripten's print, batches the lines and caps the volume before handing
//     them to the editor's console pane. A Message Debug on a fast frame source
//     emits thousands of lines a second, so reusing that batching matters —
//     posting each record straight to the parent frame would drown it.
class BrowserLogSink : public spdlog::sinks::base_sink<std::mutex> {
protected:
    void sink_it_(const spdlog::details::log_msg& msg) override {
        const std::string text(msg.payload.begin(), msg.payload.end());
        // Emscripten has no thread-naming API. GNU Radio logs the unavailable
        // cosmetic operation as an error once per scheduler thread even though
        // the threads and flowgraph continue normally.
        if (text.find("set_thread_name(gr_thread_t, string) not implemented") !=
            std::string::npos)
            return;

        if (msg.level < spdlog::level::err) {
            // Tagged the way GNU Radio's own console sink tags it, so a log line
            // is distinguishable from a block's plain stdout in the same pane.
            const auto level = spdlog::level::to_string_view(msg.level);
            const std::string name(msg.logger_name.begin(), msg.logger_name.end());
            std::printf("%.*s: %s%s%s\n",
                        static_cast<int>(level.size()), level.data(),
                        name.c_str(), name.empty() ? "" : " - ", text.c_str());
            return;
        }

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

// Must round exactly as poolTierForBlockCount() in runner.html does: that one
// sizes the prewarmed pool from a guess, this one tops it up once the flattened
// graph gives the real thread count, so a coarser rule here would re-inflate the
// pool and undo the finer one there. Multiples of 8 — see runner.html for why
// the slack is worth the ~50-100 ms per prewarmed worker.
static int worker_tier_for(int required_workers) {
    const int rounded = ((std::max(0, required_workers) + 7) / 8) * 8;
    return std::min(256, std::max(8, rounded));
}

static void start_prepared_flowgraph(unsigned int generation) {
    if (generation != g_run_generation || !g_tb)
        return;
    g_run_start = std::chrono::steady_clock::now();
    auto tb = g_tb;
    std::thread([tb] { tb->run(); }).detach();
    const std::string msg = g_pending_success_message;
    QTimer::singleShot(2500, [msg] { report(true, msg); });
}

// Called on the browser main thread after every newly allocated Worker has
// loaded the main WASM module and all currently loaded side modules.
extern "C" EMSCRIPTEN_KEEPALIVE void gr_finish_worker_preload(
    int generation, int succeeded) {
    EM_ASM({ globalThis.__grTierPreloading = false; });
    if (!succeeded) {
        if (static_cast<unsigned int>(generation) == g_run_generation)
            report(false, "worker preload failed");
        return;
    }
    start_prepared_flowgraph(static_cast<unsigned int>(generation));
}

static void preload_workers_then_start(int target, unsigned int generation) {
    EM_ASM({
        var target = $0;
        var generation = $1;
        globalThis.__grPoolTier = target;
        globalThis.__grTierPreloading = true;
        var loads = [];
        try {
            while (PThread.unusedWorkers.length + PThread.runningWorkers.length < target) {
                PThread.allocateUnusedWorker();
                var worker = PThread.unusedWorkers[PThread.unusedWorkers.length - 1];
                loads.push(PThread.loadWasmModuleToWorker(worker));
            }
        } catch (error) {
            console.error('worker preload failed:', error);
            globalThis.__grTierPreloading = false;
            _gr_finish_worker_preload(generation, 0);
            return;
        }
        Promise.all(loads).then(function() {
            globalThis.__grTierPreloading = false;
            _gr_finish_worker_preload(generation, 1);
        }).catch(function(error) {
            console.error('worker preload failed:', error);
            globalThis.__grTierPreloading = false;
            _gr_finish_worker_preload(generation, 0);
        });
    }, target, generation);
}

static void run_now(const std::string& json_source) {
    try {
        auto j = nlohmann::json::parse(json_source);
        if (g_tb) { g_tb->stop(); g_tb->wait(); g_tb.reset(); }
        // clear previous sink widgets, and the arrangement they were in
        g_widgets.clear();
        if (g_gui_area && g_gui_area->layout()) {
            QLayoutItem* item;
            while ((item = g_gui_area->layout()->takeAt(0)) != nullptr) {
                if (item->widget()) item->widget()->deleteLater();
                delete item;
            }
        }
        // The banner outlives the arrangement now that it sits outside it, so a
        // run that gets further than the last one has to put it away itself.
        if (g_error_banner) g_error_banner->hide();

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
        g_scheduler_workers = 0;
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
            params["__name"] = name;
            BuiltBlock bb;
            if (is_variable_control(id)) {
                bb = variables.at(name).built;
            } else {
                bb = it->second(params);
            }
            if (bb.block)
                byname[name] = bb.block;
            ++nblocks;
            // Collected rather than placed: where a widget goes is decided once,
            // below, by the flowgraph's GUI Layout block.
            if (bb.widget) { g_widgets.push_back({ name, id, bb.widget }); ++nsinks; }

            // Bind parameters whose expression is exactly a Range variable ID.
            // GRC's common `frequency: freq` form now updates the live block.
            for (const auto& source_param : source_params.items()) {
                if (!source_param.value().is_string())
                    continue;
                const std::string variable_name =
                    source_param.value().get<std::string>();
                auto variable = variables.find(variable_name);
                auto setter = bb.numeric_setters.find(source_param.key());
                if (variable == variables.end() ||
                    setter == bb.numeric_setters.end())
                    continue;
                // A control that publishes nothing (Msg Push Button, whose value
                // is only ever the message's) has no subscriber list to join.
                if (variable->second.built.subscribe)
                    variable->second.built.subscribe(setter->second);
                // The controls are built before this loop, from *unresolved*
                // parameters, because that is the only order in which each one's
                // value is available to the others. So one referencing another
                // starts out showing the reference rather than the value: a QT
                // GUI Label reading `freq` says "freq" until the Range moves.
                // Push the resolved value through the same setter to settle it.
                if (is_variable_control(id) && params[source_param.key()].is_number())
                    setter->second(params[source_param.key()].get<double>());
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

        // Every widget exists now, so the window can be arranged. Done before
        // the graph is connected and started so the first frame a sink paints
        // lands where it belongs rather than being moved out from under itself.
        apply_gui_layout();
        publish_gui_layout(true);

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
        // This is exactly the list scheduler_tpb uses to create its one thread
        // per primitive block. Unlike the URL-time estimate it recursively
        // expands every instantiated hierarchy with its actual parameters.
        auto flat = g_tb->flatten();
        const int scheduler_workers = static_cast<int>(flat->calc_used_blocks().size());
        g_scheduler_workers = scheduler_workers;
        // Give diagnostics a sane timestamp while an upgraded tier is loading;
        // start_prepared_flowgraph resets it when sample processing begins.
        g_run_start = std::chrono::steady_clock::now();
        const int required_workers = scheduler_workers + 1; // detached tb->run()
        const int exact_tier = worker_tier_for(required_workers);
        const int selected_tier = EM_ASM_INT({ return globalThis.__grPoolTier || 16; });
        const int target_tier = std::max(selected_tier, exact_tier);
        const int allocated_workers = EM_ASM_INT({
            return PThread.unusedWorkers.length + PThread.runningWorkers.length;
        });
        const int missing_workers = std::max(0, target_tier - allocated_workers);

        std::string count_msg = "workers: calc_used_blocks() = " +
            std::to_string(scheduler_workers) + "; " +
            std::to_string(required_workers) + " required including flowgraph runner; tier " +
            std::to_string(selected_tier);
        if (target_tier != selected_tier)
            count_msg += " -> " + std::to_string(target_tier);
        post_info_to_editor(count_msg);

        g_pending_success_message = "blocks=" + std::to_string(nblocks) +
            " sinks=" + std::to_string(nsinks);
        const unsigned int generation = ++g_run_generation;
        if (missing_workers > 0) {
            post_info_to_editor("workers: preloading " +
                std::to_string(missing_workers) + " missing worker" +
                (missing_workers == 1 ? "" : "s") + " before scheduler start");
            preload_workers_then_start(target_tier, generation);
        } else {
            EM_ASM({ globalThis.__grPoolTier = $0; }, target_tier);
            start_prepared_flowgraph(generation);
        }
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

// ---- the JavaScript Block's source fetch ------------------------------------
// A JS block's factory reads its descriptor synchronously by evaluating the
// source, so unlike the Python Block there is nothing to instantiate ahead of
// time and nothing to await -- but a *repo* JS block's source is a file, and a
// constructor cannot fetch one. So the whole flowgraph waits once, here, for a
// few kilobytes of text.
//
// The one rule, which is also what makes a shared link work before a pull
// request merges: use the inline source when a block instance carries one,
// otherwise fetch by id.
static std::string g_js_pending_flowgraph;

static nlohmann::json js_sources_needed(const nlohmann::json& lowered) {
    std::set<std::string> wanted;
    for (const auto& b : lowered["blocks"]) {
        const std::string id = b.value("id", std::string());
        const auto entry = block_js_map().find(id);
        if (entry == block_js_map().end()) continue;
        const auto params = b.value("params", nlohmann::json::object());
        if (!params.value("_js_source", std::string()).empty()) continue;
        if (!params.value("_source_code", std::string()).empty()) continue;
        wanted.insert(id);
    }
    nlohmann::json request = nlohmann::json::array();
    for (const auto& id : wanted)
        request.push_back({ { "id", id }, { "file", block_js_map().at(id) } });
    return request;
}

static void prepare_python_then_run(const std::string& fgs);

static void fetch_js_sources_then_prepare(const std::string& fgs) {
    nlohmann::json request;
    try {
        request = js_sources_needed(nlohmann::json::parse(fgs));
    } catch (const std::exception& e) {
        report(false, std::string("JS Block error: ") + e.what());
        return;
    }
    if (request.empty()) {
        prepare_python_then_run(fgs);
        return;
    }
    g_js_pending_flowgraph = fgs;
    const std::string text = request.dump();
    // Same bridge shape as the Pyodide prepare step below: runner.html holds the
    // fetching, an EM_ASM body is the only thing that can see the module's
    // exports. NOTE the EM_ASM comma caveat -- the bridge is built field by field.
    EM_ASM({
        var bridge = {};
        bridge.finish = function(ok, payload) {
            var pointer = payload ? stringToNewUTF8(payload) : 0;
            _gr_finish_js_sources(ok ? 1 : 0, pointer);
            if (pointer) _free(pointer);
        };
        window.__grJsBridge = bridge;
        window.__grLoadJsBlockSources(UTF8ToString($0));
    }, text.c_str());
}

// Called back from runner.html with {block id: source} once every repo JS block
// the flowgraph uses has been fetched (or with the reason it could not be).
extern "C" EMSCRIPTEN_KEEPALIVE void gr_finish_js_sources(int ok, const char* payload) {
    const std::string fgs = std::move(g_js_pending_flowgraph);
    g_js_pending_flowgraph.clear();
    if (!ok) {
        report(false, payload && *payload ? payload
                                          : "JS Block: its source could not be fetched");
        return;
    }
    try {
        const auto sources = nlohmann::json::parse(payload ? payload : "{}");
        for (const auto& item : sources.items())
            set_js_block_source(item.key(), item.value().get<std::string>());
    } catch (const std::exception& e) {
        report(false, std::string("JS Block: unreadable source payload: ") + e.what());
        return;
    }
    prepare_python_then_run(fgs);
}

// ---- the Embedded Python Block's prepare step ------------------------------
// A Python Block's io signature, history and output multiple come from its own
// Python object -- and are needed *before* the C++ block is constructed, because
// GR sizes buffers at construction. The block's constructor cannot go and ask:
// it runs here on the browser main thread, which may not block.
//
// So the whole flowgraph waits once instead. Every Python Block is instantiated
// in the Pyodide worker before any C++ block is built, which also means the
// Python runtime's download and startup happen with the console pane visible and
// a failure is reported against the block that caused it.
static std::string g_python_pending_flowgraph;

// {scope: {variable: value}, blocks: [{name, source, params}]}, or no blocks at
// all when the flowgraph has none -- which is the overwhelmingly common case, and
// the one where nothing is fetched and nothing waits.
static nlohmann::json python_prepare_request(const nlohmann::json& lowered) {
    nlohmann::json blocks = nlohmann::json::array();
    for (const auto& b : lowered["blocks"]) {
        if (b.value("id", std::string()) != "epy_block") continue;
        const auto& params = b["params"];
        nlohmann::json values = nlohmann::json::object();
        for (const auto& item : params.items())
            if (item.key() != "_source_code" && item.key() != "_io_cache")
                values[item.key()] = item.value();
        nlohmann::json entry = nlohmann::json::object();
        entry["name"] = b.value("name", std::string());
        entry["source"] = params.value("_source_code", std::string());
        entry["params"] = std::move(values);
        blocks.push_back(std::move(entry));
    }
    nlohmann::json request = nlohmann::json::object();
    request["blocks"] = std::move(blocks);
    request["scope"] = lowered.value("variables", nlohmann::json::object());
    return request;
}

static void prepare_python_then_run(const std::string& fgs) {
    nlohmann::json request;
    try {
        request = python_prepare_request(nlohmann::json::parse(fgs));
    } catch (const std::exception& e) {
        report(false, std::string("Python Block error: ") + e.what());
        return;
    }
    if (request["blocks"].empty()) {
        run_now(fgs);
        return;
    }
    g_python_pending_flowgraph = fgs;
    const std::string text = request.dump();
    // The glue itself lives in runner.html, which is a far better place for 90
    // lines of worker plumbing than an EM_ASM string. But runner.html's scope
    // cannot see the module's exports or its memory -- only an EM_ASM body runs
    // inside the module scope -- so hand it both here, as a bridge object.
    //
    // NOTE the EM_ASM comma caveat (see notify_module above): arguments are split
    // on commas outside parentheses, so the bridge is built field by field rather
    // than as an object literal.
    EM_ASM({
        var bridge = {};
        bridge.memory = wasmMemory;
        bridge.finish = function(ok, message) {
            var pointer = message ? stringToNewUTF8(message) : 0;
            _gr_finish_pyodide_prepare(ok ? 1 : 0, pointer);
            if (pointer) _free(pointer);
        };
        window.__grPyodideBridge = bridge;
        window.__grPyodidePrepare(UTF8ToString($0));
    }, text.c_str());
}

// Called back from runner.html once the worker has instantiated every Python
// Block (or failed to). Mirrors gr_finish_worker_preload above.
extern "C" EMSCRIPTEN_KEEPALIVE void gr_finish_pyodide_prepare(int ok, const char* message) {
    const std::string fgs = std::move(g_python_pending_flowgraph);
    g_python_pending_flowgraph.clear();
    if (!ok) {
        report(false, std::string("Python Block: ") +
                          (message && *message ? message : "the Python runtime failed to start"));
        return;
    }
    run_now(fgs);
}

static void load_next(LoadCtx* ctx) {
    while (ctx->idx < ctx->mods.size() && g_loaded_modules.count(ctx->mods[ctx->idx]))
        ++ctx->idx;  // already fetched in a previous run
    if (ctx->idx >= ctx->mods.size()) {
        const std::string fgs = std::move(ctx->fgs);
        delete ctx;
        fetch_js_sources_then_prepare(fgs);   // ... then the Python prepare step
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
    out["dsp_threads"] = g_scheduler_workers;
    // runner.html selects this before Emscripten initializes its worker pool.
    // Read the same value here so diagnostics report the active tier rather
    // than duplicating a build-time constant that can drift from the runtime.
    out["pool"] = EM_ASM_INT({
        return (typeof globalThis.__grPoolTier === 'number')
            ? globalThis.__grPoolTier : 16;
    });

    auto vmax = [](const std::vector<float>& v) {
        return v.empty() ? 0.0f : *std::max_element(v.begin(), v.end());
    };

    nlohmann::json arr = nlohmann::json::array();
    for (auto& sb : g_stats) {
        nlohmann::json b;
        b["name"] = sb.name;
        b["id"] = sb.id;
        b["ref"] = sb.is_ref;
        // Message-only blocks (no stream port on either side: PDU croppers, CRC
        // checkers, framers) have no item counter at all, so "items" below stays
        // 0 for them however well they are working. Flag them so consumers can
        // tell "moved nothing" apart from "has nothing to count".
        b["msg_only"] = !sb.has_out && !sb.has_in;
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

    // The flowgraph fills the whole runner tab: no title bar, no frame, nothing
    // to drag or resize. Where a widget goes is the GUI Layout block's business
    // (see docs/gui-layout.md), so a window inside the tab would only be a
    // second, weaker way to arrange the same widgets -- and it wasted the
    // margin around itself. Qt's WASM platform draws its non-client area from
    // these flags plus the window state: frameless *and* full screen, so
    // neither the title bar nor the resize handles are created.
    const Qt::WindowFlags window_flags = Qt::Window | Qt::FramelessWindowHint;
    g_container = new QWidget(nullptr, window_flags);
    // Never shown (there is no title bar), but Qt uses it for the window's
    // accessible name.
    g_container->setWindowTitle(QStringLiteral("GNU Radio Flowgraph"));
    // No minimum: the window tracks the browser tab, and a floor larger than a
    // narrow phone-sized tab would push the arrangement off the right edge.
    g_container->setMinimumSize(0, 0);
    g_container->setMaximumSize(QWIDGETSIZE_MAX, QWIDGETSIZE_MAX);
    // The window's own layout never changes: an error banner may be inserted
    // above, and everything else happens inside g_gui_area, whose layout each
    // run replaces with the arrangement its GUI Layout block asks for.
    auto* outer = new QVBoxLayout(g_container);
    outer->setContentsMargins(0, 0, 0, 0);
    outer->setSpacing(0);
    // ... and the layout must not put that minimum back. A layout on a *window*
    // defaults to SetDefaultConstraint, which on every activate() copies its
    // total minimum size onto the window -- and setMinimumSize() grows a window
    // that is smaller than the new floor. So the moment a run adds widgets, the
    // arrangement's minimum (each grid row is `row_height` tall, plus whatever
    // the plots ask for) resized this frameless full-screen window taller than
    // the tab and the bottom row fell off the bottom of the page. Nothing pulled
    // it back, because the only thing that re-applies the screen geometry to a
    // full-screen window is a screen-geometry *change* -- which is why the
    // arrangement snapped into place as soon as the browser window was resized
    // and looked cut off until then. With no constraint the window stays the
    // size the browser gave it and the grid squeezes into it, which is exactly
    // the state a resize used to produce. setMinimumSize(0, 0) above does not
    // prevent this: an explicit *zero* minimum is indistinguishable from having
    // set none at all, so the layout is free to overwrite it.
    outer->setSizeConstraint(QLayout::SetNoConstraint);
    g_gui_area = new QWidget(g_container);
    outer->addWidget(g_gui_area, 1);

    // The QScreen is the browser-backed canvas, so its geometry is the tab.
    // showFullScreen() both sizes the window to it and keeps it sized to it:
    // Qt resizes full-screen windows itself whenever the screen geometry
    // changes, which is what a browser resize looks like from here.
    g_container->setGeometry(app.primaryScreen()->geometry());
    g_container->showFullScreen();
    // Editor passes the flowgraph via the URL hash; fall back to the embedded demo.
    char* fg = flowgraph_from_url();
    std::string fgs = fg ? fg : kEmbeddedFlowgraph;
    if (fg) free(fg);
    // Defer the first run until the Qt event loop is running, so GR's worker
    // creation is serviced by the main loop (see gr_run_json).
    QTimer::singleShot(0, [fgs] { gr_run_json(fgs.c_str()); });

    // Publish diagnostics to window.__grstats ~3 Hz for the panel (diag.js).
    static QTimer stats_timer;
    static QSize last_gui_area_size;
    QObject::connect(&stats_timer, &QTimer::timeout, [] {
        publish_stats();
        // apply_gui_layout()'s row-height scaling (above) is a function of the
        // window size it was last called with, so a resize after the run
        // started -- there's no resizeEvent hook here, see the QScreen comment
        // above main() -- needs a re-layout, not just a re-publish. Only on an
        // actual size change: apply_gui_layout() rebuilds the whole grid, which
        // would be wasted work at 3 Hz otherwise.
        if (g_gui_area && g_gui_area->size() != last_gui_area_size) {
            last_gui_area_size = g_gui_area->size();
            apply_gui_layout();
        }
        // Cheap: it posts only when the arrangement or the window's geometry
        // actually changed, which is the only way the editor's Arrange overlay
        // hears about the browser tab being resized.
        publish_gui_layout(false);
    });
    stats_timer.start(333);

    return app.exec();
}
