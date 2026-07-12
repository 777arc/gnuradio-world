#include "registry.hpp"
#include <gnuradio/analog/sig_source.h>
#include <gnuradio/analog/noise_source.h>
#include <gnuradio/blocks/throttle.h>
#include <gnuradio/blocks/multiply_const.h>
#include <gnuradio/blocks/add_blk.h>
#include <gnuradio/blocks/multiply.h>
#include <gnuradio/blocks/complex_to_mag.h>
#include <gnuradio/blocks/complex_to_mag_squared.h>
#include <gnuradio/blocks/complex_to_float.h>
#include <gnuradio/blocks/float_to_complex.h>
#include <gnuradio/blocks/null_sink.h>
#include <gnuradio/blocks/null_source.h>
#include <gnuradio/blocks/head.h>
#include <gnuradio/qtgui/time_sink_c.h>
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

const std::map<std::string, Factory>& block_registry() {
    static const std::map<std::string, Factory> reg = {
        // ---- sources ----
        {"analog_sig_source_x", [](const json& p) -> BuiltBlock {
             return {gr::analog::sig_source_c::make(
                 p.value("samp_rate", 32000.0),
                 waveform_from(p.value("waveform", std::string("cos"))),
                 p.value("frequency", p.value("freq", 1000.0)),
                 p.value("amplitude", 1.0), p.value("offset", 0.0), p.value("phase", 0.0)), nullptr};
         }},
        {"analog_noise_source_x", [](const json& p) -> BuiltBlock {
             return {gr::analog::noise_source_c::make(
                 gr::analog::GR_GAUSSIAN, p.value("amplitude", 1.0), p.value("seed", 0)), nullptr};
         }},
        {"blocks_null_source", [](const json& p) -> BuiltBlock {
             return {gr::blocks::null_source::make(p.value("itemsize", (int)sizeof(gr_complex))), nullptr};
         }},
        // ---- flow control ----
        {"blocks_throttle", [](const json& p) -> BuiltBlock {
             return {gr::blocks::throttle::make(p.value("itemsize", (int)sizeof(gr_complex)),
                 p.value("samp_rate", 32000.0), true), nullptr};
         }},
        {"blocks_head", [](const json& p) -> BuiltBlock {
             return {gr::blocks::head::make(p.value("itemsize", (int)sizeof(gr_complex)),
                 (uint64_t)p.value("num_items", 1000000)), nullptr};
         }},
        // ---- math ----
        {"blocks_add_xx", [](const json&) -> BuiltBlock { return {gr::blocks::add_cc::make(1), nullptr}; }},
        {"blocks_multiply_xx", [](const json&) -> BuiltBlock { return {gr::blocks::multiply_cc::make(1), nullptr}; }},
        {"blocks_multiply_const_cc", [](const json& p) -> BuiltBlock {
             return {gr::blocks::multiply_const_cc::make(gr_complex(p.value("constant", 1.0), 0.0)), nullptr};
         }},
        {"blocks_multiply_const_ff", [](const json& p) -> BuiltBlock {
             return {gr::blocks::multiply_const_ff::make(p.value("constant", 1.0f)), nullptr};
         }},
        // ---- type converters ----
        {"blocks_complex_to_mag", [](const json&) -> BuiltBlock { return {gr::blocks::complex_to_mag::make(1), nullptr}; }},
        {"blocks_complex_to_mag_squared", [](const json&) -> BuiltBlock { return {gr::blocks::complex_to_mag_squared::make(1), nullptr}; }},
        {"blocks_complex_to_float", [](const json&) -> BuiltBlock { return {gr::blocks::complex_to_float::make(1), nullptr}; }},
        {"blocks_float_to_complex", [](const json&) -> BuiltBlock { return {gr::blocks::float_to_complex::make(1), nullptr}; }},
        // ---- sinks ----
        {"blocks_null_sink", [](const json& p) -> BuiltBlock {
             return {gr::blocks::null_sink::make(p.value("itemsize", (int)sizeof(gr_complex))), nullptr};
         }},
        {"qtgui_time_sink_x", [](const json& p) -> BuiltBlock {
             auto b = gr::qtgui::time_sink_c::make(p.value("size", 1024), p.value("samp_rate", 32000.0),
                 p.value("name", std::string("Scope")), p.value("nconnections", 1));
             return {b, b->qwidget()};
         }},
        {"qtgui_freq_sink_x", [](const json& p) -> BuiltBlock {
             double sr = p.value("samp_rate", 32000.0);
             auto b = gr::qtgui::freq_sink_c::make(p.value("fftsize", 1024),
                 p.value("wintype", 5 /*blackman-harris*/), p.value("fc", 0.0),
                 p.value("bw", sr), p.value("name", std::string("Spectrum")),
                 p.value("nconnections", 1));
             return {b, b->qwidget()};
         }},
    };
    return reg;
}
