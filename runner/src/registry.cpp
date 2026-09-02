#include "registry.hpp"
#include "registry_helpers.hpp"
#include "sigmf_meta.hpp"
#include "browser_file_source.hpp"
#include "browser_file_sink.hpp"
#include "sigmf_sink.hpp"
#include "browser_audio.hpp"
#include "rtlsdr_source.hpp"
#include "plutosdr_source.hpp"
#include "plutosdr_sink.hpp"
#include "bb60_source.hpp"
#include "hackrf_source.hpp"
#include "hackrf_sink.hpp"
#include "paint_image_source.hpp"
#include "rds_panel.hpp"
#include "radar_plots.hpp"
#include "fosphor_sink.hpp"
#include "fosphor_webgpu_sink.hpp"
#include "analog_hier.hpp"
#include "blocks_hier.hpp"
#include "digital_hier.hpp"
#include "fec_hier.hpp"
#include "fft_hier.hpp"
#include "filter_hier.hpp"
#include "python_block.hpp"
#include "js_block.hpp"
#include "qtgui_controls.hpp"
#include "qtgui_sinks.hpp"
#include "spectrum_analyzer_sink.hpp"
#include "musical_keyboard_source.hpp"
#include "text_sink.hpp"
#include "hrpt_image_sink.hpp"
#include "gui_layout.hpp"
#include <emscripten.h>
#include <gnuradio/analog/sig_source.h>
#include <gnuradio/analog/noise_source.h>
#include <gnuradio/analog/random_uniform_source.h>
#include <gnuradio/blocks/throttle.h>
#include <gnuradio/blocks/vector_source.h>
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
#include <gnuradio/blocks/correctiq.h>
#include <gnuradio/blocks/correctiq_auto.h>
#include <gnuradio/blocks/correctiq_man.h>
#include <gnuradio/blocks/correctiq_swapiq.h>
#include <gnuradio/blocks/phase_shift.h>
#include <gnuradio/blocks/rotator_cc.h>
#include <gnuradio/channels/fading_model.h>
#include <gnuradio/channels/selective_fading_model.h>
#include <gnuradio/digital/constellation.h>
#include <gnuradio/digital/constellation_decoder_cb.h>
#include <gnuradio/digital/constellation_encoder_bc.h>
#include <gnuradio/digital/constellation_receiver_cb.h>
#include <gnuradio/digital/costas_loop_cc.h>
#include <gnuradio/digital/constellation_soft_decoder_cf.h>
#include <gnuradio/digital/meas_evm_cc.h>
#include <gnuradio/digital/symbol_sync_cc.h>
#include <gnuradio/digital/symbol_sync_ff.h>
#include <gnuradio/fec/async_decoder.h>
#include <gnuradio/fec/ber_bf.h>
#include <gnuradio/fec/cc_decoder.h>
#include <gnuradio/fec/cc_encoder.h>
#include <gnuradio/fec/ccsds_encoder.h>
#include <gnuradio/fec/decode_ccsds_27_fb.h>
#include <gnuradio/fec/dummy_decoder.h>
#include <gnuradio/fec/dummy_encoder.h>
#include <gnuradio/fec/repetition_decoder.h>
#include <gnuradio/fec/repetition_encoder.h>
#include <gnuradio/fec/decoder.h>
#include <gnuradio/fec/depuncture_bb.h>
#include <gnuradio/fec/encode_ccsds_27_bb.h>
#include <gnuradio/fec/generic_decoder.h>
#include <gnuradio/fec/puncture_bb.h>
#include <gnuradio/fec/puncture_ff.h>
#include <gnuradio/filter/filter_delay_fc.h>
#include <gnuradio/filter/filterbank_vcvcf.h>
#include <gnuradio/filter/ival_decimator.h>
#include <gnuradio/fft/window.h>
#include <gnuradio/hier_block2.h>
#include <gnuradio/io_signature.h>
#include <gnuradio/sync_block.h>
#include <gnuradio/qtgui/time_sink_c.h>
#include <gnuradio/qtgui/time_sink_f.h>
#include <gnuradio/qtgui/freq_sink_c.h>
#include <gnuradio/qtgui/freq_sink_f.h>
#include <gnuradio/qtgui/const_sink_c.h>
#include <gnuradio/qtgui/waterfall_sink_c.h>
#include <gnuradio/qtgui/waterfall_sink_f.h>
#include <gnuradio/qtgui/edit_box_msg.h>
#include <gnuradio/qtgui/sink_c.h>
#include <gnuradio/qtgui/sink_f.h>
#include <gnuradio/qtgui/eye_sink_c.h>
#include <gnuradio/qtgui/eye_sink_f.h>
#include <gnuradio/qtgui/histogram_sink_f.h>
#include <gnuradio/qtgui/time_raster_sink_b.h>
#include <gnuradio/qtgui/time_raster_sink_f.h>
#include <gnuradio/qtgui/vector_sink_f.h>
#include <gnuradio/qtgui/matrix_sink.h>
#include <gnuradio/qtgui/ber_sink_b.h>
#include <QBoxLayout>
#include <QButtonGroup>
#include <QCheckBox>
#include <QTimer>
#include <QComboBox>
#include <QDial>
#include <QDoubleSpinBox>
#include <QGridLayout>
#include <QGroupBox>
#include <QHBoxLayout>
#include <QLabel>
#include <QLineEdit>
#include <QPointer>
#include <QPushButton>
#include <QRadioButton>
#include <QSignalBlocker>
#include <QSizePolicy>
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
#include <map>
#include <memory>
#include <mutex>
#include <random>
#include <set>
#include <stdexcept>
#include <vector>

using nlohmann::json;

// A .grc parameter declared `dtype: string` still arrives as a JSON *number*
// whenever its value looks like one -- the lowering pass turns a numeric literal
// into a real number so arithmetic parameters work at all -- and nlohmann's
// value<std::string>() throws type_error.302 rather than converting. That threw
// the entire flowgraph away over, say, a Message Edit Box whose Value is 0.5,
// with an exception naming neither the block nor the parameter. Read a
// nominally-textual parameter through here instead of p.value(k, std::string()).
static std::string param_text(const json& p, const std::string& key,
                              std::string fallback = {})
{
    auto item = p.find(key);
    if (item == p.end() || item->is_null())
        return fallback;
    if (item->is_string())
        return item->get<std::string>();
    if (item->is_boolean())
        return item->get<bool>() ? "True" : "False";
    return item->dump();
}

// GRC's Noise Type enum. The yaml spells it `analog.GR_*` and there is no
// cpp_template rewrite for this block, but choice() tolerates either spelling.
static gr::analog::noise_type_t noise_type_from(const json& p)
{
    return wasm_registry::choice<gr::analog::noise_type_t>(
        p,
        "noise_type",
        {
            { "analog.GR_UNIFORM", gr::analog::GR_UNIFORM },
            { "analog.GR_GAUSSIAN", gr::analog::GR_GAUSSIAN },
            { "analog.GR_LAPLACIAN", gr::analog::GR_LAPLACIAN },
            { "analog.GR_IMPULSE", gr::analog::GR_IMPULSE },
        },
        gr::analog::GR_GAUSSIAN);
}

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
static bool is_float(const json& p) { return param_text(p, "type", "complex") == "float"; }
static int itemsize_of(const json& p)
{
    const std::string type = param_text(p, "type", "complex");
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

// GRC's Vector Length, as a multiplier on an item size or a constructor
// argument. Absent, junk or below one means the scalar stream every flowgraph
// without the parameter has.
static std::size_t vlen_of(const json& p)
{
    return static_cast<std::size_t>(std::max(1.0, number_from(p, "vlen", 1)));
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
        param_text(p, "tr_mode", "qtgui.TRIG_MODE_FREE"));
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
        param_text(p, "tr_slope", "qtgui.TRIG_SLOPE_POS"));
    return slope.find("NEG") != std::string::npos ? gr::qtgui::TRIG_SLOPE_NEG
                                                   : gr::qtgui::TRIG_SLOPE_POS;
}

// GRC's own per-line default colors, in the order its `colorN` parameters
// declare them, so line N of a sink whose .grc leaves its color unset comes out
// the color the editor draws in its properties dialog.
static const std::vector<std::string> DEFAULT_LINE_COLORS = {
    "blue", "red", "green", "black", "cyan", "magenta", "yellow",
    "dark red", "dark green", "dark blue"
};

static const std::string& default_line_color(int line)
{
    return DEFAULT_LINE_COLORS[static_cast<std::size_t>(line) %
                               DEFAULT_LINE_COLORS.size()];
}

template <typename Sink>
static void configure_line(const std::shared_ptr<Sink>& sink,
                           const json& p,
                           unsigned int line,
                           const std::string& default_color,
                           int default_style = 1,
                           int default_marker = -1)
{
    const std::string suffix = std::to_string(line + 1);
    if (auto it = p.find("label" + suffix); it != p.end() && it->is_string())
        sink->set_line_label(line, unquoted(it->get<std::string>()));
    sink->set_line_color(
        line, unquoted(param_text(p, "color" + suffix, default_color)));
    sink->set_line_width(
        line, static_cast<int>(number_from(p, "width" + suffix, 1)));
    // The fallbacks are the defaults GRC's own Time/Frequency Sink yaml
    // declares: a solid line (Qt::SolidLine) and no marker (QwtSymbol::NoSymbol,
    // which is -1, not 0 — 0 is a circle). A .grc that leaves these out is
    // asking for GRC's default, so 0 here would put a marker on every sample.
    // A sink whose own yaml declares different defaults (the Bercurve Sink plots
    // one circle per Es/No point) passes them in.
    sink->set_line_style(
        line, static_cast<int>(number_from(p, "style" + suffix, default_style)));
    sink->set_line_marker(
        line, static_cast<int>(number_from(p, "marker" + suffix, default_marker)));
    sink->set_line_alpha(line, number_from(p, "alpha" + suffix, 1.0));
}

template <typename Sink>
static void configure_time_sink(const std::shared_ptr<Sink>& sink,
                                const json& p,
                                unsigned int line_count)
{
    sink->set_y_label(unquoted(param_text(p, "ylabel", "Amplitude")),
                      unquoted(param_text(p, "yunit")));
    sink->set_y_axis(number_from(p, "ymin", -1.0), number_from(p, "ymax", 1.0));
    sink->set_update_time(number_from(p, "update_time", 0.1));
    sink->enable_grid(bool_from(p, "grid", false));
    sink->enable_autoscale(bool_from(p, "autoscale", false));
    sink->enable_tags(bool_from(p, "entags", true));
    sink->enable_control_panel(bool_from(p, "ctrlpanel", false));
    sink->enable_axis_labels(bool_from(p, "axislabels", true));
    sink->enable_stem_plot(bool_from(p, "stemplot", false));
    if (!bool_from(p, "legend", true))
        sink->disable_legend();
    for (unsigned int line = 0; line < line_count; ++line)
        configure_line(sink, p, line, default_line_color(static_cast<int>(line)));
    sink->set_trigger_mode(trigger_mode_from(p),
                           trigger_slope_from(p),
                           static_cast<float>(number_from(p, "tr_level", 0.0)),
                           static_cast<float>(number_from(p, "tr_delay", 0.0)),
                           static_cast<int>(number_from(p, "tr_chan", 0)),
                           unquoted(param_text(p, "tr_tag")));
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
static void configure_freq_sink(const std::shared_ptr<Sink>& sink,
                                const json& p,
                                unsigned int line_count)
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
    for (unsigned int line = 0; line < line_count; ++line)
        configure_line(sink,
                       p,
                       line,
                       default_line_color(static_cast<int>(line)));
    // Upstream's own defaults, and its own parameter ids: the Frequency Sink
    // spells these `label`/`units` where the Time Sink spells them
    // `ylabel`/`yunit`.
    sink->set_y_label(unquoted(param_text(p, "label", "Relative Gain")),
                      unquoted(param_text(p, "units", "dB")));
    // Divides the window by its own power, so changing the window stops moving
    // the level the spectrum is drawn at.
    sink->set_fft_window_normalized(bool_from(p, "norm_window", false));
    sink->set_trigger_mode(trigger_mode_from(p),
                           static_cast<float>(number_from(p, "tr_level", 0.0)),
                           static_cast<int>(number_from(p, "tr_chan", 0)),
                           unquoted(param_text(p, "tr_tag")));
}

