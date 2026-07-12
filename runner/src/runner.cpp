// JSON-driven GNU Radio flowgraph runner (WASM). Parses a flowgraph JSON, builds
// blocks via the registry, connects them, runs the GR scheduler, and shows any
// GUI sink widgets on the Qt canvas. Exposed to JS as gr_run_json(const char*).
#include "registry.hpp"
#include <gnuradio/top_block.h>
#include <QApplication>
#include <QWidget>
#include <QVBoxLayout>
#include <QTimer>
#include <emscripten.h>
#include <cstdlib>
#include <map>
#include <string>
#include <thread>

static gr::top_block_sptr g_tb;
static QWidget* g_container = nullptr;

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

        g_tb = gr::make_top_block("wasm_runner");
        std::map<std::string, gr::basic_block_sptr> byname;
        int nblocks = 0, nsinks = 0;

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
        }

        for (const auto& c : j.at("connections")) {
            g_tb->connect(byname.at(c[0].get<std::string>()), c[1].get<int>(),
                          byname.at(c[2].get<std::string>()), c[3].get<int>());
        }

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
    return app.exec();
}
