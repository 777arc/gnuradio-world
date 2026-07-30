// C++ rebuilds of gr-satellites' Python deframer components.
// See satellites_wasm_deframers.hpp. Each class mirrors the block set and
// connection order of the corresponding file under
// gr-satellites/python/components/deframers, so a diff against the Python stays
// readable. Syncwords and packet lengths are copied verbatim from there.
// SPDX-License-Identifier: GPL-3.0-or-later
#include "satellites_wasm_deframers.hpp"

#include "satellites_wasm_blocks.hpp"
#include "satellites_wasm_hier.hpp"

#include <gnuradio/blocks/add_const_ff.h>
#include <gnuradio/blocks/char_to_float.h>
#include <gnuradio/blocks/delay.h>
#include <gnuradio/blocks/packed_to_unpacked.h>
#include <gnuradio/blocks/tagged_stream_multiply_length.h>
#include <gnuradio/blocks/unpack_k_bits_bb.h>
#include <gnuradio/blocks/unpacked_to_packed.h>
#include <gnuradio/digital/additive_scrambler.h>
#include <gnuradio/digital/binary_slicer_fb.h>
#include <gnuradio/digital/correlate_access_code_tag_bb.h>
#include <gnuradio/digital/descrambler_bb.h>
#include <gnuradio/digital/diff_decoder_bb.h>
#include <gnuradio/fec/async_decoder.h>
#include <gnuradio/fec/cc_decoder.h>
#include <gnuradio/hier_block2.h>
#include <gnuradio/io_signature.h>
#include <gnuradio/pdu/pdu_to_tagged_stream.h>
#include <gnuradio/pdu/tagged_stream_to_pdu.h>
#include <gnuradio/sync_block.h>
#include <gnuradio/types.h>
#include <pmt/pmt.h>
#include <satellites/ax100_decode.h>
#include <satellites/crc.h>
#include <satellites/crc_check.h>
#include <satellites/decode_rs.h>
#include <satellites/distributed_syncframe_soft.h>
#include <satellites/lilacsat1_demux.h>
#include <satellites/matrix_deinterleaver_soft.h>
#include <satellites/matrix_deinterleaver_soft.h>
#include <satellites/nrzi_decode.h>
#include <satellites/nusat_decoder.h>
#include <satellites/pdu_head_tail.h>
#include <satellites/pdu_length_filter.h>
#include <satellites/u482c_decode.h>

#include <cstddef>
#include <cstdint>
#include <deque>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace wasm_satellites {
namespace {

// ---------------------------------------------------------------------------
// python/hdlc_deframer.py
// ---------------------------------------------------------------------------

// The FCS the Python hdlc_crc_check uses: CRC-16 CCITT X.25, little-endian at
// the end of the frame.
class HdlcCrcCheck
{
public:
    HdlcCrcCheck() : d_crc(16, 0x1021, 0xFFFF, 0xFFFF, true, true) {}

    bool fcs_ok(const std::vector<std::uint8_t>& frame)
    {
        if (frame.size() <= 2)
            return false;
        const std::uint64_t out = d_crc.compute(frame.data(), frame.size() - 2);
        return frame[frame.size() - 2] == (out & 0xff) &&
               frame[frame.size() - 1] == ((out >> 8) & 0xff);
    }

private:
    gr::satellites::crc d_crc;
};

// Bit-oriented HDLC deframer: watches an unpacked bit stream for flags, undoes
// bit stuffing, and publishes each frame (minus its FCS) as a PDU.
class HdlcDeframer : public gr::sync_block
{
public:
    using sptr = std::shared_ptr<HdlcDeframer>;
    static sptr make(bool check_fcs, int max_length)
    {
        return gnuradio::make_block_sptr<HdlcDeframer>(check_fcs, max_length);
    }

    HdlcDeframer(bool check_fcs, int max_length)
        : gr::sync_block("hdlc_deframer",
                         gr::io_signature::make(1, 1, sizeof(char)),
                         gr::io_signature::make(0, 0, 0)),
          d_check(check_fcs),
          d_max_bits(static_cast<std::size_t>(max_length + 2) * 8 + 7)
    {
        message_port_register_out(pmt::mp("out"));
    }

    int work(int noutput_items,
             gr_vector_const_void_star& input_items,
             gr_vector_void_star& output_items) override
    {
        const auto* in = static_cast<const std::uint8_t*>(input_items[0]);
        for (int i = 0; i < noutput_items; ++i) {
            const std::uint8_t x = in[i];
            if (x) {
                ++d_ones;
                push_bit(x);
            } else {
                if (d_ones == 5) {
                    // Stuffed bit: destuff by dropping it.
                } else if (d_ones > 5) {
                    // A flag; d_ones should be 6 unless the frame is corrupt.
                    emit_frame();
                } else {
                    push_bit(x);
                }
                d_ones = 0;
            }
        }
        return noutput_items;
    }

private:
    void push_bit(std::uint8_t bit)
    {
        if (d_bits.size() == d_max_bits)
            d_bits.pop_front();
        d_bits.push_back(bit);
    }

    void emit_frame()
    {
        // Drop the 7 flag bits just shifted in.
        for (std::size_t i = 0, n = std::min<std::size_t>(7, d_bits.size()); i < n; ++i)
            d_bits.pop_back();
        if (d_bits.size() % 8)
            // Pad on the left with zeros.
            d_bits.insert(d_bits.begin(), 8 - d_bits.size() % 8, 0);

        std::vector<std::uint8_t> frame(d_bits.size() / 8);
        for (std::size_t i = 0; i < frame.size(); ++i) {
            std::uint8_t byte = 0;
            for (int j = 7; j >= 0; --j) { // LSB first
                byte <<= 1;
                byte |= d_bits[i * 8 + j] & 1;
            }
            frame[i] = byte;
        }
        d_bits.clear();

        if (frame.empty() || (d_check && !d_crc_check.fcs_ok(frame)))
            return;
        frame.resize(frame.size() - 2); // trim the FCS
        message_port_pub(
            pmt::mp("out"),
            pmt::cons(pmt::PMT_NIL,
                      pmt::init_u8vector(frame.size(), frame.data())));
    }

