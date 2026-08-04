// Browser-native C++ ports of gr-ham's Python blocks.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// gr-ham has no C++ implementations to generate factories from: its lib/ holds a
// CMakeLists.txt and nothing else, and all four blocks are Python gr.block
// subclasses under gr-ham/python/. The three ported here mirror the block they
// are named for, one for one; ham_dstar_rx is deliberately absent (see the note
// in blocks/overlays/gr-ham/metadata.yml).
//
// All three are gr::block rather than gr::sync_block even where upstream used a
// sync_block, because each one wants to say how much input it needs before it
// can do anything: a sync sink is called with whatever happens to be available
// and upstream's answer to a short call is to return 0 without consuming, which
// leans on the scheduler to come back with more. Stating it in forecast() is the
// same behaviour with the scheduler on side.

#include "ham_blocks.hpp"

#include <gnuradio/block.h>
#include <gnuradio/io_signature.h>
#include <gnuradio/sptr_magic.h>

#include <algorithm>
#include <array>
#include <cstddef>
#include <cstdint>
#include <cstring>
#include <iostream>
#include <string>

namespace wasm_ham {
namespace {

// ---------------------------------------------------------------------------
// The PSK31 varicode alphabet, indexed by ASCII code point. Copied out of the
// `encode` dict in gr-ham/python/varicode_tx.py, whose `decode` counterpart in
// varicode_rx.py is its exact inverse. Every code starts with '1' and contains
// no "00", which is what makes "00" usable as the inter-character terminator
// and what lets a code be keyed by its bits read as an integer below.
// ---------------------------------------------------------------------------
constexpr int kMaxCodeLen = 10;

const char* const kVaricode[128] = {
    "1010101011", "1011011011", "1011101101", "1101110111",
    "1011101011", "1101011111", "1011101111", "1011111101",
    "1011111111", "11101111",   "11101",      "1101101111",
    "1011011101", "11111",      "1101110101", "1110101011",
    "1011110111", "1011110101", "1110101101", "1110101111",
    "1101011011", "1101101011", "1101101101", "1101010111",
    "1101111011", "1101111101", "1110110111", "1101010101",
    "1101011101", "1110111011", "1011111011", "1101111111",
    "1",          "111111111",  "101011111",  "111110101",
    "111011011",  "1011010101", "1010111011", "101111111",
    "11111011",   "11110111",   "101101111",  "111011111",
    "1110101",    "110101",     "1010111",    "110101111",
    "10110111",   "10111101",   "11101101",   "11111111",
    "101110111",  "101011011",  "101101011",  "110101101",
    "110101011",  "110110111",  "11110101",   "110111101",
    "111101101",  "1010101",    "111010111",  "1010101111",
    "1010111101", "1111101",    "11101011",   "10101101",
    "10110101",   "1110111",    "11011011",   "11111101",
    "101010101",  "1111111",    "111111101",  "101111101",
    "11010111",   "10111011",   "11011101",   "10101011",
    "11010101",   "111011101",  "10101111",   "1101111",
    "1101101",    "101010111",  "110110101",  "101011101",
    "101110101",  "101111011",  "1010101101", "111110111",
    "111101111",  "111111011",  "1010111111", "101101101",
    "1011011111", "1011",       "1011111",    "101111",
    "101101",     "11",         "111101",     "1011011",
    "101011",     "1101",       "111101011",  "10111111",
    "11011",      "111011",     "1111",       "111",
    "111111",     "110111111",  "10101",      "10111",
    "101",        "110111",     "1111011",    "1101011",
    "11011111",   "1011101",    "111010101",  "1010110111",
    "110111011",  "1010110101", "1011010111", "1110110101",
};

// Reverse of the table above: a code's bits read as a binary number index a
// character directly. The leading '1' every code carries makes that number
// unique on its own -- "11" (0b11 = 3) cannot collide with "011" -- so no
// separate length is needed and the whole map is one 1024-entry array.
class VaricodeDecodeTable
{
public:
    VaricodeDecodeTable()
    {
        d_table.fill(-1);
        for (int c = 0; c < 128; c++) {
            std::uint32_t key = 0;
            for (const char* bit = kVaricode[c]; *bit; ++bit)
                key = (key << 1) | (*bit == '1' ? 1u : 0u);
            d_table[key] = static_cast<std::int16_t>(c);
        }
    }

