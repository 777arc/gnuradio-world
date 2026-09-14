#pragma once

// C++ rebuilds of gr-channels' Python gr.hier_block2 compositions: the
// impairment generators (IQ imbalance, phase noise, second- and third-order
// distortion, quantization), the two balancers that undo an imbalance, the
// conjugate frequency-selective IQ corrector, and the Radio Impairments Model
// that strings the generators together. Each is upstream's block graph
// (gr-channels/python/channels/<name>.py) wired in the same order with the same
// leaf blocks, and exposes the setters its yaml callbacks name, so a QT GUI
// Range moves the same knob it does natively.

#include "hier_support.hpp"
#include <gnuradio/analog/noise_source.h>
#include <gnuradio/analog/sig_source.h>
#include <gnuradio/blocks/add_blk.h>
#include <gnuradio/blocks/add_const_cc.h>
#include <gnuradio/blocks/complex_to_float.h>
#include <gnuradio/blocks/complex_to_mag_squared.h>
#include <gnuradio/blocks/conjugate_cc.h>
#include <gnuradio/blocks/delay.h>
#include <gnuradio/blocks/divide.h>
#include <gnuradio/blocks/float_to_complex.h>
#include <gnuradio/blocks/float_to_short.h>
#include <gnuradio/blocks/multiply.h>
#include <gnuradio/blocks/multiply_const.h>
#include <gnuradio/blocks/null_source.h>
#include <gnuradio/blocks/rms_ff.h>
#include <gnuradio/blocks/short_to_float.h>
#include <gnuradio/blocks/sub.h>
#include <gnuradio/blocks/transcendental.h>
#include <gnuradio/filter/fir_filter_blk.h>
#include <gnuradio/filter/single_pole_iir_filter_ff.h>
#include <gnuradio/hier_block2.h>
#include <gnuradio/io_signature.h>
#include <cmath>
#include <vector>

namespace channels_hier {

inline gr::io_signature::sptr complex_io()
{
    return gr::io_signature::make(1, 1, sizeof(gr_complex));
}

inline gr::io_signature::sptr float_io()
{
    return gr::io_signature::make(1, 1, sizeof(float));
}

} // namespace channels_hier

// channels.amp_bal: scale Q by the ratio of the two channels' RMS so both have
// the same power.
class AmpBal : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<AmpBal>;
    static sptr make(double alpha) { return gnuradio::make_block_sptr<AmpBal>(alpha); }

    explicit AmpBal(double alpha)
        : gr::hier_block2("amp_bal", channels_hier::complex_io(), channels_hier::complex_io())
    {
        auto split = gr::blocks::complex_to_float::make(1);
        d_rms_i = gr::blocks::rms_ff::make(alpha);
        d_rms_q = gr::blocks::rms_ff::make(alpha);
        auto ratio = gr::blocks::divide_ff::make(1);
        auto scale = gr::blocks::multiply_ff::make(1);
        auto join = gr::blocks::float_to_complex::make(1);

        connect(self(), 0, split, 0);
        connect(split, 0, d_rms_i, 0);
        connect(split, 1, d_rms_q, 0);
        connect(d_rms_i, 0, ratio, 0);
        connect(d_rms_q, 0, ratio, 1);
        connect(split, 0, join, 0);
        connect(split, 1, scale, 1);
        connect(ratio, 0, scale, 0);
        connect(scale, 0, join, 1);
        connect(join, 0, self(), 0);
    }

    void set_alpha(double alpha)
    {
        d_rms_i->set_alpha(alpha);
        d_rms_q->set_alpha(alpha);
    }

private:
    gr::blocks::rms_ff::sptr d_rms_i, d_rms_q;
};

