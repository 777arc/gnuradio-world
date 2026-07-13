#include "registry.hpp"
#include <gnuradio/analog/sig_source.h>
#include <gnuradio/analog/noise_source.h>
#include <gnuradio/blocks/throttle.h>
#include <gnuradio/blocks/multiply_const.h>
#include <gnuradio/blocks/add_blk.h>
#include <gnuradio/blocks/multiply.h>
#include <gnuradio/blocks/sub.h>
#include <gnuradio/blocks/divide.h>
#include <gnuradio/blocks/conjugate_cc.h>
#include <gnuradio/blocks/complex_to_mag.h>
#include <gnuradio/blocks/complex_to_mag_squared.h>
#include <gnuradio/blocks/complex_to_float.h>
#include <gnuradio/blocks/float_to_complex.h>
#include <gnuradio/blocks/null_sink.h>
#include <gnuradio/blocks/null_source.h>
#include <gnuradio/blocks/head.h>
#include <gnuradio/blocks/delay.h>
#include <gnuradio/qtgui/time_sink_c.h>
#include <gnuradio/qtgui/time_sink_f.h>
#include <gnuradio/qtgui/freq_sink_c.h>
#include <QDial>
#include <QDoubleSpinBox>
#include <QHBoxLayout>
#include <QLabel>
#include <QLineEdit>
#include <QPointer>
#include <QSignalBlocker>
#include <QSlider>
#include <QWidget>
#include <algorithm>
#include <cmath>
#include <limits>
#include <memory>
#include <stdexcept>
#include <vector>

using nlohmann::json;

static gr::analog::gr_waveform_t waveform_from(const std::string& s) {
    if (s == "sin" || s == "sine") return gr::analog::GR_SIN_WAVE;
    if (s == "cos" || s == "cosine") return gr::analog::GR_COS_WAVE;
    if (s == "square") return gr::analog::GR_SQR_WAVE;
    if (s == "triangle" || s == "tri") return gr::analog::GR_TRI_WAVE;
    if (s == "saw" || s == "sawtooth") return gr::analog::GR_SAW_WAVE;
    if (s == "const" || s == "constant") return gr::analog::GR_CONST_WAVE;
    return gr::analog::GR_COS_WAVE;
}
// Many blocks are type-parameterized (like GRC): a "type" param selects the C++ type.
static bool is_float(const json& p) { return p.value("type", std::string("complex")) == "float"; }
static int itemsize_of(const json& p) { return is_float(p) ? (int)sizeof(float) : (int)sizeof(gr_complex); }

namespace {

struct RangeState {
    double start;
    double stop;
    double step;
    bool integral;
    std::vector<std::function<void(double)>> subscribers;

    double normalize(double value) const
    {
        value = std::clamp(value, start, stop);
        return integral ? static_cast<double>(static_cast<long long>(value)) : value;
    }

    int index(double value) const
    {
        const double raw = std::round((normalize(value) - start) / step);
        return static_cast<int>(std::clamp(raw, 0.0, static_cast<double>(steps())));
    }

    int steps() const
    {
        const double count = std::floor((stop - start) / step + 1e-12);
        return static_cast<int>(std::clamp(
            count, 0.0, static_cast<double>(std::numeric_limits<int>::max())));
    }

    double value(int index) const { return normalize(start + index * step); }

