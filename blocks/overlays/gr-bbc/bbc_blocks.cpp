// Browser-native C++ ports of gr-bbc's four pure-Python blocks.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// The codec below mirrors python/bbc/{glowworm,codec}.py, including its
// deliberately 32-bit inversion mask, LSB-first message bits, checksum modes,
// bounded depth-first search, and one-to-many decoder output queue. The OOK
// hierarchies mirror python/bbc/{OOKModulator,OOKDemodulator}.py block for block.

#include "bbc_blocks.hpp"

#include <gnuradio/analog/sig_source.h>
#include <gnuradio/block.h>
#include <gnuradio/blocks/complex_to_mag_squared.h>
#include <gnuradio/blocks/float_to_char.h>
#include <gnuradio/blocks/float_to_complex.h>
#include <gnuradio/blocks/keep_one_in_n.h>
#include <gnuradio/blocks/multiply.h>
#include <gnuradio/blocks/repeat.h>
#include <gnuradio/blocks/skiphead.h>
#include <gnuradio/blocks/threshold_ff.h>
#include <gnuradio/blocks/uchar_to_float.h>
#include <gnuradio/blocks/unpack_k_bits_bb.h>
#include <gnuradio/blocks/unpacked_to_packed.h>
#include <gnuradio/fft/window.h>
#include <gnuradio/filter/fir_filter_blk.h>
#include <gnuradio/filter/firdes.h>
#include <gnuradio/hier_block2.h>
#include <gnuradio/io_signature.h>
#include <gnuradio/sptr_magic.h>
#include <gnuradio/sync_block.h>
#include <pmt/pmt.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <cstring>
#include <deque>
#include <iostream>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace wasm_bbc {
namespace {

constexpr std::uint64_t kInvertMask = UINT64_C(0xffffffff);
constexpr std::uint64_t kCheckValue = UINT64_C(0xcca4220fc78d45e0);

class Glowworm
{
public:
    Glowworm()
    {
        d_state.fill(0);
        std::uint64_t hash = 1;
        for (int i = 0; i < 4096; ++i)
            hash = add_bit((hash & 1) != 0);
        if (hash != kCheckValue)
            throw std::runtime_error("BBC glowworm conformance self-test failed");
        d_n = 0;
        d_initial = d_state;
    }

    void reset()
    {
        d_state = d_initial;
        d_n = 0;
    }

    std::uint64_t add_bit(bool bit)
    {
        std::uint64_t value = d_state[d_n % d_state.size()] ^ (bit ? kInvertMask : 0);
        value = (value | (value >> 1)) ^ (value << 1);
        value ^= (value >> 4) ^ (value >> 8) ^ (value >> 16) ^ (value >> 32);
        ++d_n;
        d_state[d_n % d_state.size()] ^= value;
        return d_state[d_n % d_state.size()];
    }

