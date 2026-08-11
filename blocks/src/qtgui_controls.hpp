// The QT GUI control widgets: GRC's "GUI Widgets/QT" family, minus the four
// simple ones (Range, Chooser, Push Button, Check Box, Entry) that registry.cpp
// still builds inline out of stock Qt classes.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// Every widget here is a Python class upstream (gr-qtgui/python/qtgui/), so like
// gr-rds's panel it has no C++ path at all and the browser needs one. They divide
// into two kinds, and the split is what the classes below are shaped around:
//
//   * a *variable* control publishes a value under its block ID, which the
//     runner resolves into other blocks' parameters (BuiltBlock::is_variable),
//   * a *message* control puts that value on a message port as
//     `pmt::cons(intern(key), value)` -- exactly the PMT upstream's widgets
//     publish from their clicked() slots.
//
// Most of them are both, so a control is two objects joined by one BuiltBlock: a
// QWidget the flowgraph window shows, and a ControlMessageBlock the flowgraph
// connects. Threading follows from that. The widget runs on the browser main
// thread and may call publish() directly (message_port_pub only takes the
// subscriber lock, which is why upstream can do it from a Qt slot too), while a
// message arriving *at* a control is handled on a GR thread and must not touch a
// widget -- so an inbound value goes through queue_value(), and a QTimer on the
// GUI thread paints it. Same split as blocks/overlays/gr-rds/rds_panel.hpp.
//
// Note for anything added here: this header is compiled with Qt's macros in
// scope (registry.cpp includes it), so no member may be called `emit`, `signals`
// or `slots`. None of these classes declares a signal or a slot, so none needs a
// moc pass.
#pragma once

#include <gnuradio/block.h>
#include <gnuradio/io_signature.h>
#include <gnuradio/sptr_magic.h>
#include <pmt/pmt.h>

#include <QBoxLayout>
#include <QBrush>
#include <QColor>
#include <QFont>
#include <QFontMetrics>
#include <QFrame>
#include <QKeyEvent>
#include <QLabel>
#include <QLineEdit>
#include <QMouseEvent>
#include <QPainter>
#include <QPen>
#include <QRect>
#include <QString>
#include <QTimer>
#include <QWidget>

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <utility>

namespace grworld {

// GRC's Type parameter on these controls, minus its `string` option: the
// runner's variable model carries a double (BuiltBlock::variable_value), so a
// string-valued control has no value to publish. The factories reject it by name
// rather than silently publishing zero, and the palette does not offer it (see
// blocks/overlays/gnuradio/metadata.yml).
enum class ControlType { Real, Int, Bool };

// The value half of the PMT a control publishes, typed as its Type parameter
// says -- upstream branches on the Python type of the configured value to pick
// between from_bool/from_long/from_double, which is the same decision.
inline pmt::pmt_t control_pmt(ControlType type, double value)
{
    switch (type) {
    case ControlType::Bool:
        return pmt::from_bool(value != 0.0);
    case ControlType::Int:
        return pmt::from_long(static_cast<long>(std::llround(value)));
    case ControlType::Real:
    default:
        return pmt::from_double(value);
    }
}

// The block half of a control that talks in messages. It carries no stream ports
// and never runs work(); it exists so the flowgraph has something to connect the
// control's ports to, and so `items: 0` reads as msg_only in the diagnostics
// snapshot rather than as a stalled block.
class ControlMessageBlock : public gr::block
{
public:
    using sptr = std::shared_ptr<ControlMessageBlock>;

    // An empty port name registers nothing: an unregistered port is what makes a
    // control that only emits refuse a connection into it, rather than accepting
    // one that could never be delivered.
    static sptr make(const std::string& name,
                     const std::string& out_port,
                     const std::string& in_port = std::string())
    {
        return gnuradio::make_block_sptr<ControlMessageBlock>(name, out_port, in_port);
    }

    ControlMessageBlock(const std::string& name,
                        const std::string& out_port,
                        const std::string& in_port)
        : gr::block(name,
                    gr::io_signature::make(0, 0, 0),
                    gr::io_signature::make(0, 0, 0)),
          d_out(pmt::mp(out_port.empty() ? "out" : out_port)),
          d_has_out(!out_port.empty())
    {
        if (d_has_out)
            message_port_register_out(d_out);
        if (!in_port.empty()) {
            const pmt::pmt_t port = pmt::mp(in_port);
            message_port_register_in(port);
            set_msg_handler(port, [this](pmt::pmt_t msg) {
                if (d_handler)
                    d_handler(msg);
            });
        }
    }

