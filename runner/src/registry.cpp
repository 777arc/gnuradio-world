#include "registry.hpp"
#include <emscripten.h>
#include <gnuradio/analog/sig_source.h>
#include <gnuradio/analog/agc2_cc.h>
#include <gnuradio/analog/frequency_modulator_fc.h>
#include <gnuradio/analog/noise_source.h>
#include <gnuradio/analog/pll_refout_cc.h>
#include <gnuradio/analog/quadrature_demod_cf.h>
#include <gnuradio/analog/random_uniform_source.h>
#include <gnuradio/blocks/add_const_ff.h>
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
#include <gnuradio/blocks/complex_to_imag.h>
#include <gnuradio/blocks/float_to_complex.h>
#include <gnuradio/blocks/file_sink.h>
#include <gnuradio/blocks/null_sink.h>
#include <gnuradio/blocks/null_source.h>
#include <gnuradio/blocks/head.h>
#include <gnuradio/blocks/delay.h>
#include <gnuradio/blocks/interleaved_short_to_complex.h>
#include <gnuradio/blocks/rotator_cc.h>
#include <gnuradio/blocks/repack_bits_bb.h>
#include <gnuradio/blocks/skiphead.h>
#include <gnuradio/blocks/tagged_stream_mux.h>
#include <gnuradio/blocks/threshold_ff.h>
#include <gnuradio/blocks/unpack_k_bits_bb.h>
#include <gnuradio/digital/additive_scrambler.h>
#include <gnuradio/digital/chunks_to_symbols.h>
#include <gnuradio/digital/constellation.h>
#include <gnuradio/digital/constellation_decoder_cb.h>
#include <gnuradio/digital/constellation_receiver_cb.h>
#include <gnuradio/digital/crc32_bb.h>
#include <gnuradio/digital/diff_decoder_bb.h>
#include <gnuradio/digital/diff_encoder_bb.h>
#include <gnuradio/digital/fll_band_edge_cc.h>
#include <gnuradio/digital/header_payload_demux.h>
#include <gnuradio/digital/map_bb.h>
#include <gnuradio/digital/ofdm_carrier_allocator_cvc.h>
#include <gnuradio/digital/ofdm_chanest_vcvc.h>
#include <gnuradio/digital/ofdm_cyclic_prefixer.h>
#include <gnuradio/digital/ofdm_equalizer_simpledfe.h>
#include <gnuradio/digital/ofdm_frame_equalizer_vcvc.h>
#include <gnuradio/digital/ofdm_serializer_vcc.h>
#include <gnuradio/digital/ofdm_sync_sc_cfb.h>
#include <gnuradio/digital/packet_header_ofdm.h>
#include <gnuradio/digital/packet_headergenerator_bb.h>
#include <gnuradio/digital/packet_headerparser_b.h>
#include <gnuradio/digital/pfb_clock_sync_ccf.h>
#include <gnuradio/fft/fft_v.h>
#include <gnuradio/fft/window.h>
#include <gnuradio/filter/fft_filter_ccc.h>
#include <gnuradio/filter/fft_filter_fff.h>
#include <gnuradio/filter/firdes.h>
#include <gnuradio/filter/fir_filter_blk.h>
#include <gnuradio/filter/iir_filter_ffd.h>
#include <gnuradio/filter/interp_fir_filter.h>
#include <gnuradio/filter/pm_remez.h>
#include <gnuradio/filter/pfb_arb_resampler_ccf.h>
#include <gnuradio/filter/single_pole_iir_filter_ff.h>
#include <gnuradio/hier_block2.h>
#include <gnuradio/io_signature.h>
#include <gnuradio/sync_block.h>
#include <gnuradio/endianness.h>
#include <gnuradio/qtgui/time_sink_c.h>
#include <gnuradio/qtgui/time_sink_f.h>
#include <gnuradio/qtgui/freq_sink_c.h>
#include <gnuradio/qtgui/const_sink_c.h>
#include <gnuradio/qtgui/waterfall_sink_c.h>
#include <gnuradio/qtgui/waterfall_sink_f.h>
#include <QBoxLayout>
#include <QButtonGroup>
#include <QTimer>
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
#include <atomic>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdlib>
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

// GRC's Average is an enum of FFT smoothing alphas (1.0 = off, down to 0.05 =
// heavy): mag = (1-a)*mag + a*new. Anything outside (0, 1] — including the
// legacy 'False'/'None' spellings and 0, which would freeze the display — means
// no averaging.
static double fft_average_from(const json& p)
{
    auto it = p.find("average");
    if (it == p.end() || it->is_null())
        return 1.0;
    double alpha = 1.0;
    if (it->is_boolean())
        alpha = it->get<bool>() ? 0.1 : 1.0;
    else if (it->is_number())
        alpha = it->get<double>();
    else if (it->is_string()) {
        const std::string value = unquoted(it->get<std::string>());
        if (value == "True")
            alpha = 0.1;
        else if (value != "False" && value != "None" && !value.empty())
            alpha = std::strtod(value.c_str(), nullptr);  // non-throwing; 0 on junk
    }
    return (alpha > 0.0 && alpha <= 1.0) ? alpha : 1.0;
}