// channels.phase_bal: estimate the I/Q correlation (2*I*Q / |x|^2, smoothed by a
// single-pole IIR) and subtract each channel's projection onto the other.
class PhaseBal : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<PhaseBal>;
    static sptr make(double alpha) { return gnuradio::make_block_sptr<PhaseBal>(alpha); }

    explicit PhaseBal(double alpha)
        : gr::hier_block2("phase_bal", channels_hier::complex_io(), channels_hier::complex_io())
    {
        auto split = gr::blocks::complex_to_float::make(1);
        auto power = gr::blocks::complex_to_mag_squared::make(1);
        auto iq = gr::blocks::multiply_ff::make(1);
        auto ratio = gr::blocks::divide_ff::make(1);
        auto twice = gr::blocks::multiply_const_ff::make(2.0F, 1);
        d_smooth = gr::filter::single_pole_iir_filter_ff::make(alpha, 1);
        auto i_scaled = gr::blocks::multiply_ff::make(1);
        auto q_scaled = gr::blocks::multiply_ff::make(1);
        auto q_out = gr::blocks::sub_ff::make(1);
        auto i_out = gr::blocks::sub_ff::make(1);
        auto join = gr::blocks::float_to_complex::make(1);

        connect(self(), 0, split, 0);
        connect(self(), 0, power, 0);
        connect(split, 0, iq, 0);
        connect(split, 1, iq, 1);
        connect(iq, 0, ratio, 0);
        connect(power, 0, ratio, 1);
        connect(ratio, 0, twice, 0);
        connect(twice, 0, d_smooth, 0);
        connect(split, 0, i_scaled, 0);
        connect(d_smooth, 0, i_scaled, 1);
        connect(d_smooth, 0, q_scaled, 0);
        connect(split, 1, q_scaled, 1);
        connect(split, 1, q_out, 0);
        connect(i_scaled, 0, q_out, 1);
        connect(split, 0, i_out, 0);
        connect(q_scaled, 0, i_out, 1);
        connect(i_out, 0, join, 0);
        connect(q_out, 0, join, 1);
        connect(join, 0, self(), 0);
    }

    void set_alpha(double alpha) { d_smooth->set_taps(alpha); }

private:
    gr::filter::single_pole_iir_filter_ff::sptr d_smooth;
};

// channels.iqbal_gen: the single-branch IQ imbalance model, transmitter (mode
// 0) or receiver (mode 1) side. Magnitude in dB, phase in degrees.
class IqbalGen : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<IqbalGen>;
    static sptr make(double magnitude, double phase, int mode)
    {
        return gnuradio::make_block_sptr<IqbalGen>(magnitude, phase, mode);
    }

    IqbalGen(double magnitude, double phase, int mode)
        : gr::hier_block2("iqbal_gen", channels_hier::complex_io(), channels_hier::complex_io())
    {
        d_mag = gr::blocks::multiply_const_ff::make(gain(magnitude), 1);
        d_sin = gr::blocks::multiply_const_ff::make(sine(phase), 1);
        d_cos = gr::blocks::multiply_const_ff::make(cosine(phase), 1);
        auto join = gr::blocks::float_to_complex::make(1);
        auto split = gr::blocks::complex_to_float::make(1);
        auto adder = gr::blocks::add_ff::make(1);

        connect(self(), 0, split, 0);
        if (mode) {
            connect(split, 0, d_cos, 0);
            connect(d_cos, 0, adder, 0);
            connect(split, 1, d_sin, 0);
            connect(d_sin, 0, adder, 1);
            connect(adder, 0, d_mag, 0);
            connect(d_mag, 0, join, 0);
            connect(split, 1, join, 1);
        } else {
            connect(split, 0, d_mag, 0);
            connect(d_mag, 0, d_cos, 0);
            connect(d_cos, 0, join, 0);
            connect(d_mag, 0, d_sin, 0);
            connect(d_sin, 0, adder, 0);
            connect(split, 1, adder, 1);
            connect(adder, 0, join, 1);
        }
        connect(join, 0, self(), 0);
    }

    void set_magnitude(double magnitude) { d_mag->set_k(gain(magnitude)); }

    void set_phase(double phase)
    {
        d_sin->set_k(sine(phase));
        d_cos->set_k(cosine(phase));
    }