    // Returns the ASCII code point for `bits`, or -1 if it is not a varicode.
    int lookup(const std::int8_t* bits, int length) const
    {
        if (length <= 0 || length > kMaxCodeLen)
            return -1;
        std::uint32_t key = 0;
        for (int i = 0; i < length; i++)
            key = (key << 1) | (bits[i] != 0 ? 1u : 0u);
        return d_table[key];
    }

private:
    std::array<std::int16_t, 1u << kMaxCodeLen> d_table;
};

const VaricodeDecodeTable& decode_table()
{
    static const VaricodeDecodeTable table;
    return table;
}

// ---------------------------------------------------------------------------
// varicode_tx.py: one ASCII byte in, that character's varicode plus the "00"
// inter-character gap out, one bit per byte. A byte with no varicode (anything
// >= 0x80) is dropped, exactly as upstream's `if c in encode` does.
//
// Upstream encodes a single character per general_work() call; this loops while
// there is input left and output room, which produces the identical bit stream.
// ---------------------------------------------------------------------------
class VaricodeTx : public gr::block
{
public:
    VaricodeTx()
        : gr::block("varicode_tx",
                    gr::io_signature::make(1, 1, sizeof(std::int8_t)),
                    gr::io_signature::make(1, 1, sizeof(std::int8_t)))
    {
        // The longest character is kMaxCodeLen bits plus its "00" gap, and this
        // block cannot emit a partial one. Without a floor under the output
        // request the scheduler is free to call work() with less room than that,
        // which would return having neither consumed nor produced -- and a
        // thread-per-block scheduler answers that by calling straight back.
        set_min_noutput_items(kMaxCodeLen + 2);
    }

    void forecast(int /*noutput_items*/, gr_vector_int& ninput_items_required) override
    {
        // One byte is enough to make progress, and each one expands to at most
        // kMaxCodeLen + 2 bits, so asking for noutput_items of them (upstream's
        // forecast) would stall this block behind a slow text source.
        ninput_items_required[0] = 1;
    }

    int general_work(int noutput_items,
                     gr_vector_int& ninput_items,
                     gr_vector_const_void_star& input_items,
                     gr_vector_void_star& output_items) override
    {
        const auto* in = static_cast<const std::int8_t*>(input_items[0]);
        auto* out = static_cast<std::int8_t*>(output_items[0]);
        int consumed = 0;
        int produced = 0;

        while (consumed < ninput_items[0]) {
            const auto c = static_cast<std::uint8_t>(in[consumed]);
            if (c < 128) {
                const char* code = kVaricode[c];
                const int needed = static_cast<int>(std::strlen(code)) + 2;
                if (produced + needed > noutput_items)
                    break;
                for (; *code; ++code)
                    out[produced++] = (*code == '1') ? 1 : 0;
                out[produced++] = 0;
                out[produced++] = 0;
            }
            consumed++;
        }

        consume(0, consumed);
        return produced;
    }
};

// ---------------------------------------------------------------------------
// varicode_rx.py: sliced bits in (one bit per byte, as a Binary Slicer emits),
// ASCII out. Leading zeroes are skipped, the bits up to the next "00" are one
// character, and a run that is not in the table is consumed without output.
//
// Upstream decodes one character per general_work() call; this loops until it
// runs out of input or output room, producing the identical byte stream.
// ---------------------------------------------------------------------------
class VaricodeRx : public gr::block
{
public:
    VaricodeRx()
        : gr::block("varicode_rx",
                    gr::io_signature::make(1, 1, sizeof(std::int8_t)),
                    gr::io_signature::make(1, 1, sizeof(std::int8_t)))
    {
    }

    void forecast(int /*noutput_items*/, gr_vector_int& ninput_items_required) override
    {
        ninput_items_required[0] = d_required;
    }