template <typename Sink>
static void configure_freq_sink(const std::shared_ptr<Sink>& sink, const json& p)
{
    sink->set_fft_average(static_cast<float>(fft_average_from(p)));
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

// One scalar in Python/GRC spelling ("2", "-1.5", "1+1j", "-1j") -> gr_complex.
static gr_complex complex_from_text(std::string value, const std::string& key)
{
    value = unquoted(value);
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
    return complex_from_text(it->get<std::string>(), key);
}

// ---- GRC "raw" sequence parameters ----------------------------------------
// Vector/matrix parameters (OFDM carrier allocations, pilot symbols, sync words)
// reach the runner as text: a Python or JSON-style literal such as "((-26,-25),)",
// "[[1, 2], [3, 4]]" or "(1+1j, -1j)". The editor evaluates expressions
// (range(), list concatenation, variables) before running, so only literals of
// numbers arrive here.
struct SequenceNode {
    bool is_sequence = false;
    gr_complex value{};
    std::vector<SequenceNode> items;
};

static SequenceNode parse_sequence(const std::string& text,
                                   std::size_t& pos,
                                   const std::string& key)
{
    const auto skip_space = [&] {
        while (pos < text.size() && std::isspace(static_cast<unsigned char>(text[pos])))
            ++pos;
    };
    skip_space();
    if (pos >= text.size())
        throw std::runtime_error(key + " has a malformed sequence");

    const char open = text[pos];
    if (open == '(' || open == '[') {
        const char close = open == '(' ? ')' : ']';
        ++pos;
        SequenceNode node;
        node.is_sequence = true;
        skip_space();
        while (pos < text.size() && text[pos] != close) {
            node.items.push_back(parse_sequence(text, pos, key));
            skip_space();
            if (pos < text.size() && text[pos] == ',') {
                ++pos;
                skip_space();
            }
        }
        if (pos >= text.size())
            throw std::runtime_error(key + " has an unterminated sequence");
        ++pos;  // consume the closing bracket
        return node;
    }

    const std::size_t start = pos;
    while (pos < text.size() && text[pos] != ',' && text[pos] != ')' && text[pos] != ']')
        ++pos;
    SequenceNode node;
    node.value = complex_from_text(text.substr(start, pos - start), key);
    return node;
}

// The parameter's literal text, or an empty string when it is absent or is GRC's
// "unset" spelling (an empty tuple/list), meaning "use the block's default".
static std::string sequence_text(const json& p, const std::string& key)
{
    auto it = p.find(key);
    if (it == p.end() || it->is_null())
        return {};
    const std::string text = it->is_string() ? unquoted(it->get<std::string>()) : it->dump();
    std::string compact;
    for (char c : text) {
        if (!std::isspace(static_cast<unsigned char>(c)))
            compact.push_back(c);
    }
    if (compact.empty() || compact == "()" || compact == "[]" || compact == "(,)" ||
        compact == "None")
        return {};
    return text;
}

static SequenceNode sequence_from(const std::string& text, const std::string& key)
{
    std::size_t pos = 0;
    SequenceNode node = parse_sequence(text, pos, key);
    while (pos < text.size() && std::isspace(static_cast<unsigned char>(text[pos])))
        ++pos;
    if (pos != text.size() || !node.is_sequence)
        throw std::runtime_error(key + " must be a list or tuple");
    return node;
}

template <typename T>
static T sequence_scalar(const SequenceNode& node, const std::string& key);

template <>
gr_complex sequence_scalar<gr_complex>(const SequenceNode& node, const std::string& key)
{
    if (node.is_sequence)
        throw std::runtime_error(key + " is nested more deeply than expected");
    return node.value;
}

template <>
int sequence_scalar<int>(const SequenceNode& node, const std::string& key)
{
    if (node.is_sequence)
        throw std::runtime_error(key + " is nested more deeply than expected");
    if (node.value.imag() != 0.0f)
        throw std::runtime_error(key + " must contain integers");
    return static_cast<int>(std::lround(node.value.real()));
}

template <>
float sequence_scalar<float>(const SequenceNode& node, const std::string& key)
{
    if (node.is_sequence)
        throw std::runtime_error(key + " is nested more deeply than expected");
    if (node.value.imag() != 0.0f)
        throw std::runtime_error(key + " must contain real numbers");
    return node.value.real();
}

// A flat sequence ("(1, 2, 3)") of T; empty when the parameter is unset.
template <typename T>
static std::vector<T> flat_sequence(const json& p, const std::string& key)
{
    const std::string text = sequence_text(p, key);
    if (text.empty())
        return {};
    std::vector<T> values;
    for (const auto& item : sequence_from(text, key).items)
        values.push_back(sequence_scalar<T>(item, key));
    return values;
}

// A sequence of sequences ("((1, 2), (3, 4))") of T, as GRC's carrier/symbol
// allocations are spelled. A flat sequence is accepted as a single row.
// `fallback` is returned when the parameter is unset.
template <typename T>
static std::vector<std::vector<T>> nested_sequence(const json& p,
                                                   const std::string& key,
                                                   std::vector<std::vector<T>> fallback)
{
    const std::string text = sequence_text(p, key);
    if (text.empty())
        return fallback;
    const SequenceNode root = sequence_from(text, key);
    std::vector<std::vector<T>> rows;
    std::vector<T> flat;
    for (const auto& item : root.items) {
        if (!item.is_sequence) {
            flat.push_back(sequence_scalar<T>(item, key));
            continue;
        }
        if (!flat.empty())
            throw std::runtime_error(key + " mixes plain values and sequences");
        std::vector<T> row;
        for (const auto& value : item.items)
            row.push_back(sequence_scalar<T>(value, key));
        rows.push_back(std::move(row));
    }
    if (!flat.empty())
        rows.push_back(std::move(flat));
    if (rows.empty())
        return fallback;
    return rows;
}

namespace {

constexpr double PI = 3.141592653589793238462643383279502884;

void require_positive(const char* name, double value)
{
    if (!std::isfinite(value) || value <= 0.0)
        throw std::runtime_error(std::string(name) + " must be positive");
}

std::vector<float> optfir_low_pass(double gain,
                                   double sample_rate,
                                   double passband,
                                   double stopband,
                                   double passband_ripple_db,
                                   double stopband_atten_db)
{
    require_positive("sample rate", sample_rate);
    if (!(passband > 0.0 && stopband > passband && stopband < sample_rate / 2.0))
        throw std::runtime_error(
            "low-pass frequencies must satisfy 0 < passband < stopband < Nyquist");

    const double pass_dev =
        (std::pow(10.0, passband_ripple_db / 20.0) - 1.0) /
        (std::pow(10.0, passband_ripple_db / 20.0) + 1.0);
    const double stop_dev = std::pow(10.0, -stopband_atten_db / 20.0);
    const double relative_pass_dev = pass_dev / std::abs(gain);
    const double df = std::abs(stopband - passband) / sample_rate;
    const double ddp = std::log10(relative_pass_dev);
    const double dds = std::log10(stop_dev);
    const double dinf =
        ((5.309e-3 * ddp * ddp + 7.114e-2 * ddp - 4.761e-1) * dds) +
        (-2.66e-3 * ddp * ddp - 5.941e-1 * ddp - 4.278e-1);
    const double correction = 11.01217 + 0.5124401 * (ddp - dds);
    const double estimated_length = dinf / df - correction * df + 1.0;
    const int order = static_cast<int>(std::ceil(estimated_length)) - 1;
    if (order <= 0)
        throw std::runtime_error("cannot determine sufficient low-pass filter order");

    const double max_dev = std::max(relative_pass_dev, stop_dev);
    const auto taps = gr::filter::pm_remez(order + 2,
                                           { 0.0,
                                             2.0 * passband / sample_rate,
                                             2.0 * stopband / sample_rate,
                                             1.0 },
                                           { gain, gain, 0.0, 0.0 },
                                           { max_dev / relative_pass_dev,
                                             max_dev / stop_dev },
                                           "bandpass");
    return std::vector<float>(taps.begin(), taps.end());
}

gr::filter::iir_filter_ffd::sptr make_fm_deemph(double sample_rate, double tau)
{
    require_positive("sample rate", sample_rate);
    require_positive("deemphasis tau", tau);
    const double corner = 1.0 / tau;
    const double warped = 2.0 * sample_rate * std::tan(corner / (2.0 * sample_rate));
    const double k = -warped / (2.0 * sample_rate);
    const double pole = (1.0 + k) / (1.0 - k);
    const double b0 = -k / (1.0 - k);
    return gr::filter::iir_filter_ffd::make({ b0, b0 }, { 1.0, -pole }, false);
}

gr::filter::iir_filter_ffd::sptr
make_fm_preemph(double sample_rate, double tau, double high_frequency)
{
    require_positive("sample rate", sample_rate);
    require_positive("preemphasis tau", tau);
    if (high_frequency <= 0.0 || high_frequency >= sample_rate / 2.0)
        high_frequency = 0.925 * sample_rate / 2.0;

    const double low_corner = 1.0 / tau;
    const double high_corner = 2.0 * PI * high_frequency;
    const double warped_low =
        2.0 * sample_rate * std::tan(low_corner / (2.0 * sample_rate));
    const double warped_high =
        2.0 * sample_rate * std::tan(high_corner / (2.0 * sample_rate));
    const double kl = -warped_low / (2.0 * sample_rate);
    const double kh = -warped_high / (2.0 * sample_rate);
    const double zero = (1.0 + kl) / (1.0 - kl);
    const double pole = (1.0 + kh) / (1.0 - kh);
    const double b0 = (1.0 - kl) / (1.0 - kh);
    const double gain = std::abs(1.0 - pole) / (b0 * std::abs(1.0 - zero));
    return gr::filter::iir_filter_ffd::make(
        { gain * b0, -gain * b0 * zero }, { 1.0, -pole }, false);
}

class FmDeemph : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<FmDeemph>;
    static sptr make(double sample_rate, double tau)
    {
        return gnuradio::make_block_sptr<FmDeemph>(sample_rate, tau);
    }

    FmDeemph(double sample_rate, double tau)
        : hier_block2("fm_deemph",
                      gr::io_signature::make(1, 1, sizeof(float)),
                      gr::io_signature::make(1, 1, sizeof(float)))
    {
        auto deemph = make_fm_deemph(sample_rate, tau);
        connect(self(), 0, deemph, 0);
        connect(deemph, 0, self(), 0);
    }
};

class FmPreemph : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<FmPreemph>;
    static sptr make(double sample_rate, double tau, double high_frequency)
    {
        return gnuradio::make_block_sptr<FmPreemph>(
            sample_rate, tau, high_frequency);
    }

    FmPreemph(double sample_rate, double tau, double high_frequency)
        : hier_block2("fm_preemph",
                      gr::io_signature::make(1, 1, sizeof(float)),
                      gr::io_signature::make(1, 1, sizeof(float)))
    {
        auto preemph = make_fm_preemph(sample_rate, tau, high_frequency);
        connect(self(), 0, preemph, 0);
        connect(preemph, 0, self(), 0);
    }
};

class AmDemod : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<AmDemod>;
    static sptr make(double channel_rate,
                     int audio_decimation,
                     double audio_pass,
                     double audio_stop)
    {
        return gnuradio::make_block_sptr<AmDemod>(
            channel_rate, audio_decimation, audio_pass, audio_stop);
    }

    AmDemod(double channel_rate,
            int audio_decimation,
            double audio_pass,
            double audio_stop)
        : hier_block2("am_demod_cf",
                      gr::io_signature::make(1, 1, sizeof(gr_complex)),
                      gr::io_signature::make(1, 1, sizeof(float)))
    {
        if (audio_decimation <= 0)
            throw std::runtime_error("AM Demod audio decimation must be positive");
        auto magnitude = gr::blocks::complex_to_mag::make(1);
        auto dc_remove = gr::blocks::add_const_ff::make(-1.0f);
        auto low_pass = gr::filter::fir_filter_fff::make(
            audio_decimation,
            optfir_low_pass(0.5, channel_rate, audio_pass, audio_stop, 0.1, 60.0));
        connect(self(), 0, magnitude, 0);
        connect(magnitude, 0, dc_remove, 0);
        connect(dc_remove, 0, low_pass, 0);
        connect(low_pass, 0, self(), 0);
    }
};

class FmDemod : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<FmDemod>;
    static sptr make(double channel_rate,
                     int audio_decimation,
                     double deviation,
                     double audio_pass,
                     double audio_stop,
                     double gain,
                     double tau)
    {
        return gnuradio::make_block_sptr<FmDemod>(channel_rate,
                                                  audio_decimation,
                                                  deviation,
                                                  audio_pass,
                                                  audio_stop,
                                                  gain,
                                                  tau);
    }

    FmDemod(double channel_rate,
            int audio_decimation,
            double deviation,
            double audio_pass,
            double audio_stop,
            double gain,
            double tau)
        : hier_block2("fm_demod_cf",
                      gr::io_signature::make(1, 1, sizeof(gr_complex)),
                      gr::io_signature::make(1, 1, sizeof(float)))
    {
        require_positive("FM Demod deviation", deviation);
        if (audio_decimation <= 0)
            throw std::runtime_error("FM Demod audio decimation must be positive");
        auto demod = gr::analog::quadrature_demod_cf::make(
            static_cast<float>(channel_rate / (2.0 * PI * deviation)));
        auto low_pass = gr::filter::fir_filter_fff::make(
            audio_decimation,
            optfir_low_pass(
                gain, channel_rate, audio_pass, audio_stop, 0.1, 60.0));
        connect(self(), 0, demod, 0);
        if (tau > 0.0) {
            auto deemph = make_fm_deemph(channel_rate, tau);
            connect(demod, 0, deemph, 0);
            connect(deemph, 0, low_pass, 0);
        } else {
            connect(demod, 0, low_pass, 0);
        }
        connect(low_pass, 0, self(), 0);
    }
};

class NarrowbandFmRx : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<NarrowbandFmRx>;
    static sptr make(int audio_rate, int quadrature_rate, double tau, double max_deviation)
    {
        return gnuradio::make_block_sptr<NarrowbandFmRx>(
            audio_rate, quadrature_rate, tau, max_deviation);
    }

    NarrowbandFmRx(int audio_rate, int quadrature_rate, double tau, double max_deviation)
        : hier_block2("nbfm_rx",
                      gr::io_signature::make(1, 1, sizeof(gr_complex)),
                      gr::io_signature::make(1, 1, sizeof(float))),
          d_quadrature_rate(quadrature_rate)
    {
        if (audio_rate <= 0 || quadrature_rate <= 0 ||
            quadrature_rate % audio_rate != 0)
            throw std::runtime_error(
                "NBFM Receive quadrature rate must be an integer multiple of audio rate");
        set_max_deviation_checked(max_deviation);
        d_demod = gr::analog::quadrature_demod_cf::make(
            static_cast<float>(quadrature_rate / (2.0 * PI * max_deviation)));
        auto deemph = make_fm_deemph(quadrature_rate, tau);
        auto low_pass = gr::filter::fir_filter_fff::make(
            quadrature_rate / audio_rate,
            gr::filter::firdes::low_pass(1.0,
                                         quadrature_rate,
                                         2700.0,
                                         500.0,
                                         gr::fft::window::WIN_HAMMING));
        connect(self(), 0, d_demod, 0);
        connect(d_demod, 0, deemph, 0);
        connect(deemph, 0, low_pass, 0);
        connect(low_pass, 0, self(), 0);
    }

    void set_max_deviation(double value)
    {
        set_max_deviation_checked(value);
        d_demod->set_gain(static_cast<float>(d_quadrature_rate / (2.0 * PI * value)));
    }