private:
    static float gain(double db) { return static_cast<float>(std::pow(10.0, db / 20.0)); }
    static float sine(double deg) { return static_cast<float>(std::sin(deg * PI / 180.0)); }
    static float cosine(double deg) { return static_cast<float>(std::cos(deg * PI / 180.0)); }

    gr::blocks::multiply_const_ff::sptr d_mag, d_sin, d_cos;
};

// channels.distortion_2_gen: y = x + beta * (x*x + x*conj(x)).
class Distortion2Gen : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<Distortion2Gen>;
    static sptr make(double beta) { return gnuradio::make_block_sptr<Distortion2Gen>(beta); }

    explicit Distortion2Gen(double beta)
        : gr::hier_block2("distortion_2_gen",
                          channels_hier::complex_io(),
                          channels_hier::complex_io())
    {
        auto square = gr::blocks::multiply_cc::make(1);
        auto conjugate = gr::blocks::conjugate_cc::make();
        auto power = gr::blocks::multiply_cc::make(1);
        auto sum = gr::blocks::add_cc::make(1);
        d_beta = gr::blocks::multiply_const_cc::make(gr_complex(static_cast<float>(beta), 0.0F), 1);
        auto out = gr::blocks::add_cc::make(1);

        connect(self(), 0, square, 0);
        connect(self(), 0, square, 1);
        connect(self(), 0, conjugate, 0);
        connect(self(), 0, power, 0);
        connect(conjugate, 0, power, 1);
        connect(square, 0, sum, 0);
        connect(power, 0, sum, 1);
        connect(sum, 0, d_beta, 0);
        connect(self(), 0, out, 0);
        connect(d_beta, 0, out, 1);
        connect(out, 0, self(), 0);
    }

    void set_beta(double beta) { d_beta->set_k(gr_complex(static_cast<float>(beta), 0.0F)); }

private:
    gr::blocks::multiply_const_cc::sptr d_beta;
};

// channels.distortion_3_gen: y = x + beta * x * |x|^2.
class Distortion3Gen : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<Distortion3Gen>;
    static sptr make(double beta) { return gnuradio::make_block_sptr<Distortion3Gen>(beta); }

    explicit Distortion3Gen(double beta)
        : gr::hier_block2("distortion_3_gen",
                          channels_hier::complex_io(),
                          channels_hier::complex_io())
    {
        auto power = gr::blocks::complex_to_mag_squared::make(1);
        auto zero = gr::blocks::null_source::make(sizeof(float));
        auto join = gr::blocks::float_to_complex::make(1);
        auto scaled = gr::blocks::multiply_cc::make(1);
        d_beta = gr::blocks::multiply_const_cc::make(gr_complex(static_cast<float>(beta), 0.0F), 1);
        auto out = gr::blocks::add_cc::make(1);

        connect(self(), 0, power, 0);
        connect(power, 0, join, 0);
        connect(zero, 0, join, 1);
        connect(self(), 0, scaled, 0);
        connect(join, 0, scaled, 1);
        connect(scaled, 0, d_beta, 0);
        connect(self(), 0, out, 0);
        connect(d_beta, 0, out, 1);
        connect(out, 0, self(), 0);
    }

    void set_beta(double beta) { d_beta->set_k(gr_complex(static_cast<float>(beta), 0.0F)); }

private:
    gr::blocks::multiply_const_cc::sptr d_beta;
};

