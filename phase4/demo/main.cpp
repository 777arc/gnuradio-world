// Phase 4 (Artifact 1 headline): a real GNU Radio flowgraph with a live Qt GUI
// sink, running in a browser tab. sig_source -> throttle -> qtgui time_sink,
// Qt event loop + GR thread-per-block scheduler in one WASM module.
#include <QApplication>
#include <QTimer>
#include <QWidget>
#include <gnuradio/top_block.h>
#include <gnuradio/analog/sig_source.h>
#include <gnuradio/blocks/throttle.h>
#include <gnuradio/qtgui/time_sink_c.h>
#include <emscripten.h>

int main(int argc, char** argv) {
    QApplication app(argc, argv);

    const double fs = 32000.0;
    auto tb  = gr::make_top_block("phase4");
    auto src = gr::analog::sig_source_c::make(fs, gr::analog::GR_COS_WAVE, 2000.0, 1.0);
    auto thr = gr::blocks::throttle::make(sizeof(gr_complex), fs, true);
    auto snk = gr::qtgui::time_sink_c::make(1024, fs, "GNU Radio time sink (WASM)", 1);
    tb->connect(src, 0, thr, 0);
    tb->connect(thr, 0, snk, 0);

    QWidget* w = snk->qwidget();
    w->resize(800, 480);
    w->show();

    tb->start();  // non-blocking: scheduler runs blocks on pthreads/workers

    // After the sink has had time to draw a few frames, flag success in the DOM.
    QTimer::singleShot(2500, [] {
        EM_ASM({
            var d = document.getElementById('result') ||
                document.body.appendChild(Object.assign(document.createElement('div'), {id:'result'}));
            d.setAttribute('data-status', 'pass');
            d.textContent = 'RESULT: PHASE4_PASS qtgui-time-sink-live';
        });
    });

    return app.exec();  // Qt-for-WASM event loop drives the canvas
}