    // Called from a Qt callback on the browser main thread.
    void publish(const pmt::pmt_t& message)
    {
        if (d_has_out)
            message_port_pub(d_out, message);
    }

    // What a *state* control announces once the flowgraph is running, so that
    // what its widget shows and what the rest of the graph believes agree from
    // the start. Upstream's Python widgets say nothing until the user touches
    // them, which leaves a receiver wired to a Toggle Switch waiting for a
    // toggle it can only guess at -- and gr-qtgui's one C++ control
    // (edit_box_msg_impl::start) already publishes its default the same way.
    // Deliberately unset on the Msg Push Button: a momentary trigger announces
    // an event, and an event that did not happen must not be announced.
    void set_initial_message(pmt::pmt_t message) { d_initial = std::move(message); }

    bool start() override
    {
        if (d_initial)
            publish(d_initial);
        return gr::block::start();
    }

    // Called on a GR thread. Whatever it does must be thread-safe; in practice
    // it forwards to a widget's queue_value().
    void set_handler(std::function<void(pmt::pmt_t)> handler)
    {
        d_handler = std::move(handler);
    }

private:
    pmt::pmt_t d_out;
    bool d_has_out;
    pmt::pmt_t d_initial;
    std::function<void(pmt::pmt_t)> d_handler;
};

// Where a control puts its label relative to the widget, as GRC's Label Position
// stores it (1 above, 2 below, 3 left, 4 right), plus its Cell/Vertical
// Alignment (1 center, 2 left/top, 3 right/bottom).
inline QWidget* label_around(QWidget* control,
                             const QString& text,
                             int position,
                             int alignment,
                             int valignment)
{
    auto* frame = new QFrame;
    QBoxLayout* layout = position < 3
                             ? static_cast<QBoxLayout*>(new QVBoxLayout(frame))
                             : static_cast<QBoxLayout*>(new QHBoxLayout(frame));
    layout->setContentsMargins(2, 2, 2, 2);
    control->setParent(frame);
    if (text.isEmpty()) {
        layout->addWidget(control);
    } else {
        auto* label = new QLabel(text, frame);
        label->setAlignment(position == 3   ? Qt::AlignRight
                            : position == 4 ? Qt::AlignLeft
                                            : Qt::AlignCenter);
        if (position == 1 || position == 3)
            layout->addWidget(label);
        layout->addWidget(control);
        if (position == 2 || position == 4)
            layout->addWidget(label);
    }
    const Qt::Alignment horizontal = alignment == 2   ? Qt::AlignLeft
                                     : alignment == 3 ? Qt::AlignRight
                                                      : Qt::AlignHCenter;
    const Qt::Alignment vertical = valignment == 2   ? Qt::AlignTop
                                   : valignment == 3 ? Qt::AlignBottom
                                                     : Qt::AlignVCenter;
    layout->setAlignment(horizontal | vertical);
    return frame;
}

// GRC's colour parameters are CSS colour names ('silver', 'navy', …) plus
// 'default', which means "leave the palette alone".
inline QString color_style(const std::string& background, const std::string& font)
{
    QString style;
    if (!background.empty() && background != "default")
        style += QStringLiteral("background-color: %1; ")
                     .arg(QString::fromStdString(background));
    if (!font.empty() && font != "default")
        style += QStringLiteral("color: %1; ").arg(QString::fromStdString(font));
    return style;
}

// ---- Toggle Switch --------------------------------------------------------

// A pixel-for-pixel port of toggleswitch.py's ToggleSwitch.paintEvent: a
// coloured capsule (a rectangle between two circles) with a white knob on the
// side the current state is on. Clicking a half selects that half's state, which
// is upstream's behaviour and not a toggle -- clicking the "on" side of a switch
// already on leaves it on.
class ToggleSwitchWidget : public QFrame
{
public:
    ToggleSwitchWidget(const QString& on_color,
                       const QString& off_color,
                       bool initial,
                       int max_size)
        : d_on(on_color), d_off(off_color), d_state(initial)
    {
        setMinimumSize(max_size, max_size / 2);
        setMaximumSize(max_size, max_size / 2);
    }

    void set_state(bool on)
    {
        d_state = on;
        update();
    }

    bool state() const { return d_state; }

