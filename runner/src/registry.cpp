#include "registry.hpp"
#include <emscripten.h>
#include <gnuradio/analog/sig_source.h>
#include <gnuradio/analog/noise_source.h>
#include <gnuradio/analog/random_uniform_source.h>
#include <gnuradio/blocks/throttle.h>
#include <gnuradio/blocks/vector_source.h>
#include <gnuradio/blocks/packed_to_unpacked.h>
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
#include <gnuradio/blocks/interleaved_short_to_complex.h>
#include <gnuradio/digital/chunks_to_symbols.h>
#include <gnuradio/digital/diff_encoder_bb.h>
#include <gnuradio/digital/map_bb.h>
#include <gnuradio/filter/firdes.h>
#include <gnuradio/filter/pfb_arb_resampler_ccf.h>
#include <gnuradio/hier_block2.h>
#include <gnuradio/io_signature.h>
#include <gnuradio/endianness.h>
#include <gnuradio/qtgui/time_sink_c.h>
#include <gnuradio/qtgui/time_sink_f.h>
#include <gnuradio/qtgui/freq_sink_c.h>
#include <gnuradio/qtgui/const_sink_c.h>
#include <gnuradio/qtgui/waterfall_sink_c.h>
#include <gnuradio/qtgui/waterfall_sink_f.h>
#include <QBoxLayout>
#include <QButtonGroup>
#include <QComboBox>
#include <QDial>
#include <QDoubleSpinBox>
#include <QGroupBox>
#include <QHBoxLayout>
#include <QLabel>
#include <QLineEdit>
#include <QPointer>
#include <QPushButton>
#include <QRadioButton>
#include <QSignalBlocker>
#include <QSlider>
#include <QStringList>
#include <QVBoxLayout>
#include <QWidget>
#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <limits>
#include <memory>
#include <random>
#include <stdexcept>
#include <vector>

using nlohmann::json;

EM_JS(double, browser_recording_size, (const char* filename), {
    var path = UTF8ToString(filename);
    var files = window.__grRecordingData;
    var data = files && files[path];
    return data ? data.byteLength : -1;
});

EM_JS(int,
      browser_recording_copy,
      (const char* filename, double byte_offset, unsigned char* destination, int length),
      {
          var path = UTF8ToString(filename);
          var files = window.__grRecordingData;
          var data = files && files[path];
          if (!data)
              return 0;
          var begin = Number(byte_offset);
          var end = begin + length;
          if (begin < 0 || end > data.byteLength)
              return 0;
          HEAPU8.set(data.subarray(begin, end), destination);
          return length;
      });

static gr::analog::gr_waveform_t waveform_from(const std::string& s) {
    // Accept both GRC constants ("analog.GR_COS_WAVE") and the old shorthand
    // ("cos"). Match COS before SIN because "cosine" contains "sin".
    std::string u = s;
    std::transform(u.begin(), u.end(), u.begin(),
                   [](unsigned char c) { return static_cast<char>(std::toupper(c)); });
    if (u.find("CONST") != std::string::npos) return gr::analog::GR_CONST_WAVE;
    if (u.find("COS") != std::string::npos) return gr::analog::GR_COS_WAVE;
    if (u.find("SIN") != std::string::npos) return gr::analog::GR_SIN_WAVE;
    if (u.find("SQR") != std::string::npos || u.find("SQUARE") != std::string::npos)
        return gr::analog::GR_SQR_WAVE;
    if (u.find("TRI") != std::string::npos) return gr::analog::GR_TRI_WAVE;
    if (u.find("SAW") != std::string::npos) return gr::analog::GR_SAW_WAVE;
    return gr::analog::GR_COS_WAVE;
}
// Many blocks are type-parameterized (like GRC): a "type" param selects the C++ type.
static bool is_float(const json& p) { return p.value("type", std::string("complex")) == "float"; }
static int itemsize_of(const json& p)
{
    const std::string type = p.value("type", std::string("complex"));
    if (type == "complex") return sizeof(gr_complex);
    if (type == "float" || type == "int") return sizeof(std::int32_t);
    if (type == "short") return sizeof(std::int16_t);
    if (type == "byte") return sizeof(std::int8_t);
    throw std::runtime_error("unsupported stream type: " + type);
}

static std::string type_from(const json& p, const std::string& fallback)
{
    return p.value("type", fallback);
}

static bool bool_from(const json& p, const std::string& key, bool fallback)
{
    auto it = p.find(key);
    if (it == p.end())
        return fallback;
    if (it->is_boolean())
        return it->get<bool>();
    if (it->is_number())
        return it->get<double>() != 0.0;
    if (it->is_string()) {
        std::string value = it->get<std::string>();
        std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) {
            return static_cast<char>(std::tolower(c));
        });
        return value == "true" || value == "yes" || value == "on" || value == "1";
    }
    return fallback;
}

