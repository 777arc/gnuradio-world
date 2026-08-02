#pragma once

// C++ rebuilds of gr-digital's Python gr.hier_block2 compositions: PSK
// modulation and demodulation, the constellation modulator, and the OFDM
// transmitter and receiver.

#include "hier_support.hpp"
#include <gnuradio/analog/agc2_cc.h>
#include <gnuradio/digital/additive_scrambler.h>
#include <gnuradio/blocks/packed_to_unpacked.h>
#include <gnuradio/digital/chunks_to_symbols.h>
#include <gnuradio/analog/frequency_modulator_fc.h>
#include <gnuradio/blocks/file_sink.h>
#include <gnuradio/blocks/head.h>
#include <gnuradio/blocks/delay.h>
#include <gnuradio/blocks/repack_bits_bb.h>
#include <gnuradio/blocks/skiphead.h>
#include <gnuradio/blocks/tagged_stream_mux.h>
#include <gnuradio/blocks/unpack_k_bits_bb.h>
#include <gnuradio/digital/constellation.h>
#include <gnuradio/digital/constellation_decoder_cb.h>
#include <gnuradio/digital/constellation_receiver_cb.h>
#include <gnuradio/digital/crc32_bb.h>
#include <gnuradio/digital/diff_decoder_bb.h>
#include <gnuradio/digital/diff_encoder_bb.h>
#include <gnuradio/digital/fll_band_edge_cc.h>
#include <gnuradio/digital/header_payload_demux.h>
#include <gnuradio/digital/map_bb.h>
#include <gnuradio/digital/ofdm_carrier_allocator_cvc.h>
#include <gnuradio/digital/ofdm_chanest_vcvc.h>
#include <gnuradio/digital/ofdm_cyclic_prefixer.h>
#include <gnuradio/digital/ofdm_equalizer_simpledfe.h>
#include <gnuradio/digital/ofdm_frame_equalizer_vcvc.h>
#include <gnuradio/digital/ofdm_serializer_vcc.h>
#include <gnuradio/digital/ofdm_sync_sc_cfb.h>
#include <gnuradio/digital/packet_header_ofdm.h>
#include <gnuradio/digital/packet_headergenerator_bb.h>
#include <gnuradio/digital/packet_headerparser_b.h>
#include <gnuradio/digital/pfb_clock_sync_ccf.h>
#include <gnuradio/fft/fft_v.h>
#include <gnuradio/filter/firdes.h>
#include <gnuradio/filter/pfb_arb_resampler_ccf.h>
#include <gnuradio/hier_block2.h>
#include <gnuradio/io_signature.h>
#include <random>
#include <vector>

inline gr::digital::constellation_sptr make_psk_constellation(unsigned int count,
                                                       const std::string& mod_code,
                                                       bool differential)
{
    if (count < 2 || (count & (count - 1)) != 0)
        throw std::runtime_error("PSK constellation points must be a power of two");
    if (mod_code != "gray" && mod_code != "none")
        throw std::runtime_error("PSK code must be gray or none");

    std::vector<gr_complex> points;
    points.reserve(count);
    for (unsigned int i = 0; i < count; ++i) {
        const double phase = 2.0 * PI * i / count;
        points.emplace_back(std::cos(phase), std::sin(phase));
    }
    std::vector<int> gray(count);
    for (unsigned int i = 0; i < count; ++i)
        gray[i] = static_cast<int>(i ^ (i >> 1));
    std::vector<int> pre_diff;
    if (mod_code == "gray" && differential) {
        pre_diff = gray;
    } else if (mod_code == "gray") {
        std::vector<unsigned int> inverse(count);
        for (unsigned int i = 0; i < count; ++i)
            inverse[gray[i]] = i;
        std::vector<gr_complex> reordered(count);
        for (unsigned int i = 0; i < count; ++i)
            reordered[i] = points[inverse[i]];
        points = std::move(reordered);
    }
    return gr::digital::constellation_psk::make(points, pre_diff, count)->base();
}

