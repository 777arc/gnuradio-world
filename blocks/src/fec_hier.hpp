#pragma once

// C++ rebuilds of gr-fec's Python hier blocks: the extended encoder and decoder
// family, and the BER curve generator built out of them.

#include "hier_support.hpp"
#include <gnuradio/analog/noise_source.h>
#include <gnuradio/blocks/add_blk.h>
#include <gnuradio/blocks/add_const_ff.h>
#include <gnuradio/blocks/char_to_float.h>
#include <gnuradio/blocks/copy.h>
#include <gnuradio/blocks/deinterleave.h>
#include <gnuradio/blocks/float_to_uchar.h>
#include <gnuradio/blocks/interleave.h>
#include <gnuradio/blocks/pack_k_bits_bb.h>
#include <gnuradio/blocks/packed_to_unpacked.h>
#include <gnuradio/blocks/unpack_k_bits_bb.h>
#include <gnuradio/blocks/unpacked_to_packed.h>
#include <gnuradio/blocks/uchar_to_float.h>
#include <gnuradio/blocks/vector_source.h>
#include <gnuradio/digital/binary_slicer_fb.h>
#include <gnuradio/digital/map_bb.h>
#include <gnuradio/fec/async_encoder.h>
#include <gnuradio/fec/decoder.h>
#include <gnuradio/fec/depuncture_bb.h>
#include <gnuradio/fec/encoder.h>
#include <gnuradio/fec/generic_decoder.h>
#include <gnuradio/fec/generic_encoder.h>
#include <gnuradio/fec/puncture_bb.h>
#include <gnuradio/fec/tagged_decoder.h>
#include <gnuradio/fec/tagged_encoder.h>
#include <gnuradio/hier_block2.h>
#include <gnuradio/io_signature.h>
#include <cmath>
#include <random>
#include <string>
#include <utility>
#include <vector>

// How gr-fec spells a puncture pattern: the GRC parameter is a string of '0'
// and '1', and both puncture_bb and depuncture_bb take it as an MSB-first bit
// mask of that many bits (fec.bitflip.read_bitlist).
inline int puncture_bitmask(const std::string& pattern)
{
    int mask = 0;
    for (std::size_t i = 0; i < pattern.size(); ++i) {
        if (pattern[i] == '1')
            mask |= 1 << (pattern.size() - i - 1);
    }
    return mask;
}

// "11" is upstream's spelling of "no puncturing", and is the one pattern that
// adds no block to the chain.
inline bool punctures(const std::string& pattern) { return pattern != "11"; }

// The parallel encoder/decoder arrangements gr-fec offers. With a single
// codeword worker -- the only shape a Parallelism of 0 can produce, and the
// common case -- all three are the same chain, so the choice only matters once
// a definition block declares a list.
enum class FecThreading { None, Ordinary, Capillary };

inline FecThreading fec_threading_from(const std::string& name)
{
    if (name == "capillary")
        return FecThreading::Capillary;
    if (name == "ordinary")
        return FecThreading::Ordinary;
    return FecThreading::None;
}