// channels.phase_noise_gen: multiply by exp(j*phi) where phi is Gaussian noise
// through a single-pole IIR. Upstream seeds the noise with 42.
class PhaseNoiseGen : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<PhaseNoiseGen>;
    static sptr make(double noise_mag, double alpha)
    {
        return gnuradio::make_block_sptr<PhaseNoiseGen>(noise_mag, alpha);
    }

    PhaseNoiseGen(double noise_mag, double alpha)
        : gr::hier_block2("phase_noise_gen",
                          channels_hier::complex_io(),
                          channels_hier::complex_io())
    {
        d_noise = gr::analog::noise_source_f::make(
            gr::analog::GR_GAUSSIAN, static_cast<float>(noise_mag), 42);
        d_smooth = gr::filter::single_pole_iir_filter_ff::make(alpha, 1);
        auto cosine = gr::blocks::transcendental::make("cos", "float");
        auto sine = gr::blocks::transcendental::make("sin", "float");
        auto join = gr::blocks::float_to_complex::make(1);
        auto rotate = gr::blocks::multiply_cc::make(1);

        connect(d_noise, 0, d_smooth, 0);
        connect(d_smooth, 0, cosine, 0);
        connect(d_smooth, 0, sine, 0);
        connect(cosine, 0, join, 0);
        connect(sine, 0, join, 1);
        connect(self(), 0, rotate, 0);
        connect(join, 0, rotate, 1);
        connect(rotate, 0, self(), 0);
    }

    void set_noise_mag(double noise_mag)
    {
        d_noise->set_amplitude(static_cast<float>(noise_mag));
    }

    void set_alpha(double alpha) { d_smooth->set_taps(alpha); }

private:
    gr::analog::noise_source_f::sptr d_noise;
    gr::filter::single_pole_iir_filter_ff::sptr d_smooth;
};

// channels.quantizer: scale to `bits` bits, round through a short, scale back.
class Quantizer : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<Quantizer>;
    static sptr make(int bits) { return gnuradio::make_block_sptr<Quantizer>(bits); }

    explicit Quantizer(int bits)
        : gr::hier_block2("quantizer", channels_hier::float_io(), channels_hier::float_io())
    {
        d_up = gr::blocks::multiply_const_ff::make(up(bits), 1);
        auto to_short = gr::blocks::float_to_short::make(1, 1.0F);
        auto to_float = gr::blocks::short_to_float::make(1, 1.0F);
        d_down = gr::blocks::multiply_const_ff::make(down(bits), 1);

        connect(self(), 0, d_up, 0);
        connect(d_up, 0, to_short, 0);
        connect(to_short, 0, to_float, 0);
        connect(to_float, 0, d_down, 0);
        connect(d_down, 0, self(), 0);
    }

    void set_bits(int bits)
    {
        d_up->set_k(up(bits));
        d_down->set_k(down(bits));
    }

private:
    static float up(int bits) { return static_cast<float>(std::pow(2.0, bits - 1.0)); }
    static float down(int bits) { return static_cast<float>(1.0 / std::pow(2.0, bits - 1.0)); }

    gr::blocks::multiply_const_ff::sptr d_up, d_down;
};

// channels.conj_fs_iqcorr: add a filtered copy of the conjugate to the delayed
// input, the frequency-selective IQ correction.
class ConjFsIqcorr : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<ConjFsIqcorr>;
    static sptr make(int delay, const std::vector<gr_complex>& taps)
    {
        return gnuradio::make_block_sptr<ConjFsIqcorr>(delay, taps);
    }

    ConjFsIqcorr(int delay, const std::vector<gr_complex>& taps)
        : gr::hier_block2("conj_fs_iqcorr", channels_hier::complex_io(), channels_hier::complex_io())
    {
        if (taps.empty())
            throw std::runtime_error("Conj FS IQBal needs at least one tap");
        d_filter = gr::filter::fir_filter_ccc::make(1, taps);
        d_delay = gr::blocks::delay::make(sizeof(gr_complex), delay);
        auto conjugate = gr::blocks::conjugate_cc::make();
        auto out = gr::blocks::add_cc::make(1);

        connect(self(), 0, conjugate, 0);
        connect(conjugate, 0, d_filter, 0);
        connect(d_filter, 0, out, 1);
        connect(self(), 0, d_delay, 0);
        connect(d_delay, 0, out, 0);
        connect(out, 0, self(), 0);
    }

    void set_delay(int delay) { d_delay->set_dly(delay); }
    void set_taps(const std::vector<gr_complex>& taps) { d_filter->set_taps(taps); }

private:
    gr::filter::fir_filter_ccc::sptr d_filter;
    gr::blocks::delay::sptr d_delay;
};