    bool d_check;
    std::size_t d_max_bits;
    std::size_t d_ones = 0;
    std::deque<std::uint8_t> d_bits;
    HdlcCrcCheck d_crc_check;
};

// ---------------------------------------------------------------------------
// Shared scaffolding
// ---------------------------------------------------------------------------

// python/crcs.py: named CRC-16/32 checkers built on satellites::crc_check.
// Each has an "in" message port plus "ok" and "fail" outputs.
gr::basic_block_sptr crc16_arc(bool swap_endianness = true, bool discard_crc = true)
{
    return gr::satellites::crc_check::make(
        16, 0x8005, 0x0, 0x0, true, true, swap_endianness, discard_crc);
}
gr::basic_block_sptr crc16_ccitt_x25(bool swap_endianness = true,
                                     bool discard_crc = true)
{
    return gr::satellites::crc_check::make(
        16, 0x1021, 0xFFFF, 0xFFFF, true, true, swap_endianness, discard_crc);
}
gr::basic_block_sptr crc16_ccitt_false(bool swap_endianness = false,
                                       bool discard_crc = true)
{
    return gr::satellites::crc_check::make(
        16, 0x1021, 0xFFFF, 0x0, false, false, swap_endianness, discard_crc);
}
gr::basic_block_sptr crc16_ccitt_zero(bool swap_endianness = false,
                                      bool discard_crc = true)
{
    return gr::satellites::crc_check::make(
        16, 0x1021, 0x0, 0x0, false, false, swap_endianness, discard_crc);
}
gr::basic_block_sptr crc16_cc11xx(bool discard_crc = true)
{
    return gr::satellites::crc_check::make(
        16, 0x8005, 0xFFFF, 0x0, false, false, false, discard_crc);
}
gr::basic_block_sptr crc32c(bool discard_crc = true)
{
    return gr::satellites::crc_check::make(
        32, 0x1EDC6F41, 0xFFFFFFFF, 0xFFFFFFFF, true, true, false, discard_crc);
}

// Every deframer component takes a float stream of soft symbols and publishes
// frames as PDUs on a hierarchy message port named "out".
class DeframerHier : public gr::hier_block2
{
protected:
    explicit DeframerHier(const char* name)
        : gr::hier_block2(name,
                          gr::io_signature::make(1, 1, sizeof(float)),
                          gr::io_signature::make(0, 0, 0))
    {
        message_port_register_hier_out(pmt::mp("out"));
    }

    // Connect a stream chain starting at this hierarchy's input.
    void stream_from_self(const std::vector<gr::basic_block_sptr>& blocks)
    {
        connect(self(), 0, blocks.front(), 0);
        chain(blocks);
    }

    void chain(const std::vector<gr::basic_block_sptr>& blocks)
    {
        for (std::size_t i = 0; i + 1 < blocks.size(); ++i)
            connect(blocks[i], 0, blocks[i + 1], 0);
    }

    // Connect a message chain block[i]:out_port -> block[i+1]:"in", ending at
    // this hierarchy's "out". Each entry names the *source* port to leave by.
    void msg_chain(
        const std::vector<std::pair<gr::basic_block_sptr, const char*>>& nodes)
    {
        for (std::size_t i = 0; i + 1 < nodes.size(); ++i)
            msg_connect(nodes[i].first, nodes[i].second, nodes[i + 1].first, "in");
        msg_connect(nodes.back().first, nodes.back().second, self(), "out");
    }

    // The packed-byte PDU -> unpacked-bit PDU adapter several deframers use
    // around ccsds_descrambler, which expects unpacked input.
    struct Unpacker {
        gr::basic_block_sptr in;  // message sink ("pdus")
        gr::basic_block_sptr out; // message source ("pdus")
    };
    Unpacker make_unpacker()
    {
        auto pdu2tag =
            gr::pdu::pdu_to_tagged_stream::make(gr::types::byte_t, "packet_len");
        auto unpack =
            gr::blocks::packed_to_unpacked_bb::make(1, gr::GR_MSB_FIRST);
        auto taglength = gr::blocks::tagged_stream_multiply_length::make(
            sizeof(char) * 1, "packet_len", 8);
        auto tag2pdu =
            gr::pdu::tagged_stream_to_pdu::make(gr::types::byte_t, "packet_len");
        chain({ pdu2tag, unpack, taglength, tag2pdu });
        return { pdu2tag, tag2pdu };
    }
};

// ---------------------------------------------------------------------------
// Deframers
// ---------------------------------------------------------------------------

// components/deframers/ax25_deframer.py
class Ax25Deframer : public DeframerHier
{
public:
    using sptr = std::shared_ptr<Ax25Deframer>;
    static sptr make(bool g3ruh_scrambler)
    {
        return gnuradio::make_block_sptr<Ax25Deframer>(g3ruh_scrambler);
    }

    explicit Ax25Deframer(bool g3ruh_scrambler) : DeframerHier("ax25_deframer")
    {
        std::vector<gr::basic_block_sptr> blocks{
            gr::digital::binary_slicer_fb::make(),
            gr::satellites::nrzi_decode::make()
        };
        if (g3ruh_scrambler)
            blocks.push_back(gr::digital::descrambler_bb::make(0x21, 0, 16));
        auto deframer = HdlcDeframer::make(true, 10000);
        blocks.push_back(deframer);
        stream_from_self(blocks);
        msg_connect(deframer, "out", self(), "out");
    }
};

// components/deframers/ua01_deframer.py -- two NRZ-I decoders in series is
// deliberate; UA01 applies the encoding twice.
class Ua01Deframer : public DeframerHier
{
public:
    using sptr = std::shared_ptr<Ua01Deframer>;
    static sptr make() { return gnuradio::make_block_sptr<Ua01Deframer>(); }

    Ua01Deframer() : DeframerHier("ua01_deframer")
    {
        auto deframer = HdlcDeframer::make(true, 10000);
        stream_from_self({ gr::digital::binary_slicer_fb::make(),
                           gr::satellites::nrzi_decode::make(),
                           gr::satellites::nrzi_decode::make(),
                           gr::digital::descrambler_bb::make(0x21, 0, 16),
                           deframer });
        msg_connect(deframer, "out", self(), "out");
    }
};

// components/deframers/ax100_deframer.py
class Ax100Deframer : public DeframerHier
{
public:
    using sptr = std::shared_ptr<Ax100Deframer>;
    static sptr make(const std::string& mode,
                     const std::string& scrambler,
                     int syncword_threshold,
                     const std::string& syncword)
    {
        return gnuradio::make_block_sptr<Ax100Deframer>(
            mode, scrambler, syncword_threshold, syncword);
    }