class ConstellationModulator : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<ConstellationModulator>;
    static sptr make(gr::digital::constellation_sptr constellation,
                     bool differential,
                     int samples_per_symbol,
                     double excess_bandwidth,
                     bool truncate)
    {
        return gnuradio::make_block_sptr<ConstellationModulator>(std::move(constellation),
                                                                 differential,
                                                                 samples_per_symbol,
                                                                 excess_bandwidth,
                                                                 truncate);
    }

    ConstellationModulator(gr::digital::constellation_sptr constellation,
                           bool differential,
                           int samples_per_symbol,
                           double excess_bandwidth,
                           bool truncate)
        : hier_block2("constellation_modulator",
                      gr::io_signature::make(1, 1, sizeof(std::uint8_t)),
                      gr::io_signature::make(1, 1, sizeof(gr_complex)))
    {
        if (!constellation)
            throw std::runtime_error("Constellation Modulator requires a constellation");
        if (samples_per_symbol < 2)
            throw std::runtime_error(
                "Constellation Modulator samples per symbol must be at least 2");
        if (!std::isfinite(excess_bandwidth) || excess_bandwidth < 0.0 ||
            excess_bandwidth > 1.0)
            throw std::runtime_error(
                "Constellation Modulator excess bandwidth must be between 0 and 1");

        const unsigned int bits_per_symbol = constellation->bits_per_symbol();
        const unsigned int arity = 1u << bits_per_symbol;
        auto unpack =
            gr::blocks::packed_to_unpacked_bb::make(bits_per_symbol, gr::GR_MSB_FIRST);
        std::vector<gr::basic_block_sptr> chain{ self(), unpack };
        if (constellation->apply_pre_diff_code())
            chain.push_back(gr::digital::map_bb::make(constellation->pre_diff_code()));
        if (differential)
            chain.push_back(gr::digital::diff_encoder_bb::make(arity));
        chain.push_back(
            gr::digital::chunks_to_symbols_bc::make(constellation->points()));

        constexpr unsigned int filter_count = 32;
        constexpr unsigned int taps_per_filter = 11;
        const int tap_count = filter_count * taps_per_filter * samples_per_symbol;
        auto taps = gr::filter::firdes::root_raised_cosine(filter_count,
                                                           filter_count,
                                                           1.0,
                                                           excess_bandwidth,
                                                           tap_count);
        chain.push_back(gr::filter::pfb_arb_resampler_ccf::make(
            static_cast<float>(samples_per_symbol), taps, filter_count));
        if (truncate) {
            const double sps = samples_per_symbol;
            const auto delay = static_cast<std::uint64_t>(
                (taps_per_filter * sps * sps - sps) / 2.0);
            chain.push_back(gr::blocks::skiphead::make(sizeof(gr_complex), delay));
        }
        chain.push_back(self());
        for (std::size_t i = 1; i < chain.size(); ++i)
            connect(chain[i - 1], 0, chain[i], 0);
    }
};

class PskDemod : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<PskDemod>;
    static sptr make(unsigned int constellation_points,
                     const std::string& mod_code,
                     bool differential,
                     int samples_per_symbol,
                     double excess_bandwidth,
                     double frequency_bandwidth,
                     double timing_bandwidth,
                     double phase_bandwidth)
    {
        return gnuradio::make_block_sptr<PskDemod>(constellation_points,
                                                   mod_code,
                                                   differential,
                                                   samples_per_symbol,
                                                   excess_bandwidth,
                                                   frequency_bandwidth,
                                                   timing_bandwidth,
                                                   phase_bandwidth);
    }

    PskDemod(unsigned int constellation_points,
             const std::string& mod_code,
             bool differential,
             int samples_per_symbol,
             double excess_bandwidth,
             double frequency_bandwidth,
             double timing_bandwidth,
             double phase_bandwidth)
        : hier_block2("psk_demod",
                      gr::io_signature::make(1, 1, sizeof(gr_complex)),
                      gr::io_signature::make(1, 1, sizeof(std::uint8_t)))
    {
        if (samples_per_symbol < 2)
            throw std::runtime_error("PSK Demod samples per symbol must be at least 2");
        auto constellation =
            make_psk_constellation(constellation_points, mod_code, differential);
        const unsigned int bits_per_symbol = constellation->bits_per_symbol();
        const unsigned int arity = 1u << bits_per_symbol;
        constexpr unsigned int filter_count = 32;
        const int tap_count = 11 * samples_per_symbol * filter_count;

        auto agc = gr::analog::agc2_cc::make(0.06f, 0.001f, 1.0f, 1.0f);
        auto frequency_recovery = gr::digital::fll_band_edge_cc::make(
            samples_per_symbol, excess_bandwidth, 55, frequency_bandwidth);
        auto taps = gr::filter::firdes::root_raised_cosine(filter_count,
                                                           filter_count *
                                                               samples_per_symbol,
                                                           1.0,
                                                           excess_bandwidth,
                                                           tap_count);
        auto timing_recovery = gr::digital::pfb_clock_sync_ccf::make(
            samples_per_symbol,
            timing_bandwidth,
            taps,
            filter_count,
            filter_count / 2,
            1.5f);
        auto receiver = gr::digital::constellation_receiver_cb::make(
            constellation, phase_bandwidth, -0.25f, 0.25f);
        std::vector<gr::basic_block_sptr> chain{
            self(), agc, frequency_recovery, timing_recovery, receiver
        };
        if (differential)
            chain.push_back(gr::digital::diff_decoder_bb::make(arity));
        if (constellation->apply_pre_diff_code()) {
            auto code = constellation->pre_diff_code();
            std::vector<int> inverse(code.size());
            for (std::size_t i = 0; i < code.size(); ++i)
                inverse[code[i]] = static_cast<int>(i);
            chain.push_back(gr::digital::map_bb::make(inverse));
        }
        chain.push_back(gr::blocks::unpack_k_bits_bb::make(bits_per_symbol));
        chain.push_back(self());
        for (std::size_t i = 1; i < chain.size(); ++i)
            connect(chain[i - 1], 0, chain[i], 0);
    }
};