// POSIX reads of browser-backed files are unreliable once GNU Radio's scheduler
// pthreads start. For the browser's MB-scale recording workflow, copy the
// selected region directly from the runner page's Uint8Array while factories
// are built on the main thread, then stream shared WASM memory with vector_source.
template <typename T>
static BuiltBlock memory_file_source(const json& p)
{
    const std::string filename = p.value("file", std::string());
    const unsigned int vlen =
        static_cast<unsigned int>(std::max(1, p.value("vlen", 1)));
    const std::uint64_t offset_items = p.value("offset", std::uint64_t{ 0 });
    const std::uint64_t requested_items = p.value("length", std::uint64_t{ 0 });
    const bool repeat = bool_from(p, "repeat", true);

    const double browser_size = browser_recording_size(filename.c_str());
    if (browser_size < 0)
        throw std::runtime_error("recording is not loaded client-side: " + filename);
    const std::uint64_t bytes_per_item = sizeof(T) * std::uint64_t(vlen);
    const std::uint64_t available_items =
        static_cast<std::uint64_t>(browser_size) / bytes_per_item;
    if (offset_items >= available_items)
        throw std::runtime_error("file is too small for the requested offset");
    const std::uint64_t remaining_items = available_items - offset_items;
    const std::uint64_t selected_items =
        requested_items == 0 ? remaining_items : std::min(requested_items, remaining_items);
    if (selected_items > std::numeric_limits<std::size_t>::max() / vlen)
        throw std::runtime_error("file selection is too large for browser memory");

    std::vector<T> data(static_cast<std::size_t>(selected_items) * vlen);
    const std::size_t selected_bytes = data.size() * sizeof(T);
    if (selected_bytes > static_cast<std::size_t>(std::numeric_limits<int>::max()))
        throw std::runtime_error("file selection is too large for browser memory");
    const std::uint64_t byte_offset = offset_items * bytes_per_item;
    if (browser_recording_copy(filename.c_str(),
                               static_cast<double>(byte_offset),
                               reinterpret_cast<unsigned char*>(data.data()),
                               static_cast<int>(selected_bytes)) !=
        static_cast<int>(selected_bytes))
        throw std::runtime_error("can't copy recording into WASM memory");
    auto block = gr::blocks::vector_source<T>::make(
        data, repeat, vlen, std::vector<gr::tag_t>{});
    return { block, nullptr };
}

static double number_from(const json& p, const std::string& key, double fallback)
{
    auto it = p.find(key);
    if (it == p.end())
        return fallback;
    if (it->is_number())
        return it->get<double>();
    if (it->is_string()) {
        const std::string value = it->get<std::string>();
        std::size_t used = 0;
        const double parsed = std::stod(value, &used);
        if (used == value.size())
            return parsed;
    }
    throw std::runtime_error(key + " must be numeric");
}

static std::string unquoted(std::string value)
{
    if (value.size() >= 2 &&
        ((value.front() == '\"' && value.back() == '\"') ||
         (value.front() == '\'' && value.back() == '\'')))
        return value.substr(1, value.size() - 2);
    return value;
}

static std::string uppercase(std::string value)
{
    std::transform(value.begin(), value.end(), value.begin(), [](unsigned char c) {
        return static_cast<char>(std::toupper(c));
    });
    return value;
}

static gr::qtgui::trigger_mode trigger_mode_from(const json& p)
{
    const std::string mode = uppercase(
        p.value("tr_mode", std::string("qtgui.TRIG_MODE_FREE")));
    if (mode.find("AUTO") != std::string::npos)
        return gr::qtgui::TRIG_MODE_AUTO;
    if (mode.find("NORM") != std::string::npos)
        return gr::qtgui::TRIG_MODE_NORM;
    if (mode.find("TAG") != std::string::npos)
        return gr::qtgui::TRIG_MODE_TAG;
    return gr::qtgui::TRIG_MODE_FREE;
}

static gr::qtgui::trigger_slope trigger_slope_from(const json& p)
{
    const std::string slope = uppercase(
        p.value("tr_slope", std::string("qtgui.TRIG_SLOPE_POS")));
    return slope.find("NEG") != std::string::npos ? gr::qtgui::TRIG_SLOPE_NEG
                                                   : gr::qtgui::TRIG_SLOPE_POS;
}