    void publish(double value)
    {
        value = normalize(value);
        for (const auto& subscriber : subscribers)
            subscriber(value);
    }
};

double engineering_value(const QString& text, bool* ok)
{
    QString input = text.trimmed();
    double multiplier = 1.0;
    if (!input.isEmpty()) {
        static const std::map<QChar, double> suffixes = {
            { 'E', 1e18 }, { 'P', 1e15 }, { 'T', 1e12 }, { 'G', 1e9 },
            { 'M', 1e6 },  { 'k', 1e3 },  { 'm', 1e-3 }, { 'u', 1e-6 },
            { 'n', 1e-9 }, { 'p', 1e-12 }, { 'f', 1e-15 }, { 'a', 1e-18 },
        };
        auto suffix = suffixes.find(input.back());
        if (suffix != suffixes.end()) {
            multiplier = suffix->second;
            input.chop(1);
        }
    }
    const double value = input.toDouble(ok);
    return value * multiplier;
}

QSlider* make_slider(QWidget* parent,
                     const std::shared_ptr<RangeState>& state,
                     Qt::Orientation orientation,
                     int minimum_length,
                     double initial,
                     const std::function<void(double)>& changed)
{
    auto* slider = new QSlider(orientation, parent);
    slider->setRange(0, state->steps());
    slider->setSingleStep(1);
    slider->setPageStep(std::max(1, state->steps() / std::max(1, minimum_length)));
    slider->setTickInterval(slider->pageStep());
    slider->setTickPosition(orientation == Qt::Horizontal ? QSlider::TicksBelow
                                                          : QSlider::TicksLeft);
    if (orientation == Qt::Horizontal)
        slider->setMinimumWidth(minimum_length);
    else
        slider->setMinimumHeight(minimum_length);
    slider->setValue(state->index(initial));
    QObject::connect(slider, &QSlider::valueChanged, slider, [state, changed](int index) {
        changed(state->value(index));
    });
    return slider;
}

QDoubleSpinBox* make_counter(QWidget* parent,
                            const std::shared_ptr<RangeState>& state,
                            double initial,
                            const std::function<void(double)>& changed)
{
    auto* counter = new QDoubleSpinBox(parent);
    counter->setRange(state->start, state->stop);
    counter->setSingleStep(state->step);
    int decimals = 0;
    if (!state->integral) {
        double scaled_step = std::abs(state->step);
        while (decimals < 12 &&
               std::abs(scaled_step - std::round(scaled_step)) > 1e-12) {
            scaled_step *= 10.0;
            ++decimals;
        }
        decimals = decimals == 0 ? (state->stop < 100.0 ? 1 : 0)
                                 : std::min(13, decimals + 2);
    }
    counter->setDecimals(decimals);
    counter->setKeyboardTracking(false);
    counter->setValue(initial);
    QObject::connect(counter,
                     qOverload<double>(&QDoubleSpinBox::valueChanged),
                     counter,
                     [state, changed](double value) { changed(state->normalize(value)); });
    return counter;
}

QLineEdit* make_engineering_entry(QWidget* parent,
                                  const std::shared_ptr<RangeState>& state,
                                  double initial,
                                  const std::function<void(double)>& changed)
{
    auto* entry = new QLineEdit(QString::number(initial, 'g', 12), parent);
    entry->setMaximumWidth(100);
    QObject::connect(entry, &QLineEdit::editingFinished, entry, [entry, state, changed] {
        bool ok = false;
        const double value = engineering_value(entry->text(), &ok);
        if (!ok) {
            entry->setStyleSheet(QStringLiteral("background-color: #fff59d; color: black"));
            return;
        }
        entry->setStyleSheet(QString());
        const double normalized = state->normalize(value);
        entry->setText(QString::number(normalized, 'g', 12));
        changed(normalized);
    });
    return entry;
}

BuiltBlock make_range(const json& p)
{
    const double start = p.value("start", 0.0);
    const double stop = p.value("stop", 100.0);
    const double step = p.value("step", 1.0);
    if (!std::isfinite(start) || !std::isfinite(stop) || !std::isfinite(step) ||
        start > stop || step <= 0.0)
        throw std::runtime_error("QT GUI Range requires start <= stop and step > 0");

    auto state = std::make_shared<RangeState>(RangeState{
        start, stop, step, p.value("rangeType", std::string("float")) == "int", {}
    });
    const double initial = state->normalize(p.value("value", 50.0));
    const int minimum_length = std::max(1, p.value("min_len", 200));
    const std::string orientation_name = p.value("orient", std::string("horizontal"));
    const auto orientation = orientation_name == "vertical" ||
                                     orientation_name.find("Vertical") != std::string::npos
                                 ? Qt::Vertical
                                 : Qt::Horizontal;
    const std::string style = p.value("widget", std::string("counter_slider"));

    auto* widget = new QWidget;
    auto* layout = new QHBoxLayout(widget);
    layout->setContentsMargins(0, 0, 0, 0);
    QString label = QString::fromStdString(p.value("label", std::string()));
    if (label.isEmpty())
        label = QString::fromStdString(p.value("__name", std::string("Range")));
    layout->addWidget(new QLabel(label, widget));

    auto publish = [state](double value) { state->publish(value); };
    if (style == "dial") {
        auto* dial = new QDial(widget);
        dial->setRange(0, state->steps());
        dial->setSingleStep(1);
        dial->setNotchesVisible(true);
        dial->setValue(state->index(initial));
        QObject::connect(dial, &QDial::valueChanged, dial, [state](int index) {
            state->publish(state->value(index));
        });
        layout->addWidget(dial);
    } else if (style == "slider") {
        layout->addWidget(
            make_slider(widget, state, orientation, minimum_length, initial, publish));
    } else if (style == "counter") {
        layout->addWidget(make_counter(widget, state, initial, publish));
    } else if (style == "eng") {
        layout->addWidget(make_engineering_entry(widget, state, initial, publish));
    } else if (style == "eng_slider") {
        auto entry_ref = std::make_shared<QPointer<QLineEdit>>();
        auto* slider = make_slider(widget, state, orientation, minimum_length, initial,
                             [entry_ref, state](double value) {
                                 if (*entry_ref) {
                                     QSignalBlocker blocked(*entry_ref);
                                     (*entry_ref)->setText(QString::number(value, 'g', 12));
                                 }
                                 state->publish(value);
                             });
        auto* entry = make_engineering_entry(widget, state, initial, [slider, state](double value) {
            QSignalBlocker blocked(slider);
            slider->setValue(state->index(value));
            state->publish(value);
        });
        *entry_ref = entry;
        layout->addWidget(slider);
        layout->addWidget(entry);
    } else {
        auto counter_ref = std::make_shared<QPointer<QDoubleSpinBox>>();
        auto* slider = make_slider(widget, state, orientation, minimum_length, initial,
                             [counter_ref, state](double value) {
                                 if (*counter_ref) {
                                     QSignalBlocker blocked(*counter_ref);
                                     (*counter_ref)->setValue(value);
                                 }
                                 state->publish(value);
                             });
        auto* counter = make_counter(widget, state, initial, [slider, state](double value) {
            QSignalBlocker blocked(slider);
            slider->setValue(state->index(value));
            state->publish(value);
        });
        *counter_ref = counter;
        layout->addWidget(slider);
        layout->addWidget(counter);
    }

    BuiltBlock result;
    result.widget = widget;
    result.is_variable = true;
    result.variable_value = initial;
    result.subscribe = [state](std::function<void(double)> subscriber) {
        state->subscribers.push_back(std::move(subscriber));
    };
    return result;
}

} // namespace