    Ax100Deframer(const std::string& mode,
                  const std::string& scrambler,
                  int syncword_threshold,
                  const std::string& syncword)
        : DeframerHier("ax100_deframer")
    {
        if (scrambler != "CCSDS" && scrambler != "none")
            throw std::runtime_error("invalid scrambler " + scrambler);
        if (mode != "RS" && mode != "ASM")
            throw std::runtime_error("Unsupported AX100 mode. Use 'RS' or 'ASM'");

        std::vector<gr::basic_block_sptr> blocks{
            gr::digital::binary_slicer_fb::make()
        };
        if (mode == "RS")
            blocks.push_back(gr::digital::descrambler_bb::make(0x21, 0, 16));
        auto deframer = make_sync_to_pdu_packed(
            mode == "RS" ? 256 : 258, syncword, syncword_threshold);
        blocks.push_back(deframer);
        stream_from_self(blocks);

        gr::basic_block_sptr fec;
        if (mode == "RS")
            fec = gr::satellites::ax100_decode::make(false);
        else
            fec = gr::satellites::u482c_decode::make(
                false, 0, scrambler == "CCSDS" ? 1 : 0, 1);
        msg_chain({ { deframer, "out" }, { fec, "out" } });
    }
};

// components/deframers/u482c_deframer.py
class U482cDeframer : public DeframerHier
{
public:
    using sptr = std::shared_ptr<U482cDeframer>;
    static sptr make(int syncword_threshold)
    {
        return gnuradio::make_block_sptr<U482cDeframer>(syncword_threshold);
    }

    explicit U482cDeframer(int syncword_threshold) : DeframerHier("u482c_deframer")
    {
        auto deframer = make_sync_to_pdu_packed(
            258, "11000011101010100110011001010101", syncword_threshold);
        stream_from_self({ gr::digital::binary_slicer_fb::make(), deframer });
        auto fec = gr::satellites::u482c_decode::make(false, -1, -1, -1);
        msg_chain({ { deframer, "out" }, { fec, "out" } });
    }
};

constexpr const char* kCcsdsSyncword = "00011010110011111111110000011101";

// components/deframers/ccsds_rs_deframer.py
class CcsdsRsDeframer : public DeframerHier
{
public:
    using sptr = std::shared_ptr<CcsdsRsDeframer>;
    static sptr make(int frame_size,
                     const std::string& precoding,
                     bool rs_en,
                     const std::string& rs_basis,
                     int rs_interleaving,
                     const std::string& scrambler,
                     int syncword_threshold)
    {
        return gnuradio::make_block_sptr<CcsdsRsDeframer>(frame_size,
                                                          precoding,
                                                          rs_en,
                                                          rs_basis,
                                                          rs_interleaving,
                                                          scrambler,
                                                          syncword_threshold);
    }

    CcsdsRsDeframer(int frame_size,
                    const std::string& precoding,
                    bool rs_en,
                    const std::string& rs_basis,
                    int rs_interleaving,
                    const std::string& scrambler,
                    int syncword_threshold)
        : DeframerHier("ccsds_rs_deframer")
    {
        if (!precoding.empty() && precoding != "None" &&
            precoding != "differential")
            throw std::runtime_error("invalid precoding " + precoding);
        if (rs_basis != "conventional" && rs_basis != "dual")
            throw std::runtime_error("invalid Reed-Solomon basis " + rs_basis);
        if (scrambler != "CCSDS" && scrambler != "none")
            throw std::runtime_error("invalid scrambler " + scrambler);

        const bool ccsds_scrambler = scrambler == "CCSDS";
        // The CCSDS descrambler wants unpacked bits, so that path asks
        // sync_to_pdu for 8x the items and skips the packing variant.
        const int packlen =
            (frame_size + (rs_en ? 32 * rs_interleaving : 0)) *
            (ccsds_scrambler ? 8 : 1);
        auto deframer =
            ccsds_scrambler
                ? make_sync_to_pdu(packlen, kCcsdsSyncword, syncword_threshold)
                : make_sync_to_pdu_packed(
                      packlen, kCcsdsSyncword, syncword_threshold);

        std::vector<gr::basic_block_sptr> blocks{
            gr::digital::binary_slicer_fb::make()
        };
        if (precoding == "differential")
            blocks.push_back(gr::digital::diff_decoder_bb::make(2));
        blocks.push_back(deframer);
        stream_from_self(blocks);

        std::vector<std::pair<gr::basic_block_sptr, const char*>> nodes{
            { deframer, "out" }
        };
        if (ccsds_scrambler)
            nodes.push_back({ make_ccsds_descrambler(), "out" });
        if (rs_en)
            nodes.push_back(
                { gr::satellites::decode_rs::make(rs_basis == "dual" ? 1 : 0,
                                                  rs_interleaving),
                  "out" });
        msg_chain(nodes);
    }
};

// components/deframers/ccsds_concatenated_deframer.py -- two parallel branches
// one sample apart resolve the convolutional decoder's phase ambiguity.
class CcsdsConcatenatedDeframer : public DeframerHier
{
public:
    using sptr = std::shared_ptr<CcsdsConcatenatedDeframer>;
    static sptr make(int frame_size,
                     const std::string& precoding,
                     bool rs_en,
                     const std::string& rs_basis,
                     int rs_interleaving,
                     const std::string& scrambler,
                     int syncword_threshold,
                     const std::string& convolutional)
    {
        return gnuradio::make_block_sptr<CcsdsConcatenatedDeframer>(
            frame_size,
            precoding,
            rs_en,
            rs_basis,
            rs_interleaving,
            scrambler,
            syncword_threshold,
            convolutional);
    }