class PskMod : public gr::hier_block2 {
public:
    using sptr = std::shared_ptr<PskMod>;

    static sptr make(unsigned int constellation_points,
                     const std::string& mod_code,
                     bool differential,
                     unsigned int samples_per_symbol,
                     float excess_bw)
    {
        return gnuradio::make_block_sptr<PskMod>(constellation_points,
                                                 mod_code,
                                                 differential,
                                                 samples_per_symbol,
                                                 excess_bw);
    }

    PskMod(unsigned int constellation_points,
           const std::string& mod_code,
           bool differential,
           unsigned int samples_per_symbol,
           float excess_bw)
        : hier_block2("psk_mod",
                      gr::io_signature::make(1, 1, sizeof(std::uint8_t)),
                      gr::io_signature::make(1, 1, sizeof(gr_complex)))
    {
        if (constellation_points < 2 ||
            (constellation_points & (constellation_points - 1)) != 0)
            throw std::runtime_error("PSK Mod constellation points must be a power of two");
        if (samples_per_symbol < 2)
            throw std::runtime_error("PSK Mod samples per symbol must be at least 2");
        if (!std::isfinite(excess_bw) || excess_bw < 0.0f || excess_bw > 1.0f)
            throw std::runtime_error("PSK Mod excess bandwidth must be between 0 and 1");
        if (mod_code != "gray" && mod_code != "none")
            throw std::runtime_error("PSK Mod code must be gray or none");

        unsigned int bits_per_symbol = 0;
        for (unsigned int points = constellation_points; points > 1; points >>= 1)
            ++bits_per_symbol;

        std::vector<gr_complex> points;
        points.reserve(constellation_points);
        const double tau = 2.0 * std::acos(-1.0);
        for (unsigned int i = 0; i < constellation_points; ++i) {
            const double phase = tau * i / constellation_points;
            points.emplace_back(std::cos(phase), std::sin(phase));
        }

        std::vector<int> gray(constellation_points);
        for (unsigned int i = 0; i < constellation_points; ++i)
            gray[i] = static_cast<int>(i ^ (i >> 1));

        // This reproduces digital.psk.psk_mod: differential Gray coding maps
        // symbol indexes before the encoder; non-differential Gray coding
        // instead reorders the constellation table by the inverse code.
        const bool pre_diff_code = mod_code == "gray" && differential;
        if (mod_code == "gray" && !differential) {
            std::vector<unsigned int> inverse(constellation_points);
            for (unsigned int i = 0; i < constellation_points; ++i)
                inverse[gray[i]] = i;
            std::vector<gr_complex> reordered(constellation_points);
            for (unsigned int i = 0; i < constellation_points; ++i)
                reordered[i] = points[inverse[i]];
            points = std::move(reordered);
        }

        auto unpack = gr::blocks::packed_to_unpacked_bb::make(
            bits_per_symbol, gr::GR_MSB_FIRST);
        std::vector<gr::basic_block_sptr> chain{ self(), unpack };
        if (pre_diff_code)
            chain.push_back(gr::digital::map_bb::make(gray));
        if (differential)
            chain.push_back(gr::digital::diff_encoder_bb::make(constellation_points));
        chain.push_back(gr::digital::chunks_to_symbols_bc::make(points));

        constexpr unsigned int nfilts = 32;
        constexpr unsigned int ntaps_per_filter = 11;
        const int ntaps = nfilts * ntaps_per_filter * samples_per_symbol;
        auto taps = gr::filter::firdes::root_raised_cosine(
            nfilts, nfilts, 1.0, excess_bw, ntaps);
        chain.push_back(gr::filter::pfb_arb_resampler_ccf::make(
            static_cast<float>(samples_per_symbol), taps, nfilts));
        chain.push_back(self());

        for (std::size_t i = 1; i < chain.size(); ++i)
            connect(chain[i - 1], 0, chain[i], 0);
    }
};