// Shared by the extended encoder and decoder: build the parallel worker
// arrangement `threading` asks for over `workers`, and return its head and tail
// so the caller can splice it into a chain. `Make` builds one worker from one
// coder object; `in_size`/`out_size` are the interleaver block sizes, i.e. how
// many items belong to one codeword on each side.
template <typename Coder, typename Make>
std::pair<gr::basic_block_sptr, gr::basic_block_sptr>
build_fec_workers(gr::hier_block2& parent,
                  const std::vector<Coder>& coders,
                  FecThreading threading,
                  int in_size,
                  int out_size,
                  std::size_t item_size,
                  Make make_worker)
{
    if (coders.empty())
        throw std::runtime_error("FEC block needs at least one coder object");
    if (coders.size() == 1 || threading == FecThreading::None) {
        auto worker = make_worker(coders.front());
        return { worker, worker };
    }
    if (threading == FecThreading::Ordinary) {
        auto split = gr::blocks::deinterleave::make(item_size, in_size);
        auto join = gr::blocks::interleave::make(item_size, out_size);
        for (std::size_t i = 0; i < coders.size(); ++i) {
            auto worker = make_worker(coders[i]);
            parent.connect(split, static_cast<int>(i), worker, 0);
            parent.connect(worker, 0, join, static_cast<int>(i));
        }
        return { split, join };
    }
    // Capillary: a binary tree of two-way splits rather than one N-way split, so
    // no single deinterleaver has to keep up with every worker. Upstream builds
    // the same tree breadth-first from index arithmetic and requires a power of
    // two for it; here it falls out of the recursion.
    if ((coders.size() & (coders.size() - 1)) != 0)
        throw std::runtime_error(
            "capillary threading needs a power-of-two number of coder objects");
    const auto build = [&](auto&& self, const Coder* first,
                           std::size_t count) -> std::pair<gr::basic_block_sptr,
                                                           gr::basic_block_sptr> {
        if (count == 1) {
            auto worker = make_worker(*first);
            return { worker, worker };
        }
        auto split = gr::blocks::deinterleave::make(item_size, in_size);
        auto join = gr::blocks::interleave::make(item_size, out_size);
        const auto left = self(self, first, count / 2);
        const auto right = self(self, first + count / 2, count / 2);
        parent.connect(split, 0, left.first, 0);
        parent.connect(split, 1, right.first, 0);
        parent.connect(left.second, 0, join, 0);
        parent.connect(right.second, 0, join, 1);
        return { split, join };
    };
    return build(build, coders.data(), coders.size());
}

// C++ rebuild of gr-fec's Python fec.extended_decoder hier block, for the
// parameter set gr-satellites actually uses (threading=None, ann=None,
// puncpat='11'). Under those the Python chain collapses to the decoder's
// declared input conversion followed by fec.decoder, plus an optional unpack.
class ExtendedDecoder : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<ExtendedDecoder>;
    static sptr make(gr::fec::generic_decoder::sptr decoder,
                     const std::string& puncpat = "11")
    {
        return gnuradio::make_block_sptr<ExtendedDecoder>(std::move(decoder), puncpat);
    }

    explicit ExtendedDecoder(gr::fec::generic_decoder::sptr decoder,
                             const std::string& puncpat = "11")
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
        if (punctures(puncpat))
            chain.push_back(gr::fec::depuncture_bb::make(
                static_cast<int>(puncpat.size()), puncture_bitmask(puncpat), 0));
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

// fec.extended_encoder: the encoder's declared input conversion, the encoder
// itself (parallelised per `threading`), its output conversion, and puncturing.
class ExtendedEncoder : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<ExtendedEncoder>;
    static sptr make(std::vector<gr::fec::generic_encoder::sptr> encoders,
                     FecThreading threading,
                     const std::string& puncpat)
    {
        return gnuradio::make_block_sptr<ExtendedEncoder>(
            std::move(encoders), threading, puncpat);
    }

    ExtendedEncoder(std::vector<gr::fec::generic_encoder::sptr> encoders,
                    FecThreading threading,
                    const std::string& puncpat)
        : gr::hier_block2("extended_encoder",
                          gr::io_signature::make(1, 1, sizeof(char)),
                          gr::io_signature::make(1, 1, sizeof(char)))
    {
        if (encoders.empty())
            throw std::runtime_error("FEC Extended Encoder needs an encoder object");
        const auto& encoder = encoders.front();
        std::vector<gr::basic_block_sptr> head;
        if (std::string(gr::fec::get_encoder_input_conversion(encoder)) == "pack")
            head.push_back(gr::blocks::pack_k_bits_bb::make(8));

        const auto workers = build_fec_workers(
            *this,
            encoders,
            threading,
            gr::fec::get_encoder_input_size(encoder),
            gr::fec::get_encoder_output_size(encoder),
            sizeof(char),
            [](const gr::fec::generic_encoder::sptr& one) -> gr::basic_block_sptr {
                return gr::fec::encoder::make(one, sizeof(char), sizeof(char));
            });

        std::vector<gr::basic_block_sptr> tail;
        if (std::string(gr::fec::get_encoder_output_conversion(encoder)) ==
            "packed_bits")
            tail.push_back(
                gr::blocks::packed_to_unpacked_bb::make(1, gr::GR_MSB_FIRST));
        if (punctures(puncpat))
            tail.push_back(gr::fec::puncture_bb::make(
                static_cast<int>(puncpat.size()), puncture_bitmask(puncpat), 0));

        connect_chain(head, workers.first, workers.second, tail);
    }

