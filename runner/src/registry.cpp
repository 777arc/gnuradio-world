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
#include <QWidget>

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

const std::map<std::string, Factory>& block_registry() {
    static const std::map<std::string, Factory> reg = {
        // ---- sources ----
        {"analog_sig_source_x", [](const json& p) -> BuiltBlock {
             double sr = p.value("samp_rate", 32000.0);
             auto wf = waveform_from(p.value("waveform", std::string("cos")));
             double fr = p.value("frequency", p.value("freq", 1000.0)), a = p.value("amplitude", 1.0),
                    off = p.value("offset", 0.0), ph = p.value("phase", 0.0);
             if (is_float(p)) return { gr::analog::sig_source_f::make(sr, wf, fr, a, off, ph), nullptr };
             return { gr::analog::sig_source_c::make(sr, wf, fr, a, off, ph), nullptr };
         }},
        {"analog_noise_source_x", [](const json& p) -> BuiltBlock {
             double a = p.value("amplitude", 1.0); long s = p.value("seed", 0);
             if (is_float(p)) return { gr::analog::noise_source_f::make(gr::analog::GR_GAUSSIAN, a, s), nullptr };
             return { gr::analog::noise_source_c::make(gr::analog::GR_GAUSSIAN, a, s), nullptr };
         }},
        {"blocks_null_source", [](const json& p) -> BuiltBlock {
             return { gr::blocks::null_source::make(itemsize_of(p)), nullptr };
         }},
        // ---- flow control ----
        {"blocks_throttle", [](const json& p) -> BuiltBlock {
             return { gr::blocks::throttle::make(itemsize_of(p), p.value("samp_rate", 32000.0), true), nullptr };
         }},
        {"blocks_head", [](const json& p) -> BuiltBlock {
             return { gr::blocks::head::make(itemsize_of(p), (uint64_t)p.value("num_items", 1000000)), nullptr };
         }},
        {"blocks_delay", [](const json& p) -> BuiltBlock {
             // Sets history = delay+1, so it exercises the history path (like the qtgui sinks).
             return { gr::blocks::delay::make(itemsize_of(p), p.value("delay", 1)), nullptr };
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
             if (is_float(p)) return { gr::blocks::multiply_const_ff::make((float)k), nullptr };
             return { gr::blocks::multiply_const_cc::make(gr_complex(k, 0)), nullptr };
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
             if (is_float(p)) { auto b = gr::qtgui::time_sink_f::make(n, sr, nm, nc); return { b, b->qwidget() }; }
             auto b = gr::qtgui::time_sink_c::make(n, sr, nm, nc); return { b, b->qwidget() };
         }},
        {"qtgui_freq_sink_x", [](const json& p) -> BuiltBlock {
             double sr = p.value("samp_rate", 32000.0);
             auto b = gr::qtgui::freq_sink_c::make(p.value("fftsize", 1024),
                 p.value("wintype", 5), p.value("fc", 0.0), p.value("bw", sr),
                 p.value("name", std::string("Spectrum")), p.value("nconnections", 1));
             return { b, b->qwidget() };
         }},
    };
    return reg;
}