private:
    void set_max_deviation_checked(double value)
    {
        require_positive("NBFM Receive maximum deviation", value);
    }
    int d_quadrature_rate;
    gr::analog::quadrature_demod_cf::sptr d_demod;
};

class FmTx : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<FmTx>;
    static sptr make(const std::string& name,
                     int audio_rate,
                     int quadrature_rate,
                     double tau,
                     double max_deviation,
                     double high_frequency,
                     bool wideband)
    {
        return gnuradio::make_block_sptr<FmTx>(name,
                                               audio_rate,
                                               quadrature_rate,
                                               tau,
                                               max_deviation,
                                               high_frequency,
                                               wideband);
    }

    FmTx(const std::string& name,
         int audio_rate,
         int quadrature_rate,
         double tau,
         double max_deviation,
         double high_frequency,
         bool wideband)
        : hier_block2(name,
                      gr::io_signature::make(1, 1, sizeof(float)),
                      gr::io_signature::make(1, 1, sizeof(gr_complex))),
          d_quadrature_rate(quadrature_rate)
    {
        if (audio_rate <= 0 || quadrature_rate <= 0 ||
            quadrature_rate % audio_rate != 0)
            throw std::runtime_error(
                name + " quadrature rate must be an integer multiple of audio rate");
        require_positive((name + " maximum deviation").c_str(), max_deviation);
        auto preemph = make_fm_preemph(quadrature_rate, tau, high_frequency);
        d_modulator = gr::analog::frequency_modulator_fc::make(
            static_cast<float>(2.0 * PI * max_deviation / quadrature_rate));

        if (audio_rate != quadrature_rate) {
            const int interpolation = quadrature_rate / audio_rate;
            std::vector<float> taps;
            if (wideband) {
                taps = gr::filter::firdes::low_pass(
                    interpolation, quadrature_rate, 19000.0, 4000.0);
            } else {
                taps = optfir_low_pass(
                    interpolation, quadrature_rate, 4500.0, 7000.0, 0.1, 40.0);
            }
            auto interpolator =
                gr::filter::interp_fir_filter_fff::make(interpolation, taps);
            connect(self(), 0, interpolator, 0);
            connect(interpolator, 0, preemph, 0);
        } else {
            connect(self(), 0, preemph, 0);
        }
        connect(preemph, 0, d_modulator, 0);
        connect(d_modulator, 0, self(), 0);
    }

    void set_max_deviation(double value)
    {
        require_positive("FM Transmit maximum deviation", value);
        d_modulator->set_sensitivity(
            static_cast<float>(2.0 * PI * value / d_quadrature_rate));
    }

private:
    int d_quadrature_rate;
    gr::analog::frequency_modulator_fc::sptr d_modulator;
};

class StandardSquelch : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<StandardSquelch>;
    static sptr make(double audio_rate, double threshold)
    {
        return gnuradio::make_block_sptr<StandardSquelch>(audio_rate, threshold);
    }

    StandardSquelch(double audio_rate, double threshold)
        : hier_block2("standard_squelch",
                      gr::io_signature::make(1, 1, sizeof(float)),
                      gr::io_signature::make(1, 1, sizeof(float)))
    {
        require_positive("Standard Squelch audio rate", audio_rate);
        auto input = gr::blocks::add_const_ff::make(0.0f);
        auto low_iir = gr::filter::iir_filter_ffd::make(
            { 0.0193, 0.0, -0.0193 }, { 1.0, 1.9524, -0.9615 });
        auto low_square = gr::blocks::multiply_ff::make(1);
        auto low_smooth =
            gr::filter::single_pole_iir_filter_ff::make(1.0 / (0.01 * audio_rate));
        auto high_iir = gr::filter::iir_filter_ffd::make(
            { 0.0193, 0.0, -0.0193 }, { 1.0, 1.3597, -0.9615 });
        auto high_square = gr::blocks::multiply_ff::make(1);
        auto high_smooth =
            gr::filter::single_pole_iir_filter_ff::make(1.0 / (0.01 * audio_rate));
        auto subtract = gr::blocks::sub_ff::make(1);
        auto add = gr::blocks::add_ff::make(1);
        d_gate = gr::blocks::threshold_ff::make(0.3f, static_cast<float>(threshold), 0.0f);
        auto squelch_lpf =
            gr::filter::single_pole_iir_filter_ff::make(1.0 / (0.01 * audio_rate));
        auto divide = gr::blocks::divide_ff::make(1);
        auto output_multiply = gr::blocks::multiply_ff::make(1);

        connect(self(), 0, input, 0);
        connect(input, 0, output_multiply, 0);
        connect(input, 0, low_iir, 0);
        connect(low_iir, 0, low_square, 0);
        connect(low_iir, 0, low_square, 1);
        connect(low_square, 0, low_smooth, 0);
        connect(low_smooth, 0, subtract, 0);
        connect(low_smooth, 0, add, 0);
        connect(input, 0, high_iir, 0);
        connect(high_iir, 0, high_square, 0);
        connect(high_iir, 0, high_square, 1);
        connect(high_square, 0, high_smooth, 0);
        connect(high_smooth, 0, subtract, 1);
        connect(high_smooth, 0, add, 1);
        connect(subtract, 0, divide, 0);
        connect(add, 0, divide, 1);
        connect(divide, 0, d_gate, 0);
        connect(d_gate, 0, squelch_lpf, 0);
        connect(squelch_lpf, 0, output_multiply, 1);
        connect(output_multiply, 0, self(), 0);
    }

    void set_threshold(double value) { d_gate->set_hi(static_cast<float>(value)); }

private:
    gr::blocks::threshold_ff::sptr d_gate;
};

class WidebandFmRx : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<WidebandFmRx>;
    static sptr make(double quadrature_rate, int audio_decimation, double tau)
    {
        return gnuradio::make_block_sptr<WidebandFmRx>(
            quadrature_rate, audio_decimation, tau);
    }

    WidebandFmRx(double quadrature_rate, int audio_decimation, double tau)
        : hier_block2("wfm_rcv",
                      gr::io_signature::make(1, 1, sizeof(gr_complex)),
                      gr::io_signature::make(1, 1, sizeof(float)))
    {
        require_positive("WBFM Receive quadrature rate", quadrature_rate);
        if (audio_decimation <= 0)
            throw std::runtime_error("WBFM Receive audio decimation must be positive");
        const double audio_rate = quadrature_rate / audio_decimation;
        const double transition = audio_rate / 32.0;
        auto demod = gr::analog::quadrature_demod_cf::make(
            static_cast<float>(quadrature_rate / (2.0 * PI * 75000.0)));
        auto low_pass = gr::filter::fir_filter_fff::make(
            audio_decimation,
            gr::filter::firdes::low_pass(1.0,
                                         quadrature_rate,
                                         audio_rate / 2.0 - transition,
                                         transition,
                                         gr::fft::window::WIN_HAMMING));
        auto deemph = make_fm_deemph(audio_rate, tau);
        connect(self(), 0, demod, 0);
        connect(demod, 0, low_pass, 0);
        connect(low_pass, 0, deemph, 0);
        connect(deemph, 0, self(), 0);
    }
};

class WidebandFmStereoRx : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<WidebandFmStereoRx>;
    static sptr make(double demod_rate, int audio_decimation, double tau)
    {
        return gnuradio::make_block_sptr<WidebandFmStereoRx>(
            demod_rate, audio_decimation, tau);
    }

    WidebandFmStereoRx(double demod_rate, int audio_decimation, double tau)
        : hier_block2("wfm_rcv_pll",
                      gr::io_signature::make(1, 1, sizeof(gr_complex)),
                      gr::io_signature::make(2, 2, sizeof(float)))
    {
        require_positive("WBFM Receive PLL quadrature rate", demod_rate);
        if (audio_decimation <= 0)
            throw std::runtime_error(
                "WBFM Receive PLL audio decimation must be positive");
        const double audio_rate = demod_rate / audio_decimation;
        const auto stereo_carrier_taps = gr::filter::firdes::band_pass(
            -2.0,
            demod_rate,
            37600.0,
            38400.0,
            400.0,
            gr::fft::window::WIN_HAMMING,
            6.76);
        const auto pilot_taps = gr::filter::firdes::complex_band_pass(
            1.0,
            demod_rate,
            18980.0,
            19020.0,
            1500.0,
            gr::fft::window::WIN_HAMMING,
            6.76);
        const auto audio_taps = gr::filter::firdes::low_pass(
            1.0,
            demod_rate,
            15000.0,
            1500.0,
            gr::fft::window::WIN_HAMMING,
            6.76);
        const int sample_delay = static_cast<int>(
            (pilot_taps.size() - 1) / 2 + (stereo_carrier_taps.size() - 1) / 2);

        auto demod = gr::analog::quadrature_demod_cf::make(
            static_cast<float>(demod_rate / (2.0 * PI * 75000.0)));
        auto pilot_bpf = gr::filter::fir_filter_fcc::make(1, pilot_taps);
        pilot_bpf->declare_sample_delay(0);
        auto pll = gr::analog::pll_refout_cc::make(
            0.001f,
            static_cast<float>(2.0 * PI * 19200.0 / demod_rate),
            static_cast<float>(2.0 * PI * 18800.0 / demod_rate));
        auto pilot_multiply = gr::blocks::multiply_cc::make(1);
        auto complex_to_imag = gr::blocks::complex_to_imag::make(1);
        auto stereo_carrier_bpf =
            gr::filter::fft_filter_fff::make(1, stereo_carrier_taps, 1);
        stereo_carrier_bpf->declare_sample_delay(0);
        auto delay = gr::blocks::delay::make(sizeof(float), sample_delay);
        auto stereo_multiply = gr::blocks::multiply_ff::make(1);
        auto stereo_audio_lpf =
            gr::filter::fft_filter_fff::make(audio_decimation, audio_taps, 1);
        stereo_audio_lpf->declare_sample_delay(0);
        auto mono_audio_lpf =
            gr::filter::fft_filter_fff::make(audio_decimation, audio_taps, 1);
        mono_audio_lpf->declare_sample_delay(0);
        auto left_add = gr::blocks::add_ff::make(1);
        auto right_sub = gr::blocks::sub_ff::make(1);
        auto left_deemph = make_fm_deemph(audio_rate, tau);
        auto right_deemph = make_fm_deemph(audio_rate, tau);

        connect(self(), 0, demod, 0);
        connect(demod, 0, delay, 0);
        connect(demod, 0, pilot_bpf, 0);
        connect(pilot_bpf, 0, pll, 0);
        connect(pll, 0, pilot_multiply, 0);
        connect(pll, 0, pilot_multiply, 1);
        connect(pilot_multiply, 0, complex_to_imag, 0);
        connect(complex_to_imag, 0, stereo_carrier_bpf, 0);
        connect(delay, 0, stereo_multiply, 0);
        connect(stereo_carrier_bpf, 0, stereo_multiply, 1);
        connect(stereo_multiply, 0, stereo_audio_lpf, 0);
        connect(delay, 0, mono_audio_lpf, 0);
        connect(stereo_audio_lpf, 0, left_add, 0);
        connect(mono_audio_lpf, 0, left_add, 1);
        connect(mono_audio_lpf, 0, right_sub, 0);
        connect(stereo_audio_lpf, 0, right_sub, 1);
        connect(left_add, 0, left_deemph, 0);
        connect(right_sub, 0, right_deemph, 0);
        connect(left_deemph, 0, self(), 0);
        connect(right_deemph, 0, self(), 1);
    }
};