protected:
    // Splice the pre-encoder blocks, the (already internally connected) worker
    // arrangement, and the post-encoder blocks between this block's own ports.
    void connect_chain(const std::vector<gr::basic_block_sptr>& head,
                       gr::basic_block_sptr worker_in,
                       gr::basic_block_sptr worker_out,
                       const std::vector<gr::basic_block_sptr>& tail)
    {
        std::vector<gr::basic_block_sptr> chain{ self() };
        chain.insert(chain.end(), head.begin(), head.end());
        chain.push_back(std::move(worker_in));
        for (std::size_t i = 1; i < chain.size(); ++i)
            connect(chain[i - 1], 0, chain[i], 0);

        std::vector<gr::basic_block_sptr> rest{ std::move(worker_out) };
        rest.insert(rest.end(), tail.begin(), tail.end());
        rest.push_back(self());
        for (std::size_t i = 1; i < rest.size(); ++i)
            connect(rest[i - 1], 0, rest[i], 0);
    }

    ExtendedEncoder(const std::string& name,
                    const gr::io_signature::sptr& in_sig,
                    const gr::io_signature::sptr& out_sig)
        : gr::hier_block2(name, in_sig, out_sig)
    {
    }
};

// fec.extended_tagged_encoder: the same chain over a tagged stream. An unset
// length tag name falls back to the untagged encoder, as upstream does, so the
// block still works on a plain stream.
class ExtendedTaggedEncoder : public ExtendedEncoder
{
public:
    using sptr = std::shared_ptr<ExtendedTaggedEncoder>;
    static sptr make(gr::fec::generic_encoder::sptr encoder,
                     const std::string& puncpat,
                     const std::string& lentagname,
                     int mtu)
    {
        return gnuradio::make_block_sptr<ExtendedTaggedEncoder>(
            std::move(encoder), puncpat, lentagname, mtu);
    }

    ExtendedTaggedEncoder(gr::fec::generic_encoder::sptr encoder,
                          const std::string& puncpat,
                          const std::string& lentagname,
                          int mtu)
        : ExtendedEncoder("extended_tagged_encoder",
                          gr::io_signature::make(1, 1, sizeof(char)),
                          gr::io_signature::make(1, 1, sizeof(char)))
    {
        if (!encoder)
            throw std::runtime_error(
                "FEC Extended Tagged Encoder needs an encoder object");
        std::vector<gr::basic_block_sptr> head;
        if (std::string(gr::fec::get_encoder_input_conversion(encoder)) == "pack")
            head.push_back(gr::blocks::pack_k_bits_bb::make(8));

        gr::basic_block_sptr worker;
        if (lentagname.empty())
            worker = gr::fec::encoder::make(encoder, sizeof(char), sizeof(char));
        else
            worker = gr::fec::tagged_encoder::make(
                encoder, sizeof(char), sizeof(char), lentagname, mtu);

        std::vector<gr::basic_block_sptr> tail;
        if (punctures(puncpat))
            tail.push_back(gr::fec::puncture_bb::make(
                static_cast<int>(puncpat.size()), puncture_bitmask(puncpat), 0));

        connect_chain(head, worker, worker, tail);
    }
};