    void del_bit(bool bit)
    {
        --d_n;
        add_bit(bit);
        --d_n;
    }

private:
    std::array<std::uint64_t, 32> d_state{};
    std::array<std::uint64_t, 32> d_initial{};
    std::size_t d_n = 0;
};

// Small self-contained SHA-256 implementation for gr-bbc's legacy local
// checksum mode. The interoperable/default mode appends zero bits.
std::array<std::uint8_t, 32> sha256(const std::uint8_t* data, std::size_t size)
{
    static constexpr std::array<std::uint32_t, 64> constants = {
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
        0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
        0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
        0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
        0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
        0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
        0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
        0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
    };
    auto rotate = [](std::uint32_t value, unsigned shift) {
        return (value >> shift) | (value << (32 - shift));
    };
    std::array<std::uint32_t, 8> hash = { 0x6a09e667, 0xbb67ae85, 0x3c6ef372,
                                          0xa54ff53a, 0x510e527f, 0x9b05688c,
                                          0x1f83d9ab, 0x5be0cd19 };
    const std::uint64_t bit_size = static_cast<std::uint64_t>(size) * 8;
    const std::size_t padded_size = ((size + 9 + 63) / 64) * 64;
    std::vector<std::uint8_t> padded(padded_size, 0);
    std::copy(data, data + size, padded.begin());
    padded[size] = 0x80;
    for (int i = 0; i < 8; ++i)
        padded[padded_size - 1 - i] = static_cast<std::uint8_t>(bit_size >> (8 * i));

    for (std::size_t offset = 0; offset < padded_size; offset += 64) {
        std::array<std::uint32_t, 64> words{};
        for (int i = 0; i < 16; ++i) {
            const auto* p = padded.data() + offset + 4 * i;
            words[i] = (std::uint32_t(p[0]) << 24) | (std::uint32_t(p[1]) << 16) |
                       (std::uint32_t(p[2]) << 8) | std::uint32_t(p[3]);
        }
        for (int i = 16; i < 64; ++i) {
            const std::uint32_t s0 = rotate(words[i - 15], 7) ^
                                     rotate(words[i - 15], 18) ^ (words[i - 15] >> 3);
            const std::uint32_t s1 = rotate(words[i - 2], 17) ^
                                     rotate(words[i - 2], 19) ^ (words[i - 2] >> 10);
            words[i] = words[i - 16] + s0 + words[i - 7] + s1;
        }
        auto [a, b, c, d, e, f, g, h] = hash;
        for (int i = 0; i < 64; ++i) {
            const std::uint32_t s1 = rotate(e, 6) ^ rotate(e, 11) ^ rotate(e, 25);
            const std::uint32_t choose = (e & f) ^ (~e & g);
            const std::uint32_t t1 = h + s1 + choose + constants[i] + words[i];
            const std::uint32_t s0 = rotate(a, 2) ^ rotate(a, 13) ^ rotate(a, 22);
            const std::uint32_t majority = (a & b) ^ (a & c) ^ (b & c);
            const std::uint32_t t2 = s0 + majority;
            h = g;
            g = f;
            f = e;
            e = d + t1;
            d = c;
            c = b;
            b = a;
            a = t1 + t2;
        }
        hash[0] += a;
        hash[1] += b;
        hash[2] += c;
        hash[3] += d;
        hash[4] += e;
        hash[5] += f;
        hash[6] += g;
        hash[7] += h;
    }
    std::array<std::uint8_t, 32> digest{};
    for (int i = 0; i < 8; ++i)
        for (int j = 0; j < 4; ++j)
            digest[i * 4 + j] = static_cast<std::uint8_t>(hash[i] >> (24 - 8 * j));
    return digest;
}

class Codec
{
public:
    Codec(int message_length,
          int codeword_length,
          int checksum_length,
          std::string checksum_mode)
        : message_length(message_length),
          codeword_length(codeword_length),
          checksum_length(checksum_length),
          checksum_mode(std::move(checksum_mode)),
          message_bits(message_length * 8),
          codeword_bits(codeword_length * 8),
          total_bits(message_bits + checksum_length)
    {
        if (message_length <= 0 || codeword_length <= message_length)
            throw std::runtime_error("BBC codeword length must exceed positive message length");
        if (checksum_length < 0 || checksum_length > 256)
            throw std::runtime_error("BBC checksum length must be between 0 and 256 bits");
        if (this->checksum_mode != "zeros" && this->checksum_mode != "sha256")
            throw std::runtime_error("BBC checksum mode must be zeros or sha256");
    }

protected:
    std::vector<std::uint8_t> check_bits(const std::uint8_t* message) const
    {
        std::vector<std::uint8_t> result(checksum_length, 0);
        if (checksum_mode == "sha256") {
            const auto digest = sha256(message, message_length);
            for (int i = 0; i < checksum_length; ++i)
                result[i] = (digest[i >> 3] >> (i & 7)) & 1;
        }
        return result;
    }

    int message_length;
    int codeword_length;
    int checksum_length;
    std::string checksum_mode;
    int message_bits;
    int codeword_bits;
    int total_bits;
    Glowworm glowworm;
};

class Encoder : public Codec
{
public:
    using Codec::Codec;