std::map<std::string, gr::digital::constellation_sptr>& runtime_constellations()
{
    static std::map<std::string, gr::digital::constellation_sptr> objects;
    return objects;
}

gr::digital::constellation::normalization_t normalization_from(const json& p)
{
    std::string value = p.value(
        "normalization", std::string("digital.constellation.AMPLITUDE_NORMALIZATION"));
    if (value.find("NO_NORMALIZATION") != std::string::npos)
        return gr::digital::constellation::NO_NORMALIZATION;
    if (value.find("POWER_NORMALIZATION") != std::string::npos)
        return gr::digital::constellation::POWER_NORMALIZATION;
    return gr::digital::constellation::AMPLITUDE_NORMALIZATION;
}

gr::digital::constellation_sptr named_constellation(const std::string& expression)
{
    const std::string value = unquoted(expression);
    auto found = runtime_constellations().find(value);
    if (found != runtime_constellations().end())
        return found->second;
    if (value.find("constellation_bpsk") != std::string::npos || value == "bpsk")
        return gr::digital::constellation_bpsk::make()->base();
    if (value.find("constellation_dqpsk") != std::string::npos || value == "dqpsk")
        return gr::digital::constellation_dqpsk::make()->base();
    if (value.find("constellation_qpsk") != std::string::npos || value == "qpsk")
        return gr::digital::constellation_qpsk::make()->base();
    if (value.find("constellation_8psk") != std::string::npos || value == "8psk")
        return gr::digital::constellation_8psk::make()->base();
    if (value.find("constellation_16qam") != std::string::npos || value == "16qam")
        return gr::digital::constellation_16qam::make()->base();
    throw std::runtime_error(
        "Constellation Modulator references unknown constellation object: " + value);
}

gr::digital::constellation_sptr make_psk_constellation(unsigned int count,
                                                       const std::string& mod_code,
                                                       bool differential)
{
    if (count < 2 || (count & (count - 1)) != 0)
        throw std::runtime_error("PSK constellation points must be a power of two");
    if (mod_code != "gray" && mod_code != "none")
        throw std::runtime_error("PSK code must be gray or none");

    std::vector<gr_complex> points;
    points.reserve(count);
    for (unsigned int i = 0; i < count; ++i) {
        const double phase = 2.0 * PI * i / count;
        points.emplace_back(std::cos(phase), std::sin(phase));
    }
    std::vector<int> gray(count);
    for (unsigned int i = 0; i < count; ++i)
        gray[i] = static_cast<int>(i ^ (i >> 1));
    std::vector<int> pre_diff;
    if (mod_code == "gray" && differential) {
        pre_diff = gray;
    } else if (mod_code == "gray") {
        std::vector<unsigned int> inverse(count);
        for (unsigned int i = 0; i < count; ++i)
            inverse[gray[i]] = i;
        std::vector<gr_complex> reordered(count);
        for (unsigned int i = 0; i < count; ++i)
            reordered[i] = points[inverse[i]];
        points = std::move(reordered);
    }
    return gr::digital::constellation_psk::make(points, pre_diff, count)->base();
}

class ConstellationModulator : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<ConstellationModulator>;
    static sptr make(gr::digital::constellation_sptr constellation,
                     bool differential,
                     int samples_per_symbol,
                     double excess_bandwidth,
                     bool truncate)
    {
        return gnuradio::make_block_sptr<ConstellationModulator>(std::move(constellation),
                                                                 differential,
                                                                 samples_per_symbol,
                                                                 excess_bandwidth,
                                                                 truncate);
    }

    ConstellationModulator(gr::digital::constellation_sptr constellation,
                           bool differential,
                           int samples_per_symbol,
                           double excess_bandwidth,
                           bool truncate)
        : hier_block2("constellation_modulator",
                      gr::io_signature::make(1, 1, sizeof(std::uint8_t)),
                      gr::io_signature::make(1, 1, sizeof(gr_complex)))
    {
        if (!constellation)
            throw std::runtime_error("Constellation Modulator requires a constellation");
        if (samples_per_symbol < 2)
            throw std::runtime_error(
                "Constellation Modulator samples per symbol must be at least 2");
        if (!std::isfinite(excess_bandwidth) || excess_bandwidth < 0.0 ||
            excess_bandwidth > 1.0)
            throw std::runtime_error(
                "Constellation Modulator excess bandwidth must be between 0 and 1");

        const unsigned int bits_per_symbol = constellation->bits_per_symbol();
        const unsigned int arity = 1u << bits_per_symbol;
        auto unpack =
            gr::blocks::packed_to_unpacked_bb::make(bits_per_symbol, gr::GR_MSB_FIRST);
        std::vector<gr::basic_block_sptr> chain{ self(), unpack };
        if (constellation->apply_pre_diff_code())
            chain.push_back(gr::digital::map_bb::make(constellation->pre_diff_code()));
        if (differential)
            chain.push_back(gr::digital::diff_encoder_bb::make(arity));
        chain.push_back(
            gr::digital::chunks_to_symbols_bc::make(constellation->points()));

        constexpr unsigned int filter_count = 32;
        constexpr unsigned int taps_per_filter = 11;
        const int tap_count = filter_count * taps_per_filter * samples_per_symbol;
        auto taps = gr::filter::firdes::root_raised_cosine(filter_count,
                                                           filter_count,
                                                           1.0,
                                                           excess_bandwidth,
                                                           tap_count);
        chain.push_back(gr::filter::pfb_arb_resampler_ccf::make(
            static_cast<float>(samples_per_symbol), taps, filter_count));
        if (truncate) {
            const double sps = samples_per_symbol;
            const auto delay = static_cast<std::uint64_t>(
                (taps_per_filter * sps * sps - sps) / 2.0);
            chain.push_back(gr::blocks::skiphead::make(sizeof(gr_complex), delay));
        }
        chain.push_back(self());
        for (std::size_t i = 1; i < chain.size(); ++i)
            connect(chain[i - 1], 0, chain[i], 0);
    }
};

class PskDemod : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<PskDemod>;
    static sptr make(unsigned int constellation_points,
                     const std::string& mod_code,
                     bool differential,
                     int samples_per_symbol,
                     double excess_bandwidth,
                     double frequency_bandwidth,
                     double timing_bandwidth,
                     double phase_bandwidth)
    {
        return gnuradio::make_block_sptr<PskDemod>(constellation_points,
                                                   mod_code,
                                                   differential,
                                                   samples_per_symbol,
                                                   excess_bandwidth,
                                                   frequency_bandwidth,
                                                   timing_bandwidth,
                                                   phase_bandwidth);
    }

    PskDemod(unsigned int constellation_points,
             const std::string& mod_code,
             bool differential,
             int samples_per_symbol,
             double excess_bandwidth,
             double frequency_bandwidth,
             double timing_bandwidth,
             double phase_bandwidth)
        : hier_block2("psk_demod",
                      gr::io_signature::make(1, 1, sizeof(gr_complex)),
                      gr::io_signature::make(1, 1, sizeof(std::uint8_t)))
    {
        if (samples_per_symbol < 2)
            throw std::runtime_error("PSK Demod samples per symbol must be at least 2");
        auto constellation =
            make_psk_constellation(constellation_points, mod_code, differential);
        const unsigned int bits_per_symbol = constellation->bits_per_symbol();
        const unsigned int arity = 1u << bits_per_symbol;
        constexpr unsigned int filter_count = 32;
        const int tap_count = 11 * samples_per_symbol * filter_count;

        auto agc = gr::analog::agc2_cc::make(0.06f, 0.001f, 1.0f, 1.0f);
        auto frequency_recovery = gr::digital::fll_band_edge_cc::make(
            samples_per_symbol, excess_bandwidth, 55, frequency_bandwidth);
        auto taps = gr::filter::firdes::root_raised_cosine(filter_count,
                                                           filter_count *
                                                               samples_per_symbol,
                                                           1.0,
                                                           excess_bandwidth,
                                                           tap_count);
        auto timing_recovery = gr::digital::pfb_clock_sync_ccf::make(
            samples_per_symbol,
            timing_bandwidth,
            taps,
            filter_count,
            filter_count / 2,
            1.5f);
        auto receiver = gr::digital::constellation_receiver_cb::make(
            constellation, phase_bandwidth, -0.25f, 0.25f);
        std::vector<gr::basic_block_sptr> chain{
            self(), agc, frequency_recovery, timing_recovery, receiver
        };
        if (differential)
            chain.push_back(gr::digital::diff_decoder_bb::make(arity));
        if (constellation->apply_pre_diff_code()) {
            auto code = constellation->pre_diff_code();
            std::vector<int> inverse(code.size());
            for (std::size_t i = 0; i < code.size(); ++i)
                inverse[code[i]] = static_cast<int>(i);
            chain.push_back(gr::digital::map_bb::make(inverse));
        }
        chain.push_back(gr::blocks::unpack_k_bits_bb::make(bits_per_symbol));
        chain.push_back(self());
        for (std::size_t i = 1; i < chain.size(); ++i)
            connect(chain[i - 1], 0, chain[i], 0);
    }
};

