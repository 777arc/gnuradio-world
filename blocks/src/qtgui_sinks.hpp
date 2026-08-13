#pragma once

// Browser-only Qt sinks. Neither has an upstream C++ implementation in the
// trimmed qtgui archive this build links, so they are written here against the
// same block ids and display parameters.

#include "hier_support.hpp"
#include <gnuradio/blocks/complex_to_mag.h>
#include <gnuradio/blocks/divide.h>
#include <gnuradio/blocks/keep_one_in_n.h>
#include <gnuradio/blocks/max_blk.h>
#include <gnuradio/blocks/nlog10_ff.h>
#include <gnuradio/blocks/repeat.h>
#include <gnuradio/blocks/stream_to_vector.h>
#include <gnuradio/blocks/vector_to_stream.h>
#include <gnuradio/fft/fft_v.h>
#include <gnuradio/filter/single_pole_iir_filter_ff.h>
#include <gnuradio/hier_block2.h>
#include <gnuradio/io_signature.h>
#include <gnuradio/qtgui/time_sink_f.h>
#include <gnuradio/sync_block.h>
#include <QTimer>
#include <QGroupBox>
#include <QLabel>
#include <QPointer>
#include <QVBoxLayout>
#include <QWidget>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <vector>

// The trimmed browser QTGUI archive does not include GNU Radio's number_sink
// implementation. This lightweight stream sink preserves the native block ID
// and its useful display parameters without pulling in the desktop-only form.
class NumberSinkWasm : public gr::sync_block
{
public:
    using sptr = std::shared_ptr<NumberSinkWasm>;

    static sptr make(const std::string& input_type,
                     int connections,
                     const std::string& title,
                     const std::vector<std::string>& labels,
                     const std::vector<std::string>& units,
                     const std::vector<double>& factors)
    {
        return gnuradio::make_block_sptr<NumberSinkWasm>(
            input_type, connections, title, labels, units, factors);
    }

    NumberSinkWasm(const std::string& input_type,
                   int connections,
                   const std::string& title,
                   const std::vector<std::string>& labels,
                   const std::vector<std::string>& units,
                   const std::vector<double>& factors)
        : gr::sync_block("number_sink",
                         gr::io_signature::make(
                             connections, connections, item_size(input_type)),
                         gr::io_signature::make(0, 0, 0)),
          d_input_type(input_type),
          d_widget(new QGroupBox(QString::fromStdString(title)))
    {
        auto* layout = new QVBoxLayout(d_widget);
        for (int i = 0; i < connections; ++i) {
            Display display;
            display.label = QString::fromStdString(labels[static_cast<std::size_t>(i)]);
            display.unit = QString::fromStdString(units[static_cast<std::size_t>(i)]);
            display.factor = factors[static_cast<std::size_t>(i)];
            display.value = new QLabel(d_widget);
            display.value->setAlignment(Qt::AlignCenter);
            display.value->setStyleSheet(
                QStringLiteral("font-size:28px; font-weight:600; padding:12px;"));
            display.value->setText(display.label + QStringLiteral(": 0") +
                                   display.unit);
            layout->addWidget(display.value);
            d_displays.push_back(std::move(display));
        }
        d_widget->setMinimumWidth(360);
    }

    QWidget* qwidget() const { return d_widget; }

    int work(int noutput_items,
             gr_vector_const_void_star& input_items,
             gr_vector_void_star&) override
    {
        if (noutput_items <= 0)
            return 0;
        const int latest = noutput_items - 1;
        for (std::size_t i = 0; i < d_displays.size(); ++i) {
            const double value =
                sample(input_items[i], latest) * d_displays[i].factor;
            const QString text =
                d_displays[i].label + QStringLiteral(": ") +
                QString::number(value, 'g', 10) + d_displays[i].unit;
            QPointer<QLabel> label = d_displays[i].value;
            QMetaObject::invokeMethod(
                label,
                [label, text] {
                    if (label)
                        label->setText(text);
                },
                Qt::QueuedConnection);
        }
        return noutput_items;
    }

private:
    struct Display {
        QString label;
        QString unit;
        double factor = 1.0;
        QPointer<QLabel> value;
    };

    static std::size_t item_size(const std::string& type)
    {
        if (type == "float")
            return sizeof(float);
        if (type == "short")
            return sizeof(std::int16_t);
        if (type == "byte")
            return sizeof(std::int8_t);
        throw std::runtime_error(
            "QT GUI Number Sink type must be float, short, or byte");
    }

    double sample(const void* input, int offset) const
    {
        if (d_input_type == "float")
            return static_cast<const float*>(input)[offset];
        if (d_input_type == "short")
            return static_cast<const std::int16_t*>(input)[offset];
        return static_cast<const std::int8_t*>(input)[offset];
    }