// fec.extended_tagged_decoder. Upstream's version skips the decoder entirely
// when the decoder declares a packed_bits input -- extended_decoder.py, the
// block this is otherwise a copy of, decodes in that case, so this one does too.
class ExtendedTaggedDecoder : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<ExtendedTaggedDecoder>;
    static sptr make(gr::fec::generic_decoder::sptr decoder,
                     const std::string& puncpat,
                     const std::string& lentagname,
                     int mtu)
    {
        return gnuradio::make_block_sptr<ExtendedTaggedDecoder>(
            std::move(decoder), puncpat, lentagname, mtu);
    }

    ExtendedTaggedDecoder(gr::fec::generic_decoder::sptr decoder,
                          const std::string& puncpat,
                          const std::string& lentagname,
                          int mtu)
        : gr::hier_block2("extended_tagged_decoder",
                          gr::io_signature::make(1, 1, sizeof(float)),
                          gr::io_signature::make(1, 1, sizeof(char)))
    {
        if (!decoder)
            throw std::runtime_error(
                "FEC Extended Tagged Decoder needs a decoder object");
        const std::string in_conv = gr::fec::get_decoder_input_conversion(decoder);
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
        if (punctures(puncpat))
            chain.push_back(gr::fec::depuncture_bb::make(
                static_cast<int>(puncpat.size()), puncture_bitmask(puncpat), 0));
        if (in_conv == "packed_bits") {
            chain.push_back(gr::blocks::uchar_to_float::make());
            chain.push_back(gr::blocks::add_const_ff::make(-128.0f));
            chain.push_back(gr::digital::binary_slicer_fb::make());
            chain.push_back(
                gr::blocks::unpacked_to_packed_bb::make(1, gr::GR_LSB_FIRST));
        }
        const std::size_t in_item = gr::fec::get_decoder_input_item_size(decoder);
        const std::size_t out_item = gr::fec::get_decoder_output_item_size(decoder);
        if (lentagname.empty())
            chain.push_back(gr::fec::decoder::make(decoder, in_item, out_item));
        else
            chain.push_back(gr::fec::tagged_decoder::make(
                decoder, in_item, out_item, lentagname, mtu));
        if (std::string(gr::fec::get_decoder_output_conversion(decoder)) == "unpack")
            chain.push_back(
                gr::blocks::packed_to_unpacked_bb::make(1, gr::GR_MSB_FIRST));

        connect(self(), 0, chain.front(), 0);
        for (std::size_t i = 0; i + 1 < chain.size(); ++i)
            connect(chain[i], 0, chain[i + 1], 0);
        connect(chain.back(), 0, self(), 0);
    }
};

// fec.extended_async_encoder: a message-only block, so the hier ports are
// message ports and the "chain" is one msg_connect on each side. Upstream's
// puncturing is commented out there too -- an async encoder emits whole PDUs.
class ExtendedAsyncEncoder : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<ExtendedAsyncEncoder>;
    static sptr make(gr::fec::generic_encoder::sptr encoder)
    {
        return gnuradio::make_block_sptr<ExtendedAsyncEncoder>(std::move(encoder));
    }

    explicit ExtendedAsyncEncoder(gr::fec::generic_encoder::sptr encoder)
        : gr::hier_block2("extended_async_encoder",
                          gr::io_signature::make(0, 0, 0),
                          gr::io_signature::make(0, 0, 0))
    {
        if (!encoder)
            throw std::runtime_error(
                "FEC Extended Async Encoder needs an encoder object");
        message_port_register_hier_in(pmt::mp("in"));
        message_port_register_hier_out(pmt::mp("out"));
        auto async = gr::fec::async_encoder::make(std::move(encoder));
        msg_connect(self(), "in", async, "in");
        msg_connect(async, "out", self(), "out");
    }
};

// fec.fec_test: one point of a BER curve. Encode a byte stream, map it to
// +/-1, add Gaussian noise at the requested Es/N0, decode, and emit both the
// decoded bytes and the original ones so a BER sink can compare them.
class FecTest : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<FecTest>;
    static sptr make(gr::fec::generic_encoder::sptr encoder,
                     gr::fec::generic_decoder::sptr decoder,
                     double esno,
                     FecThreading threading,
                     const std::string& puncpat,
                     long seed)
    {
        return gnuradio::make_block_sptr<FecTest>(
            std::move(encoder), std::move(decoder), esno, threading, puncpat, seed);
    }

    FecTest(gr::fec::generic_encoder::sptr encoder,
            gr::fec::generic_decoder::sptr decoder,
            double esno,
            FecThreading threading,
            const std::string& puncpat,
            long seed)
        : gr::hier_block2("fec_test",
                          gr::io_signature::make(1, 1, sizeof(char)),
                          gr::io_signature::make(2, 2, sizeof(char)))
    {
        auto unpack = gr::blocks::unpack_k_bits_bb::make(8);
        auto pack = gr::blocks::pack_k_bits_bb::make(8);
        auto extended_encoder = ExtendedEncoder::make({ encoder }, threading, puncpat);
        auto extended_decoder = ExtendedDecoder::make(decoder, puncpat);
        auto to_symbols = gr::digital::map_bb::make({ -1, 1 });
        auto to_float = gr::blocks::char_to_float::make(1, 1);
        const double noise = std::sqrt(std::pow(10.0, -esno / 10.0) / 2.0);
        auto noise_source = gr::analog::noise_source_f::make(
            gr::analog::GR_GAUSSIAN,
            static_cast<float>(noise),
            static_cast<std::uint64_t>(seed));
        auto add_noise = gr::blocks::add_ff::make(1);
        auto copy_packed = gr::blocks::copy::make(sizeof(char));

        // Output 1 is the undecoded input, straight through.
        connect(self(), 0, copy_packed, 0);
        connect(copy_packed, 0, self(), 1);

        connect(self(), 0, unpack, 0);
        connect(unpack, 0, extended_encoder, 0);
        connect(extended_encoder, 0, to_symbols, 0);
        connect(to_symbols, 0, to_float, 0);
        connect(to_float, 0, add_noise, 0);
        connect(noise_source, 0, add_noise, 1);
        connect(add_noise, 0, extended_decoder, 0);
        connect(extended_decoder, 0, pack, 0);
        connect(pack, 0, self(), 0);
    }
};

