#include "radar_plots.hpp"

#include <gnuradio/io_signature.h>

#include <QColor>
#include <QPen>
#include <QPointF>
#include <QSize>
#include <QTimer>
#include <QVBoxLayout>
#include <QVector>
#include <QWidget>

#include <qwt_axis.h>
#include <qwt_color_map.h>
#include <qwt_interval.h>
#include <qwt_matrix_raster_data.h>
#include <qwt_plot.h>
#include <qwt_plot_grid.h>
#include <qwt_plot_marker.h>
#include <qwt_plot_spectrogram.h>
#include <qwt_scale_widget.h>
#include <qwt_symbol.h>
#include <qwt_text.h>

#include <algorithm>
#include <cmath>
#include <cstring>
#include <utility>

namespace {

// A refresh period a browser can actually keep up with. GRC's own gr-radar
// examples ask for 30..250 ms; a flowgraph asking for 0 would otherwise pin the
// GUI thread with back-to-back replots and starve every other sink.
constexpr int kMinInterval = 30;

int refresh_interval(int interval) { return std::max(interval, kMinInterval); }

// Both axis parameters are a [min, max] pair. Upstream indexes them blind, so a
// flowgraph that leaves one empty takes the runtime down; fall back instead.
std::pair<double, double> axis_range(const std::vector<float>& axis,
                                     double low,
                                     double high)
{
    if (axis.size() < 2)
        return { low, high };
    return { axis[0], axis[1] };
}

// gr-radar's estimate message is a list of (symbol, f32vector) pairs -- one per
// estimated quantity, keyed by the name the plot's Label parameter names. See
// the identical loop in every gr-radar consumer, e.g. print_results_impl.cc.
bool estimate_for(const pmt::pmt_t& msg, const std::string& key,
                  std::vector<float>& out)
{
    // Upstream indexes the message blind and lets pmt throw out of the handler
    // on anything else; check instead, so wiring a plot to some other block's
    // port is an empty plot rather than a dead flowgraph.
    if (!pmt::is_pair(msg))
        return false;
    const std::size_t count = pmt::length(msg);
    for (std::size_t k = 0; k < count; ++k) {
        const pmt::pmt_t part = pmt::nth(k, msg);
        if (!pmt::is_pair(part) || pmt::length(part) < 2 ||
            !pmt::is_symbol(pmt::nth(0, part)))
            continue;
        if (pmt::symbol_to_string(pmt::nth(0, part)) != key)
            continue;
        const pmt::pmt_t value = pmt::nth(1, part);
        if (!pmt::is_f32vector(value))
            return false;
        out = pmt::f32vector_elements(value);
        return true;
    }
    return false;
}

// The plot proper, in a container the GUI Layout grid can size freely. Upstream
// hard-codes a 600x600 window and repositions the QwtPlot from resizeEvent();
// here the tile decides the size and a layout follows it.
QWidget* make_plot_container(QwtPlot*& plot, const std::string& title)
{
    auto* widget = new QWidget;
    plot = new QwtPlot(widget);
    plot->setTitle(QwtText(QString::fromStdString(title)));

    auto* grid = new QwtPlotGrid;
    grid->setPen(QPen(QColor(119, 136, 153), 0.5, Qt::DashLine));
    grid->attach(plot);

    auto* layout = new QVBoxLayout(widget);
    layout->setContentsMargins(0, 0, 0, 0);
    layout->addWidget(plot);
    widget->setMinimumSize(240, 180);
    return widget;
}

// Upstream's dark-cyan..red ramp. Qwt takes ownership of every colour map it is
// handed, so this returns a fresh one per call rather than sharing an instance.
QwtLinearColorMap* colour_map()
{
    auto* map = new QwtLinearColorMap(Qt::darkCyan, Qt::red);
    map->addColorStop(0.25, Qt::cyan);
    map->addColorStop(0.50, Qt::green);
    map->addColorStop(0.75, Qt::yellow);
    return map;
}

std::string titled(const std::string& prefix, const std::string& axes,
                   const std::string& label)
{
    std::string title = prefix + axes;
    if (!label.empty())
        title += " (" + label + ")";
    return title;
}

}  // namespace