template <typename Sink>
static void configure_first_line(const std::shared_ptr<Sink>& sink, const json& p)
{
    if (auto it = p.find("label1"); it != p.end() && it->is_string())
        sink->set_line_label(0, unquoted(it->get<std::string>()));
    sink->set_line_color(0, unquoted(p.value("color1", std::string("blue"))));
    sink->set_line_width(0, static_cast<int>(number_from(p, "width1", 1)));
    sink->set_line_style(0, static_cast<int>(number_from(p, "style1", 1)));
    sink->set_line_marker(0, static_cast<int>(number_from(p, "marker1", 0)));
    sink->set_line_alpha(0, number_from(p, "alpha1", 1.0));
}

template <typename Sink>
static void configure_time_sink(const std::shared_ptr<Sink>& sink, const json& p)
{
    sink->set_y_label(unquoted(p.value("ylabel", std::string("Amplitude"))),
                      unquoted(p.value("yunit", std::string())));
    sink->set_y_axis(number_from(p, "ymin", -1.0), number_from(p, "ymax", 1.0));
    sink->set_update_time(number_from(p, "update_time", 0.1));
    sink->enable_grid(bool_from(p, "grid", false));
    sink->enable_autoscale(bool_from(p, "autoscale", false));
    sink->enable_control_panel(bool_from(p, "ctrlpanel", false));
    sink->enable_axis_labels(bool_from(p, "axislabels", true));
    sink->enable_stem_plot(bool_from(p, "stemplot", false));
    if (!bool_from(p, "legend", true))
        sink->disable_legend();
    configure_first_line(sink, p);
    sink->set_trigger_mode(trigger_mode_from(p),
                           trigger_slope_from(p),
                           static_cast<float>(number_from(p, "tr_level", 0.0)),
                           static_cast<float>(number_from(p, "tr_delay", 0.0)),
                           static_cast<int>(number_from(p, "tr_chan", 0)),
                           unquoted(p.value("tr_tag", std::string())));
}

template <typename Sink>
static void configure_freq_sink(const std::shared_ptr<Sink>& sink, const json& p)
{
    sink->set_y_axis(number_from(p, "ymin", -140.0),
                     number_from(p, "ymax", 10.0));
    sink->set_update_time(number_from(p, "update_time", 0.1));
    sink->enable_grid(bool_from(p, "grid", false));
    sink->enable_autoscale(bool_from(p, "autoscale", false));
    sink->enable_control_panel(bool_from(p, "ctrlpanel", false));
    sink->enable_axis_labels(bool_from(p, "axislabels", true));
    if (!bool_from(p, "legend", true))
        sink->disable_legend();
    configure_first_line(sink, p);
    sink->set_trigger_mode(trigger_mode_from(p),
                           static_cast<float>(number_from(p, "tr_level", 0.0)),
                           static_cast<int>(number_from(p, "tr_chan", 0)),
                           unquoted(p.value("tr_tag", std::string())));
}

template <typename Sink>
static void configure_waterfall_sink(const std::shared_ptr<Sink>& sink,
                                     const json& p,
                                     int nconnections)
{
    sink->set_intensity_range(number_from(p, "int_min", -140.0),
                              number_from(p, "int_max", 10.0));
    sink->set_update_time(number_from(p, "update_time", 0.1));
    sink->enable_grid(bool_from(p, "grid", false));
    sink->enable_axis_labels(bool_from(p, "axislabels", true));
    if (!bool_from(p, "legend", true))
        sink->disable_legend();
    // Per-connection labels, color maps and alphas. GRC's color options map
    // directly onto WaterfallDisplayPlot's intensity color-map ids
    // (0 Multi, 1 White Hot, 2 Black Hot, 3 Incandescent, 5 Sunset, 6 Cool).
    for (int i = 0; i < nconnections; ++i) {
        const std::string suffix = std::to_string(i + 1);
        if (auto it = p.find("label" + suffix); it != p.end() && it->is_string())
            sink->set_line_label(i, unquoted(it->get<std::string>()));
        sink->set_color_map(
            i, static_cast<int>(number_from(p, "color" + suffix, 0)));
        sink->set_line_alpha(i, number_from(p, "alpha" + suffix, 1.0));
    }
}