template <typename Sink>
static void configure_waterfall_sink(const std::shared_ptr<Sink>& sink,
                                     const json& p,
                                     int nconnections)
{
    sink->set_intensity_range(number_from(p, "int_min", -140.0),
                              number_from(p, "int_max", 10.0));
    // Upstream has set_fft_average() but GRC never exposed a parameter for it, so
    // a waterfall fed by noise shows the periodogram's own ~5.6 dB per-bin speckle
    // and nothing of the channel. fft_average_from() defaults to 1.0 (no
    // averaging), which is what every .grc without the parameter keeps.
    sink->set_fft_average(static_cast<float>(fft_average_from(p)));
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

// GRC's Window Type enum, shared by every sink that takes an FFT window. The
// yaml spells the options `window.WIN_*` and its cpp_templates rewrite them to
// `fft::window::WIN_*`; choice() normalizes both. The fallback is a parameter
// because the Frequency Sink defaults to a rectangular window here rather than
// to upstream's Blackman-harris.
static gr::fft::window::win_type window_type_from(
    const json& p,
    gr::fft::window::win_type fallback = gr::fft::window::WIN_BLACKMAN_hARRIS)
{
    return wasm_registry::choice<gr::fft::window::win_type>(
        p,
        "wintype",
        {
            { "window.WIN_BLACKMAN_hARRIS", gr::fft::window::WIN_BLACKMAN_hARRIS },
            { "window.WIN_HAMMING", gr::fft::window::WIN_HAMMING },
            { "window.WIN_HANN", gr::fft::window::WIN_HANN },
            { "window.WIN_BLACKMAN", gr::fft::window::WIN_BLACKMAN },
            { "window.WIN_RECTANGULAR", gr::fft::window::WIN_RECTANGULAR },
            { "window.WIN_KAISER", gr::fft::window::WIN_KAISER },
            { "window.WIN_FLATTOP", gr::fft::window::WIN_FLATTOP },
        },
        fallback);
}

// The stream connection count for the sinks whose Type parameter has message
// variants (`msg_complex`, `msg_float`, `msg_byte`): those carry no stream
// inputs at all, so the sink is constructed with zero connections and fed
// through its `in` message port instead.
static int sink_connections(const json& p, const std::string& block_label)
{
    if (type_from(p, "complex").rfind("msg", 0) == 0)
        return 0;
    const int connections = static_cast<int>(number_from(p, "nconnections", 1));
    if (connections < 0)
        throw std::runtime_error(block_label + " connections cannot be negative");
    return connections;
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

// Coder Definition objects, keyed by their GRC variable name. Like
// variable_constellation these are GRC *variables* rather than blocks: the
// factory constructs one and files it here, and the FEC blocks that take a
// "Decoder Obj." or "Encoder Obj." parameter look it up by name.
//
// Each name holds a *list* because GRC's definition blocks have a Parallelism
// parameter: 0 declares one object, 1 declares dim1 of them, and the blocks that
// take a list (BER Curve Gen., the extended coders' threading modes) index into
// it. A parallelism of 0 is therefore a list of one, and the singular lookups
// below insist on exactly that.
std::map<std::string, std::vector<gr::fec::generic_decoder::sptr>>&
runtime_cc_decoders()
{
    static std::map<std::string, std::vector<gr::fec::generic_decoder::sptr>> objects;
    return objects;
}

std::map<std::string, std::vector<gr::fec::generic_encoder::sptr>>& runtime_fec_encoders()
{
    static std::map<std::string, std::vector<gr::fec::generic_encoder::sptr>> objects;
    return objects;
}

// How many objects a definition block declares: GRC's `ndim` parallelism, whose
// dimensions are dim1 x dim2. Only one dimension of workers is meaningful here,
// so a two-dimensional declaration is refused rather than silently flattened.
int coder_definition_count(const json& p, const char* what)
{
    const int ndim = static_cast<int>(number_from(p, "ndim", 0));
    if (ndim <= 0)
        return 1;
    if (ndim > 1)
        throw std::runtime_error(std::string(what) +
                                 " parallelism must be 0 or 1 in the browser");
    const int dim1 = static_cast<int>(number_from(p, "dim1", 1));
    if (dim1 < 1)
        throw std::runtime_error(std::string(what) + " dimension must be positive");
    return dim1;
}

std::vector<gr::fec::generic_decoder::sptr> named_cc_decoders(
    const std::string& expression)
{
    const std::string value = unquoted(expression);
    auto found = runtime_cc_decoders().find(value);
    if (found != runtime_cc_decoders().end())
        return found->second;
    throw std::runtime_error("FEC block references unknown decoder object: " + value);
}

std::vector<gr::fec::generic_encoder::sptr> named_fec_encoders(
    const std::string& expression)
{
    const std::string value = unquoted(expression);
    auto found = runtime_fec_encoders().find(value);
    if (found != runtime_fec_encoders().end())
        return found->second;
    throw std::runtime_error("FEC block references unknown encoder object: " + value);
}

gr::fec::generic_decoder::sptr named_cc_decoder(const std::string& expression)
{
    auto decoders = named_cc_decoders(expression);
    if (decoders.size() != 1)
        throw std::runtime_error(
            "FEC block needs a decoder object with a parallelism of 0: " +
            unquoted(expression));
    return decoders.front();
}

// GRC spells "this stream is not tagged" as a length tag name of None, which is
// what selects the untagged encoder/decoder inside the extended blocks.
std::string length_tag_name(const json& p)
{
    const std::string value = wasm_registry::text(p, "lentagname", "None");
    return value == "None" ? std::string() : value;
}

gr::fec::generic_encoder::sptr named_fec_encoder(const std::string& expression)
{
    auto encoders = named_fec_encoders(expression);
    if (encoders.size() != 1)
        throw std::runtime_error(
            "FEC block needs an encoder object with a parallelism of 0: " +
            unquoted(expression));
    return encoders.front();
}

cc_mode_t cc_mode_from(const json& p, const char* key)
{
    const std::string value = uppercase(unquoted(p.value(key, std::string("CC_STREAMING"))));
    if (value.find("TERMINATED") != std::string::npos)
        return CC_TERMINATED;
    if (value.find("TAILBITING") != std::string::npos)
        return CC_TAILBITING;
    if (value.find("TRUNCATED") != std::string::npos)
        return CC_TRUNCATED;
    return CC_STREAMING;
}

gr::digital::ted_type ted_type_from(const json& p)
{
    const std::string value = uppercase(
        param_text(p, "ted_type", "digital.TED_MUELLER_AND_MULLER"));
    if (value.find("MOD_MUELLER") != std::string::npos)
        return gr::digital::TED_MOD_MUELLER_AND_MULLER;
    if (value.find("MUELLER") != std::string::npos)
        return gr::digital::TED_MUELLER_AND_MULLER;
    if (value.find("ZERO_CROSSING") != std::string::npos)
        return gr::digital::TED_ZERO_CROSSING;
    if (value.find("GARDNER") != std::string::npos)
        return gr::digital::TED_GARDNER;
    if (value.find("EARLY_LATE") != std::string::npos)
        return gr::digital::TED_EARLY_LATE;
    if (value.find("DANDREA_AND_MENGALI_GEN_MSK") != std::string::npos)
        return gr::digital::TED_DANDREA_AND_MENGALI_GEN_MSK;
    if (value.find("MENGALI_AND_DANDREA_GMSK") != std::string::npos)
        return gr::digital::TED_MENGALI_AND_DANDREA_GMSK;
    if (value.find("SIGNUM_TIMES_SLOPE") != std::string::npos)
        return gr::digital::TED_SIGNUM_TIMES_SLOPE_ML;
    if (value.find("SIGNAL_TIMES_SLOPE") != std::string::npos)
        return gr::digital::TED_SIGNAL_TIMES_SLOPE_ML;
    throw std::runtime_error("Symbol Sync has an unsupported timing error detector");
}

gr::digital::ir_type resampler_type_from(const json& p)
{
    const std::string value = uppercase(
        param_text(p, "resamp_type", "digital.IR_MMSE_8TAP"));
    if (value.find("PFB_NO_MF") != std::string::npos)
        return gr::digital::IR_PFB_NO_MF;
    if (value.find("PFB_MF") != std::string::npos)
        return gr::digital::IR_PFB_MF;
    if (value.find("MMSE_8TAP") != std::string::npos)
        return gr::digital::IR_MMSE_8TAP;
    throw std::runtime_error("Symbol Sync has an unsupported resampler");
}

gr::digital::evm_measurement_t evm_type_from(const json& p)
{
    const std::string value = uppercase(
        param_text(p, "meas_type", "digital.evm_measurement_t.EVM_PERCENT"));
    return value.find("EVM_DB") != std::string::npos
               ? gr::digital::evm_measurement_t::EVM_DB
               : gr::digital::evm_measurement_t::EVM_PERCENT;
}

template <typename Block>
BuiltBlock finish_symbol_sync(const std::shared_ptr<Block>& block)
{
    BuiltBlock result{ block };
    result.numeric_setters = {
        { "loop_bw",
          [block](double value) {
              block->set_loop_bandwidth(static_cast<float>(value));
          } },
        { "damping",
          [block](double value) {
              block->set_damping_factor(static_cast<float>(value));
          } },
        { "ted_gain",
          [block](double value) { block->set_ted_gain(static_cast<float>(value)); } },
        { "sps",
          [block](double value) { block->set_sps(static_cast<float>(value)); } },
    };
    return result;
}

template <typename Block>
BuiltBlock make_symbol_sync(const json& p)
{
    auto block = Block::make(
        ted_type_from(p),
        static_cast<float>(number_from(p, "sps", 2.0)),
        static_cast<float>(number_from(p, "loop_bw", 0.045)),
        static_cast<float>(number_from(p, "damping", 1.0)),
        static_cast<float>(number_from(p, "ted_gain", 1.0)),
        static_cast<float>(number_from(p, "max_dev", 1.5)),
        static_cast<int>(number_from(p, "osps", 1)),
        named_constellation(
            param_text(p, "constellation", "digital.constellation_bpsk().base()")),
        resampler_type_from(p),
        static_cast<int>(number_from(p, "nfilters", 128)),
        flat_sequence<float>(p, "pfb_mf_taps"));
    return finish_symbol_sync(block);
}

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
        start, stop, step, param_text(p, "rangeType", "float") == "int", {}
    });
    const double initial = state->normalize(p.value("value", 50.0));
    const int minimum_length = std::max(1, p.value("min_len", 200));
    const std::string orientation_name = param_text(p, "orient", "horizontal");
    const auto orientation = orientation_name == "vertical" ||
                                     orientation_name.find("Vertical") != std::string::npos
                                 ? Qt::Vertical
                                 : Qt::Horizontal;
    const std::string style = param_text(p, "widget", "counter_slider");

    auto* widget = new QWidget;
    auto* layout = new QHBoxLayout(widget);
    layout->setContentsMargins(0, 0, 0, 0);
    QString label = QString::fromStdString(param_text(p, "label"));
    if (label.isEmpty())
        label = QString::fromStdString(param_text(p, "__name", "Range"));
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
         split_list(QString::fromStdString(param_text(p, "options", "0, 1, 2")))) {
        bool ok = false;
        const double value = piece.toDouble(&ok);
        options.push_back(ok ? value : static_cast<double>(options.size()));
    }
    if (options.empty())
        throw std::runtime_error("QT GUI Chooser requires at least one option");

    const QStringList labels =
        split_list(QString::fromStdString(param_text(p, "labels")));
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
    QString label = QString::fromStdString(param_text(p, "label"));
    if (label.isEmpty())
        label = QString::fromStdString(param_text(p, "__name", "Chooser"));

    QWidget* widget = nullptr;
    if (param_text(p, "widget", "combo_box") == "radio_buttons") {
        const std::string orient = param_text(p, "orient", "Qt.QVBoxLayout");
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
    QString label = QString::fromStdString(param_text(p, "label"));
    if (label.isEmpty())
        label = QString::fromStdString(param_text(p, "__name", "Button"));

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

double control_number(const json& p, const char* key, double fallback)
{
    auto item = p.find(key);
    if (item == p.end() || item->is_null())
        return fallback;
    if (item->is_boolean())
        return item->get<bool>() ? 1.0 : 0.0;
    if (item->is_number())
        return item->get<double>();
    if (item->is_string()) {
        const std::string value = uppercase(unquoted(item->get<std::string>()));
        if (value == "TRUE")
            return 1.0;
        if (value == "FALSE")
            return 0.0;
        char* end = nullptr;
        const double parsed = std::strtod(value.c_str(), &end);
        if (end && end == value.c_str() + value.size())
            return parsed;
    }
    throw std::runtime_error(std::string("QT GUI control parameter ") + key +
                             " must be numeric or boolean");
}

BuiltBlock make_check_box(const json& p)
{
    const std::string type = unquoted(param_text(p, "type", "int"));
    if (type != "real" && type != "int" && type != "bool")
        throw std::runtime_error(
            "QT GUI Check Box supports real, int, and bool values in WebAssembly");

    const double false_value = control_number(p, "false", 0.0);
    const double true_value = control_number(p, "true", 1.0);
    const double initial = control_number(p, "value", true_value);
    const bool checked =
        std::abs(initial - true_value) <= std::abs(initial - false_value);
    auto state = std::make_shared<ControlState>();
    QString label = QString::fromStdString(
        unquoted(param_text(p, "label")));
    if (label.isEmpty())
        label = QString::fromStdString(param_text(p, "__name", "Check Box"));

    auto* check_box = new QCheckBox(label);
    check_box->setChecked(checked);
    QObject::connect(check_box, &QCheckBox::toggled, check_box,
                     [state, true_value, false_value](bool value) {
                         state->publish(value ? true_value : false_value);
                     });

    BuiltBlock result;
    result.widget = check_box;
    result.is_variable = true;
    result.variable_value = checked ? true_value : false_value;
    result.subscribe = [state](std::function<void(double)> subscriber) {
        state->subscribers.push_back(std::move(subscriber));
    };
    return result;
}

BuiltBlock make_entry(const json& p)
{
    const std::string type = unquoted(param_text(p, "type", "int"));
    if (type != "real" && type != "int" && type != "bool")
        throw std::runtime_error(
            "QT GUI Entry supports real, int, and bool values in WebAssembly");
    const bool integral = type == "int" || type == "bool";
    const bool boolean = type == "bool";
    const double requested = control_number(p, "value", 0.0);
    const double initial =
        boolean ? (requested != 0.0 ? 1.0 : 0.0)
                : integral ? static_cast<double>(static_cast<long long>(requested))
                           : requested;
    auto state = std::make_shared<ControlState>();
    QString label = QString::fromStdString(
        unquoted(param_text(p, "label")));
    if (label.isEmpty())
        label = QString::fromStdString(param_text(p, "__name", "Entry"));

    auto* widget = new QWidget;
    auto* layout = new QHBoxLayout(widget);
    layout->setContentsMargins(0, 0, 0, 0);
    layout->addWidget(new QLabel(label + ": ", widget));
    auto* entry = new QLineEdit(QString::number(initial, 'g', 12), widget);
    layout->addWidget(entry);
    const auto publish = [state, entry, integral, boolean, initial] {
        bool ok = false;
        double value = entry->text().toDouble(&ok);
        if (!ok) {
            entry->setText(QString::number(initial, 'g', 12));
            return;
        }
        if (boolean)
            value = value != 0.0 ? 1.0 : 0.0;
        else if (integral)
            value = static_cast<double>(static_cast<long long>(value));
        entry->setText(QString::number(value, 'g', 12));
        state->publish(value);
    };
    if (param_text(p, "entry_signal", "editingFinished") ==
        "returnPressed")
        QObject::connect(entry, &QLineEdit::returnPressed, entry, publish);
    else
        QObject::connect(entry, &QLineEdit::editingFinished, entry, publish);

    BuiltBlock result;
    result.widget = widget;
    result.is_variable = true;
    result.variable_value = initial;
    result.subscribe = [state](std::function<void(double)> subscriber) {
        state->subscribers.push_back(std::move(subscriber));
    };
    return result;
}

// ---- the controls rebuilt from gr-qtgui's Python widgets -------------------
// Everything above this line is a control registry.cpp assembles from stock Qt
// classes. The rest of GRC's "GUI Widgets/QT" family are Python QWidgets with no
// C++ path at all, rebuilt in blocks/src/qtgui_controls.hpp; these are their
// factories. See that header for how a widget, its message block and the
// runner's variable model fit together.

QString control_label(const json& p, const char* fallback)
{
    QString label = QString::fromStdString(unquoted(param_text(p, "label")));
    if (label.isEmpty())
        label = QString::fromStdString(param_text(p, "__name", fallback));
    return label;
}

grworld::ControlType control_type(const json& p, const char* what)
{
    const std::string type = unquoted(param_text(p, "type", "int"));
    if (type == "real" || type == "float")
        return grworld::ControlType::Real;
    if (type == "int")
        return grworld::ControlType::Int;
    if (type == "bool")
        return grworld::ControlType::Bool;
    throw std::runtime_error(std::string(what) +
                             " supports real, int, and bool values in WebAssembly");
}

// Toggle Switch, Toggle Button and Msg CheckBox differ only in the widget the
// user clicks: each carries a Pressed and a Released value, publishes whichever
// is current as its variable, and puts the same value on a `state` message. This
// is the half they share.
struct TwoStateControl {
    grworld::ControlType type = grworld::ControlType::Int;
    double pressed = 1.0;
    double released = 0.0;
    bool initially_pressed = false;
    std::string message_name;
    std::shared_ptr<ControlState> state = std::make_shared<ControlState>();
    grworld::ControlMessageBlock::sptr block;

    double initial() const { return initially_pressed ? pressed : released; }

    pmt::pmt_t message(double value) const
    {
        return pmt::cons(pmt::intern(message_name), grworld::control_pmt(type, value));
    }

    // Called from the widget's Qt callback, on the browser main thread.
    void changed(bool on) const
    {
        const double value = on ? pressed : released;
        state->publish(value);
        block->publish(message(value));
    }

    BuiltBlock built(QWidget* widget) const
    {
        block->set_initial_message(message(initial()));
        BuiltBlock result{ block, widget };
        result.is_variable = true;
        result.variable_value = initial();
        auto subscribers = state;
        result.subscribe = [subscribers](std::function<void(double)> subscriber) {
            subscribers->subscribers.push_back(std::move(subscriber));
        };
        return result;
    }
};

TwoStateControl two_state_from(const json& p, const char* what)
{
    TwoStateControl control;
    control.type = control_type(p, what);
    control.pressed = control_number(p, "pressed", 1.0);
    control.released = control_number(p, "released", 0.0);
    control.initially_pressed = bool_from(p, "initPressed", false);
    control.message_name =
        unquoted(param_text(p, "outputmsgname", "value"));
    control.block = grworld::ControlMessageBlock::make(
        param_text(p, "__name", what), "state");
    return control;
}

BuiltBlock make_toggle_switch(const json& p)
{
    TwoStateControl control = two_state_from(p, "QT GUI Toggle Switch");
    auto* toggle = new grworld::ToggleSwitchWidget(
        QString::fromStdString(
            unquoted(param_text(p, "switchOnBackground", "green"))),
        QString::fromStdString(
            unquoted(param_text(p, "switchOffBackground", "gray"))),
        control.initially_pressed,
        50);
    toggle->on_change = [control](bool on) { control.changed(on); };
    return control.built(grworld::label_around(
        toggle,
        QString::fromStdString(unquoted(param_text(p, "label"))),
        static_cast<int>(number_from(p, "position", 4)),
        static_cast<int>(number_from(p, "cellalignment", 1)),
        static_cast<int>(number_from(p, "verticalalignment", 1))));
}

BuiltBlock make_toggle_button(const json& p)
{
    TwoStateControl control = two_state_from(p, "QT GUI Toggle Button");
    const QString released_style = grworld::color_style(
        unquoted(param_text(p, "relBackgroundColor", "default")),
        unquoted(param_text(p, "relFontColor", "default")));
    const QString pressed_style = grworld::color_style(
        unquoted(param_text(p, "pressBackgroundColor", "default")),
        unquoted(param_text(p, "pressFontColor", "default")));

    auto* button = new QPushButton(control_label(p, "Toggle Button"));
    button->setCheckable(true);
    button->setChecked(control.initially_pressed);
    button->setStyleSheet(control.initially_pressed ? pressed_style : released_style);
    QObject::connect(button, &QPushButton::toggled, button,
                     [control, button, pressed_style, released_style](bool on) {
                         button->setStyleSheet(on ? pressed_style : released_style);
                         control.changed(on);
                     });
    return control.built(button);
}

BuiltBlock make_msg_check_box(const json& p)
{
    TwoStateControl control = two_state_from(p, "QT GUI Msg CheckBox");
    auto* check_box = new QCheckBox(control_label(p, "Check Box"));
    check_box->setChecked(control.initially_pressed);
    QObject::connect(check_box, &QCheckBox::toggled, check_box,
                     [control](bool on) { control.changed(on); });
    // The label belongs to the check box itself, so the frame around it is here
    // only for the two alignment parameters.
    return control.built(grworld::label_around(
        check_box,
        QString(),
        1,
        static_cast<int>(number_from(p, "cellalignment", 1)),
        static_cast<int>(number_from(p, "verticalalignment", 1))));
}

BuiltBlock make_msg_push_button(const json& p)
{
    // Alone among these, this one is not a variable: upstream's var_make is
    // `self.<id> = None`, because its Value is what the message carries rather
    // than something the flowgraph reads.
    const grworld::ControlType type = control_type(p, "QT GUI Msg Push Button");
    const double value = control_number(p, "value", 1.0);
    const std::string key = unquoted(param_text(p, "msgName", "pressed"));
    auto block = grworld::ControlMessageBlock::make(
        param_text(p, "__name", "QT GUI Msg Push Button"), "pressed");

    auto* button = new QPushButton(control_label(p, "Button"));
    button->setStyleSheet(grworld::color_style(
        unquoted(param_text(p, "relBackgroundColor", "default")),
        unquoted(param_text(p, "relFontColor", "default"))));
    QObject::connect(button, &QPushButton::clicked, button, [block, type, value, key] {
        block->publish(pmt::cons(pmt::intern(key), grworld::control_pmt(type, value)));
    });
    return BuiltBlock{ block, button };
}

BuiltBlock make_dial_control(const json& p)
{
    // A QDial counts in integers, so upstream turns a float dial into an integer
    // one scaled on the way out: min/max are the dial's own steps and the value
    // the flowgraph sees is step * scaleFactor.
    const grworld::ControlType type = control_type(p, "QT GUI Dial");
    const double scale =
        type == grworld::ControlType::Real ? number_from(p, "scaleFactor", 1.0) : 1.0;
    if (scale == 0.0)
        throw std::runtime_error("QT GUI Dial: Scale Factor must not be zero");
    const int minimum = static_cast<int>(number_from(p, "minimum", 0.0));
    const int maximum = static_cast<int>(number_from(p, "maximum", 100.0));
    if (maximum < minimum)
        throw std::runtime_error("QT GUI Dial: Maximum must be at least Minimum");
    const int minimum_size = static_cast<int>(number_from(p, "minsize", 100.0));
    const bool show_value = bool_from(p, "showvalue", false);
    const std::string key = unquoted(param_text(p, "outputmsgname", "value"));
    const QString label = QString::fromStdString(
        unquoted(param_text(p, "label")));
    const double requested = number_from(p, "value", 0.0);
    const int steps = std::min(std::max(static_cast<int>(std::llround(requested / scale)),
                                        minimum),
                               maximum);

    auto block = grworld::ControlMessageBlock::make(
        param_text(p, "__name", "QT GUI Dial"), "value");
    auto state = std::make_shared<ControlState>();

    auto* widget = new QWidget;
    auto* layout = new QVBoxLayout(widget);
    layout->setContentsMargins(2, 2, 2, 2);
    layout->setAlignment(Qt::AlignCenter);
    // Upstream's label doubles as the readout when Show Value is on.
    const auto caption = [label, type](double value) {
        QString text = label.isEmpty() ? QString() : label + QStringLiteral(" - ");
        return text + (type == grworld::ControlType::Real
                           ? QString::number(value, 'f', 2)
                           : QString::number(static_cast<long long>(value)));
    };
    auto* caption_label = new QLabel(show_value ? caption(steps * scale) : label, widget);
    caption_label->setAlignment(Qt::AlignCenter);
    layout->addWidget(caption_label);

    auto* dial = new QDial(widget);
    dial->setMinimumSize(minimum_size, minimum_size);
    dial->setMinimum(minimum);
    dial->setMaximum(maximum);
    dial->setValue(steps);
    const QString style = grworld::color_style(
        unquoted(param_text(p, "relBackgroundColor", "default")), std::string());
    if (!style.isEmpty())
        dial->setStyleSheet(style);
    QObject::connect(
        dial, &QDial::valueChanged, dial,
        [state, block, key, type, scale, show_value, caption, caption_label](int value) {
            const double scaled = value * scale;
            state->publish(scaled);
            block->publish(pmt::cons(pmt::intern(key), grworld::control_pmt(type, scaled)));
            if (show_value)
                caption_label->setText(caption(scaled));
        });
    layout->addWidget(dial);

    block->set_initial_message(
        pmt::cons(pmt::intern(key), grworld::control_pmt(type, steps * scale)));
    BuiltBlock result{ block, widget };
    result.is_variable = true;
    result.variable_value = steps * scale;
    result.subscribe = [state](std::function<void(double)> subscriber) {
        state->subscribers.push_back(std::move(subscriber));
    };
    return result;
}

BuiltBlock make_gui_label(const json& p)
{
    const std::string type = unquoted(param_text(p, "type", "int"));
    // A Label displays whatever it is given, so unlike the controls above it has
    // no reason to refuse a string: `type` only decides the formatting.
    const auto format = [type](double value) {
        if (type == "bool")
            return QString(value != 0.0 ? "True" : "False");
        if (type == "int")
            return QString::number(static_cast<long long>(std::llround(value)));
        return QString::number(value, 'g', 12);
    };

    auto* widget = new QWidget;
    auto* layout = new QHBoxLayout(widget);
    layout->setContentsMargins(0, 0, 0, 0);
    layout->addWidget(new QLabel(control_label(p, "Label") + ": ", widget));
    // A value that is neither a number nor a numeric string is shown as it was
    // written (`type: string`, or a reference to a control built after this one).
    const auto value = p.find("value");
    double initial = 0.0;
    QString text;
    if (value != p.end() && value->is_number()) {
        initial = value->get<double>();
        text = format(initial);
    } else {
        const std::string written = unquoted(
            value != p.end() && value->is_string() ? value->get<std::string>()
                                                   : std::string("0"));
        char* end = nullptr;
        const double parsed = std::strtod(written.c_str(), &end);
        if (end && *end == '\0' && !written.empty()) {
            initial = parsed;
            text = format(initial);
        } else {
            text = QString::fromStdString(written);
        }
    }
    auto* display = new QLabel(text, widget);
    display->setStyleSheet(QStringLiteral("font-weight: 600;"));
    layout->addWidget(display);

    BuiltBlock result;
    result.widget = widget;
    result.is_variable = true;
    result.variable_value = initial;
    // Nothing subscribes to a Label -- it is a display, not a control -- but it
    // is the one variable control that *is* driven: a Label whose Value is a
    // Range's block ID tracks that Range, through the same parameter binding
    // that wires a Range to a block's setter. See run_now() in runner.cpp.
    result.subscribe = [](std::function<void(double)>) {};
    result.numeric_setters["value"] = [display, format](double updated) {
        display->setText(format(updated));
    };
    return result;
}

BuiltBlock make_numeric_entry(const json& p)
{
    auto* entry = new grworld::NumericEntryWidget(
        QString::fromStdString(unquoted(param_text(p, "label"))),
        number_from(p, "value", 0.0),
        number_from(p, "increment", 0.1),
        QString::fromStdString(unquoted(param_text(p, "unit"))),
        QString::fromStdString(unquoted(param_text(p, "description"))),
        static_cast<int>(number_from(p, "precision", 10)),
        bool_from(p, "enabled", true),
        number_from(p, "value_min", -std::numeric_limits<double>::infinity()),
        number_from(p, "value_max", std::numeric_limits<double>::infinity()));

    auto state = std::make_shared<ControlState>();
    entry->on_change = [state](double value) { state->publish(value); };

    BuiltBlock result;
    result.widget = entry;
    result.is_variable = true;
    result.variable_value = entry->value();
    result.subscribe = [state](std::function<void(double)> subscriber) {
        state->subscribers.push_back(std::move(subscriber));
    };
    return result;
}

BuiltBlock make_digital_number_control(const json& p)
{
    const long long minimum =
        static_cast<long long>(std::llround(number_from(p, "minFreqHz", 30e6)));
    const long long maximum =
        static_cast<long long>(std::llround(number_from(p, "maxFreqHz", 1700e6)));
    if (maximum < minimum)
        throw std::runtime_error(
            "QT GUI Digital Number Control: Max Freq is below Min Freq");
    const std::string key = unquoted(param_text(p, "outputmsgname", "freq"));
    auto block = grworld::ControlMessageBlock::make(
        param_text(p, "__name", "QT GUI Digital Number Control"),
        "valueout",
        "valuein");

    auto* number = new grworld::DigitalNumberWidget(
        minimum,
        maximum,
        QString::fromStdString(unquoted(param_text(p, "ThousandsSeparator", ","))),
        QString::fromStdString(unquoted(param_text(p, "relBackgroundColor", "black"))),
        QString::fromStdString(unquoted(param_text(p, "relFontColor", "white"))));
    const double requested = number_from(p, "value", static_cast<double>(minimum));
    number->set_value_now(static_cast<long long>(std::llround(
        std::min(std::max(requested, static_cast<double>(minimum)),
                 static_cast<double>(maximum)))));
    number->set_read_only(bool_from(p, "readOnly", false));

    auto state = std::make_shared<ControlState>();
    const auto announce = [state, block, key](double value) {
        state->publish(value);
        block->publish(pmt::cons(pmt::intern(key), pmt::from_double(value)));
    };
    number->on_change = announce;
    // Runs on a GR thread: the value is queued for the widget's own timer to
    // paint, and only then re-announced, exactly as upstream's msgHandler does.
    block->set_handler([number, announce](pmt::pmt_t message) {
        if (!pmt::is_pair(message))
            return;
        const pmt::pmt_t value = pmt::cdr(message);
        if (!pmt::is_number(value))
            return;
        const double updated = pmt::to_double(value);
        number->queue_value(updated);
        announce(updated);
    });

    block->set_initial_message(
        pmt::cons(pmt::intern(key),
                  pmt::from_double(static_cast<double>(number->value()))));
    // Upstream puts the label above the digits (LabeledDigitalNumberControl).
    BuiltBlock result{ block,
                       grworld::label_around(
                           number,
                           QString::fromStdString(unquoted(param_text(p, "lbl"))),
                           1,
                           1,
                           1) };
    result.is_variable = true;
    result.variable_value = static_cast<double>(number->value());
    result.subscribe = [state](std::function<void(double)> subscriber) {
        state->subscribers.push_back(std::move(subscriber));
    };
    return result;
}

BuiltBlock make_fosphor_sink(const json& p, const std::string& block_name)
{
    const auto window = wasm_registry::choice<gr::fft::window::win_type>(
        p,
        "wintype",
        {
            { "window.WIN_BLACKMAN_hARRIS",
              gr::fft::window::WIN_BLACKMAN_hARRIS },
            { "window.WIN_HAMMING", gr::fft::window::WIN_HAMMING },
            { "window.WIN_HANN", gr::fft::window::WIN_HANN },
            { "window.WIN_BLACKMAN", gr::fft::window::WIN_BLACKMAN },
            { "window.WIN_RECTANGULAR", gr::fft::window::WIN_RECTANGULAR },
            { "window.WIN_KAISER", gr::fft::window::WIN_KAISER },
            { "window.WIN_FLATTOP", gr::fft::window::WIN_FLATTOP },
        },
        gr::fft::window::WIN_BLACKMAN_hARRIS);
    const double initial_center = number_from(p, "freq_center", 0.0);
    const double initial_span = number_from(p, "freq_span", 1.0);
    const std::string instance_name = p.value("__name", block_name);

    if (MAIN_THREAD_EM_ASM_INT({
            const manager = globalThis.__grFosphorWebGpu;
            return manager && manager.ready ? 1 : 0;
        })) {
        try {
            auto block = FosphorWebGpuSinkWasm::make(
                instance_name, window, initial_center, initial_span);
            auto range = std::make_shared<std::pair<double, double>>(
                initial_center, initial_span);
            BuiltBlock result{ block, block->qwidget() };
            result.numeric_setters["freq_center"] =
                [block, range](double value) {
                    range->first = value;
                    block->set_frequency_range(range->first, range->second);
                };
            result.numeric_setters["freq_span"] =
                [block, range](double value) {
                    range->second = value;
                    block->set_frequency_range(range->first, range->second);
                };
            return result;
        } catch (const std::exception& error) {
            MAIN_THREAD_EM_ASM(
                {
                    const manager = globalThis.__grFosphorWebGpu;
                    if (manager && globalThis.__grFosphorBackend !== 'cpu')
                        manager.markCpu(UTF8ToString($0));
                },
                error.what());
        }
    }

    auto block =
        FosphorSinkWasm::make(instance_name, window, initial_center, initial_span);
    auto range = std::make_shared<std::pair<double, double>>(initial_center,
                                                             initial_span);
    BuiltBlock result{ block, block->qwidget() };
    result.numeric_setters["freq_center"] = [block, range](double value) {
        range->first = value;
        block->set_frequency_range(range->first, range->second);
    };
    result.numeric_setters["freq_span"] = [block, range](double value) {
        range->second = value;
        block->set_frequency_range(range->first, range->second);
    };
    return result;
}

// ---- Embedded Python Block ------------------------------------------------
// The Python object already exists by the time this runs: gr_run_json's prepare
// step instantiated every Python Block in the Pyodide worker before building any
// C++ block, precisely so this constructor does not have to wait for one (it runs
// on the browser main thread, which may not block). What is left here is reading
// back what that object turned out to be. See blocks/src/python_block.hpp.

static std::vector<int> itemsizes_from(const json& description, const char* key)
{
    std::vector<int> out;
    if (description.contains(key))
        for (const auto& size : description[key]) out.push_back(size.get<int>());
    return out;
}

static BuiltBlock make_python_block(const json& p)
{
    const std::string name = param_text(p, "__name");
    if (name.empty())
        throw std::runtime_error("Python Block: the flowgraph gave it no block id");

    // The worker's report, as the prepare step left it on the page.
    char* raw = reinterpret_cast<char*>(MAIN_THREAD_EM_ASM_PTR({
        var description = window.__grPyodideDescription
            ? window.__grPyodideDescription(UTF8ToString($0)) : null;
        return description ? stringToNewUTF8(JSON.stringify(description)) : 0;
    }, name.c_str()));
    if (!raw)
        throw std::runtime_error("Python Block '" + name + "': the Python runtime did not "
                                 "report this block — see the console for why it failed to "
                                 "load");
    const std::string text(raw);
    std::free(raw);
    const json description = json::parse(text);

    // Message ports need a PMT bridge between C++ and Python, which does not
    // exist yet (docs/embedded-python.md). Registering ports that could never
    // deliver anything would turn that into a flowgraph which runs and silently
    // does nothing, so refuse it in terms the user can act on.
    if (!description.value("msg_ports_in", json::array()).empty() ||
        !description.value("msg_ports_out", json::array()).empty())
        throw std::runtime_error("Python Block '" + name + "': message ports are not "
                                 "supported yet — this block registers one, and stream "
                                 "ports are all the browser runner can carry so far");

    grworld::PythonBlockConfig config;
    config.name = name;
    config.label = description.value("label", std::string("Python Block"));
    config.in_itemsizes = itemsizes_from(description, "itemsizes_in");
    config.out_itemsizes = itemsizes_from(description, "itemsizes_out");
    config.decim = std::max(1, description.value("decim", 1));
    config.interp = std::max(1, description.value("interp", 1));
    config.history = std::max(1, description.value("history", 1));
    config.output_multiple = description.value("output_multiple", 0);
    config.relative_rate = description.value("relative_rate", 1.0);
    config.tag_propagation_policy = description.value("tag_propagation_policy", 1);
    config.min_output_buffer = description.value("min_output_buffer", 0);
    config.max_noutput_items = description.value("max_noutput_items", 0);
    config.overrides_forecast = description.value("overrides_forecast", false);

    std::vector<std::string> callbacks;
    for (const auto& callback : description.value("callbacks", json::array()))
        callbacks.push_back(callback.get<std::string>());
    config.callback_count = static_cast<int>(callbacks.size());

    auto block = grworld::PythonBlockWasm::make(config);
    BuiltBlock result{ block };
    // Every introspected callback becomes a live setter, so a QT GUI Range can
    // drive a Python Block's parameter exactly as it drives a C++ block's. The
    // index is the callback's position, which is how the worker addresses it.
    for (int i = 0; i < static_cast<int>(callbacks.size()) && i < grworld::kMaxCallbacks; ++i)
        result.numeric_setters[callbacks[i]] = [block, i](double value) {
            block->set_callback_value(i, value);
        };
    return result;
}

// ---- the JavaScript Block --------------------------------------------------
// Nothing to prepare and nothing to await: the descriptor is read here, on the
// browser main thread, by evaluating the source synchronously. That is the whole
// difference from make_python_block() above, and it is why there is no prepare
// step in runner.cpp for this block.
//
// The instance the scheduler will actually call is built later, on the block's
// own thread, by evaluating the same source a second time -- a JS object cannot
// cross a worker boundary. See blocks/src/js_block.hpp.

// Repo JS blocks (blocks/js/<id>.js), fetched by runner.html before any block is
// built and copied in here. An instance carrying its own source never consults
// this map; see js_block_source() below for the one rule that decides.
static std::map<std::string, std::string>& js_block_sources()
{
    static std::map<std::string, std::string> sources;
    return sources;
}

static int js_itemsize(const std::string& dtype, int vlen)
{
    int width = 0;
    if (dtype == "complex") width = 8;
    else if (dtype == "float" || dtype == "int") width = 4;
    else if (dtype == "short") width = 2;
    else if (dtype == "byte") width = 1;
    else throw std::runtime_error("unsupported JS port type: " + dtype);
    return width * std::max(1, vlen);
}

// One rule covers the inline block, a block installed from the browser-local
// library, and a merged repo block: **use the inline source when the instance
// carries one, otherwise fetch by id.**
static std::string js_block_source(const std::string& block_id, const json& p)
{
    for (const char* key : { "_js_source", "_source_code" }) {
        const std::string text = p.value(key, std::string());
        if (!text.empty()) return text;
    }
    auto it = js_block_sources().find(block_id);
    if (it != js_block_sources().end() && !it->second.empty()) return it->second;
    throw std::runtime_error("JS Block '" + block_id + "': no source — the block's "
                             "JavaScript was neither carried by the flowgraph nor "
                             "found in blocks/js/");
}

static BuiltBlock make_js_block(const std::string& block_id, const json& p)
{
    const std::string source = js_block_source(block_id, p);

    // Evaluate the source and read its descriptor. Plain EM_ASM: this runs on the
    // browser main thread, which is where the factory always is, so nothing is
    // proxied and nothing is lost by not proxying.
    std::vector<char> error(grworld::kJsErrorBytes, '\0');
    char* raw = reinterpret_cast<char*>(EM_ASM_PTR({
        return __grJs.describe($0, $1, $2);
    }, source.c_str(), error.data(), grworld::kJsErrorBytes));
    if (!raw) {
        error[grworld::kJsErrorBytes - 1] = '\0';
        const std::string message(error.data());
        throw std::runtime_error("JS Block '" + p.value("__name", block_id) + "': " +
                                 (message.empty() ? "its source could not be read" : message));
    }
    const std::string text(raw);
    std::free(raw);
    const json info = json::parse(text);

    grworld::JsBlockConfig config;
    config.name = p.value("__name", block_id);
    config.label = info.value("label", std::string("JS Block"));
    config.source = source;
    config.descriptor_json = text;
    for (const auto& port : info.value("inputs", json::array()))
        config.in_itemsizes.push_back(
            js_itemsize(port.value("dtype", std::string()), port.value("vlen", 1)));
    for (const auto& port : info.value("outputs", json::array()))
        config.out_itemsizes.push_back(
            js_itemsize(port.value("dtype", std::string()), port.value("vlen", 1)));
    config.decim = std::max(1, info.value("decim", 1));
    config.interp = std::max(1, info.value("interp", 1));
    config.history = std::max(1, info.value("history", 1));
    config.output_multiple = info.value("outputMultiple", 0);
    config.relative_rate = info.value("relativeRate", 1.0);
    config.general = info.value("general", false);
    config.overrides_forecast = info.value("overridesForecast", false);

    auto string_list = [&](const char* key) {
        std::vector<std::string> values;
        std::set<std::string> seen;
        const auto list = info.value(key, json::array());
        if (!list.is_array())
            throw std::runtime_error("JS Block '" + config.name + "': " + key +
                                     " must be an array");
        for (const auto& item : list) {
            if (!item.is_string() || item.get<std::string>().empty())
                throw std::runtime_error("JS Block '" + config.name + "': " + key +
                                         " contains an empty or non-string port name");
            const std::string name = item.get<std::string>();
            if (!seen.insert(name).second)
                throw std::runtime_error("JS Block '" + config.name + "': duplicate " +
                                         std::string(key) + " port '" + name + "'");
            values.push_back(name);
        }
        return values;
    };
    config.msg_ports_in = string_list("msgPortsIn");
    config.msg_ports_out = string_list("msgPortsOut");
    config.msg_handler_ports = string_list("msgHandlerPorts");
    const std::set<std::string> input_messages(config.msg_ports_in.begin(),
                                                config.msg_ports_in.end());
    for (const auto& name : config.msg_handler_ports)
        if (!input_messages.count(name))
            throw std::runtime_error("JS Block '" + config.name + "': handler port '" +
                                     name + "' is not a registered input message port");

    config.tag_propagation_policy = info.value("tagPropagation", 1);
    if (config.tag_propagation_policy < 0 || config.tag_propagation_policy > 3)
        throw std::runtime_error("JS Block '" + config.name +
                                 "': unsupported tag propagation policy " +
                                 std::to_string(config.tag_propagation_policy));
    if (config.tag_propagation_policy == gr::block::TPP_ONE_TO_ONE &&
        config.in_itemsizes.size() != config.out_itemsizes.size())
        throw std::runtime_error("JS Block '" + config.name +
                                 "': TPP_ONE_TO_ONE requires equal stream port counts (" +
                                 std::to_string(config.in_itemsizes.size()) + " inputs, " +
                                 std::to_string(config.out_itemsizes.size()) + " outputs)");

    if (info.contains("minOutputBuffers")) {
        const auto& minima = info.at("minOutputBuffers");
        if (!minima.is_array() || minima.size() != config.out_itemsizes.size())
            throw std::runtime_error("JS Block '" + config.name +
                                     "': minOutputBuffers must have one entry per stream output");
        for (const auto& value : minima) {
            if (!value.is_number_integer() || value.get<long>() < 0)
                throw std::runtime_error("JS Block '" + config.name +
                                         "': minimum output buffer sizes must be non-negative integers");
            config.min_output_buffers.push_back(value.get<long>());
        }
    }
    config.max_noutput_items = info.value("maxNoutputItems", 0);
    if (info.contains("maxNoutputItems") && config.max_noutput_items <= 0)
        throw std::runtime_error("JS Block '" + config.name +
                                 "': maxNoutputItems must be a positive integer");

    // The flowgraph's values for this instance's parameters, as JSON for the JS
    // side to spread onto `this`. GRC parameters arrive as JSON numbers *or* as
    // strings depending on the path, so a parameter the descriptor declared
    // numeric is read with number_from() and carried across as a real number --
    // otherwise `this.gain * x` would silently concatenate.
    std::vector<std::string> numeric;
    for (const auto& name : info.value("numericParams", json::array()))
        numeric.push_back(name.get<std::string>());
    const std::set<std::string> numeric_set(numeric.begin(), numeric.end());
    json values = json::object();
    for (const auto& entry : info.value("params", json::array())) {
        if (!entry.is_array() || entry.empty()) continue;
        const std::string name = entry[0].get<std::string>();
        if (!p.contains(name)) continue;
        if (numeric_set.count(name)) values[name] = number_from(p, name, 0.0);
        else values[name] = p.at(name);
    }
    config.params_json = values.dump();
    config.numeric_params = numeric;

    auto block = grworld::JsBlockWasm::make(config);
    BuiltBlock result{ block };
    // Every numeric parameter becomes a live setter, so a QT GUI Range drives a JS
    // block exactly as it drives a C++ one. Without an entry here the slider would
    // still move and still publish, and the block would silently keep its
    // construction-time value.
    for (int i = 0; i < static_cast<int>(numeric.size()) && i < grworld::kJsMaxPorts; ++i)
        result.numeric_setters[numeric[i]] = [block, i](double value) {
            block->set_param_value(i, value);
        };
    return result;
}

} // namespace