    std::function<void(bool)> on_change;

protected:
    void paintEvent(QPaintEvent* event) override
    {
        QFrame::paintEvent(event);
        QPainter painter(this);
        painter.setRenderHint(QPainter::Antialiasing);

        const QSize box = size();
        const QColor color = d_state ? d_on : d_off;
        QBrush brush(color, Qt::SolidPattern);
        painter.setPen(QPen(color, 0));
        painter.setBrush(brush);
        painter.drawRect(QRect(box.width() / 4, 0, box.width() / 2 - 4, box.height()));
        painter.drawEllipse(0, 0, box.height(), box.height());
        painter.drawEllipse(box.width() / 2, 0, box.height(), box.height());

        painter.setPen(QPen(QColor(QStringLiteral("white")), 0));
        painter.setBrush(QBrush(QColor(QStringLiteral("white")), Qt::SolidPattern));
        const int knob = d_state ? box.width() / 2 + 2 : 2;
        painter.drawEllipse(knob, 2, box.height() - 4, box.height() - 4);
    }

    void mousePressEvent(QMouseEvent* event) override
    {
        const bool on = event->position().x() > width() / 2.0;
        if (on != d_state) {
            d_state = on;
            if (on_change)
                on_change(on);
        }
        update();
    }

private:
    QColor d_on, d_off;
    bool d_state;
};

// ---- Numeric Entry --------------------------------------------------------

// numeric_entry.py's QLineEdit, one behaviour short: upstream falls back to
// Python's ast for an expression like "5*2-3", and there is no Python here. What
// it does keep is the part that makes the widget worth having over a plain Entry
// -- SI prefixes and the unit suffix ("8 kHz" -> 8000), bounds, precision,
// arrow-key stepping, and the label colour that says whether what you typed has
// been applied (blue mid-edit, red invalid, default applied).
class NumericEntryLine : public QLineEdit
{
public:
    // Up/Down step by the increment, PageUp/PageDown by ten of them. Upstream
    // puts this on the enclosing toolbar, where the focused line edit's key
    // events never reach it.
    std::function<void(int)> on_step;

protected:
    void keyPressEvent(QKeyEvent* event) override
    {
        const int steps = event->key() == Qt::Key_Up       ? 1
                          : event->key() == Qt::Key_Down   ? -1
                          : event->key() == Qt::Key_PageUp ? 10
                          : event->key() == Qt::Key_PageDown ? -10
                                                             : 0;
        if (steps != 0 && on_step) {
            on_step(steps);
            return;
        }
        QLineEdit::keyPressEvent(event);
    }
};

class NumericEntryWidget : public QWidget
{
public:
    NumericEntryWidget(const QString& label,
                       double value,
                       double increment,
                       const QString& unit,
                       const QString& description,
                       int precision,
                       bool enabled,
                       double minimum,
                       double maximum)
        : d_value(value),
          d_increment(increment),
          d_unit(unit),
          d_precision(precision > 0 ? precision : 10),
          d_min(minimum),
          d_max(maximum)
    {
        auto* layout = new QHBoxLayout(this);
        layout->setContentsMargins(0, 0, 0, 0);
        d_label = new QLabel(label + QStringLiteral(": "), this);
        d_edit = new NumericEntryLine;
        d_edit->setParent(this);
        d_edit->setEnabled(enabled);
        layout->addWidget(d_label);
        layout->addWidget(d_edit);

        QString tip;
        if (!description.isEmpty())
            tip += description + QLatin1Char('\n');
        if (std::isfinite(d_min))
            tip += QStringLiteral("Minimum value: %1\n").arg(format(d_min));
        if (std::isfinite(d_max))
            tip += QStringLiteral("Maximum value: %1\n").arg(format(d_max));
        if (d_increment != 0.0)
            tip += QStringLiteral("Increment (up/down key): %1\n").arg(format(d_increment));
        d_label->setToolTip(tip.trimmed());

        d_edit->on_step = [this](int steps) {
            apply(d_value + steps * d_increment);
        };
        QObject::connect(d_edit, &QLineEdit::textEdited, d_edit,
                         [this] { set_editing(true, true); });
        QObject::connect(d_edit, &QLineEdit::editingFinished, d_edit,
                         [this] { apply_text(); });
        show_value(clamp(d_value));
    }

    double value() const { return d_value; }