static gr_complex complex_from(const json& p, const std::string& key)
{
    auto it = p.find(key);
    if (it == p.end())
        return {};
    if (it->is_number())
        return gr_complex(it->get<float>(), 0.0f);
    if (it->is_array() && it->size() == 2)
        return gr_complex((*it)[0].get<float>(), (*it)[1].get<float>());
    if (!it->is_string())
        throw std::runtime_error(key + " must be a number or complex string");

    std::string value = unquoted(it->get<std::string>());
    value.erase(std::remove_if(value.begin(), value.end(), [](unsigned char c) {
        return std::isspace(c);
    }), value.end());
    std::replace(value.begin(), value.end(), 'j', 'i');
    if (value.empty())
        throw std::runtime_error(key + " must not be empty");
    if (value.back() != 'i') {
        std::size_t used = 0;
        const float real = std::stof(value, &used);
        if (used != value.size())
            throw std::runtime_error("invalid complex value for " + key);
        return gr_complex(real, 0.0f);
    }

    value.pop_back();
    std::size_t split = std::string::npos;
    for (std::size_t i = 1; i < value.size(); ++i) {
        if ((value[i] == '+' || value[i] == '-') &&
            value[i - 1] != 'e' && value[i - 1] != 'E')
            split = i;
    }
    const std::string real_part = split == std::string::npos ? "0" : value.substr(0, split);
    std::string imag_part = split == std::string::npos ? value : value.substr(split);
    if (imag_part.empty() || imag_part == "+") imag_part = "1";
    if (imag_part == "-") imag_part = "-1";
    try {
        return gr_complex(std::stof(real_part), std::stof(imag_part));
    } catch (const std::exception&) {
        throw std::runtime_error("invalid complex value for " + key);
    }
}

namespace {

class PskMod : public gr::hier_block2 {
public:
    using sptr = std::shared_ptr<PskMod>;

    static sptr make(unsigned int constellation_points,
                     const std::string& mod_code,
                     bool differential,
                     unsigned int samples_per_symbol,
                     float excess_bw)
    {
        return gnuradio::make_block_sptr<PskMod>(constellation_points,
                                                 mod_code,
                                                 differential,
                                                 samples_per_symbol,
                                                 excess_bw);
    }

    PskMod(unsigned int constellation_points,
           const std::string& mod_code,
           bool differential,
           unsigned int samples_per_symbol,
           float excess_bw)
        : hier_block2("psk_mod",
                      gr::io_signature::make(1, 1, sizeof(std::uint8_t)),
                      gr::io_signature::make(1, 1, sizeof(gr_complex)))
    {
        if (constellation_points < 2 ||
            (constellation_points & (constellation_points - 1)) != 0)
            throw std::runtime_error("PSK Mod constellation points must be a power of two");
        if (samples_per_symbol < 2)
            throw std::runtime_error("PSK Mod samples per symbol must be at least 2");
        if (!std::isfinite(excess_bw) || excess_bw < 0.0f || excess_bw > 1.0f)
            throw std::runtime_error("PSK Mod excess bandwidth must be between 0 and 1");
        if (mod_code != "gray" && mod_code != "none")
            throw std::runtime_error("PSK Mod code must be gray or none");

        unsigned int bits_per_symbol = 0;
        for (unsigned int points = constellation_points; points > 1; points >>= 1)
            ++bits_per_symbol;

        std::vector<gr_complex> points;
        points.reserve(constellation_points);
        const double tau = 2.0 * std::acos(-1.0);
        for (unsigned int i = 0; i < constellation_points; ++i) {
            const double phase = tau * i / constellation_points;
            points.emplace_back(std::cos(phase), std::sin(phase));
        }

        std::vector<int> gray(constellation_points);
        for (unsigned int i = 0; i < constellation_points; ++i)
            gray[i] = static_cast<int>(i ^ (i >> 1));

        // This reproduces digital.psk.psk_mod: differential Gray coding maps
        // symbol indexes before the encoder; non-differential Gray coding
        // instead reorders the constellation table by the inverse code.
        const bool pre_diff_code = mod_code == "gray" && differential;
        if (mod_code == "gray" && !differential) {
            std::vector<unsigned int> inverse(constellation_points);
            for (unsigned int i = 0; i < constellation_points; ++i)
                inverse[gray[i]] = i;
            std::vector<gr_complex> reordered(constellation_points);
            for (unsigned int i = 0; i < constellation_points; ++i)
                reordered[i] = points[inverse[i]];
            points = std::move(reordered);
        }

        auto unpack = gr::blocks::packed_to_unpacked_bb::make(
            bits_per_symbol, gr::GR_MSB_FIRST);
        std::vector<gr::basic_block_sptr> chain{ self(), unpack };
        if (pre_diff_code)
            chain.push_back(gr::digital::map_bb::make(gray));
        if (differential)
            chain.push_back(gr::digital::diff_encoder_bb::make(constellation_points));
        chain.push_back(gr::digital::chunks_to_symbols_bc::make(points));

        constexpr unsigned int nfilts = 32;
        constexpr unsigned int ntaps_per_filter = 11;
        const int ntaps = nfilts * ntaps_per_filter * samples_per_symbol;
        auto taps = gr::filter::firdes::root_raised_cosine(
            nfilts, nfilts, 1.0, excess_bw, ntaps);
        chain.push_back(gr::filter::pfb_arb_resampler_ccf::make(
            static_cast<float>(samples_per_symbol), taps, nfilts));
        chain.push_back(self());

        for (std::size_t i = 1; i < chain.size(); ++i)
            connect(chain[i - 1], 0, chain[i], 0);
    }
};

template <class T>
BuiltBlock make_random_vector_source(const json& p)
{
    const int minimum = static_cast<int>(number_from(p, "min", 0));
    const int maximum = static_cast<int>(number_from(p, "max", 2));
    const int count = static_cast<int>(number_from(p, "num_samps", 1000));
    if (minimum >= maximum)
        throw std::runtime_error("Random Source requires minimum < maximum");
    if (count <= 0)
        throw std::runtime_error("Random Source requires at least one sample");

    std::mt19937 generator(std::random_device{}());
    std::uniform_int_distribution<int> distribution(minimum, maximum - 1);
    std::vector<T> values(static_cast<std::size_t>(count));
    std::generate(values.begin(), values.end(), [&] {
        return static_cast<T>(distribution(generator));
    });
    return { gr::blocks::vector_source<T>::make(
                 values, bool_from(p, "repeat", true)),
             nullptr };
}

template <class T>
BuiltBlock make_constant_source(double value)
{
    auto block = gr::analog::sig_source<T>::make(
        0.0, gr::analog::GR_CONST_WAVE, 0.0, 0.0, static_cast<T>(value));
    BuiltBlock result{ block };
    result.numeric_setters["const"] = [block](double updated) {
        block->set_offset(static_cast<T>(updated));
    };
    return result;
}

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

// Publish/subscribe state for the simple variable controls (Chooser, Push
// Button) that, unlike Range, publish discrete values without normalization.
struct ControlState {
    std::vector<std::function<void(double)>> subscribers;