    std::string d_input_type;
    QGroupBox* d_widget;
    std::vector<Display> d_displays;
};

// Throughput display driven by the wall clock rather than by the stream.
//
// NumberSinkWasm repaints only from work(), so a stream that stops leaves its
// last value frozen on screen -- indistinguishable from a live reading. That is
// exactly wrong for a link-health indicator: when an OFDM receiver stops
// decoding, the interesting fact is that nothing is arriving. Here work() only
// bumps a counter and a QTimer on the GUI thread turns the delta into a rate, so
// a dead stream decays the reading to 0. gr::blocks::probe_rate cannot do this
// (it also publishes from work(), and its output is a message, which no qtgui
// sink accepts).
class PacketRateSinkWasm : public gr::sync_block
{
public:
    using sptr = std::shared_ptr<PacketRateSinkWasm>;

    static sptr make(std::size_t itemsize,
                     double items_per_packet,
                     double update_time,
                     const std::string& title,
                     const std::string& label,
                     const std::string& unit)
    {
        return gnuradio::make_block_sptr<PacketRateSinkWasm>(
            itemsize, items_per_packet, update_time, title, label, unit);
    }

    PacketRateSinkWasm(std::size_t itemsize,
                       double items_per_packet,
                       double update_time,
                       const std::string& title,
                       const std::string& label,
                       const std::string& unit)
        : gr::sync_block("packet_rate_sink",
                         gr::io_signature::make(1, 1, itemsize),
                         gr::io_signature::make(0, 0, 0)),
          d_items_per_packet(items_per_packet > 0 ? items_per_packet : 1.0),
          d_label(QString::fromStdString(label)),
          d_unit(QString::fromStdString(unit)),
          d_widget(new QGroupBox(QString::fromStdString(title)))
    {
        auto* layout = new QVBoxLayout(d_widget);
        d_value = new QLabel(d_widget);
        d_value->setAlignment(Qt::AlignCenter);
        d_value->setStyleSheet(
            QStringLiteral("font-size:28px; font-weight:600; padding:12px;"));
        d_value->setText(d_label + QStringLiteral(": 0") + d_unit);
        layout->addWidget(d_value);
        d_widget->setMinimumWidth(360);

        // Parented to the widget, so it lives and dies on the GUI thread.
        d_last = std::chrono::steady_clock::now();
        auto* timer = new QTimer(d_widget);
        QObject::connect(timer, &QTimer::timeout, d_widget, [this] { tick(); });
        timer->start(static_cast<int>(
            std::max(0.05, update_time > 0 ? update_time : 0.5) * 1000.0));
    }

    QWidget* qwidget() const { return d_widget; }

    int work(int noutput_items,
             gr_vector_const_void_star&,
             gr_vector_void_star&) override
    {
        d_items.fetch_add(static_cast<unsigned long long>(noutput_items),
                          std::memory_order_relaxed);
        return noutput_items;
    }

private:
    void tick()
    {
        const auto now = std::chrono::steady_clock::now();
        const double dt = std::chrono::duration<double>(now - d_last).count();
        const unsigned long long items = d_items.load(std::memory_order_relaxed);
        if (dt <= 0)
            return;
        const double rate =
            static_cast<double>(items - d_last_items) / dt / d_items_per_packet;
        d_last = now;
        d_last_items = items;
        if (!d_value)
            return;
        d_value->setText(d_label + QStringLiteral(": ") +
                         QString::number(rate, 'f', rate < 10 ? 2 : 1) + d_unit);
    }

    double d_items_per_packet;
    QString d_label;
    QString d_unit;
    QGroupBox* d_widget;
    QPointer<QLabel> d_value;
    std::atomic<unsigned long long> d_items{ 0 };
    unsigned long long d_last_items = 0;
    std::chrono::steady_clock::time_point d_last;
};

// ---------------------------------------------------------------------------
// QT GUI Fast Auto-Correlator Sink (qtgui_auto_correlator_sink)
//
// A Python hier block upstream, and one of the few whose composition is the
// whole point of it: by the Wiener-Khinchin theorem the FFT of a signal's power
// spectrum is its autocorrelation, so this is two forward FFTs with a magnitude
// between them, displayed on a plain time sink. FAC size sets the FFT length and
// therefore the time span (fac_size/samp_rate) each trace covers.
//
// The sink is a member rather than a separate block because it holds the widget
// the runner has to place: qwidget() below is what reaches BuiltBlock.
// ---------------------------------------------------------------------------