// Repo JS block sources, handed over by runner.cpp once runner.html has fetched
// them -- before any block is built, because a factory cannot await anything. See
// "How the source reaches the runner" in docs/js-blocks.md.
void set_js_block_source(const std::string& block_id, const std::string& source)
{
    js_block_sources()[block_id] = source;
}

// Every repo JS block registers here rather than by hand in the table above: the
// factory is generic and the block id is the only thing that differs. Called from
// generated_js_blocks.cpp.
void register_js_block(std::map<std::string, Factory>& registry, const std::string& block_id)
{
    registry[block_id] = [block_id](const nlohmann::json& p) -> BuiltBlock {
        return make_js_block(block_id, p);
    };
}

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
        {"variable_qtgui_check_box", [](const json& p) -> BuiltBlock {
             return make_check_box(p);
         }},
        {"variable_qtgui_entry", [](const json& p) -> BuiltBlock {
             return make_entry(p);
         }},
        // The rest of GRC's GUI Widgets/QT family. All Python QWidgets
        // upstream, rebuilt in blocks/src/qtgui_controls.hpp -- except
        // edit_box_msg, which is C++ already and only needs a factory to read
        // its parameters.
        {"variable_qtgui_label", [](const json& p) -> BuiltBlock {
             return make_gui_label(p);
         }},
        {"variable_qtgui_numeric_entry", [](const json& p) -> BuiltBlock {
             return make_numeric_entry(p);
         }},
        {"variable_qtgui_toggle_switch", [](const json& p) -> BuiltBlock {
             return make_toggle_switch(p);
         }},
        {"variable_qtgui_toggle_button_msg", [](const json& p) -> BuiltBlock {
             return make_toggle_button(p);
         }},
        {"variable_qtgui_msgcheckbox", [](const json& p) -> BuiltBlock {
             return make_msg_check_box(p);
         }},
        {"variable_qtgui_msg_push_button", [](const json& p) -> BuiltBlock {
             return make_msg_push_button(p);
         }},
        {"variable_qtgui_dial_control", [](const json& p) -> BuiltBlock {
             return make_dial_control(p);
         }},
        {"qtgui_msgdigitalnumbercontrol", [](const json& p) -> BuiltBlock {
             return make_digital_number_control(p);
         }},
        // The one control upstream already writes in C++ (gr-qtgui's
        // edit_box_msg_impl.cc); qtgui/CMakeLists.txt builds it for Qt6.
        {"qtgui_edit_box_msg", [](const json& p) -> BuiltBlock {
             // The parameter holds the option *value* (`string`, `int_vec`, …);
             // it is the `t` option attribute that spells the enumerator, and
             // only the Python template ever reads that.
             const auto type = wasm_registry::choice<gr::qtgui::data_type_t>(
                 p,
                 "type",
                 {
                     { "string", gr::qtgui::STRING },
                     { "int", gr::qtgui::INT },
                     { "float", gr::qtgui::FLOAT },
                     { "double", gr::qtgui::DOUBLE },
                     { "complex", gr::qtgui::COMPLEX },
                     { "int_vec", gr::qtgui::INT_VEC },
                     { "flt_vec", gr::qtgui::FLOAT_VEC },
                     { "dbl_vec", gr::qtgui::DOUBLE_VEC },
                     { "cpx_vec", gr::qtgui::COMPLEX_VEC },
                 },
                 gr::qtgui::STRING);
             auto b = gr::qtgui::edit_box_msg::make(
                 type,
                 unquoted(param_text(p, "value")),
                 unquoted(param_text(p, "label")),
                 bool_from(p, "is_pair", true),
                 bool_from(p, "is_static", true),
                 unquoted(param_text(p, "key")));
             return BuiltBlock{ b, b->qwidget() };
         }},
        // ---- sources ----
        // A runner-only float source and QWidget in one block. The widget's
        // main-thread note state is handed to the scheduler-side synthesizer in
        // musical_keyboard_source.hpp; returning it here is what lets GUI
        // Layout place the SamSonic keyboard alongside ordinary QT GUI sinks.
        {"wasm_musical_keyboard_source", [](const json& p) -> BuiltBlock {
             const auto waveform = wasm_registry::choice<grworld::KeyboardWaveform>(
                 p,
                 "waveform",
                 {
                     { "sine", grworld::KeyboardWaveform::Sine },
                     { "triangle", grworld::KeyboardWaveform::Triangle },
                     { "saw", grworld::KeyboardWaveform::Saw },
                     { "square", grworld::KeyboardWaveform::Square },
                 },
                 grworld::KeyboardWaveform::Saw);
             const auto chord = wasm_registry::choice<grworld::KeyboardChord>(
                 p,
                 "default_chord",
                 {
                     { "none", grworld::KeyboardChord::None },
                     { "major_triad", grworld::KeyboardChord::MajorTriad },
                     { "minor_triad", grworld::KeyboardChord::MinorTriad },
                     { "tritone", grworld::KeyboardChord::Tritone },
                     { "major_seventh", grworld::KeyboardChord::MajorSeventh },
                     { "minor_seventh", grworld::KeyboardChord::MinorSeventh },
                     { "fully_diminished_seventh",
                       grworld::KeyboardChord::FullyDiminishedSeventh },
                 },
                 grworld::KeyboardChord::None);
             auto block = grworld::MusicalKeyboardSource::make(
                 number_from(p, "samp_rate", 48000.0),
                 number_from(p, "amplitude", 0.18),
                 waveform,
                 static_cast<int>(number_from(p, "first_note", 48)),
                 static_cast<int>(number_from(p, "octaves", 2)),
                 number_from(p, "tuning_hz", 440.0),
                 number_from(p, "attack_ms", 5.0),
                 number_from(p, "decay_ms", 180.0),
                 number_from(p, "sustain_level", 0.6),
                 number_from(p, "release_ms", 120.0),
                 static_cast<int>(number_from(p, "unison_voices", 2)),
                 number_from(p, "unison_detune_cents", 9.0),
                 number_from(p, "filter_cutoff_hz", 700.0),
                 number_from(p, "filter_resonance", 0.25),
                 number_from(p, "filter_envelope_octaves", 3.0),
                 number_from(p, "saturation_drive", 1.0),
                 chord);
             BuiltBlock result{ block, block->qwidget() };
             result.numeric_setters = {
                 { "amplitude", [block](double value) { block->set_amplitude(value); } },
                 { "tuning_hz", [block](double value) { block->set_tuning_hz(value); } },
                 { "attack_ms", [block](double value) { block->set_attack_ms(value); } },
                 { "decay_ms", [block](double value) { block->set_decay_ms(value); } },
                 { "sustain_level",
                   [block](double value) { block->set_sustain_level(value); } },
                 { "release_ms", [block](double value) { block->set_release_ms(value); } },
                 { "unison_voices",
                   [block](double value) { block->set_unison_voices(value); } },
                 { "unison_detune_cents",
                   [block](double value) { block->set_unison_detune_cents(value); } },
                 { "filter_cutoff_hz",
                   [block](double value) { block->set_filter_cutoff_hz(value); } },
                 { "filter_resonance",
                   [block](double value) { block->set_filter_resonance(value); } },
                 { "filter_envelope_octaves",
                   [block](double value) {
                       block->set_filter_envelope_octaves(value);
                   } },
                 { "saturation_drive",
                   [block](double value) { block->set_saturation_drive(value); } },
             };
             return result;
         }},
        {"analog_sig_source_x", [](const json& p) -> BuiltBlock {
             double sr = p.value("samp_rate", 32000.0);
             auto wf = waveform_from(param_text(p, "waveform", "cos"));
             double fr = p.value("freq", 1000.0), a = p.value("amp", 1.0),
                    off = p.value("offset", 0.0), ph = p.value("phase", 0.0);
             if (is_float(p)) {
                 auto b = gr::analog::sig_source_f::make(sr, wf, fr, a, off, ph);
                 BuiltBlock result{ b };
                 result.numeric_setters = {
                     { "samp_rate", [b](double value) { b->set_sampling_freq(value); } },
                     { "freq", [b](double value) { b->set_frequency(value); } },
                     { "amp", [b](double value) { b->set_amplitude(value); } },
                     { "offset", [b](double value) { b->set_offset(static_cast<float>(value)); } },
                     { "phase", [b](double value) { b->set_phase(static_cast<float>(value)); } },
                 };
                 return result;
             }
             auto b = gr::analog::sig_source_c::make(sr, wf, fr, a, off, ph);
             BuiltBlock result{ b };
             result.numeric_setters = {
                 { "samp_rate", [b](double value) { b->set_sampling_freq(value); } },
                 { "freq", [b](double value) { b->set_frequency(value); } },
                 { "amp", [b](double value) { b->set_amplitude(value); } },
                 { "offset", [b](double value) { b->set_offset(gr_complex(value, 0)); } },
                 { "phase", [b](double value) { b->set_phase(static_cast<float>(value)); } },
             };
             return result;
        }},
        {"analog_noise_source_x", [](const json& p) -> BuiltBlock {
             const double a = number_from(p, "amp", 1.0);
             const long s = static_cast<long>(number_from(p, "seed", 0));
             const auto noise = noise_type_from(p);
             // Upstream implements only Uniform and Gaussian for a complex
             // output (noise_source_impl<gr_complex>::work throws "invalid
             // type" for the other two) -- and it throws from work(), so the
             // graph would start, produce nothing, and say only that. Refuse it
             // here instead, where the message names the block and the fix.
             if (!is_float(p) && noise != gr::analog::GR_UNIFORM &&
                 noise != gr::analog::GR_GAUSSIAN)
                 throw std::runtime_error(
                     "Noise Source: a complex output supports only Uniform and "
                     "Gaussian noise; use a float output for Laplacian or Impulse");
             if (is_float(p)) {
                 auto b = gr::analog::noise_source_f::make(noise, a, s);
                 BuiltBlock result{ b };
                 result.numeric_setters["amp"] =
                     [b](double value) { b->set_amplitude(static_cast<float>(value)); };
                 return result;
             }
             auto b = gr::analog::noise_source_c::make(noise, a, s);
             BuiltBlock result{ b };
             result.numeric_setters["amp"] =
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
             const auto vlen = static_cast<std::size_t>(
                 std::max(1.0, number_from(p, "vlen", 1.0)));
             const auto item_size = static_cast<std::size_t>(itemsize_of(p)) * vlen;
             const auto offset = static_cast<std::uint64_t>(
                 std::max(0.0, number_from(p, "offset", 0.0)));
             const auto length = static_cast<std::uint64_t>(
                 std::max(0.0, number_from(p, "length", 0.0)));
             return { BrowserFileSource::make(item_size,
                                               param_text(p, "file"),
                                               bool_from(p, "repeat", true),
                                               offset,
                                               length),
                      nullptr };
        }},
        // The same browser reader over a hosted SigMF recording. The editor
        // registers the recording's URL under the '/recordings/<key>.sigmf-data'
        // path this derives, so the mapping lives in exactly two places:
        // recordingDataPath() in editor/src/recording-catalog.ts and here.
        {"wasm_gr_world_recording", [](const json& p) -> BuiltBlock {
             const auto key = param_text(p, "recording");
             if (key.empty())
                 throw std::runtime_error(
                     "GR World Recording: no recording chosen");
             // A recording is a stream of scalar samples: no vector length, and
             // the item type is the one its SigMF datatype dictates.
             const auto item_size = static_cast<std::size_t>(itemsize_of(p));
             const auto offset = static_cast<std::uint64_t>(
                 std::max(0.0, number_from(p, "offset", 0.0)));
             const auto length = static_cast<std::uint64_t>(
                 std::max(0.0, number_from(p, "length", 0.0)));
             return { BrowserFileSource::make(item_size,
                                               "/recordings/" + key + ".sigmf-data",
                                               bool_from(p, "repeat", false),
                                               offset,
                                               length),
                      nullptr };
        }},
        // A SigMF recording on this computer: the same browser reader again, plus
        // the recording's own metadata turned into stream tags. The editor binds
        // the .sigmf-data under a /local-files/... path and the .sigmf-meta text
        // beside it, so the tag plan is built here rather than shipped in the
        // .grc -- a binding is session-only, and a .grc keeps only a file name.
        {"wasm_sigmf_source", [](const json& p) -> BuiltBlock {
             const auto path = param_text(p, "file");
             if (path.empty())
                 throw std::runtime_error(
                     "SigMF Source: no recording chosen -- pick both .sigmf-data "
                     "and .sigmf-meta with Browse");
             // A recording is a stream of scalar samples, and its item type is
             // the one core:datatype dictates; the editor sets that parameter
             // when the files are picked and shows it read-only.
             const auto item_size = static_cast<std::size_t>(itemsize_of(p));
             const auto offset = static_cast<std::uint64_t>(
                 std::max(0.0, number_from(p, "offset", 0.0)));
             const auto length = static_cast<std::uint64_t>(
                 std::max(0.0, number_from(p, "length", 0.0)));
             auto block = BrowserFileSource::make(item_size,
                                                  path,
                                                  bool_from(p, "repeat", false),
                                                  offset,
                                                  length);

             if (bool_from(p, "tags", true)) {
                 // The .sigmf-meta text the editor bound for this run. A factory
                 // runs on the browser main thread while the graph is built, so
                 // proxying costs nothing here -- but the same call inside work()
                 // would queue the whole flowgraph behind Qt's event loop. See
                 // docs/js-blocks.md for what that trap looks like.
                 char* raw = reinterpret_cast<char*>(MAIN_THREAD_EM_ASM_PTR({
                     const source =
                         window.__grInputSources && window.__grInputSources[UTF8ToString($0)];
                     return source && typeof source.meta === 'string'
                         ? stringToNewUTF8(source.meta) : 0;
                 }, path.c_str()));
                 if (raw) {
                     std::string meta_text(raw);
                     std::free(raw);
                     try {
                         block->set_tag_plan(sigmf::build_tag_plan(
                             nlohmann::json::parse(meta_text), offset, length));
                     } catch (const std::exception& error) {
                         // Named rather than swallowed: the editor already
                         // parsed this file to derive Output Type, so metadata
                         // that will not parse here means the two disagree, and
                         // a recording read with the wrong layout is worse than
                         // one that refuses to run.
                         throw std::runtime_error(
                             std::string("SigMF Source: could not read the "
                                         ".sigmf-meta: ") + error.what());
                     }
                 }
             }
             return { block, nullptr };
        }},
        // Writing a recording to this computer. Emscripten's filesystem is
        // in-memory, so there is no File Sink here at all: this block hands its
        // input to a worker that streams it to a file the reader chose, or (with
        // no File System Access API) buffers it and downloads it at the end. The
        // editor binds that destination under a /local-output/... path.
        {"wasm_sigmf_sink", [](const json& p) -> BuiltBlock {
             const auto path = param_text(p, "file");
             if (path.empty())
                 throw std::runtime_error(
                     "SigMF Sink: no output bound -- open its properties and give "
                     "it a name, and a folder where the browser offers one");
             const auto type = type_from(p, "complex");
             const auto item_size = static_cast<std::size_t>(itemsize_of(p));
             // The datatype the recording declares, from the item type on the
             // input. An interleaved-integer recording (ci16_le) is written by
             // feeding a short stream through Complex To IShort, exactly as in
             // native GNU Radio, so a short input is ri16_le here.
             static const std::map<std::string, std::string> datatypes = {
                 { "complex", "cf32_le" }, { "float", "rf32_le" },
                 { "int", "ri32_le" },     { "short", "ri16_le" },
                 { "byte", "ri8" },
             };
             const auto datatype = datatypes.find(type);
             if (datatype == datatypes.end())
                 throw std::runtime_error("SigMF Sink: unsupported stream type: " + type);

             auto block = SigmfSink::make(item_size,
                                          path,
                                          datatype->second,
                                          number_from(p, "sample_rate", 0.0),
                                          number_from(p, "center_freq", 0.0),
                                          wasm_registry::text(p, "author"),
                                          wasm_registry::text(p, "description"),
                                          wasm_registry::text(p, "hw_info"),
                                          bool_from(p, "annotate_tags", true));
             BuiltBlock result{ block };
             return result;
        }},
        // A file at any public URL. The editor probes its size and registers it
        // under the '/recordings/external/...' path it rewrites this parameter
        // to on the Run path, so what arrives here is already that path.
        {"wasm_public_http_recording", [](const json& p) -> BuiltBlock {
             const auto url = param_text(p, "url");
             if (url.empty())
                 throw std::runtime_error("Public HTTP Recording: no URL given");
             const auto vlen = static_cast<std::size_t>(
                 std::max(1.0, number_from(p, "vlen", 1.0)));
             const auto item_size = static_cast<std::size_t>(itemsize_of(p)) * vlen;
             const auto offset = static_cast<std::uint64_t>(
                 std::max(0.0, number_from(p, "offset", 0.0)));
             const auto length = static_cast<std::uint64_t>(
                 std::max(0.0, number_from(p, "length", 0.0)));
             return { BrowserFileSource::make(item_size,
                                               url,
                                               bool_from(p, "repeat", false),
                                               offset,
                                               length),
                      nullptr };
        }},
        // An RTL-SDR on this computer, reached over WebUSB by the worker in
        // runner/src/rtlsdr_reader.js. The Device parameter is a serial number
        // the editor picked with navigator.usb.requestDevice(); the permission
        // it granted is what lets the worker re-acquire the dongle without a
        // user gesture of its own. See docs/rtlsdr.md.
        {"wasm_rtlsdr_source", [](const json& p) -> BuiltBlock {
             const auto type = type_from(p, "complex");
             RtlSdrSource::Output output;
             if (type == "complex")
                 output = RtlSdrSource::Output::COMPLEX;
             else if (type == "short")
                 output = RtlSdrSource::Output::SHORT;
             else if (type == "byte")
                 output = RtlSdrSource::Output::BYTE;
             else
                 throw std::runtime_error(
                     "RTL-SDR Source: unsupported output type: " + type);

             const auto agc = bool_from(p, "gain_mode", false);
             // wasm_registry::text() rather than json::value(): the latter
             // throws type_error.302 on a type mismatch, which surfaces as an
             // opaque "type must be string, but is number" naming no parameter.
             // is_text_param() in grc_lower.hpp is what keeps a numeric-looking
             // serial from being coerced in the first place; this is the
             // backstop for a hand-written .grc that bypasses it.
             auto block = RtlSdrSource::make(
                 wasm_registry::text(p, "device"),
                 output,
                 number_from(p, "samp_rate", 2048000.0),
                 number_from(p, "center_freq", 100e6),
                 agc,
                 number_from(p, "gain", 30.0),
                 number_from(p, "freq_correction", 0.0),
                 static_cast<int>(number_from(p, "direct_samp", 0.0)),
                 bool_from(p, "bias_tee", false),
                 static_cast<int>(number_from(p, "bufflen", 262144.0)));

             BuiltBlock result{ block };
             // Bound by GRC parameter name, so a QT GUI Range referencing
             // center_freq or gain retunes the dongle while the graph runs.
             result.numeric_setters["center_freq"] =
                 [block](double value) { block->set_center_freq(value); };
             result.numeric_setters["gain"] =
                 [block](double value) { block->set_gain(value); };
             result.numeric_setters["gain_mode"] =
                 [block](double value) { block->set_gain_mode(value != 0.0); };
             result.numeric_setters["freq_correction"] =
                 [block](double value) { block->set_freq_correction(value); };
             result.numeric_setters["bias_tee"] =
                 [block](double value) { block->set_bias_tee(value != 0.0); };
             return result;
        }},
        // ADALM-PLUTO over the IIOD protocol exposed by the stock firmware's
        // WebUSB IIO interface. Device permission is granted by the editor;
        // runner/src/plutosdr_worker.js owns the USBDevice while this runs.
        {"wasm_plutosdr_source", [](const json& p) -> BuiltBlock {
             const auto gain_mode = [](const json& params, const char* key) {
                 const auto value = wasm_registry::text(params, key, "slow_attack");
                 if (value == "slow_attack") return plutosdr::SLOW_ATTACK;
                 if (value == "fast_attack") return plutosdr::FAST_ATTACK;
                 if (value == "hybrid") return plutosdr::HYBRID;
                 if (value == "manual") return plutosdr::MANUAL;
                 throw std::runtime_error(
                     std::string("PlutoSDR Source: invalid gain mode: ") + value);
             };
             auto block = PlutoSdrSource::make(
                 wasm_registry::text(p, "device"),
                 static_cast<int>(number_from(p, "channels", 1.0)),
                 number_from(p, "samp_rate", 2.5e6),
                 number_from(p, "center_freq", 2.4e9),
                 number_from(p, "bandwidth", 2.0e6),
                 static_cast<int>(number_from(p, "buffer_size", 32768.0)),
                 gain_mode(p, "gain_mode1"),
                 number_from(p, "gain1", 30.0),
                 gain_mode(p, "gain_mode2"),
                 number_from(p, "gain2", 30.0),
                 bool_from(p, "quadrature", true),
                 bool_from(p, "rf_dc", true),
                 bool_from(p, "bb_dc", true));
             BuiltBlock result{ block };
             result.numeric_setters["samp_rate"] =
                 [block](double value) { block->set_sample_rate(value); };
             result.numeric_setters["center_freq"] =
                 [block](double value) { block->set_center_freq(value); };
             result.numeric_setters["bandwidth"] =
                 [block](double value) { block->set_bandwidth(value); };
             result.numeric_setters["gain1"] =
                 [block](double value) { block->set_gain1(value); };
             result.numeric_setters["gain2"] =
                 [block](double value) { block->set_gain2(value); };
             return result;
        }},
        {"wasm_plutosdr_sink", [](const json& p) -> BuiltBlock {
             auto block = PlutoSdrSink::make(
                 wasm_registry::text(p, "device"),
                 static_cast<int>(number_from(p, "channels", 1.0)),
                 number_from(p, "samp_rate", 2.5e6),
                 number_from(p, "center_freq", 2.4e9),
                 number_from(p, "bandwidth", 2.0e6),
                 static_cast<int>(number_from(p, "buffer_size", 32768.0)),
                 number_from(p, "attenuation1", 89.75),
                 number_from(p, "attenuation2", 89.75));
             BuiltBlock result{ block };
             result.numeric_setters["samp_rate"] =
                 [block](double value) { block->set_sample_rate(value); };
             result.numeric_setters["center_freq"] =
                 [block](double value) { block->set_center_freq(value); };
             result.numeric_setters["bandwidth"] =
                 [block](double value) { block->set_bandwidth(value); };
             result.numeric_setters["attenuation1"] =
                 [block](double value) { block->set_attenuation1(value); };
             result.numeric_setters["attenuation2"] =
                 [block](double value) { block->set_attenuation2(value); };
             return result;
        }},
        // HackRF One's stock vendor-control protocol and signed 8-bit IQ bulk
        // endpoints, owned asynchronously by runner/src/hackrf_worker.js.
        {"wasm_hackrf_source", [](const json& p) -> BuiltBlock {
             auto block = HackRfSource::make(
                 wasm_registry::text(p, "device"),
                 number_from(p, "samp_rate", 10e6),
                 number_from(p, "center_freq", 100e6),
                 number_from(p, "bandwidth", 0.0),
                 number_from(p, "lna_gain", 16.0),
                 number_from(p, "vga_gain", 16.0),
                 bool_from(p, "amp", false),
                 bool_from(p, "bias_tee", false),
                 static_cast<int>(number_from(p, "transfer_size", 262144.0)));
             BuiltBlock result{ block };
             result.numeric_setters["samp_rate"] =
                 [block](double value) { block->set_sample_rate(value); };
             result.numeric_setters["center_freq"] =
                 [block](double value) { block->set_center_freq(value); };
             result.numeric_setters["lna_gain"] =
                 [block](double value) { block->set_lna_gain(value); };
             result.numeric_setters["vga_gain"] =
                 [block](double value) { block->set_vga_gain(value); };
             result.numeric_setters["amp"] =
                 [block](double value) { block->set_amp(value != 0.0); };
             result.numeric_setters["bias_tee"] =
                 [block](double value) { block->set_bias_tee(value != 0.0); };
             return result;
        }},
        // Signal Hound BB60C/D. The device has no decimation to ask for: it
        // always streams real 16-bit samples at 70 MS/s and every bit of tuning
        // below that happens in the block. runner/src/bb60_worker.js owns the
        // reverse-engineered USB protocol. See docs/signalhound.md.
        {"wasm_bb60_source", [](const json& p) -> BuiltBlock {
             auto block = Bb60Source::make(
                 wasm_registry::text(p, "device"),
                 number_from(p, "samp_rate", 10e6),
                 number_from(p, "center_freq", 100e6),
                 number_from(p, "bandwidth", 0.0),
                 number_from(p, "ref_level", -20.0));
             BuiltBlock result{ block };
             result.numeric_setters["center_freq"] =
                 [block](double value) { block->set_center_freq(value); };
             result.numeric_setters["ref_level"] =
                 [block](double value) { block->set_ref_level(value); };
             return result;
        }},
        {"wasm_hackrf_sink", [](const json& p) -> BuiltBlock {
             auto block = HackRfSink::make(
                 wasm_registry::text(p, "device"),
                 number_from(p, "samp_rate", 10e6),
                 number_from(p, "center_freq", 100e6),
                 number_from(p, "bandwidth", 0.0),
                 number_from(p, "txvga_gain", 0.0),
                 bool_from(p, "amp", false),
                 bool_from(p, "bias_tee", false),
                 static_cast<int>(number_from(p, "transfer_size", 262144.0)));
             BuiltBlock result{ block };
             result.numeric_setters["center_freq"] =
                 [block](double value) { block->set_center_freq(value); };
             result.numeric_setters["txvga_gain"] =
                 [block](double value) { block->set_txvga_gain(value); };
             result.numeric_setters["amp"] =
                 [block](double value) { block->set_amp(value != 0.0); };
             result.numeric_setters["bias_tee"] =
                 [block](double value) { block->set_bias_tee(value != 0.0); };
             return result;
        }},
        // gr-audio's Audio Sink and Audio Source. gr-audio itself is not built
        // here -- there is no ALSA, OSS or PortAudio in a browser tab and the
        // GNU Radio configure line turns the component off -- so upstream's two
        // block ids are backed by Web Audio instead, keeping every parameter
        // and port they have natively. See docs/audio.md.
        {"audio_sink", [](const json& p) -> BuiltBlock {
             return { BrowserAudioSink::make(
                          number_from(p, "samp_rate", 48000.0),
                          wasm_registry::text(p, "device_name"),
                          bool_from(p, "ok_to_block", true),
                          static_cast<int>(number_from(p, "num_inputs", 1.0))),
                      nullptr };
        }},
        {"audio_source", [](const json& p) -> BuiltBlock {
             return { BrowserAudioSource::make(
                          number_from(p, "samp_rate", 48000.0),
                          wasm_registry::text(p, "device_name"),
                          bool_from(p, "ok_to_block", true),
                          static_cast<int>(number_from(p, "num_outputs", 1.0))),
                      nullptr };
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
             const auto vlen = static_cast<std::size_t>(
                 std::max(1.0, number_from(p, "vlen", 1)));
             return { gr::blocks::null_source::make(itemsize_of(p) * vlen), nullptr };
         }},
        {"blocks_correctiq", [](const json&) -> BuiltBlock {
             return { gr::blocks::correctiq::make(), nullptr };
         }},
        {"blocks_correctiq_auto", [](const json& p) -> BuiltBlock {
             auto block = gr::blocks::correctiq_auto::make(
                 number_from(p, "samp_rate", 32000.0),
                 number_from(p, "freq", 0.0),
                 static_cast<float>(number_from(p, "gain", 0.0)),
                 static_cast<float>(number_from(p, "syncWindow", 2.0)));
             BuiltBlock result{ block };
             result.numeric_setters = {
                 { "freq", [block](double value) { block->set_freq(value); } },
                 { "gain",
                   [block](double value) {
                       block->set_gain(static_cast<float>(value));
                   } },
             };
             return result;
         }},
        {"blocks_correctiq_man", [](const json& p) -> BuiltBlock {
             auto block = gr::blocks::correctiq_man::make(
                 static_cast<float>(number_from(p, "real", 0.0)),
                 static_cast<float>(number_from(p, "imag", 0.0)));
             BuiltBlock result{ block };
             result.numeric_setters = {
                 { "real",
                   [block](double value) {
                       block->set_real(static_cast<float>(value));
                   } },
                 { "imag",
                   [block](double value) {
                       block->set_imag(static_cast<float>(value));
                   } },
             };
             return result;
         }},
        {"blocks_freqshift_cc", [](const json& p) -> BuiltBlock {
             const double sample_rate = number_from(p, "sample_rate", 32000.0);
             if (sample_rate == 0.0)
                 throw std::runtime_error("Frequency Shift sample rate must be nonzero");
             const auto phase_increment = [sample_rate](double frequency) {
                 return 2.0 * PI * frequency / sample_rate;
             };
             auto block = gr::blocks::rotator_cc::make(
                 phase_increment(number_from(p, "freq", 0.0)), false);
             BuiltBlock result{ block };
             result.numeric_setters["freq"] =
                 [block, phase_increment](double value) {
                     block->set_phase_inc(phase_increment(value));
                 };
             return result;
         }},
        {"blocks_phase_shift", [](const json& p) -> BuiltBlock {
             auto block = gr::blocks::phase_shift::make(
                 static_cast<float>(number_from(p, "shift", 0.0)),
                 bool_from(p, "is_radians", true));
             BuiltBlock result{ block };
             result.numeric_setters["shift"] =
                 [block](double value) {
                     block->set_shift(static_cast<float>(value));
                 };
             return result;
         }},
        {"blocks_swapiq", [](const json& p) -> BuiltBlock {
             const std::string type =
                 unquoted(param_text(p, "datatype", "complex"));
             if (type == "complex")
                 return { gr::blocks::swap_iq::make(
                              1, static_cast<int>(sizeof(gr_complex))),
                          nullptr };
             if (type == "short")
                 return { gr::blocks::swap_iq::make(
                              2, static_cast<int>(sizeof(std::int16_t))),
                          nullptr };
             if (type == "byte")
                 return { gr::blocks::swap_iq::make(
                              3, static_cast<int>(sizeof(std::int8_t))),
                          nullptr };
             throw std::runtime_error("Swap IQ type must be complex, short, or byte");
         }},
        {"filter_delay_fc", [](const json& p) -> BuiltBlock {
             return { gr::filter::filter_delay_fc::make(
                          flat_sequence<float>(p, "taps")),
                      nullptr };
         }},
        {"filterbank_vcvcf", [](const json& p) -> BuiltBlock {
             return { gr::filter::filterbank_vcvcf::make(
                          nested_sequence<float>(p, "taps", {})),
                      nullptr };
         }},
        {"ival_decimator", [](const json& p) -> BuiltBlock {
             const std::string type =
                 unquoted(param_text(p, "datatype", "byte"));
             const int item_size =
                 type == "byte" ? static_cast<int>(sizeof(std::int8_t))
                                : type == "short"
                                      ? static_cast<int>(sizeof(std::int16_t))
                                      : 0;
             if (item_size == 0)
                 throw std::runtime_error(
                     "Interleaved Stream Decimator type must be byte or short");
             return { gr::filter::ival_decimator::make(
                          static_cast<int>(number_from(p, "decimation", 1)),
                          item_size),
                      nullptr };
         }},
        {"fec_ber_bf", [](const json& p) -> BuiltBlock {
             return { gr::fec::ber_bf::make(
                          bool_from(p, "test_mode", false),
                          static_cast<int>(number_from(p, "berminerrors", 100)),
                          static_cast<float>(number_from(p, "berlimit", -7.0))),
                      nullptr };
         }},
        {"fec_encode_ccsds_27_bb", [](const json&) -> BuiltBlock {
             return { gr::fec::encode_ccsds_27_bb::make(), nullptr };
         }},
        {"fec_decode_ccsds_27_fb", [](const json&) -> BuiltBlock {
             return { gr::fec::decode_ccsds_27_fb::make(), nullptr };
         }},
        {"fec_depuncture_bb", [](const json& p) -> BuiltBlock {
             return { gr::fec::depuncture_bb::make(
                          static_cast<int>(number_from(p, "puncsize", 2)),
                          static_cast<int>(number_from(p, "puncpat", 3)),
                          static_cast<int>(number_from(p, "delay", 0)),
                          static_cast<std::uint8_t>(number_from(p, "sym", 127))),
                      nullptr };
         }},
        {"fec_puncture_xx", [](const json& p) -> BuiltBlock {
             const int size = static_cast<int>(number_from(p, "puncsize", 2));
             const int pattern = static_cast<int>(number_from(p, "puncpat", 3));
             const int delay = static_cast<int>(number_from(p, "delay", 0));
             const std::string type =
                 unquoted(param_text(p, "type", "byte"));
             if (type == "byte")
                 return { gr::fec::puncture_bb::make(size, pattern, delay),
                          nullptr };
             if (type == "float")
                 return { gr::fec::puncture_ff::make(size, pattern, delay),
                          nullptr };
             throw std::runtime_error("Puncture type must be byte or float");
         }},
        // gr-fec's coder definition variables. Each files a coder object --
        // or, at a non-zero Parallelism, a list of them -- for an FEC block to
        // name. Being objects rather than blocks is what keeps them here.
        {"variable_cc_decoder_def", [](const json& p) -> BuiltBlock {
             const std::string name = param_text(p, "__name");
             if (name.empty())
                 throw std::runtime_error("CC Decoder Definition requires a block name");
             // Each object in a parallel declaration is built separately rather
             // than shared: a decoder carries per-codeword state, so N workers
             // need N of them.
             std::vector<gr::fec::generic_decoder::sptr> decoders;
             const int count = coder_definition_count(p, "CC Decoder Definition");
             for (int i = 0; i < count; ++i)
                 decoders.push_back(gr::fec::code::cc_decoder::make(
                     static_cast<int>(number_from(p, "framebits", 2048)),
                     static_cast<int>(number_from(p, "k", 7)),
                     static_cast<int>(number_from(p, "rate", 2)),
                     flat_sequence<int>(p, "polys"),
                     static_cast<int>(number_from(p, "state_start", 0)),
                     static_cast<int>(number_from(p, "state_end", -1)),
                     cc_mode_from(p, "mode"),
                     bool_from(p, "padding", false)));
             runtime_cc_decoders()[name] = std::move(decoders);
             return {};
         }},
        {"variable_cc_encoder_def", [](const json& p) -> BuiltBlock {
             const std::string name = param_text(p, "__name");
             if (name.empty())
                 throw std::runtime_error("CC Encoder Definition requires a block name");
             std::vector<gr::fec::generic_encoder::sptr> encoders;
             const int count = coder_definition_count(p, "CC Encoder Definition");
             for (int i = 0; i < count; ++i)
                 encoders.push_back(gr::fec::code::cc_encoder::make(
                     static_cast<int>(number_from(p, "framebits", 2048)),
                     static_cast<int>(number_from(p, "k", 7)),
                     static_cast<int>(number_from(p, "rate", 2)),
                     flat_sequence<int>(p, "polys"),
                     static_cast<int>(number_from(p, "state_start", 0)),
                     cc_mode_from(p, "mode"),
                     bool_from(p, "padding", false)));
             runtime_fec_encoders()[name] = std::move(encoders);
             return {};
         }},
        {"variable_ccsds_encoder_def", [](const json& p) -> BuiltBlock {
             const std::string name = param_text(p, "__name");
             if (name.empty())
                 throw std::runtime_error(
                     "CCSDS Encoder Definition requires a block name");
             std::vector<gr::fec::generic_encoder::sptr> encoders;
             const int count = coder_definition_count(p, "CCSDS Encoder Definition");
             for (int i = 0; i < count; ++i)
                 encoders.push_back(gr::fec::code::ccsds_encoder::make(
                     static_cast<int>(number_from(p, "framebits", 2048)),
                     static_cast<int>(number_from(p, "state_start", 0)),
                     cc_mode_from(p, "mode")));
             runtime_fec_encoders()[name] = std::move(encoders);
             return {};
         }},
        {"variable_dummy_encoder_def", [](const json& p) -> BuiltBlock {
             const std::string name = param_text(p, "__name");
             if (name.empty())
                 throw std::runtime_error(
                     "Dummy Encoder Definition requires a block name");
             std::vector<gr::fec::generic_encoder::sptr> encoders;
             const int count = coder_definition_count(p, "Dummy Encoder Definition");
             for (int i = 0; i < count; ++i)
                 encoders.push_back(gr::fec::code::dummy_encoder::make(
                     static_cast<int>(number_from(p, "framebits", 2048))));
             runtime_fec_encoders()[name] = std::move(encoders);
             return {};
         }},
        {"variable_repetition_encoder_def", [](const json& p) -> BuiltBlock {
             const std::string name = param_text(p, "__name");
             if (name.empty())
                 throw std::runtime_error(
                     "Repetition Encoder Definition requires a block name");
             std::vector<gr::fec::generic_encoder::sptr> encoders;
             const int count =
                 coder_definition_count(p, "Repetition Encoder Definition");
             for (int i = 0; i < count; ++i)
                 encoders.push_back(gr::fec::code::repetition_encoder::make(
                     static_cast<int>(number_from(p, "framebits", 2048)),
                     static_cast<int>(number_from(p, "rep", 3))));
             runtime_fec_encoders()[name] = std::move(encoders);
             return {};
         }},
        {"variable_dummy_decoder_def", [](const json& p) -> BuiltBlock {
             const std::string name = param_text(p, "__name");
             if (name.empty())
                 throw std::runtime_error(
                     "Dummy Decoder Definition requires a block name");
             std::vector<gr::fec::generic_decoder::sptr> decoders;
             const int count = coder_definition_count(p, "Dummy Decoder Definition");
             for (int i = 0; i < count; ++i)
                 decoders.push_back(gr::fec::code::dummy_decoder::make(
                     static_cast<int>(number_from(p, "framebits", 2048))));
             runtime_cc_decoders()[name] = std::move(decoders);
             return {};
         }},
        {"variable_repetition_decoder_def", [](const json& p) -> BuiltBlock {
             const std::string name = param_text(p, "__name");
             if (name.empty())
                 throw std::runtime_error(
                     "Repetition Decoder Definition requires a block name");
             std::vector<gr::fec::generic_decoder::sptr> decoders;
             const int count =
                 coder_definition_count(p, "Repetition Decoder Definition");
             for (int i = 0; i < count; ++i)
                 decoders.push_back(gr::fec::code::repetition_decoder::make(
                     static_cast<int>(number_from(p, "framebits", 2048)),
                     static_cast<int>(number_from(p, "rep", 3)),
                     static_cast<float>(number_from(p, "prob", 0.5))));
             runtime_cc_decoders()[name] = std::move(decoders);
             return {};
         }},
        // GRC's Tag Object: a variable holding one gr::tag_t, which a Vector
        // Source names in its `tags` parameter. Upstream builds it with
        // gr.tag_utils.python_to_tag((offset, key, value, src)); here the three
        // PMT fields are decoded from their source text and the object is filed
        // under its variable name for wasm_registry::tag_objects() to find.
        {"variable_tag_object", [](const json& p) -> BuiltBlock {
             const std::string name = param_text(p, "__name");
             if (name.empty())
                 throw std::runtime_error("Tag Object requires a block name");
             gr::tag_t tag;
             tag.offset = static_cast<std::uint64_t>(number_from(p, "offset", 0));
             tag.key = wasm_registry::pmt_value(p, "key", "pmt.intern(\"key\")");
             tag.value = wasm_registry::pmt_value(p, "value", "pmt.intern(\"value\")");
             tag.srcid = wasm_registry::pmt_value(p, "src", "pmt.intern(\"src\")");
             wasm_registry::runtime_tag_objects()[name] = tag;
             return {};
         }},
        // GUI Layout: not a block at all, and the only "parameter" it has that
        // the runtime reads is a grid spec. Like the Tag Object above it is
        // built in run_now()'s pre-pass, before any widget exists, and files
        // what it parsed for the layout pass to pick up once they do.
        {"wasm_gui_layout", [](const json& p) -> BuiltBlock {
             gui_layout::runtime_spec() = gui_layout::parse(
                 unquoted(param_text(p, "layout", "{}")),
                 static_cast<int>(number_from(p, "columns",
                                              gui_layout::kDefaultColumns)),
                 static_cast<int>(number_from(p, "row_height",
                                              gui_layout::kDefaultRowHeight)));
             return {};
         }},
        {"fec_async_decoder", [](const json& p) -> BuiltBlock {
             return { gr::fec::async_decoder::make(
                          named_cc_decoder(param_text(p, "decoder")),
                          bool_from(p, "packed", false),
                          bool_from(p, "rev_pack", true),
                          static_cast<int>(number_from(p, "mtu", 1500))),
                      nullptr };
         }},
        // gr-fec's Python hier blocks, rebuilt in blocks/src/fec_hier.hpp.
        // Each takes a coder *object* by name rather than a plain parameter,
        // which is what keeps them out of the generated factories.
        {"fec_extended_decoder", [](const json& p) -> BuiltBlock {
             return { ExtendedDecoder::make(
                          named_cc_decoder(param_text(p, "decoder_list")),
                          wasm_registry::text(p, "puncpat", "11")),
                      nullptr };
         }},
        {"fec_extended_encoder", [](const json& p) -> BuiltBlock {
             return { ExtendedEncoder::make(
                          named_fec_encoders(param_text(p, "encoder_list")),
                          fec_threading_from(
                              unquoted(param_text(p, "threadtype", "capillary"))),
                          wasm_registry::text(p, "puncpat", "11")),
                      nullptr };
         }},
        {"fec_extended_async_encoder", [](const json& p) -> BuiltBlock {
             return { ExtendedAsyncEncoder::make(
                          named_fec_encoder(param_text(p, "encoder_list"))),
                      nullptr };
         }},
        {"fec_extended_tagged_encoder", [](const json& p) -> BuiltBlock {
             return { ExtendedTaggedEncoder::make(
                          named_fec_encoder(param_text(p, "encoder_list")),
                          wasm_registry::text(p, "puncpat", "11"),
                          length_tag_name(p),
                          static_cast<int>(number_from(p, "mtu", 1500))),
                      nullptr };
         }},
        {"fec_extended_tagged_decoder", [](const json& p) -> BuiltBlock {
             const std::string annihilator =
                 wasm_registry::text(p, "ann", "None");
             if (!annihilator.empty() && annihilator != "None")
                 throw std::runtime_error(
                     "FEC Extended Tagged Decoder annihilator is not supported");
             return { ExtendedTaggedDecoder::make(
                          named_cc_decoder(param_text(p, "decoder_list")),
                          wasm_registry::text(p, "puncpat", "11"),
                          length_tag_name(p),
                          static_cast<int>(number_from(p, "mtu", 1500))),
                      nullptr };
         }},
        {"fec_bercurve_generator", [](const json& p) -> BuiltBlock {
             const auto esno = flat_sequence<float>(p, "esno");
             return { BerCurveGenerator::make(
                          named_fec_encoders(param_text(p, "encoder_list")),
                          named_cc_decoders(param_text(p, "decoder_list")),
                          std::vector<double>(esno.begin(), esno.end()),
                          fec_threading_from(
                              unquoted(param_text(p, "threadtype", "capillary"))),
                          wasm_registry::text(p, "puncpat", "11"),
                          static_cast<long>(number_from(p, "seed", 0))),
                      nullptr };
         }},
        {"variable_constellation", [](const json& p) -> BuiltBlock {
             const std::string name = param_text(p, "__name");
             if (name.empty())
                 throw std::runtime_error("Constellation Object requires a block name");
             const std::string type =
                 unquoted(param_text(p, "type", "qpsk"));
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
                 unquoted(param_text(p, "soft_dec_lut", "None"));
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
             const std::string name = param_text(p, "__name");
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
                 unquoted(param_text(p, "soft_dec_lut", "None"));
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
        {"digital_constellation_decoder_cb", [](const json& p) -> BuiltBlock {
             return { gr::digital::constellation_decoder_cb::make(
                          named_constellation(
                              param_text(p, "constellation"))),
                      nullptr };
         }},
        {"digital_constellation_encoder_bc", [](const json& p) -> BuiltBlock {
             return { gr::digital::constellation_encoder_bc::make(
                          named_constellation(
                              param_text(p, "constellation"))),
                      nullptr };
         }},
        {"digital_constellation_receiver_cb", [](const json& p) -> BuiltBlock {
             auto block = gr::digital::constellation_receiver_cb::make(
                 named_constellation(param_text(p, "constellation")),
                 static_cast<float>(number_from(p, "loop_bw", 2.0 * PI / 100.0)),
                 static_cast<float>(number_from(p, "fmin", -0.25)),
                 static_cast<float>(number_from(p, "fmax", 0.25)));
             BuiltBlock result{ block };
             result.numeric_setters = {
                 { "loop_bw",
                   [block](double value) {
                       block->set_loop_bandwidth(static_cast<float>(value));
                   } },
                 { "fmin",
                   [block](double value) {
                       block->set_min_freq(static_cast<float>(value));
                   } },
                 { "fmax",
                   [block](double value) {
                       block->set_max_freq(static_cast<float>(value));
                   } },
             };
             return result;
         }},
        // Hand-written only to keep it out of the digital side module: built
        // there, its scheduler thread dies on the first pass through the message
        // queue with "null function" out of pmt::eqv, and everything downstream
        // of it sits at zero items. Nothing about the block itself needs custom
        // treatment -- the arguments are the generated ones -- so this is a
        // placement fix, and the live loop-bandwidth setter is a bonus.
        {"digital_costas_loop_cc", [](const json& p) -> BuiltBlock {
             auto block = gr::digital::costas_loop_cc::make(
                 static_cast<float>(number_from(p, "w", 0.0)),
                 static_cast<unsigned int>(number_from(p, "order", 2)),
                 bool_from(p, "use_snr", false));
             BuiltBlock result{ block };
             result.numeric_setters["w"] = [block](double value) {
                 block->set_loop_bandwidth(static_cast<float>(value));
             };
             return result;
         }},
        {"digital_constellation_soft_decoder_cf",
         [](const json& p) -> BuiltBlock {
             auto block = gr::digital::constellation_soft_decoder_cf::make(
                 named_constellation(param_text(p, "constellation")),
                 static_cast<float>(number_from(p, "npwr", -1.0)));
             BuiltBlock result{ block };
             result.numeric_setters["npwr"] =
                 [block](double value) {
                     block->set_npwr(static_cast<float>(value));
                 };
             return result;
         }},
        {"digital_meas_evm_cc", [](const json& p) -> BuiltBlock {
             return { gr::digital::meas_evm_cc::make(
                          named_constellation(param_text(p, "cons")),
                          evm_type_from(p)),
                      nullptr };
         }},
        {"digital_symbol_sync_xx", [](const json& p) -> BuiltBlock {
             const std::string type =
                 unquoted(param_text(p, "type", "cc"));
             if (type == "cc" || type == "complex")
                 return make_symbol_sync<gr::digital::symbol_sync_cc>(p);
             if (type == "ff" || type == "float")
                 return make_symbol_sync<gr::digital::symbol_sync_ff>(p);
             throw std::runtime_error("Symbol Sync type must be cc or ff");
         }},
        {"digital_constellation_modulator", [](const json& p) -> BuiltBlock {
             const std::string constellation =
                 param_text(p, "constellation");
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
                          unquoted(param_text(p, "mod_code", "gray")),
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
                 param_text(p, "mod_code", "gray"));
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
                 unquoted(param_text(p, "packet_len_key", "length"));
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
        // C++ rebuild of gr-digital's Python-only OFDM Transmitter hier
        // block.
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
                          unquoted(param_text(p, "packet_len_key", "length")),
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
        // gr-fft's Log Power FFT, a Python hier block upstream. Hand-written
        // rather than generated because all three of its GRC callbacks are
        // meaningful live: a Range control can drive the averaging on and off
        // and retune the alpha while the graph runs.
        {"logpwrfft_x", [](const json& p) -> BuiltBlock {
             const std::string type = unquoted(param_text(p, "type", "complex"));
             const double sample_rate = number_from(p, "sample_rate", 32000.0);
             const int fft_size = static_cast<int>(number_from(p, "fft_size", 1024));
             const double ref_scale = number_from(p, "ref_scale", 2.0);
             const double frame_rate = number_from(p, "frame_rate", 30.0);
             const double avg_alpha = number_from(p, "avg_alpha", 1.0);
             const bool average = bool_from(p, "average", false);
             const bool shift = bool_from(p, "shift", false);
             const auto with_setters = [&p](auto block) {
                 BuiltBlock result{ block };
                 result.numeric_setters["sample_rate"] =
                     [block](double value) { block->set_sample_rate(value); };
                 result.numeric_setters["avg_alpha"] =
                     [block](double value) { block->set_avg_alpha(value); };
                 result.numeric_setters["average"] =
                     [block](double value) { block->set_average(value != 0.0); };
                 return result;
             };
             if (type == "complex")
                 return with_setters(LogPwrFftC::make(sample_rate, fft_size, ref_scale,
                                                      frame_rate, avg_alpha, average,
                                                      shift));
             if (type == "float")
                 return with_setters(LogPwrFftF::make(sample_rate, fft_size, ref_scale,
                                                      frame_rate, avg_alpha, average,
                                                      shift));
             throw std::runtime_error("Log Power FFT input type must be complex or float");
         }},
        // gr-filter's Hierarchical Polyphase Channelizer. Both of its list
        // parameters are optional in a way the generated factories have no
        // spelling for: an unset `taps` means "design a prototype filter with
        // optfir", and an unset `outchans` means every channel.
        {"pfb_channelizer_hier_ccf", [](const json& p) -> BuiltBlock {
             auto block = PfbChannelizerHier::make(
                 static_cast<int>(number_from(p, "nchans", 3)),
                 static_cast<int>(number_from(p, "n_filterbanks", 4)),
                 flat_sequence<float>(p, "taps"),
                 flat_sequence<int>(p, "outchans"),
                 number_from(p, "atten", 100.0),
                 number_from(p, "bw", 1.0),
                 number_from(p, "tb", 0.2),
                 number_from(p, "ripple", 0.1));
             return { block, nullptr };
         }},
        // A Python hier block plus a Python QWidget upstream; the composition
        // is rebuilt in blocks/src/qtgui_sinks.hpp around gr-qtgui's own time
        // sink.
        {"qtgui_auto_correlator_sink", [](const json& p) -> BuiltBlock {
             auto block = AutoCorrelatorSinkWasm::make(
                 number_from(p, "sampRate", 32000.0),
                 static_cast<int>(number_from(p, "fac_size", 512)),
                 static_cast<int>(number_from(p, "fac_decimation", 10)),
                 wasm_registry::text(p, "title"),
                 bool_from(p, "autoScale", false),
                 bool_from(p, "grid", false),
                 number_from(p, "yMin", 0.0),
                 number_from(p, "yMax", 1.0),
                 bool_from(p, "useDB", true));
             return { block, block->qwidget() };
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
        // ---- gr-channels ----
        // Hand-written for the live fDTs/K setters alone: a fading model whose
        // Doppler rate cannot be moved while the graph runs is a demo nobody can
        // see. Being hand-written they register from the main module, so
        // libgnuradio-channels.a is linked normally below and only these two
        // objects are pulled into core; channel_model stays in channels.wasm.
        {"channels_fading_model", [](const json& p) -> BuiltBlock {
             auto block = gr::channels::fading_model::make(
                 static_cast<unsigned int>(number_from(p, "N", 8)),
                 static_cast<float>(number_from(p, "fDTs", 0.0)),
                 bool_from(p, "LOS", false),
                 static_cast<float>(number_from(p, "K", 4.0)),
                 static_cast<uint32_t>(number_from(p, "seed", 0)));
             BuiltBlock result{ block };
             result.numeric_setters["fDTs"] = [block](double value) {
                 block->set_fDTs(static_cast<float>(value));
             };
             result.numeric_setters["K"] = [block](double value) {
                 block->set_K(static_cast<float>(value));
             };
             return result;
         }},
        {"channels_selective_fading_model", [](const json& p) -> BuiltBlock {
             auto block = gr::channels::selective_fading_model::make(
                 static_cast<unsigned int>(number_from(p, "N", 8)),
                 static_cast<float>(number_from(p, "fDTs", 0.0)),
                 bool_from(p, "LOS", false),
                 static_cast<float>(number_from(p, "K", 4.0)),
                 static_cast<int>(number_from(p, "seed", 0)),
                 flat_sequence<float>(p, "delays"),
                 flat_sequence<float>(p, "mags"),
                 static_cast<int>(number_from(p, "ntaps", 8)));
             BuiltBlock result{ block };
             result.numeric_setters["fDTs"] = [block](double value) {
                 block->set_fDTs(static_cast<float>(value));
             };
             result.numeric_setters["K"] = [block](double value) {
                 block->set_K(static_cast<float>(value));
             };
             return result;
         }},
        // ---- flow control ----
        // Deprecated upstream and hidden from the editor palette in favour of
        // blocks_throttle2 (generated factory, same gr::blocks::throttle), but
        // kept so an existing .grc still runs. `samples_per_second` is GRC's own
        // id; `samp_rate` is the spelling this editor wrote before it matched.
        {"blocks_throttle", [](const json& p) -> BuiltBlock {
             const double rate = p.contains("samples_per_second")
                 ? number_from(p, "samples_per_second", 32000.0)
                 : number_from(p, "samp_rate", 32000.0);
             auto b = gr::blocks::throttle::make(itemsize_of(p), rate, true);
             BuiltBlock result{ b };
             const auto set_rate = [b](double value) { b->set_sample_rate(value); };
             result.numeric_setters["samples_per_second"] = set_rate;
             result.numeric_setters["samp_rate"] = set_rate;
             return result;
         }},
        {"blocks_head", [](const json& p) -> BuiltBlock {
             auto b = gr::blocks::head::make(
                 itemsize_of(p) * vlen_of(p),
                 static_cast<uint64_t>(p.value("num_items", 1000000.0)));
             BuiltBlock result{ b };
             result.numeric_setters["num_items"] = [b](double value) {
                 b->set_length(static_cast<uint64_t>(std::max(0.0, value)));
             };
             return result;
         }},
        {"blocks_delay", [](const json& p) -> BuiltBlock {
             // Sets history = delay+1, so it exercises the history path (like the qtgui sinks).
             auto b = gr::blocks::delay::make(itemsize_of(p) * vlen_of(p),
                                              p.value("delay", 1));
             BuiltBlock result{ b };
             result.numeric_setters["delay"] =
                 [b](double value) { b->set_dly(static_cast<int>(value)); };
             return result;
         }},
        // ---- math (type-parameterized) ----
        // num_inputs is not passed to the constructor: these blocks' C++ io_signature
        // already accepts any number of inputs (1, -1); num_inputs is purely GRC's
        // hint for how many ports the editor draws, matching how many are connected.
        {"blocks_add_xx", [](const json& p) -> BuiltBlock {
             size_t vlen = p.value("vlen", 1);
             return { is_float(p) ? (gr::basic_block_sptr)gr::blocks::add_ff::make(vlen)
                                  : (gr::basic_block_sptr)gr::blocks::add_cc::make(vlen), nullptr }; }},
        {"blocks_sub_xx", [](const json& p) -> BuiltBlock {
             size_t vlen = p.value("vlen", 1);
             return { is_float(p) ? (gr::basic_block_sptr)gr::blocks::sub_ff::make(vlen)
                                  : (gr::basic_block_sptr)gr::blocks::sub_cc::make(vlen), nullptr }; }},
        {"blocks_multiply_xx", [](const json& p) -> BuiltBlock {
             size_t vlen = p.value("vlen", 1);
             return { is_float(p) ? (gr::basic_block_sptr)gr::blocks::multiply_ff::make(vlen)
                                  : (gr::basic_block_sptr)gr::blocks::multiply_cc::make(vlen), nullptr }; }},
        {"blocks_divide_xx", [](const json& p) -> BuiltBlock {
             size_t vlen = p.value("vlen", 1);
             return { is_float(p) ? (gr::basic_block_sptr)gr::blocks::divide_ff::make(vlen)
                                  : (gr::basic_block_sptr)gr::blocks::divide_cc::make(vlen), nullptr }; }},
        {"blocks_multiply_const_xx", [](const json& p) -> BuiltBlock {
             double k = p.value("const", 1.0);
             const auto vlen = vlen_of(p);
             if (is_float(p)) {
                 auto b = gr::blocks::multiply_const_ff::make(static_cast<float>(k), vlen);
                 BuiltBlock result{ b };
                 result.numeric_setters["const"] =
                     [b](double value) { b->set_k(static_cast<float>(value)); };
                 return result;
             }
             auto b = gr::blocks::multiply_const_cc::make(gr_complex(k, 0), vlen);
             BuiltBlock result{ b };
             result.numeric_setters["const"] =
                 [b](double value) { b->set_k(gr_complex(value, 0)); };
             return result;
         }},
        {"blocks_conjugate_cc", [](const json&) -> BuiltBlock { return { gr::blocks::conjugate_cc::make(), nullptr }; }},
        // ---- type converters (complex in -> float out, etc.) ----
        // Each of these takes GRC's Vector Length as its constructor argument, so
        // a vector stream passes through them a vector at a time. Hardcoding 1
        // made every such connection an itemsize mismatch at connect time.
        {"blocks_complex_to_mag", [](const json& p) -> BuiltBlock { return { gr::blocks::complex_to_mag::make(vlen_of(p)), nullptr }; }},
        {"blocks_complex_to_mag_squared", [](const json& p) -> BuiltBlock { return { gr::blocks::complex_to_mag_squared::make(vlen_of(p)), nullptr }; }},
        {"blocks_complex_to_float", [](const json& p) -> BuiltBlock { return { gr::blocks::complex_to_float::make(vlen_of(p)), nullptr }; }},
        {"blocks_float_to_complex", [](const json& p) -> BuiltBlock { return { gr::blocks::float_to_complex::make(vlen_of(p)), nullptr }; }},
        // ---- sinks ----
        {"blocks_null_sink", [](const json& p) -> BuiltBlock {
             // vlen matters here: a vector stream terminated by a scalar-sized
             // null sink is an itemsize mismatch, which fails the whole graph at
             // connection time rather than in this factory.
             const auto vlen = static_cast<std::size_t>(
                 std::max(1.0, number_from(p, "vlen", 1)));
             return { gr::blocks::null_sink::make(itemsize_of(p) * vlen), nullptr };
         }},
        // GNU Radio World-specific, browser-native frequency-only instrument.
        // The block owns FFT/data publication; its QWidget is only the GUI
        // Layout placeholder under runner/src/spectrum_analyzer.js's overlay.
        {"wasm_spectrum_analyzer_sink", [](const json& p) -> BuiltBlock {
             const double sample_rate = number_from(p, "samp_rate", 1000000.0);
             const double center_frequency = number_from(p, "center_freq", 0.0);
             const double reference_level = number_from(p, "reference_level", 0.0);
             const double db_per_division = number_from(p, "db_per_div", 10.0);
             const double level_offset = number_from(p, "level_offset_db", 0.0);
             auto block = SpectrumAnalyzerSinkWasm::make(
                 p.value("__name", std::string("spectrum_analyzer")),
                 unquoted(param_text(p, "name", "Spectrum Analyzer")),
                 type_from(p, "complex"),
                 sample_rate,
                 center_frequency,
                 static_cast<int>(number_from(p, "fftsize", 4096)),
                 window_type_from(p, gr::fft::window::WIN_BLACKMAN_hARRIS),
                 number_from(p, "update_time", 0.1),
                 fft_average_from(p),
                 unquoted(param_text(p, "trace_mode", "average")),
                 reference_level,
                 db_per_division,
                 level_offset,
                 unquoted(param_text(p, "level_unit", "dBFS")));
             BuiltBlock result{ block, block->qwidget() };
             result.numeric_setters["samp_rate"] =
                 [block](double value) { block->set_sample_rate(value); };
             result.numeric_setters["center_freq"] =
                 [block](double value) { block->set_center_frequency(value); };
             result.numeric_setters["update_time"] =
                 [block](double value) { block->set_update_time(value); };
             result.numeric_setters["average"] =
                 [block](double value) { block->set_average(value); };
             result.numeric_setters["reference_level"] =
                 [block](double value) { block->set_reference_level(value); };
             result.numeric_setters["db_per_div"] =
                 [block](double value) { block->set_db_per_division(value); };
             result.numeric_setters["level_offset_db"] =
                 [block](double value) { block->set_level_offset_db(value); };
             return result;
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
                     unquoted(param_text(p, "label" + suffix));
                 if (label.empty())
                     label = "Data " + std::to_string(i);
                 labels.push_back(std::move(label));
                 units.push_back(
                     unquoted(param_text(p, "unit" + suffix)));
                 factors.push_back(
                     number_from(p, "factor" + suffix, 1.0));
             }

             auto block = NumberSinkWasm::make(
                 input_type,
                 connections,
                 unquoted(param_text(p, "name", "Number")),
                 labels,
                 units,
                 factors);
             return { block, block->qwidget() };
         }},
        // A runner-only sink: no upstream GNU Radio block defines it, so its
        // whole definition is blocks/grc/wasm_packet_rate_sink.block.yml.
        {"wasm_packet_rate_sink", [](const json& p) -> BuiltBlock {
             std::string label = unquoted(param_text(p, "label"));
             if (label.empty())
                 label = "Rate";
             auto block = PacketRateSinkWasm::make(
                 static_cast<std::size_t>(itemsize_of(p)),
                 number_from(p, "items_per_packet", 1.0),
                 number_from(p, "update_time", 0.5),
                 unquoted(param_text(p, "name", "Rate")),
                 label,
                 unquoted(param_text(p, "unit")));
             return { block, block->qwidget() };
         }},
        // ---- arbitrary Python ----
        // The user's own work() method, running in Pyodide in a worker of its
        // own. See make_python_block above and blocks/src/python_block.hpp.
        {"epy_block", [](const json& p) -> BuiltBlock {
             return make_python_block(p);
         }},
        // ---- arbitrary JavaScript ----
        // The user's own work(), running on this block's own scheduler thread
        // against GNU Radio's buffers. See make_js_block above and
        // blocks/src/js_block.hpp. Repo JS blocks (flags: [js]) bind to the same
        // factory through generated_js_blocks.cpp, keyed by their own block id.
        {"wasm_js_block", [](const json& p) -> BuiltBlock {
             return make_js_block("wasm_js_block", p);
         }},
        // Runner-only: a byte stream printed as text in the console pane. The
        // browser's stand-in for the File Sink an upstream flowgraph ends a
        // text decode with; see blocks/src/text_sink.hpp.
        {"wasm_text_sink", [](const json& p) -> BuiltBlock {
             auto block = TextSinkWasm::make(
                 unquoted(param_text(p, "prefix")),
                 static_cast<int>(number_from(p, "max_line", 72.0)));
             return { block, nullptr };
         }},
        // No upstream equivalent -- gr-hrpt's own noaa_hrpt_decoder only parses
        // minor-frame telemetry, it never extracts AVHRR imagery; see
        // blocks/src/hrpt_image_sink.hpp for the channel de-interleave this
        // does instead and where its word-offset constants come from.
        {"hrpt_image_sink", [](const json& p) -> BuiltBlock {
             auto block = HrptImageSinkWasm::make(
                 unquoted(param_text(p, "name", "HRPT Image")),
                 static_cast<int>(number_from(p, "channel", 2.0)),
                 static_cast<int>(number_from(p, "image_width", 2048.0)),
                 static_cast<int>(number_from(p, "words_per_line", 11090.0)),
                 static_cast<int>(number_from(p, "video_start", 751.0)),
                 bool_from(p, "invert", false),
                 static_cast<int>(number_from(p, "max_lines", 2000.0)));
             return { block, block->qwidget() };
         }},
        // gr-paint's Image File Source is a Python block that decodes with PIL.
        // Here the browser decodes, so the image is named by URL rather than by
        // path; see blocks/overlays/gr-paint/paint_image_source.cpp.
        {"paint_image_source", [](const json& p) -> BuiltBlock {
             auto block = ImageSourceWasm::make(
                 unquoted(param_text(p, "image_file")),
                 bool_from(p, "image_flip", false),
                 bool_from(p, "bt709_map", true),
                 bool_from(p, "image_invert", false),
                 bool_from(p, "autocontrast", false),
                 static_cast<int>(number_from(p, "repeatmode", 1.0)));
             return { block, nullptr };
         }},
        // gr-rds' display panel is a Python QWidget upstream
        // (gr-rds/python/rdspanel.py), rebuilt in C++ at
        // blocks/overlays/gr-rds/rds_panel.hpp.
        {"rds_panel", [](const json& p) -> BuiltBlock {
             auto block = RdsPanelWasm::make(number_from(p, "freq", 0.0));
             BuiltBlock result{ block, block->qwidget() };
             result.numeric_setters["freq"] =
                 [block](double value) { block->set_frequency(value); };
             return result;
         }},
        // gr-radar's three Qt GUI sinks are Qwt QWidgets declaring Q_OBJECT, and
        // written against Qwt 6.1's axis constants; the runner has no moc pass
        // and a Qwt 6.3 sysroot, so they are rebuilt in
        // blocks/overlays/gr-radar/radar_plots.cpp. Without them a gr-radar
        // flowgraph runs and displays nothing at all.
        {"radar_qtgui_time_plot", [](const json& p) -> BuiltBlock {
             auto block = RadarTimePlotWasm::make(
                 wasm_registry::number<int>(p, "interval", 30),
                 wasm_registry::text(p, "label_y", "range"),
                 wasm_registry::vector<float>(p, "axis_y"),
                 static_cast<float>(wasm_registry::number<double>(p, "range_time", 10.0)),
                 wasm_registry::text(p, "label", ""));
             return { block, block->qwidget() };
         }},
        {"radar_qtgui_scatter_plot", [](const json& p) -> BuiltBlock {
             auto block = RadarScatterPlotWasm::make(
                 wasm_registry::number<int>(p, "interval", 30),
                 wasm_registry::text(p, "label_x", "range"),
                 wasm_registry::text(p, "label_y", "velocity"),
                 wasm_registry::vector<float>(p, "axis_x"),
                 wasm_registry::vector<float>(p, "axis_y"),
                 wasm_registry::text(p, "label", ""));
             return { block, block->qwidget() };
         }},
        {"radar_qtgui_spectrogram_plot", [](const json& p) -> BuiltBlock {
             auto block = RadarSpectrogramPlotWasm::make(
                 wasm_registry::number<int>(p, "vlen", 1),
                 wasm_registry::number<int>(p, "interval", 30),
                 wasm_registry::text(p, "xlabel", ""),
                 wasm_registry::text(p, "ylabel", ""),
                 wasm_registry::text(p, "label", ""),
                 wasm_registry::vector<float>(p, "axis_x"),
                 wasm_registry::vector<float>(p, "axis_y"),
                 wasm_registry::vector<float>(p, "axis_z"),
                 wasm_registry::boolean(p, "autoscale_z", true),
                 wasm_registry::text(p, "len_key", "packet_len"));
             return { block, block->qwidget() };
         }},
        // Upstream fosphor's Qt sink requires OpenCL and desktop OpenGL. The
        // browser keeps its embedded-widget contract with WebGPU plus a Qt6 CPU
        // fallback; see blocks/overlays/gr-fosphor.
        {"fosphor_qt_sink_c", [](const json& p) -> BuiltBlock {
             return make_fosphor_sink(p, "fosphor_qt_sink_c");
         }},
        {"qtgui_time_sink_x", [](const json& p) -> BuiltBlock {
             int n = static_cast<int>(number_from(p, "size", 1024));
             // `srate` is GRC's own id for this sink's rate -- the Frequency and
             // Waterfall Sinks call theirs `bw`, and the Time Raster Sink really
             // does call it `samp_rate`. Upstream is inconsistent; the schemas
             // and this factory follow it block by block.
             double sr = number_from(p, "srate", 32000.0);
             std::string nm = unquoted(param_text(p, "name")); int nc = p.value("nconnections", 1);
             // A float input is one trace, a complex input two (real and
             // imaginary), so the two branches configure different line counts.
             if (is_float(p)) {
                 auto b = gr::qtgui::time_sink_f::make(n, sr, nm, nc);
                 configure_time_sink(b, p, nc);
                 BuiltBlock result{ b, b->qwidget() };
                 result.numeric_setters["srate"] =
                     [b](double value) { b->set_samp_rate(value); };
                 return result;
             }
             auto b = gr::qtgui::time_sink_c::make(n, sr, nm, nc);
             configure_time_sink(b, p, 2 * nc);
             BuiltBlock result{ b, b->qwidget() };
             result.numeric_setters["srate"] =
                 [b](double value) { b->set_samp_rate(value); };
             return result;
         }},
        {"qtgui_freq_sink_x", [](const json& p) -> BuiltBlock {
             // `bw` is GRC's own id for this sink's rate, and the shared reader
             // keeps a non-numeric value a clean error rather than an uncaught
             // nlohmann type_error.
             const double initial_fc = number_from(p, "fc", 0.0);
             const double initial_bw = number_from(p, "bw", 32000.0);
             const int fftsize = static_cast<int>(number_from(p, "fftsize", 1024));
             // GRC's own default is Blackman-harris; this build defaults to a
             // rectangular window so an unconfigured sink shows the spectrum
             // unweighted. A .grc carrying `wintype` (native or ours) wins, and
             // it arrives as the string `window.WIN_*`, which is why this reads
             // through choice() rather than json::value<int>().
             const int wintype =
                 static_cast<int>(window_type_from(p, gr::fft::window::WIN_RECTANGULAR));
             const std::string name = unquoted(param_text(p, "name"));
             const int nc = p.value("nconnections", 1);
             // Everything past construction is identical for the two sinks, so
             // the shared tail is a template over the sptr the branch produced.
             auto finish = [&](auto b) {
                 configure_freq_sink(b, p, static_cast<unsigned int>(nc));
                 auto range =
                     std::make_shared<std::pair<double, double>>(initial_fc, initial_bw);
                 BuiltBlock result{ b, b->qwidget() };
                 result.numeric_setters["fftsize"] =
                     [b](double value) { b->set_fft_size(static_cast<int>(value)); };
                 result.numeric_setters["average"] = [b](double value) {
                     b->set_fft_average(static_cast<float>(value));
                 };
                 result.numeric_setters["fc"] = [b, range](double value) {
                     range->first = value;
                     b->set_frequency_range(range->first, range->second);
                 };
                 auto set_bandwidth = [b, range](double value) {
                     range->second = value;
                     b->set_frequency_range(range->first, range->second);
                 };
                 result.numeric_setters["bw"] = set_bandwidth;
                 return result;
             };
             if (is_float(p)) {
                 auto b = gr::qtgui::freq_sink_f::make(
                     fftsize, wintype, initial_fc, initial_bw, name, nc);
                 // GRC's Spectrum Width, meaningful only for a real input: its
                 // spectrum is symmetric, so `freqhalf` False plots the positive
                 // half alone. Same inversion as the yaml's cpp_template.
                 b->set_plot_pos_half(!bool_from(p, "freqhalf", true));
                 return finish(b);
             }
             return finish(gr::qtgui::freq_sink_c::make(
                 fftsize, wintype, initial_fc, initial_bw, name, nc));
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
                 unquoted(param_text(p, "name")),
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
                 // Unlike the Time/Frequency Sinks above, GRC's Constellation
                 // Sink yaml defaults to no line and a circle marker, so that a
                 // constellation reads as unconnected points.
                 block->set_line_style(
                     i, static_cast<int>(number_from(p, "style" + suffix, 0)));
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
                 unquoted(param_text(p, "tr_tag")));

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
             const int fftsize = static_cast<int>(number_from(p, "fftsize", 1024));
             // As on the Frequency Sink: rectangular unless the .grc says
             // otherwise, and read through choice() because the value arrives as
             // the string `window.WIN_*`, which number_from() cannot parse at all.
             const int wintype =
                 static_cast<int>(window_type_from(p, gr::fft::window::WIN_RECTANGULAR));
             const double initial_fc = number_from(p, "fc", 0.0);
             const double initial_bw = number_from(p, "bw", 32000.0);
             const std::string nm = unquoted(param_text(p, "name"));
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
                 return result;
             };
             const bool is_float_variant = type == "float" || type == "msg_float";
             if (is_float_variant) {
                 auto b = gr::qtgui::waterfall_sink_f::make(
                     fftsize, wintype, initial_fc, initial_bw, nm, nconnections);
                 // GRC's Spectrum Width, as on the Frequency Sink: a real input's
                 // spectrum is symmetric, so `freqhalf` False plots the positive
                 // half alone. Same inversion as the yaml's cpp_template.
                 b->set_plot_pos_half(!bool_from(p, "freqhalf", true));
                 return finish(b);
             }
             return finish(gr::qtgui::waterfall_sink_c::make(
                 fftsize, wintype, initial_fc, initial_bw, nm, nconnections));
         }},
        // The combined four-pane sink: one widget with a tab each for spectrum,
        // waterfall, time and constellation. Its Update Rate is a rate in Hz,
        // not a period, unlike every other sink's Update Period.
        {"qtgui_sink_x", [](const json& p) -> BuiltBlock {
             const double initial_fc = number_from(p, "fc", 0.0);
             const double initial_bw = number_from(p, "bw", 32000.0);
             const int fftsize = static_cast<int>(number_from(p, "fftsize", 1024));
             const std::string nm = unquoted(param_text(p, "name"));
             const int wintype = static_cast<int>(window_type_from(p));
             const bool plotfreq = bool_from(p, "plotfreq", true);
             const bool plotwaterfall = bool_from(p, "plotwaterfall", true);
             const bool plottime = bool_from(p, "plottime", true);
             const bool plotconst = bool_from(p, "plotconst", true);

             auto range = std::make_shared<std::pair<double, double>>(initial_fc,
                                                                     initial_bw);
             auto finish = [&](auto b) -> BuiltBlock {
                 const double rate = number_from(p, "rate", 10.0);
                 b->set_update_time(rate > 0.0 ? 1.0 / rate : 0.1);
                 b->enable_rf_freq(bool_from(p, "showrf", false));
                 BuiltBlock result{ b, b->qwidget() };
                 result.numeric_setters["fftsize"] =
                     [b](double value) { b->set_fft_size(static_cast<int>(value)); };
                 result.numeric_setters["rate"] = [b](double value) {
                     b->set_update_time(value > 0.0 ? 1.0 / value : 0.1);
                 };
                 result.numeric_setters["fc"] = [b, range](double value) {
                     range->first = value;
                     b->set_frequency_range(range->first, range->second);
                 };
                 result.numeric_setters["bw"] = [b, range](double value) {
                     range->second = value;
                     b->set_frequency_range(range->first, range->second);
                 };
                 return result;
             };
             if (is_float(p))
                 return finish(gr::qtgui::sink_f::make(fftsize, wintype, initial_fc,
                                                      initial_bw, nm, plotfreq,
                                                      plotwaterfall, plottime,
                                                      plotconst));
             return finish(gr::qtgui::sink_c::make(fftsize, wintype, initial_fc,
                                                   initial_bw, nm, plotfreq,
                                                   plotwaterfall, plottime,
                                                   plotconst));
         }},
        {"qtgui_eye_sink_x", [](const json& p) -> BuiltBlock {
             const int connections = sink_connections(p, "QT GUI Eye Sink");
             const std::string type = type_from(p, "complex");
             const double sr = number_from(p, "srate", 32000.0);
             const int size = static_cast<int>(number_from(p, "size", 1024));
             const bool complex_variant =
                 type == "complex" || type == "msg_complex";
             // A complex input is drawn as two eyes, real and imaginary, so it
             // owns two of the sink's lines per connection. Message mode carries
             // no connections but still draws one input's worth.
             const unsigned int lines = static_cast<unsigned int>(
                 std::max(connections, 1) * (complex_variant ? 2 : 1));
             auto finish = [&](auto b) -> BuiltBlock {
                 configure_time_sink(b, p, lines);
                 b->set_samp_per_symbol(static_cast<unsigned int>(
                     number_from(p, "samp_per_symbol", 1.0)));
                 b->enable_tags(bool_from(p, "entags", true));
                 BuiltBlock result{ b, b->qwidget() };
                 result.numeric_setters["srate"] =
                     [b](double value) { b->set_samp_rate(value); };
                 result.numeric_setters["samp_per_symbol"] = [b](double value) {
                     b->set_samp_per_symbol(static_cast<unsigned int>(value));
                 };
                 result.numeric_setters["update_time"] =
                     [b](double value) { b->set_update_time(value); };
                 return result;
             };
             if (complex_variant)
                 return finish(gr::qtgui::eye_sink_c::make(
                     size, sr, static_cast<unsigned int>(connections)));
             return finish(gr::qtgui::eye_sink_f::make(
                 size, sr, static_cast<unsigned int>(connections)));
         }},
        {"qtgui_histogram_sink_x", [](const json& p) -> BuiltBlock {
             const int connections = sink_connections(p, "QT GUI Histogram Sink");
             auto x_axis = std::make_shared<std::pair<double, double>>(
                 number_from(p, "xmin", -1.0), number_from(p, "xmax", 1.0));
             auto b = gr::qtgui::histogram_sink_f::make(
                 static_cast<int>(number_from(p, "size", 1024)),
                 static_cast<int>(number_from(p, "bins", 100)),
                 x_axis->first,
                 x_axis->second,
                 unquoted(param_text(p, "name")),
                 connections);
             b->set_update_time(number_from(p, "update_time", 0.1));
             b->enable_autoscale(bool_from(p, "autoscale", true));
             b->enable_accumulate(bool_from(p, "accum", false));
             b->enable_grid(bool_from(p, "grid", false));
             b->enable_axis_labels(bool_from(p, "axislabels", true));
             if (!bool_from(p, "legend", true))
                 b->disable_legend();
             for (int i = 0; i < std::max(connections, 1); ++i)
                 configure_line(b, p, static_cast<unsigned int>(i),
                                default_line_color(i));

             BuiltBlock result{ b, b->qwidget() };
             result.numeric_setters["bins"] = [b](double value) {
                 b->set_bins(static_cast<int>(value));
             };
             result.numeric_setters["size"] = [b](double value) {
                 b->set_nsamps(static_cast<int>(value));
             };
             result.numeric_setters["update_time"] =
                 [b](double value) { b->set_update_time(value); };
             result.numeric_setters["xmin"] = [b, x_axis](double value) {
                 x_axis->first = value;
                 b->set_x_axis(x_axis->first, x_axis->second);
             };
             result.numeric_setters["xmax"] = [b, x_axis](double value) {
                 x_axis->second = value;
                 b->set_x_axis(x_axis->first, x_axis->second);
             };
             return result;
         }},
        {"qtgui_time_raster_sink_x", [](const json& p) -> BuiltBlock {
             const int connections = sink_connections(p, "QT GUI Time Raster Sink");
             const std::string type = type_from(p, "byte");
             const double rows = number_from(p, "nrows", 256.0);
             const double cols = number_from(p, "ncols", 256.0);
             const std::vector<float> mult = flat_sequence<float>(p, "mult");
             const std::vector<float> offset = flat_sequence<float>(p, "offset");
             const std::string nm = unquoted(param_text(p, "name"));

             auto finish = [&](auto b) -> BuiltBlock {
                 b->set_update_time(number_from(p, "update_time", 0.1));
                 b->set_intensity_range(
                     static_cast<float>(number_from(p, "zmin", -1.0)),
                     static_cast<float>(number_from(p, "zmax", 1.0)));
                 b->enable_grid(bool_from(p, "grid", false));
                 b->enable_axis_labels(bool_from(p, "axislabels", true));
                 b->set_x_label(unquoted(param_text(p, "x_label")));
                 b->set_x_range(number_from(p, "x_start_value", 0.0),
                                number_from(p, "x_end_value", 0.0));
                 b->set_y_label(unquoted(param_text(p, "y_label")));
                 b->set_y_range(number_from(p, "y_start_value", 0.0),
                                number_from(p, "y_end_value", 0.0));
                 // Per-connection label, color map and alpha, as for the
                 // Waterfall Sink -- a raster is an intensity plot, so its
                 // "color" is a map id rather than a pen color.
                 for (int i = 0; i < std::max(connections, 1); ++i) {
                     const std::string suffix = std::to_string(i + 1);
                     if (auto it = p.find("label" + suffix);
                         it != p.end() && it->is_string())
                         b->set_line_label(static_cast<unsigned int>(i),
                                           unquoted(it->get<std::string>()));
                     b->set_color_map(
                         static_cast<unsigned int>(i),
                         static_cast<int>(number_from(p, "color" + suffix, 0)));
                     b->set_line_alpha(static_cast<unsigned int>(i),
                                       number_from(p, "alpha" + suffix, 1.0));
                 }
                 BuiltBlock result{ b, b->qwidget() };
                 result.numeric_setters["nrows"] =
                     [b](double value) { b->set_num_rows(value); };
                 result.numeric_setters["ncols"] =
                     [b](double value) { b->set_num_cols(value); };
                 result.numeric_setters["samp_rate"] =
                     [b](double value) { b->set_samp_rate(value); };
                 result.numeric_setters["update_time"] =
                     [b](double value) { b->set_update_time(value); };
                 return result;
             };
             const double sr = number_from(p, "samp_rate", 32000.0);
             if (type == "float" || type == "msg_float")
                 return finish(gr::qtgui::time_raster_sink_f::make(
                     sr, rows, cols, mult, offset, nm, connections));
             return finish(gr::qtgui::time_raster_sink_b::make(
                 sr, rows, cols, mult, offset, nm, connections));
         }},
        {"qtgui_vector_sink_f", [](const json& p) -> BuiltBlock {
             const int connections =
                 static_cast<int>(number_from(p, "nconnections", 1));
             if (connections <= 0)
                 throw std::runtime_error(
                     "QT GUI Vector Sink requires at least one input");
             auto b = gr::qtgui::vector_sink_f::make(
                 static_cast<unsigned int>(number_from(p, "vlen", 1024)),
                 number_from(p, "x_start", 0.0),
                 number_from(p, "x_step", 1.0),
                 unquoted(param_text(p, "x_axis_label", "x-Axis")),
                 unquoted(param_text(p, "y_axis_label", "y-Axis")),
                 unquoted(param_text(p, "name")),
                 connections);
             auto y_axis = std::make_shared<std::pair<double, double>>(
                 number_from(p, "ymin", -140.0), number_from(p, "ymax", 10.0));
             b->set_update_time(number_from(p, "update_time", 0.1));
             b->set_y_axis(y_axis->first, y_axis->second);
             // Shares the Frequency Sink's Average enum: an IIR alpha, 1 = off.
             b->set_vec_average(static_cast<float>(fft_average_from(p)));
             b->enable_autoscale(bool_from(p, "autoscale", false));
             b->enable_grid(bool_from(p, "grid", false));
             b->set_x_axis_units(unquoted(param_text(p, "x_units")));
             b->set_y_axis_units(unquoted(param_text(p, "y_units")));
             b->set_ref_level(number_from(p, "ref_level", 0.0));
             if (!bool_from(p, "legend", true))
                 b->disable_legend();
             for (int i = 0; i < connections; ++i)
                 configure_line(b, p, static_cast<unsigned int>(i),
                                default_line_color(i));

             BuiltBlock result{ b, b->qwidget() };
             result.numeric_setters["update_time"] =
                 [b](double value) { b->set_update_time(value); };
             result.numeric_setters["ref_level"] =
                 [b](double value) { b->set_ref_level(value); };
             result.numeric_setters["ymin"] = [b, y_axis](double value) {
                 y_axis->first = value;
                 b->set_y_axis(y_axis->first, y_axis->second);
             };
             result.numeric_setters["ymax"] = [b, y_axis](double value) {
                 y_axis->second = value;
                 b->set_y_axis(y_axis->first, y_axis->second);
             };
             return result;
         }},
        {"qtgui_matrix_sink", [](const json& p) -> BuiltBlock {
             auto b = gr::qtgui::matrix_sink::make(
                 unquoted(param_text(p, "name")),
                 static_cast<unsigned int>(number_from(p, "num_cols", 10.0)),
                 static_cast<unsigned int>(number_from(p, "vlen", 100.0)),
                 bool_from(p, "contour", false),
                 unquoted(param_text(p, "color_map", "rgb")),
                 unquoted(param_text(p, "interpolation", "BilinearInterpolation")));
             b->set_x_start(number_from(p, "x_start", 0.0));
             b->set_x_end(number_from(p, "x_end", 1.0));
             b->set_y_start(number_from(p, "y_start", 0.0));
             b->set_y_end(number_from(p, "y_end", 1.0));
             b->set_z_max(number_from(p, "z_max", 1.0));
             b->set_z_min(number_from(p, "z_min", 0.0));
             b->set_x_axis_label(
                 unquoted(param_text(p, "x_axis_label", "x-Axis")));
             b->set_y_axis_label(
                 unquoted(param_text(p, "y_axis_label", "y-Axis")));
             b->set_z_axis_label(
                 unquoted(param_text(p, "z_axis_label", "z-Axis")));

             BuiltBlock result{ b, b->qwidget() };
             result.numeric_setters["z_min"] =
                 [b](double value) { b->set_z_min(value); };
             result.numeric_setters["z_max"] =
                 [b](double value) { b->set_z_max(value); };
             return result;
         }},
        // BER vs Es/No, one input pair (data, reference) per Es/No point per
        // curve -- so its input count is len(esno)*2*num_curves, and the sink
        // itself counts the bit errors between each pair.
        {"qtgui_bercurve_sink", [](const json& p) -> BuiltBlock {
             std::vector<float> esnos = flat_sequence<float>(p, "esno");
             if (esnos.empty())
                 throw std::runtime_error(
                     "QT GUI Bercurve Sink needs at least one Es/No value");
             const int curves = static_cast<int>(number_from(p, "num_curves", 1));
             if (curves <= 0)
                 throw std::runtime_error(
                     "QT GUI Bercurve Sink requires at least one curve");
             // Curve names are left empty and the labels applied below instead:
             // GRC's own template does the same, overwriting whatever it passed
             // here with label1..label10 straight afterwards.
             auto b = gr::qtgui::ber_sink_b::make(
                 esnos,
                 curves,
                 static_cast<int>(number_from(p, "berminerrors", 100)),
                 static_cast<float>(number_from(p, "berlimit", -7.0)));
             b->set_update_time(number_from(p, "update_time", 0.1));
             b->set_y_axis(number_from(p, "ymin", -10.0),
                           number_from(p, "ymax", 0.0));
             b->set_x_axis(esnos.front(), esnos.back());
             for (int i = 0; i < curves; ++i)
                 configure_line(b, p, static_cast<unsigned int>(i),
                                default_line_color(i), 1, 0);

             BuiltBlock result{ b, b->qwidget() };
             result.numeric_setters["update_time"] =
                 [b](double value) { b->set_update_time(value); };
             return result;
         }},
      };
      // Custom factories intentionally win over generated direct-make factories.
      for (const auto& [id, factory] : custom)
          reg[id] = factory;
      // Repo JS blocks (blocks/js/<id>.js, flags: [js]) last: they are a third
      // category beside "generated C++" and "custom", registered from a generated
      // table because the factory is generic and only the block id differs.
      register_generated_js_blocks(reg);
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
    runtime_cc_decoders().clear();
    runtime_fec_encoders().clear();
    wasm_registry::runtime_tag_objects().clear();
    // Back to "no GUI Layout block", so a flowgraph without one gets the plain
    // vertical stack rather than the previous flowgraph's grid.
    gui_layout::runtime_spec() = gui_layout::Spec{};
}

// Called by dlopen'd category side modules (generated_registry_<m>.cpp) to add
// their factories once the module has been fetched. Capture-less factory function
// pointers cross the dynamic-link boundary with no C++ ABI coupling. emplace() so
// a hand-written custom factory (installed at init) always wins over a generated one.
extern "C" EMSCRIPTEN_KEEPALIVE void wasm_registry_add(
    const char* id, BuiltBlock (*factory)(const nlohmann::json&)) {
    registry_storage().emplace(std::string(id), Factory(factory));
}