// ---------------------------------------------------------------------------
// OFDM Transmitter (digital_ofdm_tx)
//
// gr-digital's OFDM Transmitter is a Python gr.hier_block2 (ofdm_txrx.py), so it
// cannot run in the browser. This is the same composition written as a C++
// hier_block2, including the two generated sync words: numpy's legacy
// RandomState(42) is MT19937 seeded exactly like std::mt19937(42), and
// randint(2) consumes one 32-bit draw and keeps its low bit, so the preambles
// come out bit-identical to the Python block's.
// ---------------------------------------------------------------------------

// 802.11a-style carrier allocation: the defaults of digital.ofdm_tx.
inline std::vector<std::vector<int>> default_occupied_carriers()
{
    std::vector<int> carriers;
    const int ranges[][2] = { { -26, -21 }, { -20, -7 }, { -6, 0 },
                              { 1, 7 },     { 8, 21 },   { 22, 27 } };
    for (const auto& range : ranges)
        for (int carrier = range[0]; carrier < range[1]; ++carrier)
            carriers.push_back(carrier);
    return { carriers };
}

inline std::vector<std::vector<int>> default_pilot_carriers() { return { { -21, -7, 7, 21 } }; }

inline std::vector<std::vector<gr_complex>> default_pilot_symbols()
{
    // _pilot_sym_scramble_seq from ofdm_txrx.py, expanded to (x, x, x, -x).
    static const int scramble[] = {
        1,  1,  1,  1,  -1, -1, -1, 1,  -1, -1, -1, -1, 1,  1,  -1, 1,  -1, -1, 1,
        1,  -1, 1,  1,  -1, 1,  1,  1,  1,  1,  1,  -1, 1,  1,  1,  -1, 1,  1,  -1,
        -1, 1,  1,  1,  -1, 1,  -1, -1, -1, 1,  -1, 1,  -1, -1, 1,  -1, -1, 1,  1,
        1,  1,  1,  -1, -1, 1,  1,  -1, -1, 1,  -1, 1,  -1, 1,  1,  -1, -1, -1, 1,
        1,  -1, -1, -1, -1, 1,  -1, -1, 1,  -1, 1,  1,  1,  1,  -1, 1,  -1, 1,  -1,
        1,  -1, -1, -1, -1, -1, 1,  -1, 1,  1,  -1, 1,  -1, 1,  1,  1,  -1, -1, 1,
        -1, -1, -1, 1,  1,  1,  -1, -1, -1, -1, -1, -1, -1
    };
    std::vector<std::vector<gr_complex>> symbols;
    symbols.reserve(std::size(scramble));
    for (int value : scramble) {
        const gr_complex symbol(static_cast<float>(value), 0.0f);
        symbols.push_back({ symbol, symbol, symbol, -symbol });
    }
    return symbols;
}

// Carriers that ever hold data or pilots, as non-negative FFT bin indexes.
inline std::vector<int> active_carriers(int fft_len,
                                 const std::vector<std::vector<int>>& occupied_carriers,
                                 const std::vector<std::vector<int>>& pilot_carriers)
{
    std::vector<int> active;
    for (const auto* rows : { &occupied_carriers, &pilot_carriers }) {
        if (rows->empty())
            continue;
        for (int carrier : rows->front())
            active.push_back(carrier < 0 ? carrier + fft_len : carrier);
    }
    return active;
}

// numpy.fft.fftshift: roll right by fft_len // 2.
inline std::vector<gr_complex> fftshift(const std::vector<gr_complex>& symbols)
{
    const std::size_t len = symbols.size();
    const std::size_t half = len / 2;
    std::vector<gr_complex> shifted(len);
    for (std::size_t i = 0; i < len; ++i)
        shifted[i] = symbols[(i + len - half) % len];
    return shifted;
}