    CcsdsConcatenatedDeframer(int frame_size,
                              const std::string& precoding,
                              bool rs_en,
                              const std::string& rs_basis,
                              int rs_interleaving,
                              const std::string& scrambler,
                              int syncword_threshold,
                              const std::string& convolutional)
        : DeframerHier("ccsds_concatenated_deframer")
    {
        for (int branch = 0; branch < 2; ++branch) {
            auto viterbi = make_ccsds_viterbi(convolutional);
            auto char2float = gr::blocks::char_to_float::make(1, 1);
            auto addconst = gr::blocks::add_const_ff::make(-0.5);
            auto rs = CcsdsRsDeframer::make(frame_size,
                                            precoding,
                                            rs_en,
                                            rs_basis,
                                            rs_interleaving,
                                            scrambler,
                                            syncword_threshold);
            if (branch == 0) {
                connect(self(), 0, viterbi, 0);
            } else {
                auto delay = gr::blocks::delay::make(sizeof(float), 1);
                connect(self(), 0, delay, 0);
                connect(delay, 0, viterbi, 0);
            }
            chain({ viterbi, char2float, addconst, rs });
            msg_connect(rs, "out", self(), "out");
        }
    }
};

// components/deframers/aistechsat_2_deframer.py
class Aistechsat2Deframer : public DeframerHier
{
public:
    using sptr = std::shared_ptr<Aistechsat2Deframer>;
    static sptr make(int syncword_threshold)
    {
        return gnuradio::make_block_sptr<Aistechsat2Deframer>(syncword_threshold);
    }

    explicit Aistechsat2Deframer(int syncword_threshold)
        : DeframerHier("aistechsat_2_deframer")
    {
        auto deframer =
            make_sync_to_pdu((93 + 32) * 8, kCcsdsSyncword, syncword_threshold);
        stream_from_self({ gr::digital::binary_slicer_fb::make(), deframer });
        msg_chain({ { deframer, "out" },
                    { make_ccsds_descrambler(), "out" },
                    { gr::satellites::pdu_head_tail::make(3, 10), "out" },
                    { gr::satellites::decode_rs::make(0, 1), "out" } });
    }
};

// components/deframers/ao40_uncoded_deframer.py
class Ao40UncodedDeframer : public DeframerHier
{
public:
    using sptr = std::shared_ptr<Ao40UncodedDeframer>;
    static sptr make(int syncword_threshold)
    {
        return gnuradio::make_block_sptr<Ao40UncodedDeframer>(syncword_threshold);
    }

    explicit Ao40UncodedDeframer(int syncword_threshold)
        : DeframerHier("ao40_uncoded_deframer")
    {
        auto deframer = make_sync_to_pdu_packed(
            512 + 2, "00111001000101011110110100110000", syncword_threshold);
        stream_from_self({ gr::digital::binary_slicer_fb::make(), deframer });
        msg_chain({ { deframer, "out" }, { crc16_ccitt_false(), "ok" } });
    }
};

// components/deframers/ao40_fec_deframer.py
class Ao40FecDeframer : public DeframerHier
{
public:
    using sptr = std::shared_ptr<Ao40FecDeframer>;
    static sptr make(int syncword_threshold, bool short_frames, bool crc)
    {
        return gnuradio::make_block_sptr<Ao40FecDeframer>(
            syncword_threshold, short_frames, crc);
    }

    Ao40FecDeframer(int syncword_threshold, bool short_frames, bool crc)
        : DeframerHier("ao40_fec_deframer")
    {
        static constexpr const char* kSyncword =
            "11111110000111011110010110010010000001000100110001011101011011000";
        static constexpr const char* kSyncwordShort =
            "1111111000011101111001011001001000000100010011000101";

        auto deframer = gr::satellites::distributed_syncframe_soft::make(
            syncword_threshold,
            short_frames ? kSyncwordShort : kSyncword,
            short_frames ? 51 : 80);
        connect(self(), 0, deframer, 0);

        auto deinterleaver = gr::satellites::matrix_deinterleaver_soft::make(
            short_frames ? 51 : 80,
            short_frames ? 52 : 65,
            short_frames ? 2572 : 5132,
            short_frames ? 80 : 65);
        auto viterbi = gr::fec::code::cc_decoder::make(short_frames ? 2572 : 5132,
                                                       7,
                                                       2,
                                                       { 79, -109 },
                                                       0,
                                                       -1,
                                                       CC_TERMINATED,
                                                       false);
        auto viterbi_decoder = gr::fec::async_decoder::make(
            viterbi, false, false, short_frames ? 2572 / 8 : 5132 / 8);

        std::vector<std::pair<gr::basic_block_sptr, const char*>> nodes{
            { deframer, "out" },
            { deinterleaver, "out" },
            { viterbi_decoder, "out" },
            { make_ccsds_descrambler(), "out" },
            { gr::satellites::decode_rs::make(0, short_frames ? 1 : 2), "out" }
        };
        if (crc)
            nodes.push_back({ crc16_arc(true, false), "ok" });
        msg_chain(nodes);
    }
};

// components/deframers/aalto1_deframer.py
class Aalto1Deframer : public DeframerHier
{
public:
    using sptr = std::shared_ptr<Aalto1Deframer>;
    static sptr make(int syncword_threshold)
    {
        return gnuradio::make_block_sptr<Aalto1Deframer>(syncword_threshold);
    }

    explicit Aalto1Deframer(int syncword_threshold) : DeframerHier("aalto1_deframer")
    {
        auto deframer = make_sync_to_pdu_packed(
            258, "00110101001011100011010100101110", syncword_threshold);
        stream_from_self({ gr::digital::binary_slicer_fb::make(), deframer });
        msg_chain({ { deframer, "out" },
                    { make_pn9_scrambler(), "out" },
                    { make_cc11xx_packet_crop(true), "out" },
                    { crc16_ccitt_x25(), "ok" },
                    { gr::satellites::pdu_head_tail::make(3, 1), "out" } });
    }
};

// components/deframers/reaktor_hello_world_deframer.py (also light1_deframer)
class ReaktorHelloWorldDeframer : public DeframerHier
{
public:
    using sptr = std::shared_ptr<ReaktorHelloWorldDeframer>;
    static sptr make(int syncword_threshold, const std::string& syncword)
    {
        return gnuradio::make_block_sptr<ReaktorHelloWorldDeframer>(
            syncword_threshold, syncword);
    }