class FrequencyXlatingFftFilter : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<FrequencyXlatingFftFilter>;
    static sptr make(int decimation,
                     const std::vector<gr_complex>& taps,
                     double center_frequency,
                     double sample_rate,
                     int threads,
                     int sample_delay)
    {
        return gnuradio::make_block_sptr<FrequencyXlatingFftFilter>(decimation,
                                                                   taps,
                                                                   center_frequency,
                                                                   sample_rate,
                                                                   threads,
                                                                   sample_delay);
    }

    FrequencyXlatingFftFilter(int decimation,
                              const std::vector<gr_complex>& taps,
                              double center_frequency,
                              double sample_rate,
                              int threads,
                              int sample_delay)
        : hier_block2("freq_xlating_fft_filter_ccc",
                      gr::io_signature::make(1, 1, sizeof(gr_complex)),
                      gr::io_signature::make(1, 1, sizeof(gr_complex))),
          d_decimation(decimation),
          d_taps(taps),
          d_sample_rate(sample_rate),
          d_center_frequency(center_frequency)
    {
        if (decimation <= 0)
            throw std::runtime_error(
                "Frequency Xlating FFT Filter decimation must be positive");
        require_positive("Frequency Xlating FFT Filter sample rate", sample_rate);
        if (taps.empty())
            throw std::runtime_error("Frequency Xlating FFT Filter taps cannot be empty");
        d_filter = gr::filter::fft_filter_ccc::make(
            decimation, rotated_taps(center_frequency), std::max(1, threads));
        d_filter->declare_sample_delay(std::max(0, sample_delay));
        d_rotator = gr::blocks::rotator_cc::make(
            -decimation * 2.0 * PI * center_frequency / sample_rate);
        connect(self(), 0, d_filter, 0);
        connect(d_filter, 0, d_rotator, 0);
        connect(d_rotator, 0, self(), 0);
    }

    void set_center_frequency(double value)
    {
        d_center_frequency = value;
        d_filter->set_taps(rotated_taps(value));
        d_rotator->set_phase_inc(-d_decimation * 2.0 * PI * value / d_sample_rate);
    }

    void set_taps(std::vector<gr_complex> taps)
    {
        if (taps.empty())
            throw std::runtime_error(
                "Frequency Xlating FFT Filter taps cannot be empty");
        d_taps = std::move(taps);
        d_filter->set_taps(rotated_taps(d_center_frequency));
    }

    void set_nthreads(int threads) { d_filter->set_nthreads(std::max(1, threads)); }

private:
    std::vector<gr_complex> rotated_taps(double center_frequency) const
    {
        const double increment = 2.0 * PI * center_frequency / d_sample_rate;
        std::vector<gr_complex> result(d_taps.size());
        for (std::size_t i = 0; i < d_taps.size(); ++i)
            result[i] = d_taps[i] *
                        std::polar(1.0f, static_cast<float>(i * increment));
        return result;
    }

    int d_decimation;
    std::vector<gr_complex> d_taps;
    double d_sample_rate;
    double d_center_frequency;
    gr::filter::fft_filter_ccc::sptr d_filter;
    gr::blocks::rotator_cc::sptr d_rotator;
};

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

// ---------------------------------------------------------------------------
// OFDM Transmitter (digital_ofdm_tx)
//
// gr-digital's OFDM Transmitter is a Python gr.hier_block2 (ofdm_txrx.py), so it
// cannot run in the browser. This is the same composition written as a C++
// hier_block2, including the two generated sync words: numpy's legacy
// RandomState(42) is MT19937 seeded exactly like std::mt19937(42), and
// randint(2) consumes one 32-bit draw and keeps its low bit, so the preambles
// come out bit-identical to the Python block's.
// ---------------------------------------------------------------------------

// 802.11a-style carrier allocation: the defaults of digital.ofdm_tx.
std::vector<std::vector<int>> default_occupied_carriers()
{
    std::vector<int> carriers;
    const int ranges[][2] = { { -26, -21 }, { -20, -7 }, { -6, 0 },
                              { 1, 7 },     { 8, 21 },   { 22, 27 } };
    for (const auto& range : ranges)
        for (int carrier = range[0]; carrier < range[1]; ++carrier)
            carriers.push_back(carrier);
    return { carriers };
}

std::vector<std::vector<int>> default_pilot_carriers() { return { { -21, -7, 7, 21 } }; }

std::vector<std::vector<gr_complex>> default_pilot_symbols()
{
    // _pilot_sym_scramble_seq from ofdm_txrx.py, expanded to (x, x, x, -x).
    static const int scramble[] = {
        1,  1,  1,  1,  -1, -1, -1, 1,  -1, -1, -1, -1, 1,  1,  -1, 1,  -1, -1, 1,
        1,  -1, 1,  1,  -1, 1,  1,  1,  1,  1,  1,  -1, 1,  1,  1,  -1, 1,  1,  -1,
        -1, 1,  1,  1,  -1, 1,  -1, -1, -1, 1,  -1, 1,  -1, -1, 1,  -1, -1, 1,  1,
        1,  1,  1,  -1, -1, 1,  1,  -1, -1, 1,  -1, 1,  -1, 1,  1,  -1, -1, -1, 1,
        1,  -1, -1, -1, -1, 1,  -1, -1, 1,  -1, 1,  1,  1,  1,  -1, 1,  -1, 1,  -1,
        1,  -1, -1, -1, -1, -1, 1,  -1, 1,  1,  -1, 1,  -1, 1,  1,  1,  -1, -1, 1,
        -1, -1, -1, 1,  1,  1,  -1, -1, -1, -1, -1, -1, -1
    };
    std::vector<std::vector<gr_complex>> symbols;
    symbols.reserve(std::size(scramble));
    for (int value : scramble) {
        const gr_complex symbol(static_cast<float>(value), 0.0f);
        symbols.push_back({ symbol, symbol, symbol, -symbol });
    }
    return symbols;
}

// Carriers that ever hold data or pilots, as non-negative FFT bin indexes.
std::vector<int> active_carriers(int fft_len,
                                 const std::vector<std::vector<int>>& occupied_carriers,
                                 const std::vector<std::vector<int>>& pilot_carriers)
{
    std::vector<int> active;
    for (const auto* rows : { &occupied_carriers, &pilot_carriers }) {
        if (rows->empty())
            continue;
        for (int carrier : rows->front())
            active.push_back(carrier < 0 ? carrier + fft_len : carrier);
    }
    return active;
}

// numpy.fft.fftshift: roll right by fft_len // 2.
std::vector<gr_complex> fftshift(const std::vector<gr_complex>& symbols)
{
    const std::size_t len = symbols.size();
    const std::size_t half = len / 2;
    std::vector<gr_complex> shifted(len);
    for (std::size_t i = 0; i < len; ++i)
        shifted[i] = symbols[(i + len - half) % len];
    return shifted;
}

// _make_sync_word1: BPSK on the odd active carriers only (so the time-domain
// symbol has two identical halves for Schmidl & Cox), scaled to keep the energy.
std::vector<gr_complex> make_sync_word1(int fft_len,
                                        const std::vector<std::vector<int>>& occupied,
                                        const std::vector<std::vector<int>>& pilots)
{
    const std::vector<int> active = active_carriers(fft_len, occupied, pilots);
    std::mt19937 generator(42);  // numpy.random.seed(_seq_seed)
    std::vector<gr_complex> word(fft_len, gr_complex(0.0f, 0.0f));
    const float amplitude = static_cast<float>(std::sqrt(2.0));
    for (int carrier = 0; carrier < fft_len; ++carrier) {
        if (carrier % 2 == 0 ||
            std::find(active.begin(), active.end(), carrier) == active.end())
            continue;
        word[carrier] = (generator() & 1u) ? gr_complex(-amplitude, 0.0f)
                                           : gr_complex(amplitude, 0.0f);
    }
    return fftshift(word);
}

// _make_sync_word2: BPSK on every active carrier, DC left empty.
std::vector<gr_complex> make_sync_word2(int fft_len,
                                        const std::vector<std::vector<int>>& occupied,
                                        const std::vector<std::vector<int>>& pilots)
{
    const std::vector<int> active = active_carriers(fft_len, occupied, pilots);
    std::mt19937 generator(42);
    std::vector<gr_complex> word(fft_len, gr_complex(0.0f, 0.0f));
    for (int carrier = 0; carrier < fft_len; ++carrier) {
        if (std::find(active.begin(), active.end(), carrier) == active.end())
            continue;
        word[carrier] = (generator() & 1u) ? gr_complex(-1.0f, 0.0f) : gr_complex(1.0f, 0.0f);
    }
    word[0] = gr_complex(0.0f, 0.0f);
    return fftshift(word);
}

std::vector<gr_complex> constellation_points(int bits_per_symbol)
{
    switch (bits_per_symbol) {
    case 1: return gr::digital::constellation_bpsk::make()->points();
    case 2: return gr::digital::constellation_qpsk::make()->points();
    case 3: return gr::digital::constellation_8psk::make()->points();
    default:
        throw std::runtime_error("OFDM Transmitter supports BPSK, QPSK or 8-PSK only");
    }
}

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