// _make_sync_word1: BPSK on the odd active carriers only (so the time-domain
// symbol has two identical halves for Schmidl & Cox), scaled to keep the energy.
inline std::vector<gr_complex> make_sync_word1(int fft_len,
                                        const std::vector<std::vector<int>>& occupied,
                                        const std::vector<std::vector<int>>& pilots)
{
    const std::vector<int> active = active_carriers(fft_len, occupied, pilots);
    std::mt19937 generator(42);  // numpy.random.seed(_seq_seed)
    std::vector<gr_complex> word(fft_len, gr_complex(0.0f, 0.0f));
    const float amplitude = static_cast<float>(std::sqrt(2.0));
    for (int carrier = 0; carrier < fft_len; ++carrier) {
        if (carrier % 2 == 0 ||
            std::find(active.begin(), active.end(), carrier) == active.end())
            continue;
        word[carrier] = (generator() & 1u) ? gr_complex(-amplitude, 0.0f)
                                           : gr_complex(amplitude, 0.0f);
    }
    return fftshift(word);
}

// _make_sync_word2: BPSK on every active carrier, DC left empty.
inline std::vector<gr_complex> make_sync_word2(int fft_len,
                                        const std::vector<std::vector<int>>& occupied,
                                        const std::vector<std::vector<int>>& pilots)
{
    const std::vector<int> active = active_carriers(fft_len, occupied, pilots);
    std::mt19937 generator(42);
    std::vector<gr_complex> word(fft_len, gr_complex(0.0f, 0.0f));
    for (int carrier = 0; carrier < fft_len; ++carrier) {
        if (std::find(active.begin(), active.end(), carrier) == active.end())
            continue;
        word[carrier] = (generator() & 1u) ? gr_complex(-1.0f, 0.0f) : gr_complex(1.0f, 0.0f);
    }
    word[0] = gr_complex(0.0f, 0.0f);
    return fftshift(word);
}

inline std::vector<gr_complex> constellation_points(int bits_per_symbol)
{
    switch (bits_per_symbol) {
    case 1: return gr::digital::constellation_bpsk::make()->points();
    case 2: return gr::digital::constellation_qpsk::make()->points();
    case 3: return gr::digital::constellation_8psk::make()->points();
    default:
        throw std::runtime_error("OFDM Transmitter supports BPSK, QPSK or 8-PSK only");
    }
}