    int general_work(int noutput_items,
                     gr_vector_int& ninput_items,
                     gr_vector_const_void_star& input_items,
                     gr_vector_void_star& output_items) override
    {
        const auto* in = static_cast<const std::int8_t*>(input_items[0]);
        auto* out = static_cast<std::int8_t*>(output_items[0]);
        const int available = ninput_items[0];
        int consumed = 0;
        int produced = 0;

        while (produced < noutput_items) {
            while (consumed < available && in[consumed] == 0)
                consumed++;                       // inter-character zeroes

            int end = consumed;
            while (end + 1 < available && !(in[end] == 0 && in[end + 1] == 0))
                end++;
            if (end + 1 >= available) {
                // No terminator in what we hold: the character is still arriving.
                // Once the unterminated run is longer than any varicode, though,
                // no character can end inside it, so drop everything but the tail
                // rather than let a stuck stream of marks fill the buffer and
                // deadlock the graph.
                if (available >= kMaxWait)
                    consumed = std::max(consumed, available - kMaxCodeLen - 1);
                break;
            }

            const int character = decode_table().lookup(in + consumed, end - consumed);
            consumed = end + 2;                   // the character and its "00"
            if (character >= 0)
                out[produced++] = static_cast<std::int8_t>(character);
        }

        // A call that neither consumed nor produced would be repeated straight
        // away by the thread-per-block scheduler, so wait for more input than we
        // just saw. Capped: a request the buffer can never satisfy is fatal.
        d_required = (consumed == 0 && produced == 0) ? std::min(available + 1, kMaxWait)
                                                      : kMinRequired;
        consume(0, consumed);
        return produced;
    }

private:
    // The shortest decodable character is "1" plus its "00" terminator. Upstream
    // asks for noutput_items * 8, which over-requests by an order of magnitude
    // once noutput_items is a whole buffer.
    static constexpr int kMinRequired = 3;
    static constexpr int kMaxWait = 64;

    int d_required = kMinRequired;
};

// ---------------------------------------------------------------------------
// chu_decode.py: CHU (Canada's shortwave time signal, 3330/7850/14670 kHz)
// broadcasts a 300 baud AFSK time code twice a minute, between seconds 31 and
// 39. This is the sink end of that chain -- 4800 sample/s sliced bits in,
// decoded time out to the console.
//
// A burst is a preamble of 533 mark bits and one space, then 110 bits carrying
// ten bytes as eleven-bit framed characters. Bytes 0-4 are repeated in 5-9 in an
// A frame (day of year and time) and inverted in a B frame (year, DUT1, TAI-UTC
// and the daylight-saving pattern), which is what tells the two apart.
// ---------------------------------------------------------------------------
constexpr int kPreambleLen = 534;               // 533 marks then one space
constexpr int kSamplesPerBit = 4800 / 300;
constexpr int kMessageBits = 110;
constexpr int kSamplesInMessage = kMessageBits * kSamplesPerBit;
constexpr int kWindow = kPreambleLen + kSamplesInMessage;

class ChuDecode : public gr::block
{
public:
    ChuDecode()
        : gr::block("chu_decode",
                    gr::io_signature::make(1, 1, sizeof(std::int8_t)),
                    gr::io_signature::make(0, 0, 0))
    {
    }

    void forecast(int /*noutput_items*/, gr_vector_int& ninput_items_required) override
    {
        // A whole preamble plus a whole message, or there is nothing to look at.
        // One more than that, so the no-preamble path below always has at least
        // one item to consume: a call that consumes nothing and produces nothing
        // is repeated immediately by the thread-per-block scheduler.
        ninput_items_required[0] = kWindow + 1;
    }

    int general_work(int /*noutput_items*/,
                     gr_vector_int& ninput_items,
                     gr_vector_const_void_star& input_items,
                     gr_vector_void_star& /*output_items*/) override
    {
        const auto* in = static_cast<const std::int8_t*>(input_items[0]);
        const int available = ninput_items[0];
        if (available <= kWindow)
            return 0;   // forecast() rules this out; kept so the maths below is safe

        // Find a space bit closing a run of at least 533 marks, which is where
        // upstream's search for [1]*533 + [0] lands too: a longer run of marks
        // matches at its last 533, so both put the message start just past the
        // space. The message has to fit in what we hold, hence the limit.
        const int last_space = available - kSamplesInMessage - 1;
        int marks = 0;
        for (int i = 0; i <= last_space; i++) {
            if (in[i] == 1) {
                marks++;
                continue;
            }
            if (in[i] == 0 && marks >= kPreambleLen - 1) {
                decode_message(in + i + 1);
                return consume_and_finish(i + 1 + kSamplesInMessage);
            }
            marks = 0;
        }

        // No preamble here. Keep back one window's worth: a burst straddling the
        // end of the buffer has to still be intact on the next call.
        return consume_and_finish(available - kWindow);
    }

private:
    int consume_and_finish(int items)
    {
        if (items > 0)
            consume(0, items);
        return 0;   // no output ports; the decode is printed, not produced
    }

