#pragma once

// C++ rebuild of gr-filter's Python hier block.

#include "hier_support.hpp"
#include <gnuradio/blocks/rotator_cc.h>
#include <gnuradio/filter/fft_filter_ccc.h>
#include <gnuradio/hier_block2.h>
#include <gnuradio/io_signature.h>
#include <vector>

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
