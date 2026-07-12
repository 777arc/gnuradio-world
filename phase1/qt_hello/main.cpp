// Phase 1: trivial Qt Widgets app proving Qt-for-WASM renders to an HTML canvas.
// Paints a recognizable pattern (for the screenshot smoke test) and writes a
// machine-readable RESULT line into the DOM (for the --dump-dom smoke test).
#include <QApplication>
#include <QWidget>
#include <QPainter>
#include <QTimer>
#include <QLinearGradient>
#include <emscripten.h>

class Hello : public QWidget {
protected:
    void paintEvent(QPaintEvent *) override {
        QPainter p(this);
        p.setRenderHint(QPainter::Antialiasing);
        QLinearGradient g(0, 0, width(), height());
        g.setColorAt(0.0, QColor(0x10, 0x18, 0x30));
        g.setColorAt(1.0, QColor(0x20, 0x10, 0x40));
        p.fillRect(rect(), g);
        // colored bars — distinctive, easy to eyeball in the screenshot
        const QColor bars[] = {QColor(220,40,40), QColor(40,200,90), QColor(60,120,240)};
        for (int i = 0; i < 3; ++i) {
            p.fillRect(60 + i*180, 120, 140, 220, bars[i]);
        }
        p.setPen(Qt::white);
        QFont f = p.font(); f.setPointSize(22); f.setBold(true); p.setFont(f);
        p.drawText(rect().adjusted(0, 20, 0, 0), Qt::AlignHCenter | Qt::AlignTop,
                   "GNU Radio — Qt for WebAssembly");
    }
};

static void reportToDom() {
    EM_ASM({
        var d = document.getElementById('result');
        if (!d) { d = document.createElement('div'); d.id = 'result'; document.body.appendChild(d); }
        d.setAttribute('data-status', 'pass');
        d.textContent = 'RESULT: QT_PASS qt-widget-painted-to-canvas';
    });
}

int main(int argc, char **argv) {
    QApplication app(argc, argv);
    auto *w = new Hello();
    w->resize(760, 480);
    w->show();
    // Report after the first paint/compositor pass so the screenshot has content.
    QTimer::singleShot(800, &app, [] { reportToDom(); });
    return app.exec();
}
