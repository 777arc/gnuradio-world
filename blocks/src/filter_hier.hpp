#pragma once

// C++ rebuilds of gr-filter's Python hier blocks.

#include "hier_support.hpp"
#include <gnuradio/blocks/rotator_cc.h>
#include <gnuradio/blocks/stream_to_vector.h>
#include <gnuradio/blocks/vector_map.h>
#include <gnuradio/blocks/vector_to_streams.h>
#include <gnuradio/fft/fft_v.h>
#include <gnuradio/filter/fft_filter_ccc.h>
#include <gnuradio/filter/filterbank_vcvcf.h>
#include <gnuradio/filter/pm_remez.h>
#include <gnuradio/hier_block2.h>
#include <gnuradio/io_signature.h>
#include <algorithm>
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

// ---------------------------------------------------------------------------
// Hierarchical Polyphase Channelizer (pfb_channelizer_hier_ccf)
//
// gr-filter's Python channelizer_hier_ccf splits one wideband stream into N
// channels using a filterbank per group of channels plus a single FFT, and
// designs its own prototype filter with filter.optfir when none is given --
// hence optfir_low_pass below, which the gr-analog rebuilds already needed and
// which belongs beside the module it comes from.
// ---------------------------------------------------------------------------

// filter.optfir.low_pass, the Parks-McClellan designer several of these
// rebuilds reach for when a flowgraph gives no taps of its own. The order
// estimate is Herrmann et al (1973), as optfir.lporder spells it, and the two
// extra taps are optfir's own allowance for it coming out low.
inline std::vector<float> optfir_low_pass(double gain,
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

class PfbChannelizerHier : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<PfbChannelizerHier>;
    static sptr make(int n_chans,
                     int n_filterbanks,
                     const std::vector<float>& taps,
                     const std::vector<int>& outchans,
                     double atten,
                     double bw,
                     double tb,
                     double ripple)
    {
        return gnuradio::make_block_sptr<PfbChannelizerHier>(
            n_chans, n_filterbanks, taps, outchans, atten, bw, tb, ripple);
    }

    PfbChannelizerHier(int n_chans,
                       int n_filterbanks,
                       const std::vector<float>& taps,
                       const std::vector<int>& outchans,
                       double atten,
                       double bw,
                       double tb,
                       double ripple)
        : gr::hier_block2(
              "pfb_channelizer_hier_ccf",
              gr::io_signature::make(1, 1, sizeof(gr_complex)),
              gr::io_signature::make(
                  static_cast<int>(output_channels(n_chans, outchans).size()),
                  static_cast<int>(output_channels(n_chans, outchans).size()),
                  sizeof(gr_complex)))
    {
        if (n_chans < 1)
            throw std::runtime_error(
                "Hierarchical Polyphase Channelizer needs at least one channel");
        const std::vector<int> channels = output_channels(n_chans, outchans);
        for (int channel : channels) {
            if (channel < 0 || channel >= n_chans)
                throw std::runtime_error(
                    "Hierarchical Polyphase Channelizer output channel is out of range");
        }
        n_filterbanks = std::max(1, std::min(n_filterbanks, n_chans));

        std::vector<float> prototype = taps;
        if (prototype.empty())
            prototype = optfir_low_pass(1.0, n_chans, bw, bw + tb, ripple, atten);
        // Pad to a whole number of taps per channel, then deal the prototype out
        // to the channels in reverse, which is the polyphase decomposition.
        prototype.resize(((prototype.size() + n_chans - 1) / n_chans) * n_chans, 0.0F);
        std::vector<std::vector<float>> channel_taps(n_chans);
        for (int channel = 0; channel < n_chans; ++channel) {
            for (std::size_t i = channel; i < prototype.size(); i += n_chans)
                channel_taps[channel].push_back(prototype[i]);
            std::reverse(channel_taps[channel].begin(), channel_taps[channel].end());
        }

        // Spread the channels over the filterbanks as evenly as possible; the
        // first `extra` banks take one channel more than the rest.
        const int low = n_chans / n_filterbanks;
        const int extra = n_chans - low * n_filterbanks;
        std::vector<int> per_bank(n_filterbanks, low);
        for (int i = 0; i < extra; ++i)
            per_bank[i] += 1;

        Mapping splitter_mapping;
        Mapping combiner_mapping(1);
        std::vector<std::size_t> combiner_vlens;
        std::vector<gr::filter::filterbank_vcvcf::sptr> filterbanks;
        int total = 0;
        for (int bank = 0; bank < n_filterbanks; ++bank) {
            std::vector<std::vector<std::size_t>> stream;
            std::vector<std::vector<float>> bank_taps;
            for (int i = total; i < total + per_bank[bank]; ++i) {
                stream.push_back({ 0, static_cast<std::size_t>(i) });
                bank_taps.push_back(channel_taps[i]);
            }
            splitter_mapping.push_back(std::move(stream));
            filterbanks.push_back(gr::filter::filterbank_vcvcf::make(bank_taps));
            combiner_vlens.push_back(static_cast<std::size_t>(per_bank[bank]));
            for (int j = 0; j < per_bank[bank]; ++j)
                combiner_mapping[0].push_back(
                    { static_cast<std::size_t>(bank), static_cast<std::size_t>(j) });
            total += per_bank[bank];
        }

        auto to_vector =
            gr::blocks::stream_to_vector::make(sizeof(gr_complex), n_chans);
        auto splitter = gr::blocks::vector_map::make(
            sizeof(gr_complex), { static_cast<std::size_t>(n_chans) }, splitter_mapping);
        auto combiner = gr::blocks::vector_map::make(
            sizeof(gr_complex), combiner_vlens, combiner_mapping);
        auto transform = gr::fft::fft_v<gr_complex, true>::make(
            n_chans, std::vector<float>(n_chans, 1.0F));
        auto to_streams = gr::blocks::vector_to_streams::make(sizeof(gr_complex),
                                                              channels.size());

        connect(self(), 0, to_vector, 0);
        connect(to_vector, 0, splitter, 0);
        for (int bank = 0; bank < n_filterbanks; ++bank) {
            connect(splitter, bank, filterbanks[bank], 0);
            connect(filterbanks[bank], 0, combiner, bank);
        }
        connect(combiner, 0, transform, 0);
        if (channels.size() != static_cast<std::size_t>(n_chans) ||
            !std::is_sorted(channels.begin(), channels.end()) ||
            channels.front() != 0) {
            Mapping selector_mapping(1);
            for (int channel : channels)
                selector_mapping[0].push_back({ 0, static_cast<std::size_t>(channel) });
            auto selector = gr::blocks::vector_map::make(
                sizeof(gr_complex), { static_cast<std::size_t>(n_chans) },
                selector_mapping);
            connect(transform, 0, selector, 0);
            connect(selector, 0, to_streams, 0);
        } else {
            connect(transform, 0, to_streams, 0);
        }
        for (std::size_t i = 0; i < channels.size(); ++i)
            connect(to_streams, static_cast<int>(i), self(), static_cast<int>(i));
    }

private:
    using Mapping = std::vector<std::vector<std::vector<std::size_t>>>;

    // An unset output channel list means every channel, in order.
    static std::vector<int> output_channels(int n_chans, const std::vector<int>& outchans)
    {
        if (!outchans.empty())
            return outchans;
        std::vector<int> all(std::max(0, n_chans));
        for (int i = 0; i < n_chans; ++i)
            all[i] = i;
        return all;
    }
};