// fec.bercurve_generator: one fec_test per Es/N0 point, all fed from one random
// byte source, with the pair of streams each produces brought out as a pair of
// ports for QT GUI BER Sink to plot.
class BerCurveGenerator : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<BerCurveGenerator>;
    static sptr make(std::vector<gr::fec::generic_encoder::sptr> encoders,
                     std::vector<gr::fec::generic_decoder::sptr> decoders,
                     const std::vector<double>& esno,
                     FecThreading threading,
                     const std::string& puncpat,
                     long seed)
    {
        return gnuradio::make_block_sptr<BerCurveGenerator>(
            std::move(encoders), std::move(decoders), esno, threading, puncpat, seed);
    }

    BerCurveGenerator(std::vector<gr::fec::generic_encoder::sptr> encoders,
                      std::vector<gr::fec::generic_decoder::sptr> decoders,
                      const std::vector<double>& esno,
                      FecThreading threading,
                      const std::string& puncpat,
                      long seed)
        : gr::hier_block2("bercurve_generator",
                          gr::io_signature::make(0, 0, 0),
                          gr::io_signature::make(static_cast<int>(esno.size()) * 2,
                                                 static_cast<int>(esno.size()) * 2,
                                                 sizeof(char)))
    {
        if (esno.empty())
            throw std::runtime_error("BER Curve Gen. needs at least one Es/N0 point");
        // Upstream indexes the encoder and decoder lists per point, which is why
        // its documentation insists both definition blocks declare a
        // parallelism. One object shared by every point is the same code under
        // test at each Es/N0, so it is accepted and reused rather than refused.
        if (encoders.size() != esno.size() && encoders.size() != 1)
            throw std::runtime_error(
                "BER Curve Gen. needs one encoder object per Es/N0 point");
        if (decoders.size() != esno.size() && decoders.size() != 1)
            throw std::runtime_error(
                "BER Curve Gen. needs one decoder object per Es/N0 point");

        auto source = gr::blocks::vector_source_b::make(random_bytes(), true);
        auto split = gr::blocks::deinterleave::make(sizeof(char));
        connect(source, 0, split, 0);
        for (std::size_t i = 0; i < esno.size(); ++i) {
            auto point = FecTest::make(encoders[encoders.size() == 1 ? 0 : i],
                                       decoders[decoders.size() == 1 ? 0 : i],
                                       esno[i],
                                       threading,
                                       puncpat,
                                       seed);
            connect(split, static_cast<int>(i), point, 0);
            connect(point, 0, self(), static_cast<int>(i) * 2);
            connect(point, 1, self(), static_cast<int>(i) * 2 + 1);
        }
    }

private:
    // Upstream draws 100k bytes from numpy's unseeded global RNG. A fixed seed
    // instead, so a curve is the same curve every time the flowgraph is run.
    static std::vector<std::uint8_t> random_bytes()
    {
        std::mt19937 generator(0);
        std::vector<std::uint8_t> bytes(100000);
        for (auto& byte : bytes)
            byte = static_cast<std::uint8_t>(generator() & 0xff);
        return bytes;
    }
};
