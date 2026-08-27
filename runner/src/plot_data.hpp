#pragma once

// What a GUI sink is *plotting*, as numbers.
//
// Every Qt GUI sink in this build ends in a QwtPlot, and Qwt's plot dictionary
// is public API: the curves attached to a plot can be enumerated and their
// series sampled without touching gr-qtgui's internals. So the numbers behind a
// trace are readable from outside the sink, with the axis titles and units the
// display itself is using — no upstream patch, and nothing per sink type. A
// screenshot answers "does this look right"; this answers "where exactly is the
// peak", which pixels are a poor instrument for.
//
// Read on the Qt main thread only. The sinks repaint from their own timers on
// that same thread, so a read from there sees a whole frame and never races a
// half-written curve. runner.cpp calls this from the export the editor drives,
// which the browser main thread — the Qt main thread here — is what runs.

#include <nlohmann/json.hpp>

#include <QLabel>
#include <QString>
#include <QWidget>
#include <qwt_axis.h>
#include <qwt_plot.h>
#include <qwt_plot_curve.h>
#include <qwt_plot_item.h>
#include <qwt_scale_div.h>
#include <qwt_text.h>

#include <algorithm>
#include <cmath>
#include <string>
#include <vector>

namespace plot_data {

// One GUI widget this run built, named as the flowgraph names it.
struct Target {
    std::string name;
    std::string id;
    QWidget* widget = nullptr;
};

namespace detail {

// A curve carries far more precision than anything reading this can use, and
// every extra digit is a token. Six significant digits keeps a frequency in Hz
// exact enough to name a bin and a dB value exact enough to compare two peaks.
inline nlohmann::json number(double value)
{
    if (!std::isfinite(value))
        return nullptr;
    if (value == 0.0)
        return 0.0;
    const double magnitude = std::pow(10.0, 6 - 1 - std::floor(std::log10(std::fabs(value))));
    return std::round(value * magnitude) / magnitude;
}

inline std::string text_of(const QwtText& text)
{
    return text.text().trimmed().toStdString();
}

// Qwt's own axis range, which is what the plot is *showing* — not the extent of
// the data. For a frequency sink they differ whenever autoscale is off, and the
// difference is the interesting part: a trace pinned to the top of the axis is
// clipped, not flat.
inline nlohmann::json axis_json(const QwtPlot* plot, QwtAxisId axis)
{
    nlohmann::json out;
    const std::string title = text_of(plot->axisTitle(axis));
    if (!title.empty())
        out["title"] = title;
    const QwtScaleDiv& div = plot->axisScaleDiv(axis);
    out["min"] = number(div.lowerBound());
    out["max"] = number(div.upperBound());
    return out;
}

inline nlohmann::json curve_json(const QwtPlotCurve* curve, int max_points)
{
    nlohmann::json out;
    const std::string label = text_of(curve->title());
    if (!label.empty())
        out["label"] = label;
    if (!curve->isVisible())
        out["visible"] = false;

    const int count = static_cast<int>(curve->dataSize());
    out["points"] = count;
    if (count <= 0)
        return out;

    double x_min = 0, x_max = 0, y_min = 0, y_max = 0, y_sum = 0;
    double peak_x = 0, peak_y = 0;
    bool first = true;
    for (int i = 0; i < count; ++i) {
        const QPointF point = curve->sample(i);
        if (!std::isfinite(point.x()) || !std::isfinite(point.y()))
            continue;
        if (first) {
            x_min = x_max = point.x();
            y_min = y_max = peak_y = point.y();
            peak_x = point.x();
            first = false;
        }
        x_min = std::min(x_min, point.x());
        x_max = std::max(x_max, point.x());
        y_min = std::min(y_min, point.y());
        if (point.y() > y_max) {
            y_max = point.y();
            peak_x = point.x();
            peak_y = point.y();
        }
        y_sum += point.y();
    }
    if (first)      // every sample was NaN: a sink that has not drawn yet
        return out;

    out["x"] = { { "min", number(x_min) }, { "max", number(x_max) } };
    out["y"] = { { "min", number(y_min) }, { "max", number(y_max) },
                 { "mean", number(y_sum / count) } };
    // The whole point of reading numbers rather than pixels: where the largest
    // value actually is, to the resolution the sink computed it at.
    out["peak"] = { { "x", number(peak_x) }, { "y", number(peak_y) } };

    // Decimated rather than enveloped: a caller comparing two runs wants real
    // samples at known abscissae, and the extremes are already reported above.
    const int stride = std::max(1, (count + max_points - 1) / max_points);
    nlohmann::json samples = nlohmann::json::array();
    for (int i = 0; i < count; i += stride) {
        const QPointF point = curve->sample(i);
        samples.push_back({ number(point.x()), number(point.y()) });
    }
    out["samples"] = std::move(samples);
    if (stride > 1)
        out["sample_stride"] = stride;
    return out;
}

// Everything that is not a Qwt plot at all. Number Sink and the browser gauges
// are QLabels, and their text is the whole of what they display.
inline nlohmann::json labels_json(QWidget* widget)
{
    nlohmann::json out = nlohmann::json::array();
    for (const QLabel* label : widget->findChildren<QLabel*>()) {
        const QString text = label->text().trimmed();
        if (text.isEmpty() || out.size() >= 12)
            continue;
        out.push_back(text.left(120).toStdString());
    }
    return out;
}

} // namespace detail

// `only` selects one widget by flowgraph name; empty reads them all.
inline std::string to_json(const std::vector<Target>& targets,
                           const std::string& only,
                           int max_points)
{
    max_points = std::clamp(max_points, 4, 256);
    nlohmann::json widgets = nlohmann::json::array();
    bool matched = false;

    for (const Target& target : targets) {
        if (!target.widget)
            continue;
        if (!only.empty() && target.name != only)
            continue;
        matched = true;

        nlohmann::json entry;
        entry["name"] = target.name;
        entry["id"] = target.id;

        const QList<QwtPlot*> plots = target.widget->findChildren<QwtPlot*>();
        if (plots.isEmpty()) {
            nlohmann::json labels = detail::labels_json(target.widget);
            entry["kind"] = "labels";
            if (!labels.empty())
                entry["labels"] = std::move(labels);
            else
                entry["note"] = "this widget displays nothing this can read as numbers";
            widgets.push_back(std::move(entry));
            continue;
        }

        const QwtPlot* plot = plots.first();
        entry["x_axis"] = detail::axis_json(plot, QwtAxis::XBottom);
        entry["y_axis"] = detail::axis_json(plot, QwtAxis::YLeft);

        nlohmann::json curves = nlohmann::json::array();
        for (const QwtPlotItem* item : plot->itemList(QwtPlotItem::Rtti_PlotCurve)) {
            curves.push_back(
                detail::curve_json(static_cast<const QwtPlotCurve*>(item), max_points));
        }
        if (curves.empty()) {
            // A waterfall is a QwtPlotSpectrogram: a raster of a scrolling
            // history rather than a series, with no curve to sample. Its axes
            // are still worth reporting, and the frequency sink beside it —
            // where there is one — carries the same spectrum as numbers.
            entry["kind"] = "raster";
            entry["note"] = "this sink draws a raster (waterfall/time raster); "
                            "only its axes are readable as numbers";
        } else {
            entry["kind"] = "curves";
            entry["curves"] = std::move(curves);
        }
        widgets.push_back(std::move(entry));
    }

    nlohmann::json out;
    out["widgets"] = std::move(widgets);
    if (!only.empty() && !matched)
        out["error"] = "no GUI widget named \"" + only + "\" is running";
    return out.dump();
}

} // namespace plot_data