    std::function<void(double)> on_change;

private:
    double clamp(double value) const
    {
        if (std::isfinite(d_min))
            value = std::max(d_min, value);
        if (std::isfinite(d_max))
            value = std::min(d_max, value);
        // Upstream rounds to the configured precision by round-tripping through
        // its own formatting, so what the box shows is exactly what was applied.
        return format_number(value).toDouble();
    }

    QString format_number(double value) const
    {
        return QString::number(value, 'g', d_precision);
    }

    QString format(double value) const
    {
        QString text = format_number(value);
        if (!d_unit.isEmpty())
            text += QLatin1Char(' ') + d_unit;
        return text;
    }

    void show_value(double value)
    {
        d_value = value;
        d_edit->setText(format(value));
        set_editing(false, true);
    }

    void set_editing(bool editing, bool valid)
    {
        if (d_editing == editing && d_valid == valid)
            return;
        d_editing = editing;
        d_valid = valid;
        d_label->setStyleSheet(!valid    ? QStringLiteral("QLabel { color: red }")
                               : editing ? QStringLiteral("QLabel { color: blue }")
                                         : QString());
    }

    void apply_text()
    {
        QString text = d_edit->text().trimmed();
        if (text.isEmpty()) {
            show_value(d_value);
            return;
        }
        bool ok = false;
        const double parsed = parse(text, ok);
        if (!ok) {
            set_editing(true, false);
            return;
        }
        apply(parsed);
    }

    void apply(double value)
    {
        const double applied = clamp(value);
        const bool changed = applied != d_value;
        show_value(applied);
        if (changed && on_change)
            on_change(applied);
    }

    // "8 kHz" with unit "Hz", "30m", "1e3", "1,5". The SI prefix may come from
    // the number itself ("30m") or from the unit the user retyped ("8 kHz" where
    // the configured unit is "Hz").
    double parse(QString text, bool& ok) const
    {
        struct Prefix { QChar symbol; double factor; };
        static const Prefix prefixes[] = {
            { QLatin1Char('G'), 1e9 },  { QLatin1Char('M'), 1e6 },
            { QLatin1Char('k'), 1e3 },  { QLatin1Char('m'), 1e-3 },
            { QLatin1Char('u'), 1e-6 }, { QChar(0x03BC), 1e-6 },
            { QLatin1Char('n'), 1e-9 },
        };
        double scale = 1.0;
        if (!d_unit.isEmpty()) {
            if (text.endsWith(d_unit)) {
                text.chop(d_unit.size());
            } else if (d_unit.size() > 1) {
                // The configured unit already carries a prefix ("kHz"): a value
                // typed as the bare unit ("500 Hz") is that many times smaller.
                for (const Prefix& prefix : prefixes)
                    if (d_unit.startsWith(prefix.symbol) &&
                        text.endsWith(d_unit.mid(1))) {
                        text.chop(d_unit.size() - 1);
                        scale /= prefix.factor;
                        break;
                    }
            }
            text = text.trimmed();
        }
        if (!text.isEmpty())
            for (const Prefix& prefix : prefixes)
                if (text.endsWith(prefix.symbol)) {
                    text.chop(1);
                    scale *= prefix.factor;
                    break;
                }
        text.replace(QLatin1Char(','), QLatin1Char('.'));
        const double value = text.trimmed().toDouble(&ok);
        return ok ? scale * value : 0.0;
    }

    QLabel* d_label;
    NumericEntryLine* d_edit;
    double d_value;
    double d_increment;
    QString d_unit;
    int d_precision;
    double d_min, d_max;
    bool d_editing = false, d_valid = true;
};

// ---- Digital Number Control -----------------------------------------------

// digitalnumbercontrol.py's per-digit frequency display: the digits are drawn
// right-aligned in a coloured box, and clicking the upper or lower half of one
// adds or subtracts that digit's place value. Clicking left of the number (past
// the most significant digit) steps the next place up again, as upstream does.
class DigitalNumberWidget : public QFrame
{
public:
    DigitalNumberWidget(long long minimum,
                        long long maximum,
                        const QString& separator,
                        const QString& background,
                        const QString& font_color)
        : d_min(minimum),
          d_max(maximum),
          d_separator(separator),
          d_background(background),
          d_font_color(font_color),
          d_value(minimum),
          d_font(QStringLiteral("Arial"), 12)
    {
        // Upstream's minimum width: the widest value this control can hold, or
        // 410 px, whichever is larger.
        const QFontMetrics metrics(d_font);
        const int digits = QString::number(maximum).size();
        QString widest(digits, QLatin1Char('0'));
        if (!d_separator.isEmpty())
            widest += QString((digits - 1) / 3, d_separator.at(0));
        setMinimumWidth(std::max(metrics.horizontalAdvance(widest), 410));
        setMaximumHeight(70);

        // An inbound message is handled on a GR thread; the repaint has to
        // happen here, on the GUI thread.
        auto* timer = new QTimer(this);
        QObject::connect(timer, &QTimer::timeout, this, [this] { drain(); });
        timer->start(100);
    }