    void publish(double value)
    {
        for (const auto& subscriber : subscribers)
            subscriber(value);
    }
};

// Split a comma-separated field into trimmed, unquoted pieces. Accepts GRC's
// bracketed raw form ("[0, 1, 2]") as well as a plain list ("0, 1, 2").
QStringList split_list(const QString& text)
{
    QString body = text.trimmed();
    if (body.startsWith('[') && body.endsWith(']'))
        body = body.mid(1, body.size() - 2);
    QStringList pieces;
    if (body.trimmed().isEmpty())
        return pieces;
    for (const QString& raw : body.split(',')) {
        QString piece = raw.trimmed();
        if (piece.size() >= 2 &&
            ((piece.startsWith('\'') && piece.endsWith('\'')) ||
             (piece.startsWith('"') && piece.endsWith('"'))))
            piece = piece.mid(1, piece.size() - 2);
        pieces.push_back(piece);
    }
    return pieces;
}

BuiltBlock make_chooser(const json& p)
{
    // Options are numeric because the WASM variable model carries a double.
    std::vector<double> options;
    for (const QString& piece :
         split_list(QString::fromStdString(p.value("options", std::string("0, 1, 2"))))) {
        bool ok = false;
        const double value = piece.toDouble(&ok);
        options.push_back(ok ? value : static_cast<double>(options.size()));
    }
    if (options.empty())
        throw std::runtime_error("QT GUI Chooser requires at least one option");

    const QStringList labels =
        split_list(QString::fromStdString(p.value("labels", std::string())));
    bool have_labels = false;
    for (const QString& label : labels)
        have_labels = have_labels || !label.isEmpty();
    auto label_for = [&](int i) -> QString {
        if (have_labels && i < labels.size() && !labels[i].isEmpty())
            return labels[i];
        return QString::number(options[i], 'g', 12);
    };

    // Snap the default value onto the closest option so the initial selection
    // and the variable's starting value always agree.
    const double requested = p.value("value", options.front());
    int initial_index = 0;
    for (std::size_t i = 1; i < options.size(); ++i)
        if (std::abs(options[i] - requested) <
            std::abs(options[initial_index] - requested))
            initial_index = static_cast<int>(i);

    auto state = std::make_shared<ControlState>();
    auto option_values = std::make_shared<std::vector<double>>(options);
    QString label = QString::fromStdString(p.value("label", std::string()));
    if (label.isEmpty())
        label = QString::fromStdString(p.value("__name", std::string("Chooser")));

    QWidget* widget = nullptr;
    if (p.value("widget", std::string("combo_box")) == "radio_buttons") {
        const std::string orient = p.value("orient", std::string("Qt.QVBoxLayout"));
        auto* group = new QGroupBox(label);
        // GRC stores "Qt.QHBoxLayout"/"Qt.QVBoxLayout"; also accept the shorthand.
        const bool horizontal = orient == "horizontal" ||
            orient.find("HBox") != std::string::npos ||
            orient.find("Horizontal") != std::string::npos;
        QBoxLayout* box = horizontal
                              ? static_cast<QBoxLayout*>(new QHBoxLayout(group))
                              : static_cast<QBoxLayout*>(new QVBoxLayout(group));
        // Grouping keeps the radio buttons mutually exclusive.
        auto* button_group = new QButtonGroup(group);
        for (std::size_t i = 0; i < options.size(); ++i) {
            auto* radio = new QRadioButton(label_for(static_cast<int>(i)), group);
            radio->setChecked(static_cast<int>(i) == initial_index);
            button_group->addButton(radio, static_cast<int>(i));
            box->addWidget(radio);
            QObject::connect(radio, &QRadioButton::clicked, radio,
                             [state, option_values, i] {
                                 state->publish((*option_values)[i]);
                             });
        }
        widget = group;
    } else {
        widget = new QWidget;
        auto* layout = new QHBoxLayout(widget);
        layout->setContentsMargins(0, 0, 0, 0);
        layout->addWidget(new QLabel(label + ": ", widget));
        auto* combo = new QComboBox(widget);
        for (std::size_t i = 0; i < options.size(); ++i)
            combo->addItem(label_for(static_cast<int>(i)));
        combo->setCurrentIndex(initial_index);
        QObject::connect(combo, &QComboBox::currentIndexChanged, combo,
                         [state, option_values](int i) {
                             if (i >= 0)
                                 state->publish((*option_values)[i]);
                         });
        layout->addWidget(combo);
    }

    BuiltBlock result;
    result.widget = widget;
    result.is_variable = true;
    result.variable_value = options[initial_index];
    result.subscribe = [state](std::function<void(double)> subscriber) {
        state->subscribers.push_back(std::move(subscriber));
    };
    return result;
}

BuiltBlock make_push_button(const json& p)
{
    // A momentary control: the variable takes `pressed` while held and
    // `released` otherwise, mirroring GRC's variable_qtgui_push_button.
    const double pressed = p.value("pressed", 1.0);
    const double released = p.value("released", 0.0);
    const double initial = p.value("value", released);

    auto state = std::make_shared<ControlState>();
    QString label = QString::fromStdString(p.value("label", std::string()));
    if (label.isEmpty())
        label = QString::fromStdString(p.value("__name", std::string("Button")));

    auto* button = new QPushButton(label);
    QObject::connect(button, &QPushButton::pressed, button,
                     [state, pressed] { state->publish(pressed); });
    QObject::connect(button, &QPushButton::released, button,
                     [state, released] { state->publish(released); });

    BuiltBlock result;
    result.widget = button;
    result.is_variable = true;
    result.variable_value = initial;
    result.subscribe = [state](std::function<void(double)> subscriber) {
        state->subscribers.push_back(std::move(subscriber));
    };
    return result;
}

} // namespace