class OfdmTxWasm : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<OfdmTxWasm>;

    static sptr make(int fft_len,
                     int cp_len,
                     const std::string& packet_length_tag_key,
                     const std::vector<std::vector<int>>& occupied_carriers,
                     const std::vector<std::vector<int>>& pilot_carriers,
                     const std::vector<std::vector<gr_complex>>& pilot_symbols,
                     int bps_header,
                     int bps_payload,
                     const std::vector<gr_complex>& sync_word1,
                     const std::vector<gr_complex>& sync_word2,
                     int rolloff,
                     bool scramble_bits)
    {
        return gnuradio::make_block_sptr<OfdmTxWasm>(fft_len,
                                                     cp_len,
                                                     packet_length_tag_key,
                                                     occupied_carriers,
                                                     pilot_carriers,
                                                     pilot_symbols,
                                                     bps_header,
                                                     bps_payload,
                                                     sync_word1,
                                                     sync_word2,
                                                     rolloff,
                                                     scramble_bits);
    }

    OfdmTxWasm(int fft_len,
               int cp_len,
               const std::string& packet_length_tag_key,
               const std::vector<std::vector<int>>& occupied_carriers,
               const std::vector<std::vector<int>>& pilot_carriers,
               const std::vector<std::vector<gr_complex>>& pilot_symbols,
               int bps_header,
               int bps_payload,
               const std::vector<gr_complex>& sync_word1,
               const std::vector<gr_complex>& sync_word2,
               int rolloff,
               bool scramble_bits)
        : hier_block2("ofdm_tx_wasm",
                      gr::io_signature::make(1, 1, sizeof(std::uint8_t)),
                      gr::io_signature::make(1, 1, sizeof(gr_complex)))
    {
        if (fft_len <= 0)
            throw std::runtime_error("OFDM Transmitter FFT length must be positive");
        if (cp_len <= 0 || cp_len >= fft_len)
            throw std::runtime_error(
                "OFDM Transmitter cyclic prefix length must be between 1 and FFT length");
        if (rolloff < 0 || rolloff > cp_len)
            throw std::runtime_error(
                "OFDM Transmitter rolloff length must be between 0 and the cyclic prefix");

        // An empty sync word means "generate one", exactly like the Python block's
        // sync_word1=None / sync_word2=None defaults.
        std::vector<std::vector<gr_complex>> sync_words;
        sync_words.push_back(sync_word1.empty()
                                 ? make_sync_word1(fft_len, occupied_carriers, pilot_carriers)
                                 : sync_word1);
        std::vector<gr_complex> second =
            sync_word2.empty() ? make_sync_word2(fft_len, occupied_carriers, pilot_carriers)
                               : sync_word2;
        if (!second.empty())
            sync_words.push_back(std::move(second));
        for (const auto& word : sync_words) {
            if (static_cast<int>(word.size()) != fft_len)
                throw std::runtime_error(
                    "OFDM Transmitter sync word length must equal the FFT length");
        }

        // Deactivating the scrambler = seeding its LFSR with zeros.
        const std::uint64_t scramble_seed = scramble_bits ? 0x7f : 0x00;

        // ---- header ----
        auto crc = gr::digital::crc32_bb::make(false, packet_length_tag_key, true);
        auto header_mod =
            gr::digital::chunks_to_symbols_bc::make(constellation_points(bps_header));
        auto header_formatter = gr::digital::packet_header_ofdm::make(occupied_carriers,
                                                                      1,
                                                                      "packet_len",
                                                                      "frame_len",
                                                                      "packet_num",
                                                                      bps_header,
                                                                      bps_payload,
                                                                      scramble_bits);
        auto header_gen = gr::digital::packet_headergenerator_bb::make(
            header_formatter->base(), packet_length_tag_key);
        // Head tags on the payload stream stay on the head.
        auto header_payload_mux = gr::blocks::tagged_stream_mux::make(
            sizeof(gr_complex) * 1, packet_length_tag_key, 1);
        connect(self(), 0, crc, 0);
        connect(crc, 0, header_gen, 0);
        connect(header_gen, 0, header_mod, 0);
        connect(header_mod, 0, header_payload_mux, 0);

        // ---- payload ----
        auto payload_mod =
            gr::digital::chunks_to_symbols_bc::make(constellation_points(bps_payload));
        auto payload_scrambler = gr::digital::additive_scrambler_bb::make(
            0x8a,
            scramble_seed,
            7,
            0,  // don't reset after a fixed length; the reset tag does that
            8,  // bits per byte, before unpacking
            packet_length_tag_key);
        auto payload_unpack =
            gr::blocks::repack_bits_bb::make(8, bps_payload, packet_length_tag_key);
        connect(crc, 0, payload_scrambler, 0);
        connect(payload_scrambler, 0, payload_unpack, 0);
        connect(payload_unpack, 0, payload_mod, 0);
        connect(payload_mod, 0, header_payload_mux, 1);

        // ---- OFDM frame ----
        auto allocator = gr::digital::ofdm_carrier_allocator_cvc::make(fft_len,
                                                                       occupied_carriers,
                                                                       pilot_carriers,
                                                                       pilot_symbols,
                                                                       sync_words,
                                                                       packet_length_tag_key);
        auto ffter = gr::fft::fft_v<gr_complex, false>::make(
            fft_len, std::vector<float>(), true);
        auto cyclic_prefixer =
            gr::digital::ofdm_cyclic_prefixer::make(static_cast<std::size_t>(fft_len),
                                                    static_cast<std::size_t>(fft_len + cp_len),
                                                    rolloff,
                                                    packet_length_tag_key);
        connect(header_payload_mux, 0, allocator, 0);
        connect(allocator, 0, ffter, 0);
        connect(ffter, 0, cyclic_prefixer, 0);
        connect(cyclic_prefixer, 0, self(), 0);
    }
};

