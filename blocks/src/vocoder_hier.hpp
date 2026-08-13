#pragma once

// C++ rebuilds of gr-vocoder's Python gr.hier_block2 compositions: the CVSD
// encoder and decoder wrappers.

#include "hier_support.hpp"
#include <gnuradio/blocks/float_to_short.h>
#include <gnuradio/blocks/multiply_const.h>
#include <gnuradio/blocks/short_to_float.h>
#include <gnuradio/filter/fir_filter_blk.h>
#include <gnuradio/filter/firdes.h>
#include <gnuradio/filter/interp_fir_filter.h>
#include <gnuradio/hier_block2.h>
#include <gnuradio/io_signature.h>
#include <gnuradio/vocoder/cvsd_decode_bs.h>
#include <gnuradio/vocoder/cvsd_encode_sb.h>

// The CVSD vocoder's own blocks work on shorts at the resampled rate, so both
// wrappers are the same three steps: scale into short range, resample, vocode.
// 32000 rather than 32767 is upstream's headroom against clipping.
inline constexpr double kCvsdScaleFactor = 32000.0;

// vocoder.cvsd_encode_fb
class CvsdEncode : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<CvsdEncode>;
    static sptr make(int resample, double bw)
    {
        return gnuradio::make_block_sptr<CvsdEncode>(resample, bw);
    }

    CvsdEncode(int resample, double bw)
        : gr::hier_block2("cvsd_encode",
                          gr::io_signature::make(1, 1, sizeof(float)),
                          gr::io_signature::make(1, 1, sizeof(std::uint8_t)))
    {
        if (resample < 1)
            throw std::runtime_error("CVSD Encoder resample must be at least 1");
        require_positive("CVSD Encoder fractional bandwidth", bw);

        auto scale = gr::blocks::multiply_const_ff::make(kCvsdScaleFactor);
        auto interpolator = gr::filter::interp_fir_filter_fff::make(
            resample,
            gr::filter::firdes::low_pass(resample, resample, bw, 2 * bw));
        auto to_short = gr::blocks::float_to_short::make();
        auto encoder = gr::vocoder::cvsd_encode_sb::make();

        connect(self(), 0, scale, 0);
        connect(scale, 0, interpolator, 0);
        connect(interpolator, 0, to_short, 0);
        connect(to_short, 0, encoder, 0);
        connect(encoder, 0, self(), 0);
    }
};

// vocoder.cvsd_decode_bf
class CvsdDecode : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<CvsdDecode>;
    static sptr make(int resample, double bw)
    {
        return gnuradio::make_block_sptr<CvsdDecode>(resample, bw);
    }

    CvsdDecode(int resample, double bw)
        : gr::hier_block2("cvsd_decode",
                          gr::io_signature::make(1, 1, sizeof(std::uint8_t)),
                          gr::io_signature::make(1, 1, sizeof(float)))
    {
        if (resample < 1)
            throw std::runtime_error("CVSD Decoder resample must be at least 1");
        require_positive("CVSD Decoder fractional bandwidth", bw);

        auto decoder = gr::vocoder::cvsd_decode_bs::make();
        auto to_float = gr::blocks::short_to_float::make();
        auto decimator = gr::filter::fir_filter_fff::make(
            resample, gr::filter::firdes::low_pass(1, 1, bw, 2 * bw));
        auto scale = gr::blocks::multiply_const_ff::make(1.0 / kCvsdScaleFactor);

        connect(self(), 0, decoder, 0);
        connect(decoder, 0, to_float, 0);
        connect(to_float, 0, decimator, 0);
        connect(decimator, 0, scale, 0);
        connect(scale, 0, self(), 0);
    }
};