    std::vector<std::uint8_t> encode(const std::uint8_t* message)
    {
        glowworm.reset();
        std::vector<std::uint8_t> codeword(codeword_length, 0);
        for (int i = 0; i < message_bits; ++i) {
            const bool bit = ((message[i >> 3] >> (i & 7)) & 1) != 0;
            const auto location = glowworm.add_bit(bit) % codeword_bits;
            codeword[location >> 3] |= std::uint8_t(1u << (location & 7));
        }
        for (const auto bit : check_bits(message)) {
            const auto location = glowworm.add_bit(bit != 0) % codeword_bits;
            codeword[location >> 3] |= std::uint8_t(1u << (location & 7));
        }
        return codeword;
    }
};

struct DecodeResult {
    std::vector<std::vector<std::uint8_t>> messages;
    bool truncated = false;
    int steps = 0;
};

class Decoder : public Codec
{
public:
    Decoder(int message_length,
            int codeword_length,
            int checksum_length,
            int max_candidates,
            int max_steps,
            std::string checksum_mode)
        : Codec(message_length, codeword_length, checksum_length, std::move(checksum_mode)),
          d_max_candidates(max_candidates),
          d_max_steps(max_steps)
    {
        if (max_candidates <= 0 || max_steps <= 0)
            throw std::runtime_error("BBC decoder search limits must be positive");
    }

    DecodeResult decode(const std::uint8_t* packet)
    {
        glowworm.reset();
        DecodeResult result;
        std::vector<std::uint8_t> candidate(
            message_length + (checksum_length + 7) / 8, 0);
        int n = 0;
        while (true) {
            if (++result.steps > d_max_steps) {
                result.truncated = true;
                break;
            }
            if (checksum_length && n == message_bits) {
                const auto bits = check_bits(candidate.data());
                for (int j = 0; j < checksum_length; ++j) {
                    const int index = message_bits + j;
                    if (bits[j])
                        candidate[index >> 3] |= std::uint8_t(1u << (index & 7));
                    else
                        candidate[index >> 3] &= std::uint8_t(~(1u << (index & 7)));
                }
            }
            const bool proposed = ((candidate[n >> 3] >> (n & 7)) & 1) != 0;
            const auto location = glowworm.add_bit(proposed) % codeword_bits;
            const bool present = ((packet[location >> 3] >> (location & 7)) & 1) != 0;
            if (present) {
                if (n < total_bits - 1) {
                    ++n;
                    if (n < message_bits)
                        candidate[n >> 3] &= std::uint8_t(~(1u << (n & 7)));
                    continue;
                }
                result.messages.emplace_back(candidate.begin(),
                                             candidate.begin() + message_length);
                if (static_cast<int>(result.messages.size()) >= d_max_candidates) {
                    result.truncated = true;
                    break;
                }
            }
            while (n >= message_bits) {
                glowworm.del_bit(((candidate[n >> 3] >> (n & 7)) & 1) != 0);
                --n;
            }
            while (n >= 0 && ((candidate[n >> 3] >> (n & 7)) & 1) != 0) {
                glowworm.del_bit(true);
                candidate[n >> 3] &= std::uint8_t(~(1u << (n & 7)));
                --n;
            }
            if (n < 0)
                break;
            glowworm.del_bit(false);
            candidate[n >> 3] |= std::uint8_t(1u << (n & 7));
        }
        if (result.truncated)
            glowworm.reset();
        return result;
    }

private:
    int d_max_candidates;
    int d_max_steps;
};

class EncoderBlock : public gr::sync_block
{
public:
    EncoderBlock(int message_length,
                 int codeword_length,
                 int checksum_length,
                 const std::string& checksum_mode)
        : gr::sync_block("bbc_encoder",
                         gr::io_signature::make(1, 1, message_length),
                         gr::io_signature::make(1, 1, codeword_length)),
          d_message_length(message_length),
          d_codeword_length(codeword_length),
          d_encoder(message_length, codeword_length, checksum_length, checksum_mode)
    {
    }