    ReaktorHelloWorldDeframer(int syncword_threshold, const std::string& syncword)
        : DeframerHier("reaktor_hello_world_deframer")
    {
        auto deframer = make_sync_to_pdu_packed(258, syncword, syncword_threshold);
        stream_from_self({ gr::digital::binary_slicer_fb::make(), deframer });
        msg_chain({ { deframer, "out" },
                    { make_pn9_scrambler(), "out" },
                    { make_cc11xx_packet_crop(true), "out" },
                    { crc16_cc11xx(), "ok" },
                    { gr::satellites::pdu_head_tail::make(3, 1), "out" } });
    }
};

// components/deframers/binar1_deframer.py and endurosat_deframer.py -- the same
// CC11xx-style framing with a CRC-16 CCITT FALSE.
class Cc11xxCcittFalseDeframer : public DeframerHier
{
public:
    using sptr = std::shared_ptr<Cc11xxCcittFalseDeframer>;
    static sptr make(const char* name, const char* syncword, int syncword_threshold)
    {
        return gnuradio::make_block_sptr<Cc11xxCcittFalseDeframer>(
            name, syncword, syncword_threshold);
    }

    Cc11xxCcittFalseDeframer(const char* name,
                             const char* syncword,
                             int syncword_threshold)
        : DeframerHier(name)
    {
        auto deframer = make_sync_to_pdu_packed(258, syncword, syncword_threshold);
        stream_from_self({ gr::digital::binary_slicer_fb::make(), deframer });
        msg_chain({ { deframer, "out" },
                    { make_cc11xx_packet_crop(true), "out" },
                    { crc16_ccitt_false(), "ok" } });
    }
};

// components/deframers/binar2_deframer.py
class Binar2Deframer : public DeframerHier
{
public:
    using sptr = std::shared_ptr<Binar2Deframer>;
    static sptr make(int syncword_threshold)
    {
        return gnuradio::make_block_sptr<Binar2Deframer>(syncword_threshold);
    }

    explicit Binar2Deframer(int syncword_threshold) : DeframerHier("binar2_deframer")
    {
        auto sync = make_sync_to_pdu_packed(
            258, "11010011100100011101001110010001", syncword_threshold);
        stream_from_self({ gr::digital::binary_slicer_fb::make(), sync });
        msg_chain({ { sync, "out" },
                    { make_sx12xx_packet_crop(2), "out" },
                    { crc16_cc11xx(), "ok" },
                    { gr::satellites::pdu_head_tail::make(3, 1), "out" } });
    }
};

// components/deframers/geoscan_deframer.py
class GeoscanDeframer : public DeframerHier
{
public:
    using sptr = std::shared_ptr<GeoscanDeframer>;
    static sptr make(int frame_size, int syncword_threshold)
    {
        return gnuradio::make_block_sptr<GeoscanDeframer>(frame_size,
                                                          syncword_threshold);
    }

    GeoscanDeframer(int frame_size, int syncword_threshold)
        : DeframerHier("geoscan_deframer")
    {
        auto deframer = make_sync_to_pdu_packed(
            frame_size, "10010011000010110101000111011110", syncword_threshold);
        stream_from_self({ gr::digital::binary_slicer_fb::make(), deframer });
        msg_chain({ { deframer, "out" },
                    { make_pn9_scrambler(), "out" },
                    { crc16_cc11xx(), "ok" } });
    }
};

// components/deframers/lucky7_deframer.py
class Lucky7Deframer : public DeframerHier
{
public:
    using sptr = std::shared_ptr<Lucky7Deframer>;
    static sptr make(int syncword_threshold)
    {
        return gnuradio::make_block_sptr<Lucky7Deframer>(syncword_threshold);
    }

    explicit Lucky7Deframer(int syncword_threshold) : DeframerHier("lucky7_deframer")
    {
        auto deframer =
            make_sync_to_pdu(37 * 8, "0010110111010100", syncword_threshold);
        stream_from_self({ gr::digital::binary_slicer_fb::make(), deframer });
        msg_chain({ { deframer, "out" },
                    { make_si4463_scrambler(), "out" },
                    { crc16_cc11xx(), "ok" } });
    }
};

// components/deframers/nusat_deframer.py
class NusatDeframer : public DeframerHier
{
public:
    using sptr = std::shared_ptr<NusatDeframer>;
    static sptr make(int syncword_threshold)
    {
        return gnuradio::make_block_sptr<NusatDeframer>(syncword_threshold);
    }

    explicit NusatDeframer(int syncword_threshold) : DeframerHier("nusat_deframer")
    {
        auto deframer = make_sync_to_pdu_packed(
            64, "00000001111001011010101011001100", syncword_threshold);
        stream_from_self({ gr::digital::binary_slicer_fb::make(), deframer });
        msg_chain({ { deframer, "out" },
                    { gr::satellites::nusat_decoder::make(), "out" } });
    }
};

// components/deframers/astrocast_fx25_deframer.py
class AstrocastFx25Deframer : public DeframerHier
{
public:
    using sptr = std::shared_ptr<AstrocastFx25Deframer>;
    static sptr make(int syncword_threshold, bool nrzi)
    {
        return gnuradio::make_block_sptr<AstrocastFx25Deframer>(syncword_threshold,
                                                                nrzi);
    }

    AstrocastFx25Deframer(int syncword_threshold, bool nrzi)
        : DeframerHier("astrocast_fx25_deframer")
    {
        std::vector<gr::basic_block_sptr> blocks{
            gr::digital::binary_slicer_fb::make()
        };
        if (nrzi)
            blocks.push_back(gr::satellites::nrzi_decode::make());
        auto deframer = make_sync_to_pdu_packed(
            255,
            "0111010111111010110000011010001101011000110100000110010001110110",
            syncword_threshold);
        blocks.push_back(deframer);
        stream_from_self(blocks);
        msg_chain({ { deframer, "out" },
                    { make_reflect_bytes(), "out" },
                    { gr::satellites::decode_rs::make(1, 1), "out" },
                    { make_check_astrocast_crc(false), "ok" } });
    }
};

// components/deframers/fossasat_deframer.py
class FossasatDeframer : public DeframerHier
{
public:
    using sptr = std::shared_ptr<FossasatDeframer>;
    static sptr make(int syncword_threshold)
    {
        return gnuradio::make_block_sptr<FossasatDeframer>(syncword_threshold);
    }