class OfdmTxWasm : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<OfdmTxWasm>;

    static sptr make(int fft_len,
                     int cp_len,
                     const std::string& packet_length_tag_key,
                     const std::vector<std::vector<int>>& occupied_carriers,
                     const std::vector<std::vector<int>>& pilot_carriers,
                     const std::vector<std::vector<gr_complex>>& pilot_symbols,
                     int bps_header,
                     int bps_payload,
                     const std::vector<gr_complex>& sync_word1,
                     const std::vector<gr_complex>& sync_word2,
                     int rolloff,
                     bool scramble_bits)
    {
        return gnuradio::make_block_sptr<OfdmTxWasm>(fft_len,
                                                     cp_len,
                                                     packet_length_tag_key,
                                                     occupied_carriers,
                                                     pilot_carriers,
                                                     pilot_symbols,
                                                     bps_header,
                                                     bps_payload,
                                                     sync_word1,
                                                     sync_word2,
                                                     rolloff,
                                                     scramble_bits);
    }

    OfdmTxWasm(int fft_len,
               int cp_len,
               const std::string& packet_length_tag_key,
               const std::vector<std::vector<int>>& occupied_carriers,
               const std::vector<std::vector<int>>& pilot_carriers,
               const std::vector<std::vector<gr_complex>>& pilot_symbols,
               int bps_header,
               int bps_payload,
               const std::vector<gr_complex>& sync_word1,
               const std::vector<gr_complex>& sync_word2,
               int rolloff,
               bool scramble_bits)
        : hier_block2("ofdm_tx_wasm",
                      gr::io_signature::make(1, 1, sizeof(std::uint8_t)),
                      gr::io_signature::make(1, 1, sizeof(gr_complex)))
    {
        if (fft_len <= 0)
            throw std::runtime_error("OFDM Transmitter FFT length must be positive");
        if (cp_len <= 0 || cp_len >= fft_len)
            throw std::runtime_error(
                "OFDM Transmitter cyclic prefix length must be between 1 and FFT length");
        if (rolloff < 0 || rolloff > cp_len)
            throw std::runtime_error(
                "OFDM Transmitter rolloff length must be between 0 and the cyclic prefix");

        // An empty sync word means "generate one", exactly like the Python block's
        // sync_word1=None / sync_word2=None defaults.
        std::vector<std::vector<gr_complex>> sync_words;
        sync_words.push_back(sync_word1.empty()
                                 ? make_sync_word1(fft_len, occupied_carriers, pilot_carriers)
                                 : sync_word1);
        std::vector<gr_complex> second =
            sync_word2.empty() ? make_sync_word2(fft_len, occupied_carriers, pilot_carriers)
                               : sync_word2;
        if (!second.empty())
            sync_words.push_back(std::move(second));
        for (const auto& word : sync_words) {
            if (static_cast<int>(word.size()) != fft_len)
                throw std::runtime_error(
                    "OFDM Transmitter sync word length must equal the FFT length");
        }

        // Deactivating the scrambler = seeding its LFSR with zeros.
        const std::uint64_t scramble_seed = scramble_bits ? 0x7f : 0x00;

        // ---- header ----
        auto crc = gr::digital::crc32_bb::make(false, packet_length_tag_key, true);
        auto header_mod =
            gr::digital::chunks_to_symbols_bc::make(constellation_points(bps_header));
        auto header_formatter = gr::digital::packet_header_ofdm::make(occupied_carriers,
                                                                      1,
                                                                      "packet_len",
                                                                      "frame_len",
                                                                      "packet_num",
                                                                      bps_header,
                                                                      bps_payload,
                                                                      scramble_bits);
        auto header_gen = gr::digital::packet_headergenerator_bb::make(
            header_formatter->base(), packet_length_tag_key);
        // Head tags on the payload stream stay on the head.
        auto header_payload_mux = gr::blocks::tagged_stream_mux::make(
            sizeof(gr_complex) * 1, packet_length_tag_key, 1);
        connect(self(), 0, crc, 0);
        connect(crc, 0, header_gen, 0);
        connect(header_gen, 0, header_mod, 0);
        connect(header_mod, 0, header_payload_mux, 0);

        // ---- payload ----
        auto payload_mod =
            gr::digital::chunks_to_symbols_bc::make(constellation_points(bps_payload));
        auto payload_scrambler = gr::digital::additive_scrambler_bb::make(
            0x8a,
            scramble_seed,
            7,
            0,  // don't reset after a fixed length; the reset tag does that
            8,  // bits per byte, before unpacking
            packet_length_tag_key);
        auto payload_unpack =
            gr::blocks::repack_bits_bb::make(8, bps_payload, packet_length_tag_key);
        connect(crc, 0, payload_scrambler, 0);
        connect(payload_scrambler, 0, payload_unpack, 0);
        connect(payload_unpack, 0, payload_mod, 0);
        connect(payload_mod, 0, header_payload_mux, 1);

        // ---- OFDM frame ----
        auto allocator = gr::digital::ofdm_carrier_allocator_cvc::make(fft_len,
                                                                       occupied_carriers,
                                                                       pilot_carriers,
                                                                       pilot_symbols,
                                                                       sync_words,
                                                                       packet_length_tag_key);
        auto ffter = gr::fft::fft_v<gr_complex, false>::make(
            fft_len, std::vector<float>(), true);
        auto cyclic_prefixer =
            gr::digital::ofdm_cyclic_prefixer::make(static_cast<std::size_t>(fft_len),
                                                    static_cast<std::size_t>(fft_len + cp_len),
                                                    rolloff,
                                                    packet_length_tag_key);
        connect(header_payload_mux, 0, allocator, 0);
        connect(allocator, 0, ffter, 0);
        connect(ffter, 0, cyclic_prefixer, 0);
        connect(cyclic_prefixer, 0, self(), 0);
    }
};

class OfdmRxWasm : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<OfdmRxWasm>;
    static sptr make(int fft_len,
                     int cp_len,
                     const std::string& frame_length_tag_key,
                     const std::string& packet_length_tag_key,
                     const std::string& packet_number_tag_key,
                     const std::vector<std::vector<int>>& occupied_carriers,
                     const std::vector<std::vector<int>>& pilot_carriers,
                     const std::vector<std::vector<gr_complex>>& pilot_symbols,
                     int bps_header,
                     int bps_payload,
                     const std::vector<gr_complex>& sync_word1,
                     const std::vector<gr_complex>& sync_word2,
                     bool scramble_bits,
                     bool debug_log)
    {
        return gnuradio::make_block_sptr<OfdmRxWasm>(fft_len,
                                                     cp_len,
                                                     frame_length_tag_key,
                                                     packet_length_tag_key,
                                                     packet_number_tag_key,
                                                     occupied_carriers,
                                                     pilot_carriers,
                                                     pilot_symbols,
                                                     bps_header,
                                                     bps_payload,
                                                     sync_word1,
                                                     sync_word2,
                                                     scramble_bits,
                                                     debug_log);
    }

    OfdmRxWasm(int fft_len,
               int cp_len,
               const std::string& frame_length_tag_key,
               const std::string& packet_length_tag_key,
               const std::string& packet_number_tag_key,
               const std::vector<std::vector<int>>& occupied_carriers,
               const std::vector<std::vector<int>>& pilot_carriers,
               const std::vector<std::vector<gr_complex>>& pilot_symbols,
               int bps_header,
               int bps_payload,
               const std::vector<gr_complex>& requested_sync_word1,
               const std::vector<gr_complex>& requested_sync_word2,
               bool scramble_bits,
               bool debug_log)
        : hier_block2("ofdm_rx",
                      gr::io_signature::make(1, 1, sizeof(gr_complex)),
                      gr::io_signature::make(1, 1, sizeof(std::uint8_t)))
    {
        if (fft_len <= 0)
            throw std::runtime_error("OFDM Receiver FFT length must be positive");
        if (cp_len <= 0 || cp_len >= fft_len)
            throw std::runtime_error(
                "OFDM Receiver cyclic prefix length must be between 1 and FFT length");

        const std::vector<gr_complex> sync_word1 =
            requested_sync_word1.empty()
                ? make_sync_word1(fft_len, occupied_carriers, pilot_carriers)
                : requested_sync_word1;
        const std::vector<gr_complex> sync_word2 =
            requested_sync_word2.empty()
                ? make_sync_word2(fft_len, occupied_carriers, pilot_carriers)
                : requested_sync_word2;
        if (static_cast<int>(sync_word1.size()) != fft_len ||
            static_cast<int>(sync_word2.size()) != fft_len)
            throw std::runtime_error(
                "OFDM Receiver sync word length must equal the FFT length");

        bool even_carriers = false;
        bool odd_carriers = false;
        for (int i = 0; i < fft_len; ++i) {
            if (std::norm(sync_word1[static_cast<std::size_t>(i)]) == 0.0f)
                continue;
            (i % 2 == 0 ? even_carriers : odd_carriers) = true;
        }
        if (even_carriers && odd_carriers)
            throw std::runtime_error(
                "OFDM Receiver Sync Word 1 must leave alternating carriers empty");

        // ---- synchronization and header/payload split ----
        auto sync =
            gr::digital::ofdm_sync_sc_cfb::make(fft_len, cp_len, even_carriers);
        auto delay = gr::blocks::delay::make(sizeof(gr_complex), fft_len + cp_len);
        auto oscillator =
            gr::analog::frequency_modulator_fc::make(-2.0f / fft_len);
        auto mixer = gr::blocks::multiply_cc::make(1);
        auto demux = gr::digital::header_payload_demux::make(
            3,
            fft_len,
            cp_len,
            frame_length_tag_key,
            "",
            true,
            sizeof(gr_complex));
        connect(self(), 0, sync, 0);
        connect(self(), 0, delay, 0);
        connect(delay, 0, mixer, 0);
        connect(sync, 0, oscillator, 0);
        connect(oscillator, 0, mixer, 1);
        connect(mixer, 0, demux, 0);
        connect(sync, 1, demux, 1);

        // ---- header ----
        auto header_fft = gr::fft::fft_v<gr_complex, true>::make(
            fft_len, std::vector<float>(), true);
        auto channel_estimator =
            gr::digital::ofdm_chanest_vcvc::make(sync_word1, sync_word2, 1);
        auto header_constellation =
            constellation_for_bits(bps_header);
        auto header_equalizer = gr::digital::ofdm_equalizer_simpledfe::make(
            fft_len,
            header_constellation,
            occupied_carriers,
            pilot_carriers,
            pilot_symbols,
            0);
        auto header_frame_equalizer =
            gr::digital::ofdm_frame_equalizer_vcvc::make(header_equalizer->base(),
                                                         cp_len,
                                                         frame_length_tag_key,
                                                         true,
                                                         1);
        auto header_serializer = gr::digital::ofdm_serializer_vcc::make(
            fft_len, occupied_carriers, frame_length_tag_key);
        auto header_demod =
            gr::digital::constellation_decoder_cb::make(header_constellation);
        auto header_formatter = gr::digital::packet_header_ofdm::make(
            occupied_carriers,
            1,
            packet_length_tag_key,
            frame_length_tag_key,
            packet_number_tag_key,
            bps_header,
            bps_payload,
            scramble_bits);
        auto header_parser =
            gr::digital::packet_headerparser_b::make(header_formatter->formatter());
        connect(demux, 0, header_fft, 0);
        connect(header_fft, 0, channel_estimator, 0);
        connect(channel_estimator, 0, header_frame_equalizer, 0);
        connect(header_frame_equalizer, 0, header_serializer, 0);
        connect(header_serializer, 0, header_demod, 0);
        connect(header_demod, 0, header_parser, 0);
        msg_connect(header_parser, "header_data", demux, "header_data");
        if (debug_log) {
            const auto debug_sink = [](std::size_t item_size, const char* path) {
                auto sink = gr::blocks::file_sink::make(item_size, path, false);
                sink->set_unbuffered(true);
                return sink;
            };
            connect(channel_estimator,
                    0,
                    debug_sink(sizeof(gr_complex) * fft_len,
                               "/ofdm_rx_post_channel_estimator.bin"),
                    0);
            connect(header_frame_equalizer,
                    0,
                    debug_sink(sizeof(gr_complex) * fft_len,
                               "/ofdm_rx_header_equalized.bin"),
                    0);
            connect(header_serializer,
                    0,
                    debug_sink(sizeof(gr_complex),
                               "/ofdm_rx_header_symbols.bin"),
                    0);
            connect(header_demod,
                    0,
                    debug_sink(sizeof(std::uint8_t),
                               "/ofdm_rx_header_bits.bin"),
                    0);
        }

        // ---- payload ----
        auto payload_fft = gr::fft::fft_v<gr_complex, true>::make(
            fft_len, std::vector<float>(), true);
        auto payload_constellation =
            constellation_for_bits(bps_payload);
        auto payload_equalizer = gr::digital::ofdm_equalizer_simpledfe::make(
            fft_len,
            payload_constellation,
            occupied_carriers,
            pilot_carriers,
            pilot_symbols,
            1,
            0.1f);
        auto payload_frame_equalizer =
            gr::digital::ofdm_frame_equalizer_vcvc::make(payload_equalizer->base(),
                                                         cp_len,
                                                         frame_length_tag_key);
        auto payload_serializer = gr::digital::ofdm_serializer_vcc::make(
            fft_len,
            occupied_carriers,
            frame_length_tag_key,
            packet_length_tag_key,
            1);
        auto payload_demod =
            gr::digital::constellation_decoder_cb::make(payload_constellation);
        auto payload_pack = gr::blocks::repack_bits_bb::make(
            bps_payload, 8, packet_length_tag_key, true);
        const std::uint64_t scramble_seed = scramble_bits ? 0x7f : 0x00;
        auto payload_descrambler = gr::digital::additive_scrambler_bb::make(
            0x8a, scramble_seed, 7, 0, 8, packet_length_tag_key);
        auto crc = gr::digital::crc32_bb::make(true, packet_length_tag_key, true);
        connect(demux, 1, payload_fft, 0);
        connect(payload_fft, 0, payload_frame_equalizer, 0);
        connect(payload_frame_equalizer, 0, payload_serializer, 0);
        connect(payload_serializer, 0, payload_demod, 0);
        connect(payload_demod, 0, payload_pack, 0);
        connect(payload_pack, 0, payload_descrambler, 0);
        connect(payload_descrambler, 0, crc, 0);
        connect(crc, 0, self(), 0);
    }

