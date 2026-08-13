#pragma once

// C++ rebuild of gr-fft's Python gr.hier_block2 composition: the Log Power FFT.

#include "blocks_hier.hpp"
#include "hier_support.hpp"
#include <gnuradio/blocks/complex_to_mag_squared.h>
#include <gnuradio/blocks/nlog10_ff.h>
#include <gnuradio/fft/fft_v.h>
#include <gnuradio/fft/window.h>
#include <gnuradio/filter/single_pole_iir_filter_ff.h>
#include <gnuradio/hier_block2.h>
#include <gnuradio/io_signature.h>
#include <cmath>
#include <vector>

// fft.logpwrfft.logpwrfft_c / logpwrfft_f: the dB-scaled power spectrum chain
// GRC's own spectrum displays are built out of -- decimate to a frame rate,
// window and transform, square, average, then take 10*log10 with the offset that
// makes a full-scale sinusoid read 0 dB.
//
// `average` is not a mode the averaging filter has: as upstream, it selects
// between the requested IIR alpha and a tap of 1.0, i.e. no memory at all. That
// is why set_average() has to remember the alpha rather than read it back.
template <typename Input>
class LogPwrFft : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<LogPwrFft<Input>>;
    static sptr make(double sample_rate,
                     int fft_size,
                     double ref_scale,
                     double frame_rate,
                     double avg_alpha,
                     bool average,
                     bool shift)
    {
        return gnuradio::make_block_sptr<LogPwrFft<Input>>(
            sample_rate, fft_size, ref_scale, frame_rate, avg_alpha, average, shift);
    }

    LogPwrFft(double sample_rate,
              int fft_size,
              double ref_scale,
              double frame_rate,
              double avg_alpha,
              bool average,
              bool shift)
        : gr::hier_block2("logpwrfft",
                          gr::io_signature::make(1, 1, sizeof(Input)),
                          gr::io_signature::make(1, 1, sizeof(float) * fft_size)),
          d_avg_alpha(avg_alpha),
          d_average(average)
    {
        if (fft_size < 1)
            throw std::runtime_error("Log Power FFT size must be positive");
        require_positive("Log Power FFT frame rate", frame_rate);
        require_positive("Log Power FFT reference scale", ref_scale);

        d_decimator = StreamToVectorDecimator::make(
            sizeof(Input), sample_rate, frame_rate, fft_size);
        const std::vector<float> window = gr::fft::window::blackmanharris(fft_size);
        auto transform = gr::fft::fft_v<Input, true>::make(fft_size, window, shift);
        auto magnitude_squared = gr::blocks::complex_to_mag_squared::make(fft_size);
        d_average_filter = gr::filter::single_pole_iir_filter_ff::make(1.0, fft_size);

        double window_power = 0.0;
        for (float tap : window)
            window_power += static_cast<double>(tap) * tap;
        // Correct for the bin count, the window's processing loss, and the
        // amplitude that is to read as 0 dB.
        const double offset = -20.0 * std::log10(fft_size) -
                              10.0 * std::log10(window_power / fft_size) -
                              20.0 * std::log10(ref_scale / 2.0);
        auto to_db = gr::blocks::nlog10_ff::make(10.0F, fft_size,
                                                 static_cast<float>(offset));

        connect(self(), 0, d_decimator, 0);
        connect(d_decimator, 0, transform, 0);
        connect(transform, 0, magnitude_squared, 0);
        connect(magnitude_squared, 0, d_average_filter, 0);
        connect(d_average_filter, 0, to_db, 0);
        connect(to_db, 0, self(), 0);

        apply_average();
    }

    void set_sample_rate(double sample_rate) { d_decimator->set_sample_rate(sample_rate); }

    void set_avg_alpha(double avg_alpha)
    {
        d_avg_alpha = avg_alpha;
        apply_average();
    }

    void set_average(bool average)
    {
        d_average = average;
        apply_average();
    }

private:
    void apply_average() { d_average_filter->set_taps(d_average ? d_avg_alpha : 1.0); }

    double d_avg_alpha;
    bool d_average;
    StreamToVectorDecimator::sptr d_decimator;
    gr::filter::single_pole_iir_filter_ff::sptr d_average_filter;
};

using LogPwrFftC = LogPwrFft<gr_complex>;
using LogPwrFftF = LogPwrFft<float>;