    explicit FossasatDeframer(int syncword_threshold)
        : DeframerHier("fossasat_deframer")
    {
        auto sync = make_sync_to_pdu_packed(
            258, "01010101010101010001001000010010", syncword_threshold);
        stream_from_self({ gr::digital::binary_slicer_fb::make(), sync });
        msg_chain({ { sync, "out" },
                    { make_reflect_bytes(), "out" },
                    { make_pn9_scrambler(), "out" },
                    { make_reflect_bytes(), "out" },
                    { make_sx12xx_packet_crop(2), "out" },
                    { gr::satellites::crc_check::make(
                          16, 0x1021, 0x1D0F, 0xFFFF, false, false, false, true),
                      "ok" },
                    { gr::satellites::pdu_head_tail::make(3, 1), "out" } });
    }
};

// components/deframers/grizu263a_deframer.py
class Grizu263aDeframer : public DeframerHier
{
public:
    using sptr = std::shared_ptr<Grizu263aDeframer>;
    static sptr make(int syncword_threshold)
    {
        return gnuradio::make_block_sptr<Grizu263aDeframer>(syncword_threshold);
    }

    explicit Grizu263aDeframer(int syncword_threshold)
        : DeframerHier("grizu263a_deframer")
    {
        auto sync = make_sync_to_pdu_packed(
            258,
            "0000000100100011010001010110011110001001101010111100110111101111",
            syncword_threshold);
        stream_from_self({ gr::digital::binary_slicer_fb::make(), sync });

        // This descrambler runs on packed bytes, so the PDU makes a round trip
        // through a tagged stream rather than using the unpacked adapter.
        auto pdu2stream =
            gr::pdu::pdu_to_tagged_stream::make(gr::types::byte_t, "packet_len");
        auto scrambler = gr::digital::additive_scrambler_bb::make(
            0x21, 0x100, 8, 0, 8, "packet_len");
        auto stream2pdu =
            gr::pdu::tagged_stream_to_pdu::make(gr::types::byte_t, "packet_len");
        chain({ pdu2stream, scrambler, stream2pdu });

        auto reflect_1 = make_reflect_bytes();
        msg_connect(sync, "out", reflect_1, "in");
        msg_connect(reflect_1, "out", pdu2stream, "pdus");
        msg_chain({ { stream2pdu, "pdus" },
                    { make_reflect_bytes(), "out" },
                    { make_sx12xx_packet_crop(2), "out" },
                    { crc16_cc11xx(), "ok" },
                    { gr::satellites::pdu_head_tail::make(3, 1), "out" } });
    }
};

// components/deframers/smogp_signalling_deframer.py
class SmogpSignallingDeframer : public DeframerHier
{
public:
    using sptr = std::shared_ptr<SmogpSignallingDeframer>;
    static sptr make(bool new_protocol, int syncword_threshold)
    {
        return gnuradio::make_block_sptr<SmogpSignallingDeframer>(
            new_protocol, syncword_threshold);
    }

    SmogpSignallingDeframer(bool new_protocol, int syncword_threshold)
        : DeframerHier("smogp_signalling_deframer")
    {
        static constexpr const char* kSyncword =
            "0010110111010100100101111111110111010011011110110000111100011111";
        static constexpr const char* kSyncwordTx =
            "0010110111010100101000111001111000011010010101010110101111001011";

        auto slicer = gr::digital::binary_slicer_fb::make();
        auto deframer = make_sync_to_pdu_packed(64, kSyncword, syncword_threshold);
        stream_from_self({ slicer, deframer });
        msg_connect(deframer, "out", self(), "out");
        if (new_protocol) {
            auto deframer_tx =
                make_sync_to_pdu_packed(64, kSyncwordTx, syncword_threshold);
            connect(slicer, 0, deframer_tx, 0);
            msg_connect(deframer_tx, "out", self(), "out");
        }
    }
};

// components/deframers/lilacsat_1_deframer.py -- also publishes Codec2 voice
// frames on a second hierarchy port.
class Lilacsat1Deframer : public DeframerHier
{
public:
    using sptr = std::shared_ptr<Lilacsat1Deframer>;
    static sptr make(int syncword_threshold)
    {
        return gnuradio::make_block_sptr<Lilacsat1Deframer>(syncword_threshold);
    }

    explicit Lilacsat1Deframer(int syncword_threshold)
        : DeframerHier("lilacsat_1_deframer")
    {
        message_port_register_hier_out(pmt::mp("codec2"));
        for (int branch = 0; branch < 2; ++branch) {
            auto viterbi = make_ccsds_viterbi("CCSDS");
            auto differential = gr::digital::diff_decoder_bb::make(2);
            auto tag = gr::digital::correlate_access_code_tag_bb::make(
                kCcsdsSyncword, syncword_threshold, "syncword");
            auto scrambler = gr::digital::additive_scrambler_bb::make(
                0xA9, 0xFF, 7, 0, 1, "syncword");
            auto demux = gr::satellites::lilacsat1_demux::make("syncword");
            if (branch == 0) {
                connect(self(), 0, viterbi, 0);
            } else {
                auto delay = gr::blocks::delay::make(sizeof(float), 1);
                connect(self(), 0, delay, 0);
                connect(delay, 0, viterbi, 0);
            }
            chain({ viterbi, differential, tag, scrambler, demux });
            msg_connect(demux, "frame", self(), "out");
            msg_connect(demux, "codec2", self(), "codec2");
        }
    }
};

// components/deframers/ngham_deframer.py
class NghamDeframer : public DeframerHier
{
public:
    using sptr = std::shared_ptr<NghamDeframer>;
    static sptr make(bool decode_rs, int syncword_threshold)
    {
        return gnuradio::make_block_sptr<NghamDeframer>(decode_rs,
                                                        syncword_threshold);
    }

