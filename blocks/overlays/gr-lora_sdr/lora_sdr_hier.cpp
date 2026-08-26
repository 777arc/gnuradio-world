// C++ rebuilds of gr-lora_sdr's Python hierarchies. Each class mirrors the block
// set and connection order of the file named above it, so a diff against the
// Python stays readable.
// SPDX-License-Identifier: GPL-3.0-or-later
#include "lora_sdr_hier.hpp"

#include <gnuradio/hier_block2.h>
#include <gnuradio/io_signature.h>
#include <gnuradio/lora_sdr/add_crc.h>
#include <gnuradio/lora_sdr/crc_verif.h>
#include <gnuradio/lora_sdr/deinterleaver.h>
#include <gnuradio/lora_sdr/dewhitening.h>
#include <gnuradio/lora_sdr/fft_demod.h>
#include <gnuradio/lora_sdr/frame_sync.h>
#include <gnuradio/lora_sdr/gray_demap.h>
#include <gnuradio/lora_sdr/gray_mapping.h>
#include <gnuradio/lora_sdr/hamming_dec.h>
#include <gnuradio/lora_sdr/hamming_enc.h>
#include <gnuradio/lora_sdr/header.h>
#include <gnuradio/lora_sdr/header_decoder.h>
#include <gnuradio/lora_sdr/interleaver.h>
#include <gnuradio/lora_sdr/modulate.h>
#include <gnuradio/lora_sdr/whitening.h>
#include <pmt/pmt.h>

#include <algorithm>
#include <cctype>
#include <string>
#include <utility>
#include <vector>