private:
    static gr::digital::constellation_sptr constellation_for_bits(int bits)
    {
        switch (bits) {
        case 1: return gr::digital::constellation_bpsk::make()->base();
        case 2: return gr::digital::constellation_qpsk::make()->base();
        case 3: return gr::digital::constellation_8psk::make()->base();
        default:
            throw std::runtime_error(
                "OFDM Receiver supports BPSK, QPSK or 8-PSK only");
        }
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
             // "amp" is the native GRC parameter. Accept the older WASM
             // example's "amplitude" spelling as a compatibility alias.
             const double a = p.contains("amp")
                                  ? number_from(p, "amp", 1.0)
                                  : number_from(p, "amplitude", 1.0);
             const long s = static_cast<long>(number_from(p, "seed", 0));
             if (is_float(p)) {
                 auto b = gr::analog::noise_source_f::make(gr::analog::GR_GAUSSIAN, a, s);
                 BuiltBlock result{ b };
                 const auto set_amplitude =
                     [b](double value) { b->set_amplitude(static_cast<float>(value)); };
                 result.numeric_setters["amp"] = set_amplitude;
                 result.numeric_setters["amplitude"] = set_amplitude;
                 return result;
             }
             auto b = gr::analog::noise_source_c::make(gr::analog::GR_GAUSSIAN, a, s);
             BuiltBlock result{ b };
             const auto set_amplitude =
                 [b](double value) { b->set_amplitude(static_cast<float>(value)); };
             result.numeric_setters["amp"] = set_amplitude;
             result.numeric_setters["amplitude"] = set_amplitude;
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
        {"analog_am_demod_cf", [](const json& p) -> BuiltBlock {
             return { AmDemod::make(number_from(p, "chan_rate", 48000.0),
                                    static_cast<int>(number_from(p, "audio_decim", 1)),
                                    number_from(p, "audio_pass", 5000.0),
                                    number_from(p, "audio_stop", 5500.0)),
                      nullptr };
         }},
        {"analog_fm_deemph", [](const json& p) -> BuiltBlock {
             return { FmDeemph::make(number_from(p, "samp_rate", 48000.0),
                                     number_from(p, "tau", 75e-6)),
                      nullptr };
         }},
        {"analog_fm_demod_cf", [](const json& p) -> BuiltBlock {
             return { FmDemod::make(number_from(p, "chan_rate", 192000.0),
                                    static_cast<int>(number_from(p, "audio_decim", 4)),
                                    number_from(p, "deviation", 75000.0),
                                    number_from(p, "audio_pass", 15000.0),
                                    number_from(p, "audio_stop", 16000.0),
                                    number_from(p, "gain", 1.0),
                                    number_from(p, "tau", 75e-6)),
                      nullptr };
         }},
        {"analog_fm_preemph", [](const json& p) -> BuiltBlock {
             return { FmPreemph::make(number_from(p, "samp_rate", 48000.0),
                                      number_from(p, "tau", 75e-6),
                                      number_from(p, "fh", -1.0)),
                      nullptr };
         }},
        {"analog_nbfm_rx", [](const json& p) -> BuiltBlock {
             auto block = NarrowbandFmRx::make(
                 static_cast<int>(number_from(p, "audio_rate", 48000)),
                 static_cast<int>(number_from(p, "quad_rate", 192000)),
                 number_from(p, "tau", 75e-6),
                 number_from(p, "max_dev", 5000.0));
             BuiltBlock result{ block };
             result.numeric_setters["max_dev"] =
                 [block](double value) { block->set_max_deviation(value); };
             return result;
         }},
        {"analog_nbfm_tx", [](const json& p) -> BuiltBlock {
             auto block = FmTx::make(
                 "nbfm_tx",
                 static_cast<int>(number_from(p, "audio_rate", 48000)),
                 static_cast<int>(number_from(p, "quad_rate", 192000)),
                 number_from(p, "tau", 75e-6),
                 number_from(p, "max_dev", 5000.0),
                 number_from(p, "fh", -1.0),
                 false);
             BuiltBlock result{ block };
             result.numeric_setters["max_dev"] =
                 [block](double value) { block->set_max_deviation(value); };
             return result;
         }},
        {"analog_standard_squelch", [](const json& p) -> BuiltBlock {
             auto block = StandardSquelch::make(
                 number_from(p, "audio_rate", 48000.0),
                 number_from(p, "threshold", 0.43));
             BuiltBlock result{ block };
             result.numeric_setters["threshold"] =
                 [block](double value) { block->set_threshold(value); };
             return result;
         }},
        {"analog_wfm_rcv", [](const json& p) -> BuiltBlock {
             return { WidebandFmRx::make(
                          number_from(p, "quad_rate", 192000.0),
                          static_cast<int>(number_from(p, "audio_decimation", 4)),
                          number_from(p, "deemph_tau", 75e-6)),
                      nullptr };
         }},
        {"analog_wfm_rcv_pll", [](const json& p) -> BuiltBlock {
             return { WidebandFmStereoRx::make(
                          number_from(p, "quad_rate", 192000.0),
                          static_cast<int>(number_from(p, "audio_decimation", 4)),
                          number_from(p, "deemph_tau", 75e-6)),
                      nullptr };
         }},
        {"analog_wfm_tx", [](const json& p) -> BuiltBlock {
             auto block = FmTx::make(
                 "wfm_tx",
                 static_cast<int>(number_from(p, "audio_rate", 48000)),
                 static_cast<int>(number_from(p, "quad_rate", 192000)),
                 number_from(p, "tau", 75e-6),
                 number_from(p, "max_dev", 75000.0),
                 number_from(p, "fh", -1.0),
                 true);
             BuiltBlock result{ block };
             result.numeric_setters["max_dev"] =
                 [block](double value) { block->set_max_deviation(value); };
             return result;
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
        {"variable_constellation", [](const json& p) -> BuiltBlock {
             const std::string name = p.value("__name", std::string());
             if (name.empty())
                 throw std::runtime_error("Constellation Object requires a block name");
             const std::string type =
                 unquoted(p.value("type", std::string("qpsk")));
             gr::digital::constellation_sptr object;
             if (type == "calcdist") {
                 object = gr::digital::constellation_calcdist::make(
                              flat_sequence<gr_complex>(p, "const_points"),
                              flat_sequence<int>(p, "sym_map"),
                              static_cast<unsigned int>(
                                  number_from(p, "rot_sym", 4)),
                              static_cast<unsigned int>(
                                  number_from(p, "dims", 1)),
                              normalization_from(p))
                              ->base();
             } else {
                 object = named_constellation(type);
             }
             object->set_npwr(static_cast<float>(number_from(p, "npwr", 1.0)));
             const std::string soft_lut =
                 unquoted(p.value("soft_dec_lut", std::string("None")));
             if (soft_lut == "auto") {
                 object->gen_soft_dec_lut(
                     static_cast<int>(number_from(p, "precision", 8)));
             } else if (!soft_lut.empty() && soft_lut != "None") {
                 object->set_soft_dec_lut(
                     nested_sequence<float>(p, "soft_dec_lut", {}),
                     static_cast<int>(number_from(p, "precision", 8)));
             }
             runtime_constellations()[name] = std::move(object);
             return {};
         }},
        {"variable_constellation_rect", [](const json& p) -> BuiltBlock {
             const std::string name = p.value("__name", std::string());
             if (name.empty())
                 throw std::runtime_error(
                     "Rectangular Constellation Object requires a block name");
             auto object = gr::digital::constellation_rect::make(
                               flat_sequence<gr_complex>(p, "const_points"),
                               flat_sequence<int>(p, "sym_map"),
                               static_cast<unsigned int>(
                                   number_from(p, "rot_sym", 4)),
                               static_cast<unsigned int>(
                                   number_from(p, "real_sect", 2)),
                               static_cast<unsigned int>(
                                   number_from(p, "imag_sect", 2)),
                               static_cast<float>(
                                   number_from(p, "w_real_sect", 1)),
                               static_cast<float>(
                                   number_from(p, "w_imag_sect", 1)))
                               ->base();
             const std::string soft_lut =
                 unquoted(p.value("soft_dec_lut", std::string("None")));
             if (soft_lut == "auto") {
                 object->gen_soft_dec_lut(
                     static_cast<int>(number_from(p, "precision", 8)));
             } else if (!soft_lut.empty() && soft_lut != "None") {
                 object->set_soft_dec_lut(
                     nested_sequence<float>(p, "soft_dec_lut", {}),
                     static_cast<int>(number_from(p, "precision", 8)));
             }
             runtime_constellations()[name] = std::move(object);
             return {};
         }},
        {"digital_constellation_modulator", [](const json& p) -> BuiltBlock {
             const std::string constellation =
                 p.value("constellation", std::string());
             return { ConstellationModulator::make(
                          named_constellation(constellation),
                          bool_from(p, "differential", true),
                          static_cast<int>(
                              number_from(p, "samples_per_symbol", 2)),
                          number_from(p, "excess_bw", 0.35),
                          bool_from(p, "truncate", false)),
                      nullptr };
         }},
        {"digital_psk_demod", [](const json& p) -> BuiltBlock {
             const int points = static_cast<int>(
                 number_from(p, "constellation_points", 8));
             return { PskDemod::make(
                          static_cast<unsigned int>(std::max(0, points)),
                          unquoted(p.value("mod_code", std::string("gray"))),
                          bool_from(p, "differential", true),
                          static_cast<int>(
                              number_from(p, "samples_per_symbol", 2)),
                          number_from(p, "excess_bw", 0.35),
                          number_from(p, "freq_bw", 2.0 * PI / 100.0),
                          number_from(p, "timing_bw", 2.0 * PI / 100.0),
                          number_from(p, "phase_bw", 2.0 * PI / 100.0)),
                      nullptr };
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
        {"digital_ofdm_rx", [](const json& p) -> BuiltBlock {
             static const std::map<std::string, int> bits_per_symbol = {
                 { "BPSK", 1 }, { "QPSK", 2 }, { "8-PSK", 3 }
             };
             const auto modulation = [&](const std::string& key,
                                         const std::string& fallback) {
                 const std::string name = unquoted(p.value(key, fallback));
                 auto it = bits_per_symbol.find(name);
                 if (it == bits_per_symbol.end())
                     throw std::runtime_error("OFDM Receiver " + key +
                                              " must be BPSK, QPSK or 8-PSK");
                 return it->second;
             };
             const std::string packet_key =
                 unquoted(p.value("packet_len_key", std::string("length")));
             const auto occupied_carriers =
                 nested_sequence<int>(p, "occupied_carriers", default_occupied_carriers());
             const auto pilot_carriers =
                 nested_sequence<int>(p, "pilot_carriers", default_pilot_carriers());
             return { OfdmRxWasm::make(
                          static_cast<int>(number_from(p, "fft_len", 64)),
                          static_cast<int>(number_from(p, "cp_len", 16)),
                          "frame_" + packet_key,
                          packet_key,
                          "packet_num",
                          occupied_carriers,
                          pilot_carriers,
                          nested_sequence<gr_complex>(p, "pilot_symbols",
                                                      default_pilot_symbols()),
                          modulation("header_mod", "\"BPSK\""),
                          modulation("payload_mod", "\"BPSK\""),
                          flat_sequence<gr_complex>(p, "sync_word1"),
                          flat_sequence<gr_complex>(p, "sync_word2"),
                          bool_from(p, "scramble_bits", false),
                          bool_from(p, "log", false)),
                      nullptr };
         }},
        {"digital_ofdm_tx", [](const json& p) -> BuiltBlock {
             // The stock OFDM Transmitter is a Python hier block; this is the same
             // chain composed in C++ (see OfdmTxWasm above). Empty carrier/pilot/
             // sync parameters select the Python block's defaults, so a default
             // configuration is bit-compatible with digital.ofdm_tx.
             static const std::map<std::string, int> bits_per_symbol = {
                 { "BPSK", 1 }, { "QPSK", 2 }, { "8-PSK", 3 }
             };
             const auto modulation = [&](const std::string& key,
                                         const std::string& fallback) {
                 const std::string name = unquoted(p.value(key, fallback));
                 auto it = bits_per_symbol.find(name);
                 if (it == bits_per_symbol.end())
                     throw std::runtime_error("OFDM Transmitter " + key +
                                              " must be BPSK, QPSK or 8-PSK");
                 return it->second;
             };
             const auto occupied_carriers =
                 nested_sequence<int>(p, "occupied_carriers", default_occupied_carriers());
             const auto pilot_carriers =
                 nested_sequence<int>(p, "pilot_carriers", default_pilot_carriers());
             return { OfdmTxWasm::make(
                          static_cast<int>(number_from(p, "fft_len", 64)),
                          static_cast<int>(number_from(p, "cp_len", 16)),
                          unquoted(p.value("packet_len_key", std::string("length"))),
                          occupied_carriers,
                          pilot_carriers,
                          nested_sequence<gr_complex>(p, "pilot_symbols",
                                                      default_pilot_symbols()),
                          modulation("header_mod", "\"BPSK\""),
                          modulation("payload_mod", "\"BPSK\""),
                          flat_sequence<gr_complex>(p, "sync_word1"),
                          flat_sequence<gr_complex>(p, "sync_word2"),
                          static_cast<int>(number_from(p, "rolloff", 0)),
                          bool_from(p, "scramble_bits", false)),
                      nullptr };
         }},
        {"freq_xlating_fft_filter_ccc", [](const json& p) -> BuiltBlock {
             auto block = FrequencyXlatingFftFilter::make(
                 static_cast<int>(number_from(p, "decim", 1)),
                 flat_sequence<gr_complex>(p, "taps"),
                 number_from(p, "center_freq", 0.0),
                 number_from(p, "samp_rate", 32000.0),
                 static_cast<int>(number_from(p, "nthreads", 1)),
                 static_cast<int>(number_from(p, "samp_delay", 0)));
             BuiltBlock result{ block };
             result.numeric_setters["center_freq"] =
                 [block](double value) { block->set_center_frequency(value); };
             result.numeric_setters["nthreads"] = [block](double value) {
                 block->set_nthreads(static_cast<int>(value));
             };
             return result;
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
        {"qtgui_number_sink", [](const json& p) -> BuiltBlock {
             const std::string input_type = type_from(p, "float");
             const int connections =
                 static_cast<int>(number_from(p, "nconnections", 1));
             if (connections <= 0)
                 throw std::runtime_error(
                     "QT GUI Number Sink requires at least one input");

             std::vector<std::string> labels;
             std::vector<std::string> units;
             std::vector<double> factors;
             for (int i = 0; i < connections; ++i) {
                 const std::string suffix = std::to_string(i + 1);
                 std::string label =
                     unquoted(p.value("label" + suffix, std::string()));
                 if (label.empty())
                     label = "Data " + std::to_string(i);
                 labels.push_back(std::move(label));
                 units.push_back(
                     unquoted(p.value("unit" + suffix, std::string())));
                 factors.push_back(
                     number_from(p, "factor" + suffix, 1.0));
             }

             auto block = NumberSinkWasm::make(
                 input_type,
                 connections,
                 unquoted(p.value("name", std::string("Number"))),
                 labels,
                 units,
                 factors);
             return { block, block->qwidget() };
         }},
        {"wasm_packet_rate_sink", [](const json& p) -> BuiltBlock {
             std::string label = unquoted(p.value("label", std::string()));
             if (label.empty())
                 label = "Rate";
             auto block = PacketRateSinkWasm::make(
                 static_cast<std::size_t>(itemsize_of(p)),
                 number_from(p, "items_per_packet", 1.0),
                 number_from(p, "update_time", 0.5),
                 unquoted(p.value("name", std::string("Rate"))),
                 label,
                 unquoted(p.value("unit", std::string())));
             return { block, block->qwidget() };
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

void clear_runtime_objects()
{
    runtime_constellations().clear();
}

// Called by dlopen'd category side modules (generated_registry_<m>.cpp) to add
// their factories once the module has been fetched. Capture-less factory function
// pointers cross the dynamic-link boundary with no C++ ABI coupling. emplace() so
// a hand-written custom factory (installed at init) always wins over a generated one.
extern "C" EMSCRIPTEN_KEEPALIVE void wasm_registry_add(
    const char* id, BuiltBlock (*factory)(const nlohmann::json&)) {
    registry_storage().emplace(std::string(id), Factory(factory));
}