    NghamDeframer(bool decode_rs, int syncword_threshold)
        : DeframerHier("ngham_deframer")
    {
        if (decode_rs)
            throw std::runtime_error(
                "NGHam Reed-Solomon decoding not implemented yet");

        auto deframer = make_sync_to_pdu_packed(
            255 + 3, "01011101111001100010101001111110", syncword_threshold);
        stream_from_self({ gr::digital::binary_slicer_fb::make(), deframer });

        auto crop = make_ngham_packet_crop();
        auto unpacker = make_unpacker();
        msg_connect(deframer, "out", crop, "in");
        // Both RS variants feed the same unpack path.
        msg_connect(crop, "rs16", unpacker.in, "pdus");
        msg_connect(crop, "rs32", unpacker.in, "pdus");
        msg_chain({ { unpacker.out, "pdus" },
                    { make_ccsds_descrambler(), "out" },
                    { make_ngham_remove_padding(), "out" },
                    { crc16_ccitt_x25(false), "ok" } });
    }
};

// components/deframers/qubik_deframer.py
class QubikDeframer : public DeframerHier
{
public:
    using sptr = std::shared_ptr<QubikDeframer>;
    static sptr make(int syncword_threshold)
    {
        return gnuradio::make_block_sptr<QubikDeframer>(syncword_threshold);
    }

    explicit QubikDeframer(int syncword_threshold) : DeframerHier("qubik_deframer")
    {
        auto deframer = make_sync_to_pdu_packed(
            128 + 32 + 4, "00111100011001110100100101010010", syncword_threshold);
        stream_from_self({ gr::digital::binary_slicer_fb::make(), deframer });

        // Qubik unpacks with unpack_k_bits rather than packed_to_unpacked.
        auto pdu2tag =
            gr::pdu::pdu_to_tagged_stream::make(gr::types::byte_t, "packet_len");
        auto unpack = gr::blocks::unpack_k_bits_bb::make(8);
        auto multiply_length = gr::blocks::tagged_stream_multiply_length::make(
            sizeof(char), "packet_len", 8.0);
        auto tag2pdu =
            gr::pdu::tagged_stream_to_pdu::make(gr::types::byte_t, "packet_len");
        chain({ pdu2tag, unpack, multiply_length, tag2pdu });

        auto rs = gr::satellites::decode_rs::make(0, 1);
        msg_connect(deframer, "out", rs, "in");
        msg_connect(rs, "out", pdu2tag, "pdus");
        msg_chain({ { tag2pdu, "pdus" },
                    { make_ccsds_descrambler(), "out" },
                    { crc32c(), "ok" },
                    { crc16_ccitt_false(), "ok" } });
    }
};

// components/deframers/sat_3cat_1_deframer.py
class Sat3cat1Deframer : public DeframerHier
{
public:
    using sptr = std::shared_ptr<Sat3cat1Deframer>;
    static sptr make(int syncword_threshold)
    {
        return gnuradio::make_block_sptr<Sat3cat1Deframer>(syncword_threshold);
    }

    explicit Sat3cat1Deframer(int syncword_threshold)
        : DeframerHier("sat_3cat_1_deframer")
    {
        auto deframer = make_sync_to_pdu_packed(
            255, "11010011100100011101001110010001", syncword_threshold);
        stream_from_self({ gr::digital::binary_slicer_fb::make(), deframer });
        msg_chain(
            { { deframer, "out" },
              { make_pn9_scrambler(), "out" },
              { gr::satellites::decode_rs::make(8, 0x11d, 1, 1, 32, 1), "out" } });
    }
};

// components/deframers/tt64_deframer.py
class Tt64Deframer : public DeframerHier
{
public:
    using sptr = std::shared_ptr<Tt64Deframer>;
    static sptr make(int syncword_threshold)
    {
        return gnuradio::make_block_sptr<Tt64Deframer>(syncword_threshold);
    }

    explicit Tt64Deframer(int syncword_threshold) : DeframerHier("tt64_deframer")
    {
        auto deframer =
            make_sync_to_pdu_packed(64, "0010110111010100", syncword_threshold);
        stream_from_self({ gr::digital::binary_slicer_fb::make(), deframer });
        msg_chain(
            { { deframer, "out" },
              { gr::satellites::decode_rs::make(8, 0x11d, 1, 1, 16, 1), "out" },
              { crc16_arc(), "ok" } });
    }
};

// components/deframers/swiatowid_deframer.py
class SwiatowidDeframer : public DeframerHier
{
public:
    using sptr = std::shared_ptr<SwiatowidDeframer>;
    static sptr make(int syncword_threshold)
    {
        return gnuradio::make_block_sptr<SwiatowidDeframer>(syncword_threshold);
    }

    explicit SwiatowidDeframer(int syncword_threshold)
        : DeframerHier("swiatowid_deframer")
    {
        auto deframer = make_sync_to_pdu_packed(
            8200, "01011011010110111101110111011101", syncword_threshold);
        stream_from_self({ gr::digital::binary_slicer_fb::make(), deframer });
        msg_chain(
            { { deframer, "out" },
              { make_reflect_bytes(), "out" },
              { make_swiatowid_packet_crop(), "out" },
              { make_swiatowid_packet_split(), "out" },
              { gr::satellites::decode_rs::make(8, 0x11d, 0, 1, 10, 1), "out" } });
    }
};

// components/deframers/ops_sat_deframer.py
class OpsSatDeframer : public DeframerHier
{
public:
    using sptr = std::shared_ptr<OpsSatDeframer>;
    static sptr make() { return gnuradio::make_block_sptr<OpsSatDeframer>(); }

    OpsSatDeframer() : DeframerHier("ops_sat_deframer")
    {
        // The HDLC CRC-16 check is deliberately skipped here; OPS-SAT's frames
        // carry a Reed-Solomon code instead.
        auto deframer = HdlcDeframer::make(false, 10000);
        stream_from_self({ gr::digital::binary_slicer_fb::make(),
                           gr::satellites::nrzi_decode::make(),
                           gr::digital::descrambler_bb::make(0x21, 0, 16),
                           deframer });

        auto pdu2tag =
            gr::pdu::pdu_to_tagged_stream::make(gr::types::byte_t, "packet_len");
        auto unpack =
            gr::blocks::packed_to_unpacked_bb::make(1, gr::GR_MSB_FIRST);
        auto scramble = gr::digital::additive_scrambler_bb::make(
            0xA9, 0xFF, 7, 0, 1, "packet_len");
        auto pack = gr::blocks::unpacked_to_packed_bb::make(1, gr::GR_MSB_FIRST);
        auto tag2pdu =
            gr::pdu::tagged_stream_to_pdu::make(gr::types::byte_t, "packet_len");
        chain({ pdu2tag, unpack, scramble, pack, tag2pdu });

        auto strip = gr::satellites::pdu_head_tail::make(3, 16);
        msg_connect(deframer, "out", strip, "in");
        msg_connect(strip, "out", pdu2tag, "pdus");
        msg_chain({ { tag2pdu, "pdus" },
                    { gr::satellites::pdu_length_filter::make(33, 255), "out" },
                    { gr::satellites::decode_rs::make(0, 1), "out" } });
    }
};

} // namespace