    int work(int noutput_items,
             gr_vector_const_void_star& input_items,
             gr_vector_void_star& output_items) override
    {
        const auto* input = static_cast<const std::uint8_t*>(input_items[0]);
        auto* output = static_cast<std::uint8_t*>(output_items[0]);
        for (int i = 0; i < noutput_items; ++i) {
            const auto codeword = d_encoder.encode(input + i * d_message_length);
            std::memcpy(output + i * d_codeword_length,
                        codeword.data(),
                        static_cast<std::size_t>(d_codeword_length));
        }
        return noutput_items;
    }

private:
    int d_message_length;
    int d_codeword_length;
    Encoder d_encoder;
};

class DecoderBlock : public gr::block
{
public:
    DecoderBlock(int message_length,
                 int codeword_length,
                 int checksum_length,
                 int max_candidates,
                 int max_steps,
                 const std::string& checksum_mode)
        : gr::block("bbc_decoder",
                    gr::io_signature::make(1, 1, codeword_length),
                    gr::io_signature::make(1, 1, message_length)),
          d_message_length(message_length),
          d_codeword_length(codeword_length),
          d_decoder(message_length,
                    codeword_length,
                    checksum_length,
                    max_candidates,
                    max_steps,
                    checksum_mode)
    {
        message_port_register_out(pmt::mp("decoded"));
    }

    void forecast(int, gr_vector_int& required) override
    {
        required[0] = d_pending.empty() ? 1 : 0;
    }

    int general_work(int noutput_items,
                     gr_vector_int& ninput_items,
                     gr_vector_const_void_star& input_items,
                     gr_vector_void_star& output_items) override
    {
        const auto* input = static_cast<const std::uint8_t*>(input_items[0]);
        auto* output = static_cast<std::uint8_t*>(output_items[0]);
        int consumed = 0;
        while (static_cast<int>(d_pending.size()) < noutput_items &&
               consumed < ninput_items[0]) {
            auto decoded = d_decoder.decode(input + consumed * d_codeword_length);
            if (decoded.truncated)
                std::cerr << "BBC decode truncated after " << decoded.steps << " steps and "
                          << decoded.messages.size()
                          << " candidates; the codeword is likely saturated with marks\n";
            for (auto& message : decoded.messages) {
                message_port_pub(
                    pmt::mp("decoded"),
                    pmt::cons(pmt::PMT_NIL,
                              pmt::init_u8vector(message.size(), message.data())));
                d_pending.push_back(std::move(message));
            }
            ++consumed;
        }
        consume(0, consumed);
        int produced = 0;
        while (produced < noutput_items && !d_pending.empty()) {
            std::memcpy(output + produced * d_message_length,
                        d_pending.front().data(),
                        static_cast<std::size_t>(d_message_length));
            d_pending.pop_front();
            ++produced;
        }
        return produced;
    }

private:
    int d_message_length;
    int d_codeword_length;
    Decoder d_decoder;
    std::deque<std::vector<std::uint8_t>> d_pending;
};

int samples_per_symbol(double samp_rate, double symbol_rate)
{
    if (symbol_rate <= 0 || samp_rate < symbol_rate)
        throw std::runtime_error("BBC OOK sample rate must be at least the positive symbol rate");
    return static_cast<int>(samp_rate / symbol_rate);
}

class OokModulator : public gr::hier_block2
{
public:
    OokModulator(double carrier_freq, double samp_rate, double symbol_rate)
        : gr::hier_block2("OOK Modulator",
                          gr::io_signature::make(1, 1, sizeof(std::uint8_t)),
                          gr::io_signature::make(1, 1, sizeof(gr_complex)))
    {
        if (std::abs(carrier_freq) >= samp_rate / 2)
            throw std::runtime_error("BBC OOK carrier offset must be below Nyquist");
        auto unpack = gr::blocks::unpack_k_bits_bb::make(8);
        auto to_float = gr::blocks::uchar_to_float::make();
        auto repeat = gr::blocks::repeat::make(sizeof(float),
                                               samples_per_symbol(samp_rate, symbol_rate));
        auto to_complex = gr::blocks::float_to_complex::make(1);
        auto multiply = gr::blocks::multiply_cc::make(1);
        auto carrier = gr::analog::sig_source_c::make(
            samp_rate, gr::analog::GR_COS_WAVE, carrier_freq, 1.0, 0.0, 0.0);
        connect(self(), 0, unpack, 0);
        connect(unpack, 0, to_float, 0);
        connect(to_float, 0, repeat, 0);
        connect(repeat, 0, to_complex, 0);
        connect(to_complex, 0, multiply, 0);
        connect(carrier, 0, multiply, 1);
        connect(multiply, 0, self(), 0);
    }
};

class OokDemodulator : public gr::hier_block2
{
public:
    OokDemodulator(double carrier_freq,
                   double samp_rate,
                   double symbol_rate,
                   double bandwidth,
                   double threshold)
        : gr::hier_block2("OOK Demodulator",
                          gr::io_signature::make(1, 1, sizeof(gr_complex)),
                          gr::io_signature::make(1, 1, sizeof(std::uint8_t)))
    {
        const int sps = samples_per_symbol(samp_rate, symbol_rate);
        if (threshold <= 0)
            throw std::runtime_error("BBC OOK threshold must be positive");
        if (bandwidth <= 0)
            bandwidth = 4.0 * symbol_rate;
        const auto taps = gr::filter::firdes::complex_band_pass(
            1.0,
            samp_rate,
            carrier_freq - bandwidth / 2.0,
            carrier_freq + bandwidth / 2.0,
            bandwidth / 4.0,
            gr::fft::window::WIN_HAMMING,
            6.76);
        std::vector<float> integrator_taps(static_cast<std::size_t>(sps),
                                           1.0f / static_cast<float>(sps));
        auto band_pass = gr::filter::fir_filter_ccc::make(1, taps);
        auto magnitude = gr::blocks::complex_to_mag_squared::make(1);
        auto integrator = gr::filter::fir_filter_fff::make(1, integrator_taps);
        auto skip = gr::blocks::skiphead::make(sizeof(float), (taps.size() - 1) / 2);
        auto slicer = gr::blocks::threshold_ff::make(threshold, threshold, 0.0f);
        auto keep = gr::blocks::keep_one_in_n::make(sizeof(float), sps);
        auto to_char = gr::blocks::float_to_char::make(1, 1.0f);
        auto pack = gr::blocks::unpacked_to_packed_bb::make(1, gr::GR_MSB_FIRST);
        connect(self(), 0, band_pass, 0);
        connect(band_pass, 0, magnitude, 0);
        connect(magnitude, 0, integrator, 0);
        connect(integrator, 0, skip, 0);
        connect(skip, 0, slicer, 0);
        connect(slicer, 0, keep, 0);
        connect(keep, 0, to_char, 0);
        connect(to_char, 0, pack, 0);
        connect(pack, 0, self(), 0);
    }
};

} // namespace

