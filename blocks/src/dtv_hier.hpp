#pragma once

// C++ rebuilds of gr-dtv's Python gr.hier_block2 compositions: the ATSC
// receive filter and the whole ATSC receive pipeline built on top of it.
// Every block in both is C++ already; only the composition was Python.

#include "hier_support.hpp"
#include <gnuradio/analog/agc_ff.h>
#include <gnuradio/dtv/atsc_deinterleaver.h>
#include <gnuradio/dtv/atsc_depad.h>
#include <gnuradio/dtv/atsc_derandomizer.h>
#include <gnuradio/dtv/atsc_equalizer.h>
#include <gnuradio/dtv/atsc_fpll.h>
#include <gnuradio/dtv/atsc_fs_checker.h>
#include <gnuradio/dtv/atsc_rs_decoder.h>
#include <gnuradio/dtv/atsc_sync.h>
#include <gnuradio/dtv/atsc_viterbi_decoder.h>
#include <gnuradio/filter/dc_blocker_ff.h>
#include <gnuradio/filter/firdes.h>
#include <gnuradio/filter/pfb_arb_resampler_ccf.h>
#include <gnuradio/hier_block2.h>
#include <gnuradio/io_signature.h>

// The constants dtv/atsc_rx_filter.py keeps beside the block rather than in
// gr-dtv's own atsc_consts.h.
inline constexpr double kAtscChannelBandwidth = 6.0e6;
inline constexpr double kAtscSymbolRate = 4.5e6 / 286.0 * 684.0; // ~10.76 Mbaud
inline constexpr int kAtscRrcSymbols = 8; // kernel spans 2N+1 symbols

// dtv.atsc_rx_filter: a matched root-raised-cosine filter that also resamples an
// arbitrary capture rate to the oversampled symbol rate the demodulator wants.
class AtscRxFilter : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<AtscRxFilter>;
    static sptr make(double input_rate, double sps)
    {
        return gnuradio::make_block_sptr<AtscRxFilter>(input_rate, sps);
    }

    AtscRxFilter(double input_rate, double sps)
        : gr::hier_block2("atsc_rx_filter",
                          gr::io_signature::make(1, 1, sizeof(gr_complex)),
                          gr::io_signature::make(1, 1, sizeof(gr_complex)))
    {
        require_positive("ATSC RX Filter input rate", input_rate);
        require_positive("ATSC RX Filter oversampling ratio", sps);

        constexpr int nfilts = 16;
        const double output_rate = kAtscSymbolRate * sps;
        const double filter_rate = input_rate * nfilts;
        // One-sided bandwidth of the vestigial sideband, and the excess
        // bandwidth that goes with it (~10.3% of the 6 MHz channel).
        const double symbol_rate = kAtscSymbolRate / 2.0;
        constexpr double excess_bw = 0.1152;
        const int ntaps = static_cast<int>((2 * kAtscRrcSymbols + 1) * sps * nfilts);
        const double interp = output_rate / input_rate;
        const double gain = nfilts * symbol_rate / filter_rate;

        auto resampler = gr::filter::pfb_arb_resampler_ccf::make(
            static_cast<float>(interp),
            gr::filter::firdes::root_raised_cosine(
                gain, filter_rate, symbol_rate, excess_bw, ntaps),
            nfilts);
        connect(self(), 0, resampler, 0);
        connect(resampler, 0, self(), 0);
    }
};

// dtv.atsc_rx: filter, lock to the pilot, recover timing, then unwind the
// transmitter's coding one layer at a time down to MPEG-2 transport packets.
// The three coding stages carry the segment/field plinfo alongside the data on a
// second port, which is why they are connected pairwise rather than in a chain.
class AtscRx : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<AtscRx>;
    static sptr make(double input_rate, double sps)
    {
        return gnuradio::make_block_sptr<AtscRx>(input_rate, sps);
    }

    AtscRx(double input_rate, double sps)
        : gr::hier_block2("atsc_rx",
                          gr::io_signature::make(1, 1, sizeof(gr_complex)),
                          gr::io_signature::make(1, 1, sizeof(std::uint8_t)))
    {
        require_positive("ATSC Receive Pipeline input rate", input_rate);
        require_positive("ATSC Receive Pipeline oversampling ratio", sps);
        const double output_rate = kAtscSymbolRate * sps;

        auto rx_filter = AtscRxFilter::make(input_rate, sps);
        // Lock onto the pilot tone, shift it to DC and keep the real channel.
        auto pll = gr::dtv::atsc_fpll::make(static_cast<float>(output_rate));
        auto dc_blocker = gr::filter::dc_blocker_ff::make(4096);
        auto agc = gr::analog::agc_ff::make(1e-5F, 4.0F);
        auto timing = gr::dtv::atsc_sync::make(static_cast<float>(output_rate));
        auto field_sync = gr::dtv::atsc_fs_checker::make();
        auto equalizer = gr::dtv::atsc_equalizer::make();
        auto viterbi = gr::dtv::atsc_viterbi_decoder::make();
        auto deinterleaver = gr::dtv::atsc_deinterleaver::make();
        auto rs_decoder = gr::dtv::atsc_rs_decoder::make();
        auto derandomizer = gr::dtv::atsc_derandomizer::make();
        auto depad = gr::dtv::atsc_depad::make();

        connect(self(), 0, rx_filter, 0);
        connect(rx_filter, 0, pll, 0);
        connect(pll, 0, dc_blocker, 0);
        connect(dc_blocker, 0, agc, 0);
        connect(agc, 0, timing, 0);
        connect(timing, 0, field_sync, 0);
        for (int port = 0; port < 2; ++port) {
            connect(field_sync, port, equalizer, port);
            connect(equalizer, port, viterbi, port);
            connect(viterbi, port, deinterleaver, port);
            connect(deinterleaver, port, rs_decoder, port);
            connect(rs_decoder, port, derandomizer, port);
        }
        connect(derandomizer, 0, depad, 0);
        connect(depad, 0, self(), 0);
    }
};
