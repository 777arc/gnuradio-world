/* -*- c++ -*- */
// A Qwt plot's title, drawn inside the canvas instead of above it.
//
// Qwt puts QwtPlot::setTitle() in a label widget stacked on top of the canvas,
// which is the right place on a desktop window and the wrong one here: a sink is
// one tile of the runner's grid layout, so every pixel the title takes is a pixel
// the trace loses, and a row of tiles ends up with plots of unequal heights
// depending on which of them happen to be named. Drawing the title as a
// QwtPlotTextLabel keeps the canvas the same size whether a plot is titled or not.
//
// Included from the gr-qtgui sources the qtgui/ build compiles (displayform.cc for
// every DisplayForm-based sink, matrix_display.cc for the Matrix Sink), guarded
// there by __EMSCRIPTEN__ so the desktop build keeps Qwt's own title widget.

#ifndef WASM_QTGUI_PLOT_TITLE_HPP
#define WASM_QTGUI_PLOT_TITLE_HPP

#include <QBrush>
#include <QColor>
#include <QFont>
#include <QRectF>
#include <QSizeF>
#include <QString>
#include <qwt_plot.h>
#include <qwt_plot_item.h>
#include <qwt_plot_textlabel.h>
#include <qwt_text.h>

namespace wasm_qtgui {

//! Padding, in pixels, between the title text and the edges of the plate behind it.
inline constexpr double title_padding_x = 8.0;
inline constexpr double title_padding_y = 4.0;
//! Distance from the title to the top edge of the canvas.
inline constexpr int title_margin = 6;

/*!
 * The title item. QwtPlotTextLabel would size the plate the background brush
 * fills to the text alone; textRect() is overridden to inflate it, which is what
 * lets the text be centered inside a plate with even padding on all four sides
 * (the base class aligns text by the same render flags it positions the label
 * with, so padding cannot come from the flags themselves).
 */
class CanvasTitle : public QwtPlotTextLabel
{
public:
    QRectF textRect(const QRectF& rect, const QSizeF& textSize) const override
    {
        const double w = qMin(textSize.width() + 2 * title_padding_x, rect.width());
        const double h = qMin(textSize.height() + 2 * title_padding_y, rect.height());
        return QRectF(rect.center().x() - w / 2.0, rect.top(), w, h);
    }
};

/*!
 * \brief Show \p title centered along the top of \p plot's canvas, or remove the
 * title if \p title is empty.
 *
 * Safe to call repeatedly: each call replaces whatever the previous one attached,
 * which is what the sinks' set_title() and the plot's own Title menu item do.
 */
inline void set_canvas_title(QwtPlot* plot, const QString& title)
{
    if (plot == nullptr)
        return;

    // Never both: Qwt's title widget stays empty so the canvas keeps its height.
    plot->setTitle(QwtText());
    const QwtPlotItemList existing = plot->itemList(QwtPlotItem::Rtti_PlotTextLabel);
    for (QwtPlotItem* item : existing) {
        item->detach();
        delete item;
    }

    if (title.trimmed().isEmpty()) {
        plot->replot();
        return;
    }

    // The canvas background is what the text is read against on a line plot; on a
    // waterfall or raster the image covers it, so the title gets a plate of that
    // same background color to sit on rather than being drawn straight onto the
    // colormap, where a dark palette would swallow it.
    const QColor background =
        plot->canvas()->palette().color(plot->canvas()->backgroundRole());
    QColor plate = background;
    plate.setAlpha(200);

    QwtText text(title);
    text.setRenderFlags(Qt::AlignHCenter | Qt::AlignTop);
    text.setColor(background.lightness() > 127 ? Qt::black : Qt::white);
    text.setBackgroundBrush(QBrush(plate));
    text.setBorderRadius(4.0);

    QFont font = plot->font();
    font.setBold(true);
    if (font.pointSize() > 0)
        font.setPointSize(font.pointSize() + 1);
    text.setFont(font);

    auto* label = new CanvasTitle();
    label->setText(text);
    label->setMargin(title_margin);
    // Above the curves, the grid and the spectrogram images, all of which use the
    // small z values Qwt hands out by default.
    label->setZ(1000.0);
    label->attach(plot);
    plot->replot();
}

} // namespace wasm_qtgui

#endif // WASM_QTGUI_PLOT_TITLE_HPP