gr::basic_block_sptr make_encoder(int message_length,
                                  int codeword_length,
                                  int checksum_length,
                                  const std::string& checksum_mode)
{
    return gnuradio::make_block_sptr<EncoderBlock>(
        message_length, codeword_length, checksum_length, checksum_mode);
}

gr::basic_block_sptr make_decoder(int message_length,
                                  int codeword_length,
                                  int checksum_length,
                                  int max_candidates,
                                  int max_steps,
                                  const std::string& checksum_mode)
{
    return gnuradio::make_block_sptr<DecoderBlock>(message_length,
                                                   codeword_length,
                                                   checksum_length,
                                                   max_candidates,
                                                   max_steps,
                                                   checksum_mode);
}

gr::basic_block_sptr
make_ook_modulator(double carrier_freq, double samp_rate, double symbol_rate)
{
    return gnuradio::make_block_sptr<OokModulator>(carrier_freq, samp_rate, symbol_rate);
}

gr::basic_block_sptr make_ook_demodulator(double carrier_freq,
                                          double samp_rate,
                                          double symbol_rate,
                                          double bandwidth,
                                          double threshold)
{
    return gnuradio::make_block_sptr<OokDemodulator>(
        carrier_freq, samp_rate, symbol_rate, bandwidth, threshold);
}

} // namespace wasm_bbc