    static void decode_message(const std::int8_t* start)
    {
        // Integrate each bit's 16 samples: a mark counts +1 and a space -1, so
        // the sign of the sum is the bit.
        std::array<int, kMessageBits> bits{};
        for (int bit = 0; bit < kMessageBits; bit++) {
            int discriminant = 0;
            const std::int8_t* samples = start + kSamplesPerBit * bit;
            for (int s = 0; s < kSamplesPerBit; s++)
                discriminant += -1 + 2 * samples[s];
            bits[bit] = discriminant >= 0 ? 1 : 0;
        }

        // Ten characters of eleven bits: a start space, two BCD digits sent low
        // digit first with each digit's bits reversed, and two stop marks.
        std::array<int, 10> bytes{};
        for (int index = 0; index < 10; index++) {
            const int* b = &bits[index * 11];
            if (b[0] != 0 || b[9] != 1 || b[10] != 1) {
                std::cout << "error ";
                bytes[index] = -1;
                continue;
            }
            int value = 0;
            for (int bit = 4; bit >= 1; bit--)
                value = value * 2 + b[bit];
            for (int bit = 8; bit >= 5; bit--)
                value = value * 2 + b[bit];
            bytes[index] = value;
        }

        bool repeated = true;
        bool inverted = true;
        for (int i = 0; i < 5; i++) {
            repeated = repeated && bytes[i] == bytes[i + 5];
            inverted = inverted && bytes[i] == (bytes[i + 5] ^ 0xff);
        }

        if (repeated && bytes[0] >> 4 == 6) {
            const int day = (bytes[0] & 0x0f) * 100 + (bytes[1] >> 4) * 10 + (bytes[1] & 0x0f);
            const int hour = (bytes[2] >> 4) * 10 + (bytes[2] & 0x0f);
            const int minute = (bytes[3] >> 4) * 10 + (bytes[3] & 0x0f);
            const int second = (bytes[4] >> 4) * 10 + (bytes[4] & 0x0f);
            std::cout << "A frame:\n"
                      << " Day of year: " << day << '\n'
                      << " Current Time: " << hour << ":" << minute << ":" << second
                      << " UTC\n\n"
                      << std::flush;
        } else if (inverted) {
            const int dut_tenths = (bytes[0] & 0x10) ? -(bytes[0] & 0x0f) : (bytes[0] & 0x0f);
            int leap_second_warning = 0;
            if (bytes[0] & 0x20)
                leap_second_warning = 1;
            if (bytes[0] & 0x40)
                leap_second_warning = -1;
            const int year = (bytes[1] >> 4) * 1000 + (bytes[1] & 0x0f) * 100 +
                             (bytes[2] >> 4) * 10 + (bytes[2] & 0x0f);
            const int tai_utc = (bytes[3] >> 4) * 10 + (bytes[3] & 0x0f);
            const int dst_pattern = (bytes[4] >> 4) * 10 + (bytes[4] & 0x0f);
            std::cout << "B frame:\n"
                      << " Year: " << year << '\n'
                      << " Leap second warning: " << leap_second_warning << '\n'
                      << " Difference between UTC and UT1: " << tenths(dut_tenths)
                      << " seconds\n"
                      << " Difference between TAI and UTC: " << tai_utc << " seconds\n"
                      << " Daylight saving time pattern: " << dst_pattern << "\n\n"
                      << std::flush;
        } else {
            std::cout << "Decoding error.\n\n" << std::flush;
        }
    }

    // DUT1 is a signed number of tenths of a second; upstream prints it as a
    // Python float, e.g. "-0.3".
    static std::string tenths(int value)
    {
        std::string text = value < 0 ? "-" : "";
        const int magnitude = value < 0 ? -value : value;
        text += std::to_string(magnitude / 10);
        text += '.';
        text += std::to_string(magnitude % 10);
        return text;
    }
};

} // namespace

gr::basic_block_sptr make_varicode_tx() { return gnuradio::make_block_sptr<VaricodeTx>(); }

gr::basic_block_sptr make_varicode_rx() { return gnuradio::make_block_sptr<VaricodeRx>(); }

gr::basic_block_sptr make_chu_decode() { return gnuradio::make_block_sptr<ChuDecode>(); }

} // namespace wasm_ham
