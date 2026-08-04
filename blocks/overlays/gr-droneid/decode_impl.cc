/* Browser-side replacement for gr-droneid's split decode block.
 *
 * Upstream's demodulation block publishes equalized QPSK carriers before its
 * internal descrambler, but decode_impl.cc feeds those raw bits directly to
 * the LTE turbo decoder. Generate the same 7,200-bit LTE Gold sequence used by
 * demodulation_impl.cc, and try the four possible QPSK orientations before
 * publishing a CRC-valid DroneID payload.
 */

#include "decode_impl.h"

#include <gnuradio/droneid/misc_utils.h>
#include <gnuradio/io_signature.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <complex>
#include <cstdio>
#include <vector>

extern "C" {
#include <turbofec/rate_match.h>
#include <turbofec/turbo.h>
}

#define CRCPP_INCLUDE_ESOTERIC_CRC_DEFINITIONS
#include <CRC.h>

namespace gr {
namespace droneid {

namespace {

constexpr std::size_t ENCODED_BITS = 7200;
constexpr std::size_t DECODED_BYTES = 176;

const std::array<std::uint8_t, ENCODED_BITS>& descrambler()
{
    static const auto sequence = [] {
        constexpr std::size_t warmup = 1600;
        std::array<std::uint8_t, warmup + ENCODED_BITS + 31> x1{};
        std::array<std::uint8_t, warmup + ENCODED_BITS + 31> x2{};
        std::array<std::uint8_t, ENCODED_BITS> output{};

        // fliplr() of the 31-bit representation used by process_file.m.
        constexpr std::array<std::uint8_t, 31> x2_initial = {
            0, 0, 0, 1, 1, 1, 1, 0, 1, 1, 0, 0, 1, 0, 1, 0,
            0, 0, 1, 0, 1, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0,
        };
        x1[0] = 1;
        std::copy(x2_initial.begin(), x2_initial.end(), x2.begin());

        for (std::size_t n = 0; n < warmup + ENCODED_BITS; ++n) {
            x1[n + 31] = (x1[n + 3] + x1[n]) & 1U;
            x2[n + 31] =
                (x2[n + 3] + x2[n + 2] + x2[n + 1] + x2[n]) & 1U;
        }
        for (std::size_t n = 0; n < ENCODED_BITS; ++n)
            output[n] = (x1[n + warmup] + x2[n + warmup]) & 1U;
        return output;
    }();
    return sequence;
}

} // namespace

decode::sptr decode::make(const std::string& debug_path)
{
    return gnuradio::get_initial_sptr(new decode_impl(debug_path));
}

decode_impl::decode_impl(const std::string& debug_path)
    : gr::sync_block("decode",
                     gr::io_signature::make(0, 0, 0),
                     gr::io_signature::make(0, 0, 0)),
      debug_path_(debug_path)
{
    message_port_register_in(pmt::mp(input_pdu_port_name_));
    message_port_register_out(pmt::mp(output_pdu_port_name_));
    set_msg_handler(pmt::mp(input_pdu_port_name_),
                    [this](const pmt::pmt_t& pdu) { handle_pdu(pdu); });
}

decode_impl::~decode_impl() = default;

std::vector<int8_t>
decode_impl::qpsk_to_bits(const std::vector<gr_complex>& samples)
{
    std::vector<int8_t> bits(samples.size() * 2);
    auto* output = bits.data();
    for (const auto& sample : samples) {
        *output++ = sample.real() < 0 ? 1 : 0;
        *output++ = sample.imag() < 0 ? 1 : 0;
    }
    return bits;
}

void decode_impl::handle_pdu(const pmt::pmt_t& pdu)
{
    const auto start_time = std::chrono::high_resolution_clock::now();
    const auto samples = pmt::c32vector_elements(pmt::cdr(pdu));
    if (samples.size() != 3600) {
        std::cout << "Invalid number of samples. Expected 3600, got "
                  << samples.size() << "\n";
        return;
    }

    constexpr std::array<gr_complex, 4> rotations = {
        gr_complex{1, 0}, gr_complex{0, -1},
        gr_complex{-1, 0}, gr_complex{0, 1},
    };
    bool valid = false;
    for (std::size_t rotation = 0; rotation < rotations.size() && !valid; ++rotation) {
        std::vector<gr_complex> oriented(samples.size());
        std::transform(samples.begin(), samples.end(), oriented.begin(),
                       [rotation, &rotations](gr_complex sample) {
                           return sample * rotations[rotation];
                       });
        auto bits = qpsk_to_bits(oriented);
        const auto& sequence = descrambler();
        for (std::size_t i = 0; i < bits.size(); ++i)
            bits[i] ^= sequence[i];

        constexpr int turbo_decoder_bits = 1412;
        std::vector<int8_t> d1(turbo_decoder_bits);
        std::vector<int8_t> d2(turbo_decoder_bits);
        std::vector<int8_t> d3(turbo_decoder_bits);
        std::vector<std::uint8_t> decoded(DECODED_BYTES);
        auto* matcher = lte_rate_matcher_alloc();
        auto* decoder = alloc_tdec();
        lte_rate_matcher_io io = {
            .D = turbo_decoder_bits,
            .E = static_cast<int>(ENCODED_BITS),
            .d = {d1.data(), d2.data(), d3.data()},
            .e = bits.data(),
        };
        lte_rate_match_rv(matcher, &io, 0);
        const int status = lte_turbo_decode(decoder,
                                            DECODED_BYTES * 8,
                                            4,
                                            decoded.data(),
                                            d1.data(), d2.data(), d3.data());
        free_tdec(decoder);
        lte_rate_matcher_free(matcher);

        const bool nonzero =
            std::any_of(decoded.begin(), decoded.end(), [](std::uint8_t byte) {
                return byte != 0;
            });
        const auto crc = CRC::Calculate(decoded.data(), decoded.size(),
                                        CRC::CRC_24_LTEA());
        if (status != 0 || !nonzero || crc != 0)
            continue;

        valid = true;
        std::cout << "DroneID CRC OK (QPSK rotation " << rotation << ")\n";
        for (const auto byte : decoded)
            std::fprintf(stdout, "%02x", byte);
        std::fprintf(stdout, "\n");

        if (!debug_path_.empty()) {
            misc_utils::write(debug_path_ + "/bits",
                              bits.data(), sizeof(bits[0]), bits.size());
            misc_utils::write(debug_path_ + "/decoded",
                              decoded.data(), sizeof(decoded[0]), decoded.size());
        }
        message_port_pub(pmt::mp(output_pdu_port_name_),
                         pmt::cons(pmt::make_dict(),
                                   pmt::init_u8vector(decoded.size(), decoded)));
    }

    if (!valid)
        std::cout << "DroneID CRC check failed for all QPSK rotations\n";
    const auto end_time = std::chrono::high_resolution_clock::now();
    std::cout << "DroneID decode time: "
              << std::chrono::duration<float>(end_time - start_time).count()
              << " s\n";
}

int decode_impl::work(int noutput_items,
                      gr_vector_const_void_star&,
                      gr_vector_void_star&)
{
    return noutput_items;
}

} // namespace droneid
} // namespace gr
