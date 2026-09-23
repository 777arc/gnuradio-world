/* -*- c++ -*- */
// How every Qwt plot in the browser paints its canvas.
//
// Qwt's default is a full-canvas backing pixmap: the plot renders into a QPixmap
// the size of the canvas and blits that on each paint event. Two things are wrong
// with it here.
//
// It is expensive. Recreating and blitting a canvas-sized pixmap costs real time
// on the browser canvas, and a live sink repaints at its update rate rather than
// on expose, so the cache buys nothing it does not also pay for.
//
// And it is a correctness problem. QwtPlotCanvas::backingStore() leaves the new
// pixmap *uninitialized* when the canvas carries WA_OpaquePaintEvent, on the
// assumption that the repaint which follows covers every one of its pixels — but
// that repaint is clipped to the paint event's region. A partial region arriving
// on the resize that reallocated the pixmap leaves the rest of it holding
// whatever the WASM heap held, and the canvas blits that and then draws the grid
// and the trace on top. What the reader sees is a rectangle of garbage — bands of
// black and dithered color, sheared diagonally the way a wrong row stride shears
// an image — in a corner of an otherwise working plot, with the plot's own grid
// lines running across it. It does not clear on resize, because once the pixmap
// is the right size Qwt stops recreating it.
//
// So: no backing store, and paint immediately rather than through the browser's
// deferred paint queue. Every QwtPlot this project puts on screen should go
// through here — the nine DisplayPlot subclasses via their shared base, and the
// four plots that are built as bare QwtPlots instead (Matrix Sink, gr-inspector's
// GUI sink, and gr-radar's time / scatter / spectrogram widgets).
//
// Included from the gr-qtgui sources the qtgui/ build compiles, guarded there by
// __EMSCRIPTEN__ so the desktop build keeps Qwt's own behavior, and from the
// browser-only rebuilds under blocks/overlays/, which have no desktop build.

#ifndef WASM_QTGUI_PLOT_CANVAS_HPP
#define WASM_QTGUI_PLOT_CANVAS_HPP

#include <qwt_plot.h>
#include <qwt_plot_canvas.h>

namespace wasm_qtgui {

/*!
 * \brief Put \p plot's canvas on the browser's paint settings.
 *
 * Safe on a plot whose canvas is not a QwtPlotCanvas (Qwt allows any QWidget
 * there): such a canvas has no paint attributes and is left alone.
 */
inline void configure_plot_canvas(QwtPlot* plot)
{
    if (plot == nullptr)
        return;
    if (auto* canvas = qobject_cast<QwtPlotCanvas*>(plot->canvas())) {
        canvas->setPaintAttribute(QwtPlotCanvas::ImmediatePaint, true);
        canvas->setPaintAttribute(QwtPlotCanvas::BackingStore, false);
    }
}

} // namespace wasm_qtgui

#endif // WASM_QTGUI_PLOT_CANVAS_HPP