const std::map<std::string, Factory>& block_registry() {
    static const std::map<std::string, Factory> reg = {
        // ---- variables / controls ----
        {"variable_qtgui_range", [](const json& p) -> BuiltBlock {
             return make_range(p);
         }},
        // ---- sources ----
        {"analog_sig_source_x", [](const json& p) -> BuiltBlock {
             double sr = p.value("samp_rate", 32000.0);
             auto wf = waveform_from(p.value("waveform", std::string("cos")));
             double fr = p.value("frequency", p.value("freq", 1000.0)), a = p.value("amplitude", 1.0),
                    off = p.value("offset", 0.0), ph = p.value("phase", 0.0);
             if (is_float(p)) {
                 auto b = gr::analog::sig_source_f::make(sr, wf, fr, a, off, ph);
                 BuiltBlock result{ b };
                 result.numeric_setters = {
                     { "samp_rate", [b](double value) { b->set_sampling_freq(value); } },
                     { "frequency", [b](double value) { b->set_frequency(value); } },
                     { "freq", [b](double value) { b->set_frequency(value); } },
                     { "amplitude", [b](double value) { b->set_amplitude(value); } },
                     { "offset", [b](double value) { b->set_offset(static_cast<float>(value)); } },
                     { "phase", [b](double value) { b->set_phase(static_cast<float>(value)); } },
                 };
                 return result;
             }
             auto b = gr::analog::sig_source_c::make(sr, wf, fr, a, off, ph);
             BuiltBlock result{ b };
             result.numeric_setters = {
                 { "samp_rate", [b](double value) { b->set_sampling_freq(value); } },
                 { "frequency", [b](double value) { b->set_frequency(value); } },
                 { "freq", [b](double value) { b->set_frequency(value); } },
                 { "amplitude", [b](double value) { b->set_amplitude(value); } },
                 { "offset", [b](double value) { b->set_offset(gr_complex(value, 0)); } },
                 { "phase", [b](double value) { b->set_phase(static_cast<float>(value)); } },
             };
             return result;
         }},
        {"analog_noise_source_x", [](const json& p) -> BuiltBlock {
             double a = p.value("amplitude", 1.0); long s = p.value("seed", 0);
             if (is_float(p)) {
                 auto b = gr::analog::noise_source_f::make(gr::analog::GR_GAUSSIAN, a, s);
                 BuiltBlock result{ b };
                 result.numeric_setters["amplitude"] =
                     [b](double value) { b->set_amplitude(static_cast<float>(value)); };
                 return result;
             }
             auto b = gr::analog::noise_source_c::make(gr::analog::GR_GAUSSIAN, a, s);
             BuiltBlock result{ b };
             result.numeric_setters["amplitude"] =
                 [b](double value) { b->set_amplitude(static_cast<float>(value)); };
             return result;
         }},
        {"blocks_null_source", [](const json& p) -> BuiltBlock {
             return { gr::blocks::null_source::make(itemsize_of(p)), nullptr };
         }},
        // ---- flow control ----
        {"blocks_throttle", [](const json& p) -> BuiltBlock {
             auto b = gr::blocks::throttle::make(
                 itemsize_of(p), p.value("samp_rate", 32000.0), true);
             BuiltBlock result{ b };
             result.numeric_setters["samp_rate"] =
                 [b](double value) { b->set_sample_rate(value); };
             return result;
         }},
        {"blocks_head", [](const json& p) -> BuiltBlock {
             auto b = gr::blocks::head::make(
                 itemsize_of(p), static_cast<uint64_t>(p.value("num_items", 1000000.0)));
             BuiltBlock result{ b };
             result.numeric_setters["num_items"] = [b](double value) {
                 b->set_length(static_cast<uint64_t>(std::max(0.0, value)));
             };
             return result;
         }},
        {"blocks_delay", [](const json& p) -> BuiltBlock {
             // Sets history = delay+1, so it exercises the history path (like the qtgui sinks).
             auto b = gr::blocks::delay::make(itemsize_of(p), p.value("delay", 1));
             BuiltBlock result{ b };
             result.numeric_setters["delay"] =
                 [b](double value) { b->set_dly(static_cast<int>(value)); };
             return result;
         }},
        // ---- math (type-parameterized) ----
        {"blocks_add_xx", [](const json& p) -> BuiltBlock {
             return { is_float(p) ? (gr::basic_block_sptr)gr::blocks::add_ff::make(1)
                                  : (gr::basic_block_sptr)gr::blocks::add_cc::make(1), nullptr }; }},
        {"blocks_sub_xx", [](const json& p) -> BuiltBlock {
             return { is_float(p) ? (gr::basic_block_sptr)gr::blocks::sub_ff::make(1)
                                  : (gr::basic_block_sptr)gr::blocks::sub_cc::make(1), nullptr }; }},
        {"blocks_multiply_xx", [](const json& p) -> BuiltBlock {
             return { is_float(p) ? (gr::basic_block_sptr)gr::blocks::multiply_ff::make(1)
                                  : (gr::basic_block_sptr)gr::blocks::multiply_cc::make(1), nullptr }; }},
        {"blocks_divide_xx", [](const json& p) -> BuiltBlock {
             return { is_float(p) ? (gr::basic_block_sptr)gr::blocks::divide_ff::make(1)
                                  : (gr::basic_block_sptr)gr::blocks::divide_cc::make(1), nullptr }; }},
        {"blocks_multiply_const_xx", [](const json& p) -> BuiltBlock {
             double k = p.value("constant", 1.0);
             if (is_float(p)) {
                 auto b = gr::blocks::multiply_const_ff::make(static_cast<float>(k));
                 BuiltBlock result{ b };
                 result.numeric_setters["constant"] =
                     [b](double value) { b->set_k(static_cast<float>(value)); };
                 return result;
             }
             auto b = gr::blocks::multiply_const_cc::make(gr_complex(k, 0));
             BuiltBlock result{ b };
             result.numeric_setters["constant"] =
                 [b](double value) { b->set_k(gr_complex(value, 0)); };
             return result;
         }},
        {"blocks_conjugate_cc", [](const json&) -> BuiltBlock { return { gr::blocks::conjugate_cc::make(), nullptr }; }},
        // ---- type converters (complex in -> float out, etc.) ----
        {"blocks_complex_to_mag", [](const json&) -> BuiltBlock { return { gr::blocks::complex_to_mag::make(1), nullptr }; }},
        {"blocks_complex_to_mag_squared", [](const json&) -> BuiltBlock { return { gr::blocks::complex_to_mag_squared::make(1), nullptr }; }},
        {"blocks_complex_to_float", [](const json&) -> BuiltBlock { return { gr::blocks::complex_to_float::make(1), nullptr }; }},
        {"blocks_float_to_complex", [](const json&) -> BuiltBlock { return { gr::blocks::float_to_complex::make(1), nullptr }; }},
        // ---- sinks ----
        {"blocks_null_sink", [](const json& p) -> BuiltBlock {
             return { gr::blocks::null_sink::make(itemsize_of(p)), nullptr };
         }},
        {"qtgui_time_sink_x", [](const json& p) -> BuiltBlock {
             int n = p.value("size", 1024); double sr = p.value("samp_rate", 32000.0);
             std::string nm = p.value("name", std::string("Scope")); int nc = p.value("nconnections", 1);
             if (is_float(p)) {
                 auto b = gr::qtgui::time_sink_f::make(n, sr, nm, nc);
                 BuiltBlock result{ b, b->qwidget() };
                 result.numeric_setters["samp_rate"] =
                     [b](double value) { b->set_samp_rate(value); };
                 return result;
             }
             auto b = gr::qtgui::time_sink_c::make(n, sr, nm, nc);
             BuiltBlock result{ b, b->qwidget() };
             result.numeric_setters["samp_rate"] =
                 [b](double value) { b->set_samp_rate(value); };
             return result;
         }},
        {"qtgui_freq_sink_x", [](const json& p) -> BuiltBlock {
             double sr = p.value("samp_rate", 32000.0);
             const double initial_fc = p.value("fc", 0.0);
             const double initial_bw = p.value("bw", sr);
             auto b = gr::qtgui::freq_sink_c::make(p.value("fftsize", 1024),
                 p.value("wintype", 5), initial_fc, initial_bw,
                 p.value("name", std::string("Spectrum")), p.value("nconnections", 1));
             auto range = std::make_shared<std::pair<double, double>>(initial_fc, initial_bw);
             BuiltBlock result{ b, b->qwidget() };
             result.numeric_setters["fftsize"] =
                 [b](double value) { b->set_fft_size(static_cast<int>(value)); };
             result.numeric_setters["fc"] = [b, range](double value) {
                 range->first = value;
                 b->set_frequency_range(range->first, range->second);
             };
             auto set_bandwidth = [b, range](double value) {
                 range->second = value;
                 b->set_frequency_range(range->first, range->second);
             };
             result.numeric_setters["bw"] = set_bandwidth;
             result.numeric_setters["samp_rate"] = set_bandwidth;
             return result;
         }},
    };
    return reg;
}