// ---------------------------------------------------------------------------
// Time plot
// ---------------------------------------------------------------------------

RadarTimePlotWasm::sptr RadarTimePlotWasm::make(int interval,
                                                const std::string& label_y,
                                                const std::vector<float>& axis_y,
                                                float range_time,
                                                const std::string& label)
{
    return gnuradio::make_block_sptr<RadarTimePlotWasm>(
        interval, label_y, axis_y, range_time, label);
}

RadarTimePlotWasm::RadarTimePlotWasm(int interval,
                                     const std::string& label_y,
                                     const std::vector<float>& axis_y,
                                     float range_time,
                                     const std::string& label)
    : gr::block("qtgui_time_plot",
                gr::io_signature::make(0, 0, 0),
                gr::io_signature::make(0, 0, 0)),
      d_label_y(label_y),
      d_interval(refresh_interval(interval)),
      d_range_time(range_time > 0.0F ? range_time : 1.0F)
{
    d_widget = make_plot_container(d_plot, titled("Time Plot: ", label_y, label));
    const auto y = axis_range(axis_y, 0.0, 1.0);
    d_plot->setAxisScale(QwtAxis::XBottom, 0, d_range_time);
    d_plot->setAxisTitle(QwtAxis::XBottom, QwtText(QStringLiteral("time")));
    d_plot->setAxisScale(QwtAxis::YLeft, y.first, y.second);
    d_plot->setAxisTitle(QwtAxis::YLeft, QwtText(QString::fromStdString(label_y)));
    d_plot->replot();

    d_symbol = new QwtSymbol(QwtSymbol::Diamond, Qt::red, Qt::NoPen, QSize(9, 9));
    // One marker row per tick in the visible window, reused as it scrolls off --
    // upstream's ring, which is what bounds the marker count on a long run.
    d_marker.resize(std::max<std::size_t>(
        1, static_cast<std::size_t>(d_range_time / d_interval * 1000.0F)));

    auto* timer = new QTimer(d_widget);
    QObject::connect(timer, &QTimer::timeout, d_widget, [this] { refresh(); });
    timer->start(d_interval);

    message_port_register_in(pmt::mp("Msg in"));
    set_msg_handler(pmt::mp("Msg in"), [this](pmt::pmt_t msg) { handle(msg); });
}

void RadarTimePlotWasm::handle(const pmt::pmt_t& msg)
{
    std::vector<float> y;
    if (!estimate_for(msg, d_label_y, y))
        return;
    std::lock_guard<std::mutex> lock(d_mutex);
    d_y = std::move(y);
    d_fresh = true;
}

void RadarTimePlotWasm::refresh()
{
    const double now = d_refresh_counter * double(d_interval) / 1000.0;
    if (now >= d_range_time)
        d_plot->setAxisScale(QwtAxis::XBottom, now - d_range_time, now);

    // Detach whatever this row drew one window ago before reusing it.
    const std::size_t row = d_refresh_counter % d_marker.size();
    for (QwtPlotMarker* marker : d_marker[row])
        marker->detach();

    std::vector<float> y;
    {
        std::lock_guard<std::mutex> lock(d_mutex);
        if (d_fresh) {
            y = d_y;
            d_fresh = false;
        }
    }
    for (std::size_t k = 0; k < y.size(); ++k) {
        if (k >= d_marker[row].size()) {
            auto* marker = new QwtPlotMarker;
            marker->setSymbol(d_symbol);
            d_marker[row].push_back(marker);
        }
        d_marker[row][k]->setValue(QPointF(now, y[k]));
        d_marker[row][k]->attach(d_plot);
    }

    d_plot->replot();
    ++d_refresh_counter;
}

// ---------------------------------------------------------------------------
// Scatter plot
// ---------------------------------------------------------------------------

RadarScatterPlotWasm::sptr RadarScatterPlotWasm::make(int interval,
                                                      const std::string& label_x,
                                                      const std::string& label_y,
                                                      const std::vector<float>& axis_x,
                                                      const std::vector<float>& axis_y,
                                                      const std::string& label)
{
    return gnuradio::make_block_sptr<RadarScatterPlotWasm>(
        interval, label_x, label_y, axis_x, axis_y, label);
}