static std::map<std::string, Factory>& registry_storage() {
    static std::map<std::string, Factory> reg = [] {
      std::map<std::string, Factory> reg;
      register_generated_blocks(reg);
      const std::map<std::string, Factory> custom = {
        // ---- variables / controls ----
        {"variable_qtgui_range", [](const json& p) -> BuiltBlock {
             return make_range(p);
         }},
        {"variable_qtgui_chooser", [](const json& p) -> BuiltBlock {
             return make_chooser(p);
         }},
        {"variable_qtgui_push_button", [](const json& p) -> BuiltBlock {
             return make_push_button(p);
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
        {"analog_random_source_x", [](const json& p) -> BuiltBlock {
             const std::string type = type_from(p, "byte");
             if (type == "byte") return make_random_vector_source<std::uint8_t>(p);
             if (type == "short") return make_random_vector_source<std::int16_t>(p);
             if (type == "int") return make_random_vector_source<std::int32_t>(p);
             throw std::runtime_error("Random Source type must be byte, short, or int");
         }},
        {"analog_random_uniform_source_x", [](const json& p) -> BuiltBlock {
             const std::string type = type_from(p, "byte");
             const int minimum = static_cast<int>(number_from(p, "minimum", 0));
             const int maximum = static_cast<int>(number_from(p, "maximum", 2));
             const int seed = static_cast<int>(number_from(p, "seed", 0));
             if (minimum >= maximum)
                 throw std::runtime_error(
                     "Random Uniform Source requires minimum < maximum");
             if (type == "byte")
                 return { gr::analog::random_uniform_source_b::make(
                              minimum, maximum, seed),
                          nullptr };
             if (type == "short")
                 return { gr::analog::random_uniform_source_s::make(
                              minimum, maximum, seed),
                          nullptr };
             if (type == "int")
                 return { gr::analog::random_uniform_source_i::make(
                              minimum, maximum, seed),
                          nullptr };
             throw std::runtime_error(
                 "Random Uniform Source type must be byte, short, or int");
         }},
        {"analog_const_source_x", [](const json& p) -> BuiltBlock {
             const std::string type = type_from(p, "complex");
             if (type == "complex") {
                 const gr_complex value = complex_from(p, "const");
                 auto block = gr::analog::sig_source_c::make(
                     0.0, gr::analog::GR_CONST_WAVE, 0.0, 0.0, value);
                 BuiltBlock result{ block };
                 result.numeric_setters["const"] = [block](double updated) {
                     block->set_offset(gr_complex(updated, 0.0));
                 };
                 return result;
             }
             const double value = number_from(p, "const", 0.0);
             if (type == "float") return make_constant_source<float>(value);
             if (type == "int") return make_constant_source<std::int32_t>(value);
             if (type == "short") return make_constant_source<std::int16_t>(value);
             if (type == "byte") return make_constant_source<std::int8_t>(value);
             throw std::runtime_error(
                 "Constant Source type must be complex, float, int, short, or byte");
         }},
        {"blocks_file_source", [](const json& p) -> BuiltBlock {
             const std::string type = type_from(p, "complex");
             if (type == "complex") return memory_file_source<gr_complex>(p);
             if (type == "float") return memory_file_source<float>(p);
             if (type == "int") return memory_file_source<std::int32_t>(p);
             if (type == "short") return memory_file_source<std::int16_t>(p);
             if (type == "byte") return memory_file_source<std::uint8_t>(p);
             throw std::runtime_error(
                 "File Source type must be complex, float, int, short, or byte");
         }},
        {"blocks_interleaved_short_to_complex", [](const json& p) -> BuiltBlock {
             return {
                 gr::blocks::interleaved_short_to_complex::make(
                     bool_from(p, "vector_input", false),
                     bool_from(p, "swap", false),
                     static_cast<float>(number_from(p, "scale_factor", 1.0))),
                 nullptr
             };
         }},
        {"blocks_null_source", [](const json& p) -> BuiltBlock {
             return { gr::blocks::null_source::make(itemsize_of(p)), nullptr };
         }},
        {"digital_psk_mod", [](const json& p) -> BuiltBlock {
             const int points = static_cast<int>(
                 number_from(p, "constellation_points", 8));
             const int samples_per_symbol = static_cast<int>(
                 number_from(p, "samples_per_symbol", 2));
             std::string mod_code = unquoted(
                 p.value("mod_code", std::string("gray")));
             return { PskMod::make(
                          static_cast<unsigned int>(std::max(0, points)),
                          mod_code,
                          bool_from(p, "differential", true),
                          static_cast<unsigned int>(std::max(0, samples_per_symbol)),
                          static_cast<float>(number_from(p, "excess_bw", 0.35))),
                      nullptr };
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
                 configure_time_sink(b, p);
                 BuiltBlock result{ b, b->qwidget() };
                 result.numeric_setters["samp_rate"] =
                     [b](double value) { b->set_samp_rate(value); };
                 return result;
             }
             auto b = gr::qtgui::time_sink_c::make(n, sr, nm, nc);
             configure_time_sink(b, p);
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
             configure_freq_sink(b, p);
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
        {"qtgui_const_sink_x", [](const json& p) -> BuiltBlock {
             const std::string type = type_from(p, "complex");
             const int connections = type.rfind("msg", 0) == 0
                                         ? 0
                                         : static_cast<int>(number_from(
                                               p, "nconnections", 1));
             if (connections < 0)
                 throw std::runtime_error(
                     "QT GUI Constellation Sink connections cannot be negative");
             auto block = gr::qtgui::const_sink_c::make(
                 static_cast<int>(number_from(p, "size", 1024)),
                 unquoted(p.value("name", std::string("Constellation"))),
                 connections);

             auto x_axis = std::make_shared<std::pair<double, double>>(
                 number_from(p, "xmin", -2.0), number_from(p, "xmax", 2.0));
             auto y_axis = std::make_shared<std::pair<double, double>>(
                 number_from(p, "ymin", -2.0), number_from(p, "ymax", 2.0));
             block->set_x_axis(x_axis->first, x_axis->second);
             block->set_y_axis(y_axis->first, y_axis->second);
             block->set_update_time(number_from(p, "update_time", 0.1));
             block->enable_grid(bool_from(p, "grid", false));
             block->enable_autoscale(bool_from(p, "autoscale", false));
             block->enable_axis_labels(bool_from(p, "axislabels", true));
             if (!bool_from(p, "legend", true))
                 block->disable_legend();

             const std::vector<std::string> default_colors = {
                 "blue", "red", "green", "black", "cyan", "magenta", "yellow"
             };
             for (int i = 0; i < connections; ++i) {
                 const std::string suffix = std::to_string(i + 1);
                 const std::string label_key = "label" + suffix;
                 const std::string color_key = "color" + suffix;
                 if (auto it = p.find(label_key); it != p.end() && it->is_string())
                     block->set_line_label(i, unquoted(it->get<std::string>()));
                 block->set_line_color(
                     i,
                     p.contains(color_key)
                         ? unquoted(p.at(color_key).get<std::string>())
                         : default_colors[static_cast<std::size_t>(i) %
                                          default_colors.size()]);
                 block->set_line_width(
                     i, static_cast<int>(number_from(p, "width" + suffix, 1)));
                 block->set_line_style(
                     i, static_cast<int>(number_from(p, "style" + suffix, 1)));
                 block->set_line_marker(
                     i, static_cast<int>(number_from(p, "marker" + suffix, 0)));
                 block->set_line_alpha(
                     i, number_from(p, "alpha" + suffix, 1.0));
             }

             block->set_trigger_mode(
                 trigger_mode_from(p),
                 trigger_slope_from(p),
                 static_cast<float>(number_from(p, "tr_level", 0.0)),
                 static_cast<int>(number_from(p, "tr_chan", 0)),
                 unquoted(p.value("tr_tag", std::string())));

             BuiltBlock result{ block, block->qwidget() };
             result.numeric_setters["size"] = [block](double value) {
                 block->set_nsamps(static_cast<int>(value));
             };
             result.numeric_setters["update_time"] = [block](double value) {
                 block->set_update_time(value);
             };
             result.numeric_setters["xmin"] = [block, x_axis](double value) {
                 x_axis->first = value;
                 block->set_x_axis(x_axis->first, x_axis->second);
             };
             result.numeric_setters["xmax"] = [block, x_axis](double value) {
                 x_axis->second = value;
                 block->set_x_axis(x_axis->first, x_axis->second);
             };
             result.numeric_setters["ymin"] = [block, y_axis](double value) {
                 y_axis->first = value;
                 block->set_y_axis(y_axis->first, y_axis->second);
             };
             result.numeric_setters["ymax"] = [block, y_axis](double value) {
                 y_axis->second = value;
                 block->set_y_axis(y_axis->first, y_axis->second);
             };
             return result;
         }},
        {"qtgui_waterfall_sink_x", [](const json& p) -> BuiltBlock {
             const std::string type = type_from(p, "complex");
             const double sr = p.value("samp_rate", 32000.0);
             const int fftsize = static_cast<int>(number_from(p, "fftsize", 1024));
             const int wintype = static_cast<int>(number_from(p, "wintype", 0));
             const double initial_fc = number_from(p, "fc", 0.0);
             const double initial_bw = number_from(p, "bw", sr);
             const std::string nm = unquoted(p.value("name", std::string("Waterfall")));
             // Message-mode variants carry no stream inputs.
             const int nconnections = type.rfind("msg", 0) == 0
                                          ? 0
                                          : static_cast<int>(number_from(p, "nconnections", 1));
             if (nconnections < 0)
                 throw std::runtime_error(
                     "QT GUI Waterfall Sink connections cannot be negative");

             auto range = std::make_shared<std::pair<double, double>>(initial_fc, initial_bw);
             auto finish = [&](auto b) -> BuiltBlock {
                 b->set_frequency_range(range->first, range->second);
                 configure_waterfall_sink(b, p, nconnections);
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
             };
             const bool is_float_variant = type == "float" || type == "msg_float";
             if (is_float_variant)
                 return finish(gr::qtgui::waterfall_sink_f::make(
                     fftsize, wintype, initial_fc, initial_bw, nm, nconnections));
             return finish(gr::qtgui::waterfall_sink_c::make(
                 fftsize, wintype, initial_fc, initial_bw, nm, nconnections));
         }},
      };
      // Custom factories intentionally win over generated direct-make factories.
      for (const auto& [id, factory] : custom)
          reg[id] = factory;
      return reg;
    }();
    return reg;
}

const std::map<std::string, Factory>& block_registry() {
    return registry_storage();
}

// Called by dlopen'd category side modules (generated_registry_<m>.cpp) to add
// their factories once the module has been fetched. Capture-less factory function
// pointers cross the dynamic-link boundary with no C++ ABI coupling. emplace() so
// a hand-written custom factory (installed at init) always wins over a generated one.
extern "C" EMSCRIPTEN_KEEPALIVE void wasm_registry_add(
    const char* id, BuiltBlock (*factory)(const nlohmann::json&)) {
    registry_storage().emplace(std::string(id), Factory(factory));
}