class AutoCorrelatorSinkWasm : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<AutoCorrelatorSinkWasm>;

    static sptr make(double sample_rate,
                     int fac_size,
                     int fac_decimation,
                     const std::string& title,
                     bool auto_scale,
                     bool grid,
                     double y_min,
                     double y_max,
                     bool use_db)
    {
        return gnuradio::make_block_sptr<AutoCorrelatorSinkWasm>(sample_rate,
                                                                 fac_size,
                                                                 fac_decimation,
                                                                 title,
                                                                 auto_scale,
                                                                 grid,
                                                                 y_min,
                                                                 y_max,
                                                                 use_db);
    }

    AutoCorrelatorSinkWasm(double sample_rate,
                           int fac_size,
                           int fac_decimation,
                           const std::string& title,
                           bool auto_scale,
                           bool grid,
                           double y_min,
                           double y_max,
                           bool use_db)
        : gr::hier_block2("auto_correlator_sink",
                          gr::io_signature::make(1, 1, sizeof(gr_complex)),
                          gr::io_signature::make(0, 0, 0))
    {
        if (fac_size < 2 || fac_size % 2 != 0)
            throw std::runtime_error(
                "QT GUI Fast Auto-Correlator Sink FAC size must be an even number "
                "of at least 2");
        if (fac_decimation < 1)
            throw std::runtime_error(
                "QT GUI Fast Auto-Correlator Sink FAC decimation must be positive");
        require_positive("QT GUI Fast Auto-Correlator Sink sample rate", sample_rate);

        const std::vector<float> no_window;
        auto to_vector =
            gr::blocks::stream_to_vector::make(sizeof(gr_complex), fac_size);
        const int decimation =
            static_cast<int>(sample_rate / fac_size / fac_decimation);
        auto one_in_n = gr::blocks::keep_one_in_n::make(
            sizeof(gr_complex) * fac_size, std::max(1, decimation));
        auto spectrum = gr::fft::fft_v<gr_complex, true>::make(fac_size, no_window);
        auto spectrum_magnitude = gr::blocks::complex_to_mag::make(fac_size);
        auto correlation = gr::fft::fft_v<float, true>::make(fac_size, no_window);
        auto correlation_magnitude = gr::blocks::complex_to_mag::make(fac_size);
        auto average = gr::filter::single_pole_iir_filter_ff::make(1.0, fac_size);

        connect(self(), 0, to_vector, 0);
        connect(to_vector, 0, one_in_n, 0);
        connect(one_in_n, 0, spectrum, 0);
        connect(spectrum, 0, spectrum_magnitude, 0);
        connect(spectrum_magnitude, 0, correlation, 0);
        connect(correlation, 0, correlation_magnitude, 0);
        connect(correlation_magnitude, 0, average, 0);

        gr::basic_block_sptr tail = average;
        if (use_db) {
            auto to_db = gr::blocks::nlog10_ff::make(
                20.0F, fac_size, static_cast<float>(-20.0 * std::log10(fac_size)));
            connect(average, 0, to_db, 0);
            tail = to_db;
        } else {
            // Normalise each vector against its own peak, so the trace stays in
            // 0..1 without an absolute reference: divide the vector by its
            // maximum, held constant across the vector by repeat + s2v.
            auto peak = gr::blocks::max_ff::make(fac_size);
            auto spread = gr::blocks::repeat::make(sizeof(float), fac_size);
            auto peak_vector = gr::blocks::stream_to_vector::make(sizeof(float),
                                                                  fac_size);
            auto divide = gr::blocks::divide_ff::make(fac_size);
            connect(average, 0, peak, 0);
            connect(peak, 0, spread, 0);
            connect(spread, 0, peak_vector, 0);
            connect(average, 0, divide, 0);
            connect(peak_vector, 0, divide, 1);
            tail = divide;
        }

        auto to_stream = gr::blocks::vector_to_stream::make(sizeof(float), fac_size);
        // Only the first half of the autocorrelation is meaningful; the rest is
        // its mirror image, which is why the sink is half as wide as the FFT.
        d_sink = gr::qtgui::time_sink_f::make(
            fac_size / 2, sample_rate, title, 1, nullptr);
        d_sink->enable_grid(grid);
        d_sink->set_y_axis(y_min, y_max);
        d_sink->enable_autoscale(auto_scale);
        d_sink->disable_legend();
        d_sink->set_update_time(0.1);

        connect(tail, 0, to_stream, 0);
        connect(to_stream, 0, d_sink, 0);
    }

    QWidget* qwidget() { return d_sink->qwidget(); }

private:
    gr::qtgui::time_sink_f::sptr d_sink;
};
