#pragma once

// C++ rebuild of gr-fec's Python hier block.

#include "hier_support.hpp"
#include <gnuradio/blocks/add_const_ff.h>
#include <gnuradio/blocks/unpacked_to_packed.h>
#include <gnuradio/blocks/float_to_uchar.h>
#include <gnuradio/blocks/uchar_to_float.h>
#include <gnuradio/digital/binary_slicer_fb.h>
#include <gnuradio/fec/decoder.h>
#include <gnuradio/fec/generic_decoder.h>
#include <gnuradio/hier_block2.h>
#include <gnuradio/io_signature.h>
#include <vector>

// C++ rebuild of gr-fec's Python fec.extended_decoder hier block, for the
// parameter set gr-satellites actually uses (threading=None, ann=None,
// puncpat='11'). Under those the Python chain collapses to the decoder's
// declared input conversion followed by fec.decoder, plus an optional unpack.
class ExtendedDecoder : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<ExtendedDecoder>;
    static sptr make(gr::fec::generic_decoder::sptr decoder)
    {
        return gnuradio::make_block_sptr<ExtendedDecoder>(std::move(decoder));
    }

    explicit ExtendedDecoder(gr::fec::generic_decoder::sptr decoder)
        : gr::hier_block2("extended_decoder",
                          gr::io_signature::make(1, 1, sizeof(float)),
                          gr::io_signature::make(1, 1, sizeof(char)))
    {
        const std::string in_conv = gr::fec::get_decoder_input_conversion(decoder);
        const std::string out_conv = gr::fec::get_decoder_output_conversion(decoder);
        const bool needs_float_to_uchar =
            in_conv == "uchar" || in_conv == "packed_bits";
        float bias = gr::fec::get_shift(decoder);
        if (bias == 0.0f && in_conv == "packed_bits")
            bias = 128.0f;

        std::vector<gr::basic_block_sptr> chain;
        if (bias != 0.0f && !needs_float_to_uchar)
            chain.push_back(gr::blocks::add_const_ff::make(bias));
        if (needs_float_to_uchar)
            chain.push_back(gr::blocks::float_to_uchar::make(1, 48.0f, bias));
        if (in_conv == "packed_bits") {
            chain.push_back(gr::blocks::uchar_to_float::make());
            chain.push_back(gr::blocks::add_const_ff::make(-128.0f));
            chain.push_back(gr::digital::binary_slicer_fb::make());
            chain.push_back(
                gr::blocks::unpacked_to_packed_bb::make(1, gr::GR_LSB_FIRST));
        }
        chain.push_back(
            gr::fec::decoder::make(decoder,
                                   gr::fec::get_decoder_input_item_size(decoder),
                                   gr::fec::get_decoder_output_item_size(decoder)));
        if (out_conv == "unpack")
            chain.push_back(
                gr::blocks::packed_to_unpacked_bb::make(1, gr::GR_MSB_FIRST));

        connect(self(), 0, chain.front(), 0);
        for (std::size_t i = 0; i + 1 < chain.size(); ++i)
            connect(chain[i], 0, chain[i + 1], 0);
        connect(chain.back(), 0, self(), 0);
    }
};
