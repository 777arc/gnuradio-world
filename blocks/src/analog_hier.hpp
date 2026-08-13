#pragma once

// C++ rebuilds of gr-analog's Python gr.hier_block2 compositions (FM/AM
// demodulation, de-emphasis, squelch). Python cannot run in the browser, so each
// keeps upstream's block id and is rebuilt here from the same chain; see the
// module's own Python source named in each class comment.

#include "filter_hier.hpp"
#include "hier_support.hpp"
#include <gnuradio/analog/frequency_modulator_fc.h>
#include <gnuradio/blocks/multiply.h>
#include <gnuradio/blocks/sub.h>
#include <gnuradio/filter/interp_fir_filter.h>
#include <gnuradio/analog/pll_refout_cc.h>
#include <gnuradio/analog/quadrature_demod_cf.h>
#include <gnuradio/blocks/add_const_ff.h>
#include <gnuradio/blocks/divide.h>
#include <gnuradio/blocks/complex_to_mag.h>
#include <gnuradio/blocks/complex_to_imag.h>
#include <gnuradio/blocks/delay.h>
#include <gnuradio/blocks/threshold_ff.h>
#include <gnuradio/fft/window.h>
#include <gnuradio/filter/fft_filter_fff.h>
#include <gnuradio/filter/firdes.h>
#include <gnuradio/filter/iir_filter_ffd.h>
#include <gnuradio/filter/pm_remez.h>
#include <gnuradio/filter/single_pole_iir_filter_ff.h>
#include <gnuradio/hier_block2.h>
#include <gnuradio/io_signature.h>
#include <gnuradio/filter/fir_filter_blk.h>
#include <gnuradio/blocks/add_blk.h>
#include <vector>

inline gr::filter::iir_filter_ffd::sptr make_fm_deemph(double sample_rate, double tau)
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
