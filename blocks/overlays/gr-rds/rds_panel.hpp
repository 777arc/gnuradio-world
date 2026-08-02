#pragma once

// One of gr-rds's browser-side additions: see metadata.yml beside this file for
// the rest. Header-only, as it was when it lived inline in registry.cpp -- the
// class declares no signals or slots, so it needs no moc pass.

#include <gnuradio/block.h>
#include <gnuradio/io_signature.h>
#include <pmt/pmt.h>

#include <QGridLayout>
#include <QGroupBox>
#include <QLabel>
#include <QPointer>
#include <QSizePolicy>
#include <QString>
#include <QStringList>
#include <QTimer>

#include <memory>
#include <mutex>

// Browser rebuild of gr-rds's `rds.rdsPanel` (gr-rds/python/rdspanel.py). That
// block is a Python QWidget, so it has no C++ path at all -- and it is the only
// thing in the gr-rds receiver chain that ever shows the decoded ASCII, so
// without it an RDS flowgraph runs perfectly and displays nothing.
//
// gr-rds's parser publishes `(msg_type, text)` tuples; the type selects which
// field the text belongs to (see parser_impl.cc's send_message()). The handler
// runs on a GR thread while the labels belong to the GUI thread, so it only
// records the text and a QTimer paints it -- the same split PacketRateSinkWasm
// uses.
class RdsPanelWasm : public gr::block
{
public:
    using sptr = std::shared_ptr<RdsPanelWasm>;

    // gr-rds parser message types.
    enum Field {
        PI = 0, STATION = 1, PROGRAM_TYPE = 2, FLAGS = 3,
        RADIOTEXT = 4, CLOCK_TIME = 5, ALT_FREQ = 6, FREQUENCY = 7,
        FIELD_COUNT = 8,
    };

    static sptr make(double freq)
    {
        return gnuradio::make_block_sptr<RdsPanelWasm>(freq);
    }

    explicit RdsPanelWasm(double freq)
        : gr::block("rds_panel",
                    gr::io_signature::make(0, 0, 0),
                    gr::io_signature::make(0, 0, 0)),
          d_widget(new QGroupBox(QStringLiteral("RDS")))
    {
        struct Row { Field field; const char* label; };
        // Native's panel order, flattened to one label/value row per field.
        static const Row rows[] = {
            { FREQUENCY, "Frequency (MHz)" }, { STATION, "Station Name" },
            { PROGRAM_TYPE, "Program Type" }, { PI, "PI" },
            { FLAGS, "Flags" },               { CLOCK_TIME, "Clock Time" },
            { ALT_FREQ, "Alt. Frequencies" }, { RADIOTEXT, "Radiotext" },
        };
        auto* grid = new QGridLayout(d_widget);
        grid->setContentsMargins(10, 6, 10, 6);
        grid->setHorizontalSpacing(10);
        grid->setVerticalSpacing(2);
        int row = 0;
        for (const Row& entry : rows) {
            auto* name = new QLabel(QString::fromLatin1(entry.label), d_widget);
            auto* value = new QLabel(d_widget);
            // No word wrap. A wrapping label's height depends on the width the
            // layout hands it, so in a narrow or short flowgraph window the rows
            // get a one-line height for two lines of text and the fields run into
            // each other. One line per field, clipped at the right edge instead.
            value->setWordWrap(false);
            value->setTextInteractionFlags(Qt::TextSelectableByMouse);
            value->setStyleSheet(
                QStringLiteral("font-family:monospace; font-weight:600;"));
            // The field names keep their width; only the value column gives way
            // (Ignored) so a long radiotext can't force the whole panel wider
            // than the flowgraph window.
            name->setSizePolicy(QSizePolicy::Fixed, QSizePolicy::Fixed);
            value->setSizePolicy(QSizePolicy::Ignored, QSizePolicy::Fixed);
            for (QLabel* label : { name, value })
                label->setFixedHeight(label->sizeHint().height());
            grid->addWidget(name, row, 0, Qt::AlignRight | Qt::AlignVCenter);
            grid->addWidget(value, row, 1);
            d_value[entry.field] = value;
            ++row;
        }
        grid->setColumnStretch(1, 1);
        d_widget->setMinimumWidth(420);
        // Text, not a plot: keep the rows at their natural height and let the
        // sinks above absorb the slack, or a short flowgraph window squeezes the
        // rows into one another and clips the radiotext -- the one line the whole
        // receiver exists to produce.
        d_widget->setSizePolicy(QSizePolicy::Preferred, QSizePolicy::Fixed);
        d_widget->setFixedHeight(d_widget->sizeHint().height());

        d_text[FREQUENCY] = QString::number(freq / 1e6, 'f', 1);
        d_dirty = true;

        // Parented to the widget, so it lives and dies on the GUI thread.
        auto* timer = new QTimer(d_widget);
        QObject::connect(timer, &QTimer::timeout, d_widget, [this] { repaint(); });
        timer->start(200);

        message_port_register_in(pmt::mp("in"));
        set_msg_handler(pmt::mp("in"), [this](pmt::pmt_t msg) { handle(msg); });
    }

    QWidget* qwidget() const { return d_widget; }

    // Mirrors native's set_frequency callback: retuning invalidates everything
    // decoded from the old station.
    void set_frequency(double freq)
    {
        std::lock_guard<std::mutex> lock(d_mutex);
        for (auto& text : d_text)
            text.clear();
        d_text[FREQUENCY] = QString::number(freq / 1e6, 'f', 1);
        d_dirty = true;
    }

private:
    void handle(const pmt::pmt_t& msg)
    {
        if (!pmt::is_tuple(msg) || pmt::length(msg) < 2)
            return;
        const long type = pmt::to_long(pmt::tuple_ref(msg, 0));
        if (type < 0 || type >= FIELD_COUNT)
            return;
        // The parser hands us UTF-8 (it transcodes RadioText out of ISO-8859-2).
        const QString text = QString::fromStdString(
            pmt::symbol_to_string(pmt::tuple_ref(msg, 1)));
        std::lock_guard<std::mutex> lock(d_mutex);
        d_text[type] = type == FLAGS ? describe_flags(text) : text;
        d_dirty = true;
    }

    // The seven RDS flag bits arrive as '0'/'1' characters. Native colours a
    // fixed row of labels; as plain text, naming the ones that are set (and the
    // either/or pairs both ways) says the same thing.
    static QString describe_flags(const QString& bits)
    {
        static const char* const set[] = { "TP", "TA", "Music", "Stereo",
                                          "AH", "CMP", "" };
        static const char* const clear[] = { "", "", "Speech", "Mono",
                                            "", "", "static PTY" };
        QStringList parts;
        for (int i = 0; i < 7 && i < bits.size(); ++i) {
            const char* text = bits[i] == QLatin1Char('1') ? set[i] : clear[i];
            if (*text)
                parts << QString::fromLatin1(text);
        }
        return parts.join(QStringLiteral(", "));
    }

    void repaint()
    {
        QString text[FIELD_COUNT];
        {
            std::lock_guard<std::mutex> lock(d_mutex);
            if (!d_dirty)
                return;
            d_dirty = false;
            for (int i = 0; i < FIELD_COUNT; ++i)
                text[i] = d_text[i];
        }
        for (int i = 0; i < FIELD_COUNT; ++i)
            if (d_value[i])
                d_value[i]->setText(text[i]);
    }

    QGroupBox* d_widget;
    QPointer<QLabel> d_value[FIELD_COUNT];
    std::mutex d_mutex;
    QString d_text[FIELD_COUNT];
    bool d_dirty = false;
};