// channels.impairments: frequency offset, phase noise, third- then second-order
// distortion, IQ imbalance and DC offset in a row, with the frequency offset
// applied conjugated before the chain and again after it -- so the DC offset
// and imbalance are added at the offset carrier, as upstream has it.
class Impairments : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<Impairments>;
    static sptr make(double phase_noise_mag,
                     double magbal,
                     double phasebal,
                     double q_ofs,
                     double i_ofs,
                     double freq_offset,
                     double gamma,
                     double beta)
    {
        return gnuradio::make_block_sptr<Impairments>(
            phase_noise_mag, magbal, phasebal, q_ofs, i_ofs, freq_offset, gamma, beta);
    }

    Impairments(double phase_noise_mag,
                double magbal,
                double phasebal,
                double q_ofs,
                double i_ofs,
                double freq_offset,
                double gamma,
                double beta)
        : gr::hier_block2("impairments", channels_hier::complex_io(), channels_hier::complex_io()),
          d_i_ofs(i_ofs),
          d_q_ofs(q_ofs)
    {
        d_phase_noise = PhaseNoiseGen::make(noise_mag(phase_noise_mag), 0.01);
        d_iq_imbalance = IqbalGen::make(magbal, phasebal, 0);
        d_distortion_3 = Distortion3Gen::make(beta);
        d_distortion_2 = Distortion2Gen::make(gamma);
        auto modulator = gr::blocks::multiply_cc::make(1);
        d_offset_gen = gr::analog::sig_source_c::make(
            1.0, gr::analog::GR_COS_WAVE, freq_offset, 1.0, gr_complex(0.0F, 0.0F));
        auto modulator_dc = gr::blocks::multiply_cc::make(1);
        auto offset_conj = gr::blocks::conjugate_cc::make();
        d_dc_offset = gr::blocks::add_const_cc::make(dc());

        connect(self(), 0, modulator, 1);
        connect(d_offset_gen, 0, offset_conj, 0);
        connect(offset_conj, 0, modulator, 0);
        connect(modulator, 0, d_phase_noise, 0);
        connect(d_phase_noise, 0, d_distortion_3, 0);
        connect(d_distortion_3, 0, d_distortion_2, 0);
        connect(d_distortion_2, 0, d_iq_imbalance, 0);
        connect(d_iq_imbalance, 0, d_dc_offset, 0);
        connect(d_offset_gen, 0, modulator_dc, 0);
        connect(d_dc_offset, 0, modulator_dc, 1);
        connect(modulator_dc, 0, self(), 0);
    }

    void set_phase_noise_mag(double db) { d_phase_noise->set_noise_mag(noise_mag(db)); }
    void set_magbal(double magbal) { d_iq_imbalance->set_magnitude(magbal); }
    void set_phasebal(double phasebal) { d_iq_imbalance->set_phase(phasebal); }
    void set_q_ofs(double q_ofs)
    {
        d_q_ofs = q_ofs;
        d_dc_offset->set_k(dc());
    }
    void set_i_ofs(double i_ofs)
    {
        d_i_ofs = i_ofs;
        d_dc_offset->set_k(dc());
    }
    void set_freq_offset(double freq_offset) { d_offset_gen->set_frequency(freq_offset); }
    void set_gamma(double gamma) { d_distortion_2->set_beta(gamma); }
    void set_beta(double beta) { d_distortion_3->set_beta(beta); }

private:
    static double noise_mag(double db) { return std::pow(10.0, db / 20.0); }
    gr_complex dc() const
    {
        return gr_complex(static_cast<float>(d_i_ofs), static_cast<float>(d_q_ofs));
    }

    double d_i_ofs, d_q_ofs;
    PhaseNoiseGen::sptr d_phase_noise;
    IqbalGen::sptr d_iq_imbalance;
    Distortion3Gen::sptr d_distortion_3;
    Distortion2Gen::sptr d_distortion_2;
    gr::analog::sig_source_c::sptr d_offset_gen;
    gr::blocks::add_const_cc::sptr d_dc_offset;
};