namespace wasm_lora_sdr {
namespace {

// Values the Python hierarchies hard-code rather than take as GRC parameters.
constexpr int kPreambleLen = 8;              // modulate()/frame_sync() preamble
constexpr std::uint32_t kCenterFreq = 868100000; // lora_sdr_lora_rx.py's default
constexpr bool kMaxLogApprox = true;         // fft_demod(soft_decoding, True)
constexpr bool kOutputCrcCheck = false;      // crc_verif(print_payload, False)
constexpr bool kTxIsHex = false;             // whitening(False, False, ...)
constexpr bool kTxUseLengthTag = false;
constexpr char kTxSeparator = ',';
constexpr const char* kTxLengthTag = "packet_len";

// The GRC `print_rx` parameter is a two-element Python list literal spelled
// `[True,True]` / `[False,True]` / ... . The editor evaluates numeric and
// vector parameters before the runner sees them but leaves an enum's symbolic
// value alone, so it arrives as that text and is parsed here. Anything
// unrecognised keeps upstream's default of printing both.
std::pair<bool, bool> parse_print_rx(const std::string& value)
{
    std::string text;
    for (char c : value)
        if (!std::isspace(static_cast<unsigned char>(c)))
            text.push_back(c);
    const auto comma = text.find(',');
    if (text.size() < 2 || text.front() != '[' || comma == std::string::npos)
        return { true, true };
    const std::string first = text.substr(1, comma - 1);
    std::string second = text.substr(comma + 1);
    if (!second.empty() && second.back() == ']')
        second.pop_back();
    return { first == "True" || first == "true", second == "True" || second == "true" };
}

// python/lora_sdr/lora_sdr_lora_tx.py
class LoraTx : public gr::hier_block2
{
public:
    LoraTx(int samp_rate,
           int bw,
           int sf,
           bool impl_head,
           int cr,
           bool has_crc,
           int ldro_mode,
           const std::vector<std::uint16_t>& sync_word,
           int frame_zero_padd)
        : gr::hier_block2("lora_sdr_lora_tx",
                          gr::io_signature::make(0, 0, 0),
                          gr::io_signature::make(1, 1, sizeof(gr_complex)))
    {
        message_port_register_hier_in(pmt::mp("in"));

        auto whitening = gr::lora_sdr::whitening::make(
            kTxIsHex, kTxUseLengthTag, kTxSeparator, kTxLengthTag);
        auto modulate = gr::lora_sdr::modulate::make(
            static_cast<std::uint8_t>(sf), static_cast<std::uint32_t>(samp_rate),
            static_cast<std::uint32_t>(bw), sync_word,
            static_cast<std::uint32_t>(frame_zero_padd),
            static_cast<std::uint16_t>(kPreambleLen));
        auto interleaver = gr::lora_sdr::interleaver::make(
            static_cast<std::uint8_t>(cr), static_cast<std::uint8_t>(sf),
            static_cast<std::uint8_t>(ldro_mode), bw);
        auto header = gr::lora_sdr::header::make(
            impl_head, has_crc, static_cast<std::uint8_t>(cr));
        auto hamming_enc = gr::lora_sdr::hamming_enc::make(
            static_cast<std::uint8_t>(cr), static_cast<std::uint8_t>(sf));
        auto gray_demap = gr::lora_sdr::gray_demap::make(static_cast<std::uint8_t>(sf));
        auto add_crc = gr::lora_sdr::add_crc::make(has_crc);

        msg_connect(self(), "in", whitening, "msg");
        connect(add_crc, 0, hamming_enc, 0);
        connect(gray_demap, 0, modulate, 0);
        connect(hamming_enc, 0, interleaver, 0);
        connect(header, 0, add_crc, 0);
        connect(interleaver, 0, gray_demap, 0);
        connect(modulate, 0, self(), 0);
        connect(whitening, 0, header, 0);
    }
};

// python/lora_sdr/lora_sdr_lora_rx.py
class LoraRx : public gr::hier_block2
{
public:
    LoraRx(int samp_rate,
           int bw,
           int sf,
           bool impl_head,
           int cr,
           bool has_crc,
           int pay_len,
           bool soft_decoding,
           int ldro_mode,
           const std::vector<std::uint16_t>& sync_word,
           const std::string& print_rx)
        : gr::hier_block2("lora_sdr_lora_rx",
                          gr::io_signature::make(1, 1, sizeof(gr_complex)),
                          gr::io_signature::make(1, 1, sizeof(char)))
    {
        message_port_register_hier_out(pmt::mp("out"));

        const auto printing = parse_print_rx(print_rx);
        const bool print_header = printing.first;
        const bool print_payload = printing.second;
        // Python takes int(samp_rate/bw); the GRC block asserts the ratio is
        // whole, and a zero would divide by zero inside frame_sync.
        const int os_factor = bw > 0 ? std::max(1, samp_rate / bw) : 1;

        auto header_decoder = gr::lora_sdr::header_decoder::make(
            impl_head, static_cast<std::uint8_t>(cr),
            static_cast<std::uint32_t>(pay_len), has_crc,
            static_cast<std::uint8_t>(ldro_mode), print_header);
        auto hamming_dec = gr::lora_sdr::hamming_dec::make(soft_decoding);
        auto gray_mapping = gr::lora_sdr::gray_mapping::make(soft_decoding);
        auto frame_sync = gr::lora_sdr::frame_sync::make(
            kCenterFreq, static_cast<std::uint32_t>(bw),
            static_cast<std::uint8_t>(sf), impl_head, sync_word,
            static_cast<std::uint8_t>(os_factor),
            static_cast<std::uint16_t>(kPreambleLen));
        auto fft_demod = gr::lora_sdr::fft_demod::make(soft_decoding, kMaxLogApprox);
        auto dewhitening = gr::lora_sdr::dewhitening::make();
        auto deinterleaver = gr::lora_sdr::deinterleaver::make(soft_decoding);
        auto crc_verif = gr::lora_sdr::crc_verif::make(print_payload ? 1 : 0,
                                                       kOutputCrcCheck);

        msg_connect(crc_verif, "msg", self(), "out");
        msg_connect(header_decoder, "frame_info", frame_sync, "frame_info");
        connect(crc_verif, 0, self(), 0);
        connect(deinterleaver, 0, hamming_dec, 0);
        connect(dewhitening, 0, crc_verif, 0);
        connect(fft_demod, 0, gray_mapping, 0);
        connect(frame_sync, 0, fft_demod, 0);
        connect(gray_mapping, 0, deinterleaver, 0);
        connect(hamming_dec, 0, header_decoder, 0);
        connect(header_decoder, 0, dewhitening, 0);
        connect(self(), 0, frame_sync, 0);
    }
};

} // namespace

gr::basic_block_sptr make_lora_tx(int samp_rate,
                                  int bw,
                                  int sf,
                                  bool impl_head,
                                  int cr,
                                  bool has_crc,
                                  int ldro_mode,
                                  const std::vector<std::uint16_t>& sync_word,
                                  int frame_zero_padd)
{
    return gnuradio::make_block_sptr<LoraTx>(samp_rate, bw, sf, impl_head, cr, has_crc,
                                             ldro_mode, sync_word, frame_zero_padd);
}

gr::basic_block_sptr make_lora_rx(int samp_rate,
                                  int bw,
                                  int sf,
                                  bool impl_head,
                                  int cr,
                                  bool has_crc,
                                  int pay_len,
                                  bool soft_decoding,
                                  int ldro_mode,
                                  const std::vector<std::uint16_t>& sync_word,
                                  const std::string& print_rx)
{
    return gnuradio::make_block_sptr<LoraRx>(samp_rate, bw, sf, impl_head, cr, has_crc,
                                             pay_len, soft_decoding, ldro_mode,
                                             sync_word, print_rx);
}

} // namespace wasm_lora_sdr
