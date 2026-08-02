#pragma once

// Browser-only Qt sinks. Neither has an upstream C++ implementation in the
// trimmed qtgui archive this build links, so they are written here against the
// same block ids and display parameters.

#include "hier_support.hpp"
#include <gnuradio/io_signature.h>
#include <gnuradio/sync_block.h>
#include <QTimer>
#include <QGroupBox>
#include <QLabel>
#include <QPointer>
#include <QVBoxLayout>
#include <QWidget>
#include <atomic>
#include <chrono>
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