gr::basic_block_sptr make_hdlc_deframer(bool check_fcs, int max_length)
{
    return HdlcDeframer::make(check_fcs, max_length);
}

gr::basic_block_sptr make_ax25_deframer(bool g3ruh_scrambler)
{
    return Ax25Deframer::make(g3ruh_scrambler);
}

gr::basic_block_sptr make_ua01_deframer() { return Ua01Deframer::make(); }

gr::basic_block_sptr make_ax100_deframer(const std::string& mode,
                                         const std::string& scrambler,
                                         int syncword_threshold,
                                         const std::string& syncword)
{
    return Ax100Deframer::make(mode, scrambler, syncword_threshold, syncword);
}

gr::basic_block_sptr make_u482c_deframer(int syncword_threshold)
{
    return U482cDeframer::make(syncword_threshold);
}

gr::basic_block_sptr make_ccsds_rs_deframer(int frame_size,
                                            const std::string& precoding,
                                            bool rs_en,
                                            const std::string& rs_basis,
                                            int rs_interleaving,
                                            const std::string& scrambler,
                                            int syncword_threshold)
{
    return CcsdsRsDeframer::make(frame_size,
                                 precoding,
                                 rs_en,
                                 rs_basis,
                                 rs_interleaving,
                                 scrambler,
                                 syncword_threshold);
}

gr::basic_block_sptr
make_ccsds_concatenated_deframer(int frame_size,
                                 const std::string& precoding,
                                 bool rs_en,
                                 const std::string& rs_basis,
                                 int rs_interleaving,
                                 const std::string& scrambler,
                                 int syncword_threshold,
                                 const std::string& convolutional)
{
    return CcsdsConcatenatedDeframer::make(frame_size,
                                           precoding,
                                           rs_en,
                                           rs_basis,
                                           rs_interleaving,
                                           scrambler,
                                           syncword_threshold,
                                           convolutional);
}

gr::basic_block_sptr make_aistechsat_2_deframer(int syncword_threshold)
{
    return Aistechsat2Deframer::make(syncword_threshold);
}

gr::basic_block_sptr make_ao40_uncoded_deframer(int syncword_threshold)
{
    return Ao40UncodedDeframer::make(syncword_threshold);
}

gr::basic_block_sptr
make_ao40_fec_deframer(int syncword_threshold, bool short_frames, bool crc)
{
    return Ao40FecDeframer::make(syncword_threshold, short_frames, crc);
}

gr::basic_block_sptr make_aalto1_deframer(int syncword_threshold)
{
    return Aalto1Deframer::make(syncword_threshold);
}

gr::basic_block_sptr
make_reaktor_hello_world_deframer(int syncword_threshold, const std::string& syncword)
{
    return ReaktorHelloWorldDeframer::make(syncword_threshold, syncword);
}

gr::basic_block_sptr make_binar1_deframer(int syncword_threshold)
{
    return Cc11xxCcittFalseDeframer::make(
        "binar1_deframer", "1010101001111110", syncword_threshold);
}

gr::basic_block_sptr make_endurosat_deframer(int syncword_threshold)
{
    return Cc11xxCcittFalseDeframer::make(
        "endurosat_deframer", "1010101001111110", syncword_threshold);
}

gr::basic_block_sptr make_binar2_deframer(int syncword_threshold)
{
    return Binar2Deframer::make(syncword_threshold);
}

gr::basic_block_sptr make_geoscan_deframer(int frame_size, int syncword_threshold)
{
    return GeoscanDeframer::make(frame_size, syncword_threshold);
}

gr::basic_block_sptr make_lucky7_deframer(int syncword_threshold)
{
    return Lucky7Deframer::make(syncword_threshold);
}

gr::basic_block_sptr make_nusat_deframer(int syncword_threshold)
{
    return NusatDeframer::make(syncword_threshold);
}

gr::basic_block_sptr make_astrocast_fx25_deframer(int syncword_threshold, bool nrzi)
{
    return AstrocastFx25Deframer::make(syncword_threshold, nrzi);
}

gr::basic_block_sptr make_fossasat_deframer(int syncword_threshold)
{
    return FossasatDeframer::make(syncword_threshold);
}

gr::basic_block_sptr make_grizu263a_deframer(int syncword_threshold)
{
    return Grizu263aDeframer::make(syncword_threshold);
}

gr::basic_block_sptr make_smogp_signalling_deframer(bool new_protocol,
                                                    int syncword_threshold)
{
    return SmogpSignallingDeframer::make(new_protocol, syncword_threshold);
}

gr::basic_block_sptr make_lilacsat_1_deframer(int syncword_threshold)
{
    return Lilacsat1Deframer::make(syncword_threshold);
}

gr::basic_block_sptr make_ngham_deframer(bool decode_rs, int syncword_threshold)
{
    return NghamDeframer::make(decode_rs, syncword_threshold);
}

gr::basic_block_sptr make_qubik_deframer(int syncword_threshold)
{
    return QubikDeframer::make(syncword_threshold);
}

gr::basic_block_sptr make_sat_3cat_1_deframer(int syncword_threshold)
{
    return Sat3cat1Deframer::make(syncword_threshold);
}

gr::basic_block_sptr make_tt64_deframer(int syncword_threshold)
{
    return Tt64Deframer::make(syncword_threshold);
}

gr::basic_block_sptr make_swiatowid_deframer(int syncword_threshold)
{
    return SwiatowidDeframer::make(syncword_threshold);
}

gr::basic_block_sptr make_ops_sat_deframer() { return OpsSatDeframer::make(); }

} // namespace wasm_satellites