RadarScatterPlotWasm::RadarScatterPlotWasm(int interval,
                                           const std::string& label_x,
                                           const std::string& label_y,
                                           const std::vector<float>& axis_x,
                                           const std::vector<float>& axis_y,
                                           const std::string& label)
    : gr::block("qtgui_scatter_plot",
                gr::io_signature::make(0, 0, 0),
                gr::io_signature::make(0, 0, 0)),
      d_label_x(label_x),
      d_label_y(label_y)
{
    d_widget = make_plot_container(
        d_plot, titled("Scatter Plot: ", label_x + "/" + label_y, label));
    const auto x = axis_range(axis_x, 0.0, 1.0);
    const auto y = axis_range(axis_y, 0.0, 1.0);
    d_plot->setAxisScale(QwtAxis::XBottom, x.first, x.second);
    d_plot->setAxisTitle(QwtAxis::XBottom, QwtText(QString::fromStdString(label_x)));
    d_plot->setAxisScale(QwtAxis::YLeft, y.first, y.second);
    d_plot->setAxisTitle(QwtAxis::YLeft, QwtText(QString::fromStdString(label_y)));
    d_plot->replot();

    d_symbol = new QwtSymbol(QwtSymbol::Diamond, Qt::red, Qt::NoPen, QSize(12, 12));

    auto* timer = new QTimer(d_widget);
    QObject::connect(timer, &QTimer::timeout, d_widget, [this] { refresh(); });
    timer->start(refresh_interval(interval));

    message_port_register_in(pmt::mp("Msg in"));
    set_msg_handler(pmt::mp("Msg in"), [this](pmt::pmt_t msg) { handle(msg); });
}

void RadarScatterPlotWasm::handle(const pmt::pmt_t& msg)
{
    std::vector<float> x, y;
    const bool found_x = estimate_for(msg, d_label_x, x);
    const bool found_y = estimate_for(msg, d_label_y, y);
    if (!found_x && !found_y)
        return;
    // With only one of the pair present, plot it against zero -- upstream's
    // behaviour, and what makes a range-only estimator still show something.
    if (!found_x)
        x.assign(y.size(), 0.0F);
    if (!found_y)
        y.assign(x.size(), 0.0F);

    std::lock_guard<std::mutex> lock(d_mutex);
    d_x = std::move(x);
    d_y = std::move(y);
    d_fresh = true;
}

void RadarScatterPlotWasm::refresh()
{
    std::vector<float> x, y;
    {
        std::lock_guard<std::mutex> lock(d_mutex);
        if (!d_fresh)
            return;
        d_fresh = false;
        x = d_x;
        y = d_y;
    }
    // A scatter plot shows one estimate at a time, so every previous marker goes.
    for (QwtPlotMarker* marker : d_marker)
        marker->detach();

    const std::size_t count = std::min(x.size(), y.size());
    for (std::size_t k = 0; k < count; ++k) {
        if (k >= d_marker.size()) {
            auto* marker = new QwtPlotMarker;
            marker->setSymbol(d_symbol);
            d_marker.push_back(marker);
        }
        d_marker[k]->setValue(QPointF(x[k], y[k]));
        d_marker[k]->attach(d_plot);
    }
    d_plot->replot();
}

// ---------------------------------------------------------------------------
// Spectrogram plot
// ---------------------------------------------------------------------------

RadarSpectrogramPlotWasm::sptr
RadarSpectrogramPlotWasm::make(int vlen,
                               int interval,
                               const std::string& xlabel,
                               const std::string& ylabel,
                               const std::string& label,
                               const std::vector<float>& axis_x,
                               const std::vector<float>& axis_y,
                               const std::vector<float>& axis_z,
                               bool autoscale_z,
                               const std::string& len_key)
{
    return gnuradio::make_block_sptr<RadarSpectrogramPlotWasm>(
        vlen, interval, xlabel, ylabel, label, axis_x, axis_y, axis_z,
        autoscale_z, len_key);
}