    QSize minimumSizeHint() const override { return QSize(minimumWidth(), 50); }

    void set_read_only(bool read_only) { d_read_only = read_only; }

    // Thread-safe: called from the message handler on a GR thread.
    void queue_value(double value)
    {
        std::lock_guard<std::mutex> lock(d_mutex);
        d_pending = value;
        d_has_pending = true;
    }

    long long value() const { return d_value; }

    // Called on the GUI thread only, with a value already in range.
    void set_value_now(long long value)
    {
        d_value = value;
        update();
    }

    // Raised for a click and for an accepted inbound message alike, matching
    // upstream: both call the variable callback and republish on `valueout`.
    std::function<void(double)> on_change;

protected:
    void paintEvent(QPaintEvent* event) override
    {
        QFrame::paintEvent(event);
        QPainter painter(this);
        const QSize box = size();
        painter.fillRect(QRect(2, 2, box.width() - 4, box.height() - 4),
                         QBrush(d_background, Qt::SolidPattern));
        d_font.setPixelSize(static_cast<int>(0.9 * box.height()));
        painter.setFont(d_font);
        painter.setPen(d_font_color);
        painter.drawText(QRect(0, 0, box.width() - 4, box.height()),
                         Qt::AlignRight | Qt::AlignVCenter,
                         formatted());
    }

    void mousePressEvent(QMouseEvent* event) override
    {
        QFrame::mousePressEvent(event);
        if (d_read_only)
            return;
        const QString text = formatted();
        const QFontMetrics metrics(d_font);
        // The text is right-aligned, so measure from the right edge: the click
        // is inside the i-th character from the end when it falls between the
        // widths of the last i and last i-1 characters.
        const double click = width() - 2 - event->position().x();
        const bool up = event->position().y() <= height() / 2.0;
        int place = -1;
        for (int i = 1; i <= text.size(); ++i) {
            const QString tail = text.right(i);
            const int right = metrics.horizontalAdvance(tail);
            const int left = right - metrics.horizontalAdvance(tail.left(1));
            if (click < left || click > right)
                continue;
            if (!d_separator.isEmpty() && tail.startsWith(d_separator))
                return;                          // a separator selects no digit
            place = i - 1 - (d_separator.isEmpty() ? 0 : tail.count(d_separator));
            break;
        }
        // Clicked past the most significant digit: step the place above it, so
        // a control sitting at its minimum can still be raised.
        if (place < 0)
            place = QString::number(d_value).size();

        long long step = 1;
        for (int i = 0; i < place; ++i)
            step *= 10;
        const long long next = d_value + (up ? step : -step);
        if (next < d_min || next > d_max)
            return;
        set_value_now(next);
        if (on_change)
            on_change(static_cast<double>(next));
    }

private:
    // The value with thousands separators, as Python's format(v, ',') gives it.
    QString formatted() const
    {
        QString digits = QString::number(std::llabs(d_value));
        if (!d_separator.isEmpty())
            for (int at = digits.size() - 3; at > 0; at -= 3)
                digits.insert(at, d_separator);
        return d_value < 0 ? QLatin1Char('-') + digits : digits;
    }

    void drain()
    {
        double pending = 0.0;
        {
            std::lock_guard<std::mutex> lock(d_mutex);
            if (!d_has_pending)
                return;
            d_has_pending = false;
            pending = d_pending;
        }
        // Upstream ignores an out-of-range value rather than clamping it.
        if (pending < static_cast<double>(d_min) || pending > static_cast<double>(d_max))
            return;
        set_value_now(static_cast<long long>(pending));
    }

    long long d_min, d_max;
    QString d_separator;
    QColor d_background, d_font_color;
    long long d_value;
    QFont d_font;
    bool d_read_only = false;
    std::mutex d_mutex;
    double d_pending = 0.0;
    bool d_has_pending = false;
};

} // namespace grworld