class OfdmRxWasm : public gr::hier_block2
{
public:
    using sptr = std::shared_ptr<OfdmRxWasm>;
    static sptr make(int fft_len,
                     int cp_len,
                     const std::string& frame_length_tag_key,
                     const std::string& packet_length_tag_key,
                     const std::string& packet_number_tag_key,
                     const std::vector<std::vector<int>>& occupied_carriers,
                     const std::vector<std::vector<int>>& pilot_carriers,
                     const std::vector<std::vector<gr_complex>>& pilot_symbols,
                     int bps_header,
                     int bps_payload,
                     const std::vector<gr_complex>& sync_word1,
                     const std::vector<gr_complex>& sync_word2,
                     bool scramble_bits,
                     bool debug_log)
    {
        return gnuradio::make_block_sptr<OfdmRxWasm>(fft_len,
                                                     cp_len,
                                                     frame_length_tag_key,
                                                     packet_length_tag_key,
                                                     packet_number_tag_key,
                                                     occupied_carriers,
                                                     pilot_carriers,
                                                     pilot_symbols,
                                                     bps_header,
                                                     bps_payload,
                                                     sync_word1,
                                                     sync_word2,
                                                     scramble_bits,
                                                     debug_log);
    }

    OfdmRxWasm(int fft_len,
               int cp_len,
               const std::string& frame_length_tag_key,
               const std::string& packet_length_tag_key,
               const std::string& packet_number_tag_key,
               const std::vector<std::vector<int>>& occupied_carriers,
               const std::vector<std::vector<int>>& pilot_carriers,
               const std::vector<std::vector<gr_complex>>& pilot_symbols,
               int bps_header,
               int bps_payload,
               const std::vector<gr_complex>& requested_sync_word1,
               const std::vector<gr_complex>& requested_sync_word2,
               bool scramble_bits,
               bool debug_log)
        : hier_block2("ofdm_rx",
                      gr::io_signature::make(1, 1, sizeof(gr_complex)),
                      gr::io_signature::make(1, 1, sizeof(std::uint8_t)))
    {
        if (fft_len <= 0)
            throw std::runtime_error("OFDM Receiver FFT length must be positive");
        if (cp_len <= 0 || cp_len >= fft_len)
            throw std::runtime_error(
                "OFDM Receiver cyclic prefix length must be between 1 and FFT length");

        const std::vector<gr_complex> sync_word1 =
            requested_sync_word1.empty()
                ? make_sync_word1(fft_len, occupied_carriers, pilot_carriers)
                : requested_sync_word1;
        const std::vector<gr_complex> sync_word2 =
            requested_sync_word2.empty()
                ? make_sync_word2(fft_len, occupied_carriers, pilot_carriers)
                : requested_sync_word2;
        if (static_cast<int>(sync_word1.size()) != fft_len ||
            static_cast<int>(sync_word2.size()) != fft_len)
            throw std::runtime_error(
                "OFDM Receiver sync word length must equal the FFT length");

        bool even_carriers = false;
        bool odd_carriers = false;
        for (int i = 0; i < fft_len; ++i) {
            if (std::norm(sync_word1[static_cast<std::size_t>(i)]) == 0.0f)
                continue;
            (i % 2 == 0 ? even_carriers : odd_carriers) = true;
        }
        if (even_carriers && odd_carriers)
            throw std::runtime_error(
                "OFDM Receiver Sync Word 1 must leave alternating carriers empty");

        // ---- synchronization and header/payload split ----
        auto sync =
            gr::digital::ofdm_sync_sc_cfb::make(fft_len, cp_len, even_carriers);
        auto delay = gr::blocks::delay::make(sizeof(gr_complex), fft_len + cp_len);
        auto oscillator =
            gr::analog::frequency_modulator_fc::make(-2.0f / fft_len);
        auto mixer = gr::blocks::multiply_cc::make(1);
        auto demux = gr::digital::header_payload_demux::make(
            3,
            fft_len,
            cp_len,
            frame_length_tag_key,
            "",
            true,
            sizeof(gr_complex));
        connect(self(), 0, sync, 0);
        connect(self(), 0, delay, 0);
        connect(delay, 0, mixer, 0);
        connect(sync, 0, oscillator, 0);
        connect(oscillator, 0, mixer, 1);
        connect(mixer, 0, demux, 0);
        connect(sync, 1, demux, 1);

        // ---- header ----
        auto header_fft = gr::fft::fft_v<gr_complex, true>::make(
            fft_len, std::vector<float>(), true);
        auto channel_estimator =
            gr::digital::ofdm_chanest_vcvc::make(sync_word1, sync_word2, 1);
        auto header_constellation =
            constellation_for_bits(bps_header);
        auto header_equalizer = gr::digital::ofdm_equalizer_simpledfe::make(
            fft_len,
            header_constellation,
            occupied_carriers,
            pilot_carriers,
            pilot_symbols,
            0);
        auto header_frame_equalizer =
            gr::digital::ofdm_frame_equalizer_vcvc::make(header_equalizer->base(),
                                                         cp_len,
                                                         frame_length_tag_key,
                                                         true,
                                                         1);
        auto header_serializer = gr::digital::ofdm_serializer_vcc::make(
            fft_len, occupied_carriers, frame_length_tag_key);
        auto header_demod =
            gr::digital::constellation_decoder_cb::make(header_constellation);
        auto header_formatter = gr::digital::packet_header_ofdm::make(
            occupied_carriers,
            1,
            packet_length_tag_key,
            frame_length_tag_key,
            packet_number_tag_key,
            bps_header,
            bps_payload,
            scramble_bits);
        auto header_parser =
            gr::digital::packet_headerparser_b::make(header_formatter->formatter());
        connect(demux, 0, header_fft, 0);
        connect(header_fft, 0, channel_estimator, 0);
        connect(channel_estimator, 0, header_frame_equalizer, 0);
        connect(header_frame_equalizer, 0, header_serializer, 0);
        connect(header_serializer, 0, header_demod, 0);
        connect(header_demod, 0, header_parser, 0);
        msg_connect(header_parser, "header_data", demux, "header_data");
        if (debug_log) {
            const auto debug_sink = [](std::size_t item_size, const char* path) {
                auto sink = gr::blocks::file_sink::make(item_size, path, false);
                sink->set_unbuffered(true);
                return sink;
            };
            connect(channel_estimator,
                    0,
                    debug_sink(sizeof(gr_complex) * fft_len,
                               "/ofdm_rx_post_channel_estimator.bin"),
                    0);
            connect(header_frame_equalizer,
                    0,
                    debug_sink(sizeof(gr_complex) * fft_len,
                               "/ofdm_rx_header_equalized.bin"),
                    0);
            connect(header_serializer,
                    0,
                    debug_sink(sizeof(gr_complex),
                               "/ofdm_rx_header_symbols.bin"),
                    0);
            connect(header_demod,
                    0,
                    debug_sink(sizeof(std::uint8_t),
                               "/ofdm_rx_header_bits.bin"),
                    0);
        }

        // ---- payload ----
        auto payload_fft = gr::fft::fft_v<gr_complex, true>::make(
            fft_len, std::vector<float>(), true);
        auto payload_constellation =
            constellation_for_bits(bps_payload);
        auto payload_equalizer = gr::digital::ofdm_equalizer_simpledfe::make(
            fft_len,
            payload_constellation,
            occupied_carriers,
            pilot_carriers,
            pilot_symbols,
            1,
            0.1f);
        auto payload_frame_equalizer =
            gr::digital::ofdm_frame_equalizer_vcvc::make(payload_equalizer->base(),
                                                         cp_len,
                                                         frame_length_tag_key);
        auto payload_serializer = gr::digital::ofdm_serializer_vcc::make(
            fft_len,
            occupied_carriers,
            frame_length_tag_key,
            packet_length_tag_key,
            1);
        auto payload_demod =
            gr::digital::constellation_decoder_cb::make(payload_constellation);
        auto payload_pack = gr::blocks::repack_bits_bb::make(
            bps_payload, 8, packet_length_tag_key, true);
        const std::uint64_t scramble_seed = scramble_bits ? 0x7f : 0x00;
        auto payload_descrambler = gr::digital::additive_scrambler_bb::make(
            0x8a, scramble_seed, 7, 0, 8, packet_length_tag_key);
        auto crc = gr::digital::crc32_bb::make(true, packet_length_tag_key, true);
        connect(demux, 1, payload_fft, 0);
        connect(payload_fft, 0, payload_frame_equalizer, 0);
        connect(payload_frame_equalizer, 0, payload_serializer, 0);
        connect(payload_serializer, 0, payload_demod, 0);
        connect(payload_demod, 0, payload_pack, 0);
        connect(payload_pack, 0, payload_descrambler, 0);
        connect(payload_descrambler, 0, crc, 0);
        connect(crc, 0, self(), 0);
    }

private:
    static gr::digital::constellation_sptr constellation_for_bits(int bits)
    {
        switch (bits) {
        case 1: return gr::digital::constellation_bpsk::make()->base();
        case 2: return gr::digital::constellation_qpsk::make()->base();
        case 3: return gr::digital::constellation_8psk::make()->base();
        default:
            throw std::runtime_error(
                "OFDM Receiver supports BPSK, QPSK or 8-PSK only");
        }
    }
};