RadarSpectrogramPlotWasm::RadarSpectrogramPlotWasm(int vlen,
                                                   int interval,
                                                   const std::string& xlabel,
                                                   const std::string& ylabel,
                                                   const std::string& label,
                                                   const std::vector<float>& axis_x,
                                                   const std::vector<float>& axis_y,
                                                   const std::vector<float>& axis_z,
                                                   bool autoscale_z,
                                                   const std::string& len_key)
    : gr::tagged_stream_block("qtgui_spectrogram_plot",
                              gr::io_signature::make(1, 1, sizeof(float) * vlen),
                              gr::io_signature::make(0, 0, 0),
                              len_key),
      d_vlen(vlen),
      d_axis_x(axis_x),
      d_axis_y(axis_y),
      d_axis_z(axis_z),
      d_autoscale_z(autoscale_z)
{
    d_widget = make_plot_container(
        d_plot, titled("Spectrogram Plot: ", xlabel + "/" + ylabel, label));
    d_plot->setAxisTitle(QwtAxis::XBottom, QwtText(QString::fromStdString(xlabel)));
    d_plot->setAxisTitle(QwtAxis::YLeft, QwtText(QString::fromStdString(ylabel)));

    d_spectrogram = new QwtPlotSpectrogram;
    d_spectrogram->attach(d_plot);
    // Qwt takes ownership of a colour map, and the scale widget below needs one
    // of its own -- upstream hands the same pointer to both and double-frees.
    d_spectrogram->setColorMap(colour_map());

    auto* scale = d_plot->axisWidget(QwtAxis::YRight);
    scale->setColorBarEnabled(true);
    scale->setColorBarWidth(20);
    d_plot->setAxisVisible(QwtAxis::YRight, true);
    d_plot->replot();

    auto* timer = new QTimer(d_widget);
    QObject::connect(timer, &QTimer::timeout, d_widget, [this] { refresh(); });
    timer->start(refresh_interval(interval));
}

int RadarSpectrogramPlotWasm::calculate_output_stream_length(const gr_vector_int&)
{
    return 0;
}

int RadarSpectrogramPlotWasm::work(int /*noutput_items*/,
                                   gr_vector_int& ninput_items,
                                   gr_vector_const_void_star& input_items,
                                   gr_vector_void_star& /*output_items*/)
{
    const float* in = static_cast<const float*>(input_items[0]);
    const std::size_t count = std::size_t(ninput_items[0]) * d_vlen;
    std::lock_guard<std::mutex> lock(d_mutex);
    d_buffer.assign(in, in + count);
    d_fresh = true;
    return 0;
}

void RadarSpectrogramPlotWasm::refresh()
{
    QVector<double> values;
    {
        std::lock_guard<std::mutex> lock(d_mutex);
        // Upstream throws out of the refresh slot on an empty buffer, which is
        // every tick before the first packet arrives. Just wait for one.
        if (!d_fresh || d_buffer.empty())
            return;
        d_fresh = false;
        values.reserve(int(d_buffer.size()));
        for (float value : d_buffer)
            values.append(value);
    }

    double minimum = values[0], maximum = values[0];
    for (double value : values) {
        minimum = std::min(minimum, value);
        maximum = std::max(maximum, value);
    }
    if (std::isnan(minimum) || std::isnan(maximum))
        return;

    const auto x = axis_range(d_axis_x, 0.0, double(d_vlen));
    const auto y = axis_range(d_axis_y, 0.0, double(values.size() / d_vlen));
    const auto z = d_autoscale_z ? std::make_pair(minimum, maximum)
                                 : axis_range(d_axis_z, minimum, maximum);

    auto* data = new QwtMatrixRasterData;
    data->setValueMatrix(values, d_vlen);
    data->setInterval(Qt::XAxis, QwtInterval(x.first, x.second));
    data->setInterval(Qt::YAxis, QwtInterval(y.first, y.second));
    data->setInterval(Qt::ZAxis, QwtInterval(z.first, z.second));
    // Hands ownership over and drops the previous matrix, which is also what
    // invalidates the item's render cache -- reusing one raster object, as
    // upstream does, leaves setData() a no-op and the picture stale.
    d_spectrogram->setData(data);

    auto* scale = d_plot->axisWidget(QwtAxis::YRight);
    scale->setColorMap(QwtInterval(z.first, z.second), colour_map());
    d_plot->setAxisScale(QwtAxis::YRight, z.first, z.second);
    d_plot->replot();
}
