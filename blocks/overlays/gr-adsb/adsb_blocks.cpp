// Browser-native C++ ports of gr-adsb's pure-Python GNU Radio blocks.
// SPDX-License-Identifier: GPL-3.0-or-later
//
// gr-adsb has no C++ implementations to generate factories from: its lib/ holds
// the QA harness and nothing else, and all three blocks are Python gr.sync_block
// subclasses under gr-adsb/python/adsb/. Each class below mirrors the Python
// file named in its comment, statement for statement where that is possible, so
// the two stay diffable.
//
// Three deliberate departures from upstream, all forced by the browser:
//
//   * The decoder's "Brief" print level draws a live table with curses. There is
//     no curses here and the editor's console pane is append-only, so the same
//     columns are printed as one row per update instead of being redrawn in
//     place. "Verbose" keeps upstream's per-field log, and "None" is silent --
//     upstream's "None" still logs at DEBUG level, which looks like an oversight
//     given the option is named None.
//   * Upstream's colorama escapes are dropped; the console pane renders text.
//   * The framer's SNR estimate divides by the median of the samples before the
//     pulse. Upstream takes that median of an empty slice when a pulse lands on
//     sample 0 of a work() call, which yields NaN; here an empty window falls
//     back to the pulse sample itself, so the tag carries 1.6 dB rather than a
//     NaN that would propagate into every PDU for that burst.

#include "adsb_blocks.hpp"

#include <gnuradio/block.h>
#include <gnuradio/io_signature.h>
#include <gnuradio/sptr_magic.h>
#include <gnuradio/sync_block.h>
#include <gnuradio/tags.h>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <iostream>
#include <map>
#include <sstream>
#include <stdexcept>
#include <string>
#include <vector>

namespace wasm_adsb {
namespace {

// ADS-B is 1 Msym/s pulse-position modulation, so two pulses per symbol and a
// minimum usable sample rate of 2 Msps.
constexpr double kSymbolRate = 1e6;
constexpr int kNumPreambleBits = 8;
constexpr int kMinNumBits = 56;
constexpr int kNumPreamblePulses = kNumPreambleBits * 2; // 16 half symbols
constexpr int kNumNoiseSamples = 100;
constexpr int kMaxNumBits = 112;

// The preamble as half-symbol "pulses", from framer.py.
const int kPreamblePulses[kNumPreamblePulses] = { 1, 0, 1, 0, 0, 0, 0, 1,
                                                  0, 1, 0, 0, 0, 0, 0, 0 };

// Samples per symbol, with upstream's integer-rate requirement enforced the way
// its assert does -- as an error the user can act on rather than a silent
// mis-decode at, say, 2.4 Msps.
int samples_per_symbol(double fs, const char* who)
{
    if (fs <= 0.0 || std::fmod(fs, kSymbolRate) != 0.0) {
        std::ostringstream msg;
        msg << who << " is designed to operate on an integer number of samples "
            << "per symbol, not " << (fs / kSymbolRate) << " sps";
        throw std::runtime_error(msg.str());
    }
    return static_cast<int>(fs / kSymbolRate);
}

// ---------------------------------------------------------------------------
// framer.py -- detect the 8-bit ADS-B preamble and tag the start of each burst.
// ---------------------------------------------------------------------------
class framer_impl : public framer
{
public:
    framer_impl(double fs, double threshold)
        : framer("ADS-B Framer",
                 gr::io_signature::make(1, 1, sizeof(float)),
                 gr::io_signature::make(1, 1, sizeof(float))),
          d_sps(samples_per_symbol(fs, "ADS-B Framer")),
          d_threshold(threshold),
          d_n_hist(kNumPreambleBits * d_sps)
    {
        // History so a preamble straddling the end of the previous work() call's
        // input is still visible in this one.
        set_history(d_n_hist);
        set_tag_propagation_policy(TPP_ONE_TO_ONE);
    }

    void set_threshold(double threshold) override { d_threshold = threshold; }

    int work(int noutput_items,
             gr_vector_const_void_star& input_items,
             gr_vector_void_star& output_items) override
    {
        const float* in0 = static_cast<const float*>(input_items[0]);
        float* out0 = static_cast<float*>(output_items[0]);
        const int N = noutput_items;

        // Threshold the input into a binary pulse train and difference it, with
        // the last sample of the previous call prepended so a transition on the
        // boundary is not lost. +1 is a rising edge, -1 a falling edge.
        d_rise.clear();
        d_fall.clear();
        int prev = (d_prev_in0 >= d_threshold) ? 1 : 0;
        for (int i = 0; i < N; i++) {
            const int cur = (in0[i] >= d_threshold) ? 1 : 0;
            if (cur - prev == 1)
                d_rise.push_back(i);
            else if (cur - prev == -1)
                d_fall.push_back(i);
            prev = cur;
        }
        d_prev_in0 = in0[N - 1];

        if (!d_rise.empty() && !d_fall.empty()) {
            // Pair each rising edge with its own falling edge.
            if (d_fall[0] < d_rise[0])
                d_fall.erase(d_fall.begin());
            if (d_rise.size() > d_fall.size()) {
                // There can only ever be one unmatched rising edge -- the pulse
                // whose fall lands in the next work() call.
                if (d_rise.size() - d_fall.size() == 1)
                    d_rise.pop_back();
                else
                    std::cout << "Oh no, this shouldn't be happening..." << std::endl;
            }

            const std::size_t n_pulses = std::min(d_rise.size(), d_fall.size());
            for (std::size_t p = 0; p < n_pulses; p++) {
                // Centre of the pulse.
                const int pulse_idx = (d_fall[p] + d_rise[p]) / 2;

                // Skip the many pulses inside a burst already being received.
                if (pulse_idx <= d_prev_eob_idx)
                    continue;
                d_prev_eob_idx = -1;

                // Compare the 16 half-symbol amplitudes against the preamble,
                // calling a half symbol set if it exceeds half the amplitude of
                // the pulse that triggered the search.
                const float ref = in0[pulse_idx] / 2.0f;
                int corr_matches = 0;
                for (int k = 0; k < kNumPreamblePulses; k++) {
                    const int bit = (in0[pulse_idx + k * (d_sps / 2)] > ref) ? 1 : 0;
                    if (bit == kPreamblePulses[k])
                        corr_matches++;
                }
                if (corr_matches != kNumPreamblePulses)
                    continue;

                // Burst SNR. in0[] is already a power vector (I^2 + Q^2), so
                // 10*log10() gives power SNR; the median of a Rayleigh variable
                // sits 1.6 dB below its mean, hence the correction.
                const int noise_lo =
                    (pulse_idx < kNumNoiseSamples) ? 0 : pulse_idx - kNumNoiseSamples;
                const double noise = median(in0 + noise_lo, pulse_idx - noise_lo,
                                            in0[pulse_idx]);
                const double snr = 10.0 * std::log10(in0[pulse_idx] / noise) + 1.6;

                // Where this burst ends, assuming the shorter 56-bit message
                // because the length is not yet known.
                d_prev_eob_idx =
                    pulse_idx + (kNumPreambleBits + kMinNumBits - 1) * d_sps;

                // Tag the start of the burst. in0[i] is output item
                // nitems_written + i - (history - 1); a preamble found inside the
                // history at the very first call has no output item to tag.
                const std::int64_t offset = static_cast<std::int64_t>(nitems_written(0)) -
                                            (d_n_hist - 1) + pulse_idx;
                if (offset >= 0) {
                    add_item_tag(0,
                                 static_cast<std::uint64_t>(offset),
                                 pmt::intern("burst"),
                                 pmt::make_tuple(pmt::intern("SOB"), pmt::from_double(snr)),
                                 pmt::intern("framer"));
                }
            }

            // Carry an end-of-burst that lands in the next call across to it.
            if (d_prev_eob_idx >= N)
                d_prev_eob_idx -= N;
        }

        std::memcpy(out0, in0 + (d_n_hist - 1), sizeof(float) * static_cast<std::size_t>(N));
        return N;
    }

private:
    // np.median, with an empty window falling back to `fallback` (see the file
    // header) rather than producing NaN.
    static double median(const float* first, int count, float fallback)
    {
        if (count <= 0)
            return fallback;
        std::vector<float> window(first, first + count);
        const int mid = count / 2;
        std::nth_element(window.begin(), window.begin() + mid, window.end());
        if (count % 2 == 1)
            return window[mid];
        const float hi = window[mid];
        const float lo = *std::max_element(window.begin(), window.begin() + mid);
        return 0.5 * (static_cast<double>(lo) + static_cast<double>(hi));
    }

    const int d_sps;
    double d_threshold;
    const int d_n_hist;
    float d_prev_in0 = 0.0f;
    // End of the last burst, as an index into the current work() call's input.
    int d_prev_eob_idx = -1;
    std::vector<int> d_rise;
    std::vector<int> d_fall;
};

// ---------------------------------------------------------------------------
// demod.py -- slice each tagged burst into 112 bits and publish it as a PDU.
// ---------------------------------------------------------------------------
class demod : public gr::sync_block
{
public:
    explicit demod(double fs)
        : gr::sync_block("demod",
                         gr::io_signature::make(1, 1, sizeof(float)),
                         gr::io_signature::make(1, 1, sizeof(float))),
          d_fs(fs),
          d_sps(samples_per_symbol(fs, "ADS-B Demodulator"))
    {
        // Wall-clock time at startup; a burst's own time comes from its sample
        // offset relative to this.
        d_start_timestamp =
            std::chrono::duration_cast<std::chrono::duration<double>>(
                std::chrono::system_clock::now().time_since_epoch())
                .count();

        set_tag_propagation_policy(TPP_ONE_TO_ONE);
        message_port_register_out(pmt::intern("demodulated"));
    }

    int work(int noutput_items,
             gr_vector_const_void_star& input_items,
             gr_vector_void_star& output_items) override
    {
        const float* in0 = static_cast<const float*>(input_items[0]);
        float* out0 = static_cast<float*>(output_items[0]);
        const int N = noutput_items;

        std::vector<gr::tag_t> tags;
        get_tags_in_range(tags, 0, nitems_read(0),
                          nitems_read(0) + static_cast<std::uint64_t>(N),
                          pmt::intern("burst"));

        for (const gr::tag_t& tag : tags) {
            const double snr = burst_snr(tag.value);

            // Start of burst is the middle of the first "bit 1 pulse"; end of
            // burst the middle of the last "bit 0 pulse".
            const std::int64_t written = static_cast<std::int64_t>(nitems_written(0));
            const std::int64_t offset = static_cast<std::int64_t>(tag.offset);
            const std::int64_t sob_idx = offset + kNumPreambleBits * d_sps - written;
            const std::int64_t eob_idx =
                offset + (kNumPreambleBits + kMaxNumBits - 1) * d_sps + d_sps / 2 - written;

            if (eob_idx >= N || sob_idx < 0) {
                // The burst is only partly in this block of samples; upstream
                // gives up on it too rather than buffering across the boundary.
                continue;
            }

            // A bit is 1 when the first half symbol carries more energy than the
            // second, which is what pulse-position modulation means here.
            std::vector<std::uint8_t> bits(kMaxNumBits, 0);
            for (int k = 0; k < kMaxNumBits; k++) {
                const float bit1_amp = in0[sob_idx + k * d_sps];
                const float bit0_amp = in0[sob_idx + d_sps / 2 + k * d_sps];
                bits[k] = (bit1_amp > bit0_amp) ? 1 : 0;
            }

            pmt::pmt_t meta = pmt::make_dict();
            meta = pmt::dict_add(meta, pmt::intern("timestamp"),
                                 pmt::from_double(d_start_timestamp +
                                                  static_cast<double>(tag.offset) / d_fs));
            meta = pmt::dict_add(meta, pmt::intern("snr"), pmt::from_double(snr));
            message_port_pub(pmt::intern("demodulated"),
                             pmt::cons(meta, pmt::init_u8vector(bits.size(), bits)));
        }

        std::memcpy(out0, in0, sizeof(float) * static_cast<std::size_t>(N));
        return N;
    }

private:
    // The framer tags ("SOB", snr); tolerate anything else rather than throwing
    // out of work() if some other block wrote a "burst" tag.
    static double burst_snr(const pmt::pmt_t& value)
    {
        if (pmt::is_tuple(value) && pmt::length(value) >= 2) {
            const pmt::pmt_t snr = pmt::tuple_ref(value, 1);
            if (pmt::is_real(snr))
                return pmt::to_double(snr);
        }
        return 0.0;
    }

    const double d_fs;
    const int d_sps;
    double d_start_timestamp = 0.0;
};

// ---------------------------------------------------------------------------
// decoder.py -- Mode S / ADS-B message decoder.
//
// The string tables below are copied verbatim from decoder.py, which cites the
// ICAO Annex 10 / DO-260B paragraph each one comes from.
// ---------------------------------------------------------------------------

// Downlink Format, 5 bits
const char* const kDfStr[32] = {
    "Short Air-Air Surveillance (ACAS)", "Reserved",
    "Reserved", "Reserved",
    "Surveillance Altitude Reply", "Surveillance Identity Reply",
    "Reserved", "Reserved",
    "Reserved", "Reserved",
    "Reserved", "All-Call Reply",
    "Reserved", "Reserved",
    "Reserved", "Reserved",
    "Long Air-Air Surveillance (ACAS)", "Extended Squitter",
    "Extended Squitter/Non-Transponder", "Military Extended Squitter",
    "Comm-B Altitude Reply", "Comm-B Identity Reply",
    "Reserved for Military Use", "Reserved",
    "Comm-D (ELM)", "Reserved",
    "Reserved", "Reserved",
    "Reserved", "Reserved",
    "Reserved", "Reserved",
};

// (DF 0, 16) Vertical Status, 1 bit (3.1.2.8.2.1)
const char* const kVsStr[2] = { "In Air", "On Ground" };

// (DF 0, 16) Reply Information, 4 bits (3.1.2.8.2.2)
const char* const kRiStr[16] = {
    "Reply to Interr UF=0 AQ=0, No Operating ACAS",
    "Reserved for ACAS",
    "Reserved for ACAS",
    "Reserved for ACAS",
    "Reserved for ACAS",
    "Reserved for ACAS",
    "Reserved for ACAS",
    "Reserved for ACAS",
    "Reply to Interr UF=0 AQ=1, No Max Speed Available",
    "Reply to Interr UF=0 AQ=1, max(v) < 75 kt",
    "Reply to Interr UF=0 AQ=1, 75 < max(v) < 150 kt",
    "Reply to Interr UF=0 AQ=1, 150 < max(v) < 300 kt",
    "Reply to Interr UF=0 AQ=1, 300 < max(v) < 600 kt",
    "Reply to Interr UF=0 AQ=1, 600 < max(v) < 1200 kt",
    "Reply to Interr UF=0 AQ=1, max(v) > 1200 kt",
    "Not Assigned",
};

// (DF 0) Crosslink Capability, 1 bit (3.1.2.8.2.3)
const char* const kCcStr[2] = { "Does Not Support Crosslink Capability",
                                "Does Support Crosslink Capability" };

// (DF 4, 20) Flight Status, 3 bits (3.1.2.6.5.1)
const char* const kFsStr[8] = {
    "No Alert, No SPI, In Air",         "No Alert, No SPI, On Ground",
    "Alert, No SPI, In Air",            "Alert, No SPI, On Ground",
    "Alert, SPI, On Ground or In Air",  "No Alert, SPI, On Ground or In Air",
    "Reserved",                         "Not Assigned",
};

// (DF 4, 20) Downlink Request, 5 bits (3.1.2.6.5.2)
const char* const kDrStr[32] = {
    "No Downlink Request", "Request to Send Comm-B Message",
    "Reserved for ACAS", "Reserved for ACAS",
    "Comm-B Broadcast Message 1 Available", "Comm-B Broadcast Message 2 Available",
    "Reserved for ACAS", "Reserved for ACAS",
    "Not Assigned", "Not Assigned", "Not Assigned", "Not Assigned",
    "Not Assigned", "Not Assigned", "Not Assigned", "Not Assigned",
    "Downlink ELM", "Downlink ELM", "Downlink ELM", "Downlink ELM",
    "Downlink ELM", "Downlink ELM", "Downlink ELM", "Downlink ELM",
    "Downlink ELM", "Downlink ELM", "Downlink ELM", "Downlink ELM",
    "Downlink ELM", "Downlink ELM", "Downlink ELM", "Downlink ELM",
};

// (DF 4, 20) Identifier Designator Subfield, 2 bits (3.1.2.6.5.3.1)
const char* const kIdsStr[4] = {
    "No Information", "IIS Contains Comm-B II Code",
    "IIS Contains Comm-C II Code", "IIS Contains Comm-D II Code",
};

// (DF 17) Capability, 3 bits (3.1.2.5.2.2.1)
const char* const kCaStr[8] = {
    "Level 1 Transponder, Cannot Set CA 7, On Ground or In Air",
    "Reserved",
    "Reserved",
    "Reserved",
    "Level 2 or Above Transponder, Can Set CA 7, On Ground",
    "Level 2 or Above Transponder, Can Set CA 7, In Air",
    "Level 2 or Above Transponder, Can Set CA 7, On Ground or In Air",
    "DR != 0 or FS in [2,3,4,5], On Ground or In Air",
};

// (DF 18) CF Field, 3 bits
const char* const kCfStr[8] = {
    "AA Field is the ICAO Address",
    "AA Field is an Anonymous Address",
    "Fine TIS-B Message Using ICAO Address",
    "Coarse TIS-B Airborne Position/Velocity Message",
    "TIS-B and ADS-R Management Message",
    "Fine TIS-B Using Non-ICAO Address",
    "ADS-B Rebroadcast",
    "Reserved",
};

// (DF 19) Application Field, 3 bits
const char* const kAfStr[8] = {
    "ADS-B Message",             "Reserved for Military Use",
    "Reserved for Military Use", "Reserved for Military Use",
    "Reserved for Military Use", "Reserved for Military Use",
    "Reserved for Military Use", "Reserved for Military Use",
};

// (DF 17,18,19) Type Code, 5 bits
const char* const kTcStr[32] = {
    "No Position Information",
    "Identification (Category Set D)",
    "Identification (Category Set C)",
    "Identification (Category Set B)",
    "Identification (Category Set A)",
    "Surface Position", "Surface Position", "Surface Position", "Surface Position",
    "Airborne Position", "Airborne Position", "Airborne Position", "Airborne Position",
    "Airborne Position", "Airborne Position", "Airborne Position", "Airborne Position",
    "Airborne Position", "Airborne Position",
    "Airborne Velocity",
    "Airborne Position", "Airborne Position", "Airborne Position",
    "Reserved for Test Purposes",
    "Reserved for Surface System Status",
    "Reserved", "Reserved", "Reserved",
    "Extended Squitter Aircraft Emergency Priority Status",
    "Reserved", "Reserved",
    "Aircraft Operational Status",
};

// (DF 17,18,19) Surveillance Status, 2 bits (2.2.3.2.3.2)
const char* const kSsStr[4] = {
    "No Condition Information",
    "Permanent Alert Condition (Emergency)",
    "Temporary Alert Condition",
    "Special Position Identification (SPI) Condition",
};

// (DF 17,18,19) Time, 1 bit (2.2.3.2.3.5)
const char* const kTStr[2] = { "Not Synced to 0.2s UTC Epoch",
                               "Synced to 0.2s UTC Epoch" };

// (DF 17,18,19) Callsign, 48 bits, 6 bits per character (3.1.2.9.1.2)
const char kCallsignChars[] =
    "_ABCDEFGHIJKLMNOPQRSTUVWXYZ_____ _______________0123456789______";

// CRC polynomial 0xFFFA048 = 1 + x + ... + x^12 + x^14 + x^21 + x^24
const int kCrcPoly[25] = { 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
                           0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 0, 1 };
constexpr int kNumCrcBits = 24;

// Seconds after which a CPR-encoded lat/lon half is considered stale.
constexpr long kCprTimeoutS = 30;

// One tracked aircraft. Mirrors the per-ICAO dictionary decoder.py builds in
// update_plane()/reset_plane_altimetry(), NaN standing in for np.nan.
struct Plane {
    bool has_callsign = false;
    std::string callsign;
    double altitude = std::nan("");
    double speed = std::nan("");
    double heading = std::nan("");
    double vertical_rate = std::nan("");
    double latitude = std::nan("");
    double longitude = std::nan("");
    // cpr[frame] = {lat_cpr, lon_cpr, time}; frame 0 even, frame 1 odd.
    double cpr[2][3] = { { std::nan(""), std::nan(""), std::nan("") },
                         { std::nan(""), std::nan(""), std::nan("") } };
    long num_msgs = 0;
    long last_seen = 0;
};

long now_seconds()
{
    return static_cast<long>(std::chrono::duration_cast<std::chrono::seconds>(
                                 std::chrono::system_clock::now().time_since_epoch())
                                 .count());
}

// datetime.utcfromtimestamp(ts).strftime(fmt), with "%f" microseconds appended
// when `with_micros` is set -- strftime has no %f.
std::string format_utc(double ts, const char* fmt, bool with_micros)
{
    const double floor_ts = std::floor(ts);
    std::time_t secs = static_cast<std::time_t>(floor_ts);
    std::tm tm {};
    gmtime_r(&secs, &tm);

    char buf[64];
    std::strftime(buf, sizeof(buf), fmt, &tm);
    std::string out(buf);
    if (with_micros) {
        char frac[16];
        std::snprintf(frac, sizeof(frac), ".%06d",
                      static_cast<int>((ts - floor_ts) * 1e6));
        out += frac;
    }
    return out;
}

class decoder : public gr::block
{
public:
    decoder(const std::string& msg_filter,
            const std::string& error_corr,
            const std::string& print_level)
        : gr::block("ADS-B Decoder",
                    gr::io_signature::make(0, 0, 0),
                    gr::io_signature::make(0, 0, 0)),
          d_msg_filter(msg_filter),
          d_error_corr(error_corr),
          d_verbose(print_level == "Verbose"),
          d_brief(print_level == "Brief")
    {
        // Syndromes for every contiguous 1- and 2-bit error burst, for the
        // "Conservative" error correction mode.
        for (int burst = 1; burst < 3; burst++) {
            compute_crc_syndromes_for_contiguous_bursts(56, burst);
            compute_crc_syndromes_for_contiguous_bursts(112, burst);
        }

        if (d_brief) {
            // Upstream draws this as a curses table refreshed in place. Here the
            // header is printed once and each update appends a row; see the note
            // at the top of this file.
            std::cout << "  Time     ICAO  Callsign   Alt  Climb Speed  Hdng    "
                         "Latitude    Longitude Msgs"
                      << std::endl;
            std::cout << "                             ft  ft/m    kt   deg         "
                         "deg          deg     "
                      << std::endl;
        }

        message_port_register_in(pmt::intern("demodulated"));
        message_port_register_out(pmt::intern("decoded"));
        message_port_register_out(pmt::intern("unknown"));
        set_msg_handler(pmt::intern("demodulated"),
                        [this](const pmt::pmt_t& pdu) { decode_packet(pdu); });
    }

private:
    // -----------------------------------------------------------------------
    // Bit and CRC helpers
    // -----------------------------------------------------------------------

    // bin2dec() over a slice of the packet's bits.
    std::uint64_t bin2dec(int offset, int count) const
    {
        std::uint64_t value = 0;
        for (int i = 0; i < count; i++)
            value = (value << 1) | (d_bits[offset + i] & 1);
        return value;
    }

    static std::uint64_t bin2dec(const std::vector<int>& bits)
    {
        std::uint64_t value = 0;
        for (int bit : bits)
            value = (value << 1) | (bit & 1);
        return value;
    }

    // compute_crc(): divide `count` data bits followed by 24 zeros by the CRC
    // polynomial and return the 24-bit remainder.
    std::vector<int> compute_crc(int offset, int count) const
    {
        std::vector<int> data(d_bits.begin() + offset, d_bits.begin() + offset + count);
        data.resize(count + kNumCrcBits, 0);
        for (int i = 0; i < count; i++) {
            if (data[i] == 1) {
                for (int j = 0; j <= kNumCrcBits; j++)
                    data[i + j] ^= kCrcPoly[j];
            }
        }
        return std::vector<int>(data.begin() + count, data.begin() + count + kNumCrcBits);
    }

    // compute_crc_2(): divide a whole codeword (payload including its parity
    // field) in place and return the trailing 25 bits. Upstream stops one step
    // short of a full division, so a valid codeword leaves all 25 bits zero.
    static std::vector<int> compute_crc_2(const std::vector<int>& codeword)
    {
        std::vector<int> data = codeword;
        const int num_data_bits = static_cast<int>(data.size()) - (kNumCrcBits + 1);
        for (int i = 0; i < num_data_bits; i++) {
            if (data[i] == 1) {
                for (int j = 0; j <= kNumCrcBits; j++)
                    data[i + j] ^= kCrcPoly[j];
            }
        }
        return std::vector<int>(data.begin() + num_data_bits, data.end());
    }

    // For each contiguous burst of `burst_length` flipped bits in a payload of
    // `payload_length`, record which bits it was under the syndrome it produces.
    void compute_crc_syndromes_for_contiguous_bursts(int payload_length, int burst_length)
    {
        std::map<std::uint64_t, std::vector<int>>& lut = d_crc_fix_lookup[payload_length];
        for (int i = 0; i <= payload_length - burst_length; i++) {
            std::vector<int> zarray(payload_length, 0);
            for (int j = 0; j < burst_length; j++)
                zarray[i + j] = 1;

            const std::uint64_t syndrome = bin2dec(compute_crc_2(zarray));

            // Upstream raises on a collision. None occurs for the burst lengths
            // it builds, but keeping the first entry rather than aborting the
            // flowgraph is the browser-appropriate response if one ever does.
            if (lut.count(syndrome))
                continue;

            std::vector<int> positions;
            for (int j = 0; j < burst_length; j++)
                positions.push_back(i + j);
            lut[syndrome] = positions;
        }
    }

    // -----------------------------------------------------------------------
    // Logging. Upstream wraps these in colorama escapes and hands them to the
    // logging module; here they go to stdout, which the runner forwards to the
    // editor's console pane.
    // -----------------------------------------------------------------------
    void log(const std::string& name, const std::string& value,
             const std::string& subvalue = std::string()) const
    {
        if (!d_verbose)
            return;
        std::cout << name << ": " << value;
        if (!subvalue.empty())
            std::cout << " " << subvalue;
        std::cout << std::endl;
    }

    void log(const std::string& name, long value,
             const std::string& subvalue = std::string()) const
    {
        log(name, std::to_string(value), subvalue);
    }

    static std::string fmt(const char* format, double value)
    {
        char buf[64];
        std::snprintf(buf, sizeof(buf), format, value);
        return buf;
    }

    // -----------------------------------------------------------------------
    // Plane bookkeeping
    // -----------------------------------------------------------------------
    Plane& update_plane(const std::string& aa_str)
    {
        auto it = d_planes.find(aa_str);
        if (it == d_planes.end()) {
            it = d_planes.emplace(aa_str, Plane()).first;
        }
        it->second.num_msgs += 1;
        it->second.last_seen = now_seconds();
        return it->second;
    }

    // The curses table's columns, one row per update. Upstream reprints every
    // tracked plane on every message; printing only the one that changed is what
    // makes that readable in an append-only console.
    void print_plane(const std::string& icao, const Plane& plane) const
    {
        auto field = [](bool present, const char* format, double value, int width) {
            if (!present)
                return std::string(static_cast<std::size_t>(width), ' ');
            char buf[64];
            std::snprintf(buf, sizeof(buf), format, value);
            return std::string(buf);
        };

        char callsign[16];
        std::snprintf(callsign, sizeof(callsign), "%-8s",
                      plane.has_callsign ? plane.callsign.c_str() : "");

        char num_msgs[16];
        std::snprintf(num_msgs, sizeof(num_msgs), "%4ld", plane.num_msgs);

        std::cout << format_utc(d_timestamp, "%H:%M:%S", false) << " " << icao << " "
                  << callsign << " "
                  << field(!std::isnan(plane.altitude), "%5.0f", plane.altitude, 5) << " "
                  << field(!std::isnan(plane.vertical_rate), "%5.0f", plane.vertical_rate, 5)
                  << " " << field(!std::isnan(plane.speed), "%5.0f", plane.speed, 5) << " "
                  << field(!std::isnan(plane.heading), "%5.0f", plane.heading, 5) << " "
                  << field(!std::isnan(plane.latitude), "%11.7f", plane.latitude, 11) << " "
                  << field(!std::isnan(plane.longitude), "%11.7f", plane.longitude, 11) << " "
                  << num_msgs << std::endl;
    }

    void publish_decoded_pdu(const std::string& aa_str)
    {
        const Plane& plane = d_planes.at(aa_str);

        pmt::pmt_t meta = pmt::make_dict();
        meta = pmt::dict_add(meta, pmt::intern("callsign"),
                             plane.has_callsign ? pmt::intern(plane.callsign) : pmt::PMT_NIL);
        meta = pmt::dict_add(meta, pmt::intern("altitude"), pmt::from_double(plane.altitude));
        meta = pmt::dict_add(meta, pmt::intern("speed"), pmt::from_double(plane.speed));
        meta = pmt::dict_add(meta, pmt::intern("heading"), pmt::from_double(plane.heading));
        meta = pmt::dict_add(meta, pmt::intern("vertical_rate"),
                             pmt::from_double(plane.vertical_rate));
        meta = pmt::dict_add(meta, pmt::intern("latitude"), pmt::from_double(plane.latitude));
        meta = pmt::dict_add(meta, pmt::intern("longitude"), pmt::from_double(plane.longitude));
        meta = pmt::dict_add(meta, pmt::intern("num_msgs"), pmt::from_long(plane.num_msgs));
        meta = pmt::dict_add(meta, pmt::intern("timestamp"), pmt::from_double(d_timestamp));
        meta = pmt::dict_add(meta, pmt::intern("datetime"), pmt::intern(d_datetime));
        meta = pmt::dict_add(meta, pmt::intern("icao"), pmt::intern(aa_str));
        meta = pmt::dict_add(meta, pmt::intern("df"), pmt::from_long(d_df));
        meta = pmt::dict_add(meta, pmt::intern("snr"), pmt::from_double(d_snr));

        message_port_pub(pmt::intern("decoded"), pmt::cons(meta, bits_to_pmt()));

        if (d_brief)
            print_plane(aa_str, plane);
    }

    void publish_unknown_pdu()
    {
        pmt::pmt_t meta = pmt::make_dict();
        meta = pmt::dict_add(meta, pmt::intern("timestamp"), pmt::from_double(d_timestamp));
        meta = pmt::dict_add(meta, pmt::intern("datetime"), pmt::intern(d_datetime));
        meta = pmt::dict_add(meta, pmt::intern("df"), pmt::from_long(d_df));
        meta = pmt::dict_add(meta, pmt::intern("snr"), pmt::from_double(d_snr));

        message_port_pub(pmt::intern("unknown"), pmt::cons(meta, bits_to_pmt()));
    }

    pmt::pmt_t bits_to_pmt() const
    {
        std::vector<std::uint8_t> bytes(d_bits.begin(), d_bits.end());
        return pmt::init_u8vector(bytes.size(), bytes);
    }

    // -----------------------------------------------------------------------
    // Decode path
    // -----------------------------------------------------------------------
    void decode_packet(const pmt::pmt_t& pdu)
    {
        if (!pmt::is_pair(pdu) || !pmt::is_u8vector(pmt::cdr(pdu))) {
            std::cerr << "[gr-adsb] expected a u8vector PDU on 'demodulated'" << std::endl;
            return;
        }

        reset();

        const pmt::pmt_t meta = pmt::car(pdu);
        d_timestamp = pmt::to_double(
            pmt::dict_ref(meta, pmt::intern("timestamp"), pmt::from_double(0.0)));
        d_snr =
            pmt::to_double(pmt::dict_ref(meta, pmt::intern("snr"), pmt::from_double(0.0)));
        d_datetime = format_utc(d_timestamp, "%Y-%m-%d %H:%M:%S", true) + " UTC";

        std::size_t len = 0;
        const std::uint8_t* bits = pmt::u8vector_elements(pmt::cdr(pdu), len);
        d_bits.assign(bits, bits + len);
        if (d_bits.size() < kMaxNumBits)
            d_bits.resize(kMaxNumBits, 0);

        decode_header();

        int parity_passed = check_parity();
        if (parity_passed == 0)
            parity_passed = correct_errors();

        if (parity_passed == 1) {
            // Re-parse the header in case error correction changed it.
            decode_header();
            decode_message();
        }
    }

    void reset()
    {
        d_aa = -1;
        d_aa_str.clear();
        d_df = -1;
        d_payload_length = -1;
    }

    void decode_header()
    {
        d_df = static_cast<int>(bin2dec(0, 5));

        const bool interesting =
            d_msg_filter == "All Messages" ||
            (d_msg_filter == "Extended Squitter Only" && (d_df == 17 || d_df == 18 || d_df == 19));
        if (interesting && d_verbose) {
            std::cout << "----------------------------------------------------------------------"
                      << std::endl;
            log("Datetime", d_datetime);
            log("SNR", fmt("%1.2f dB", d_snr));
            log("Downlink Format (DF)", d_df, kDfStr[d_df]);
        }
    }

    // Sets d_aa/d_aa_str for the formats whose parity field is overlaid with the
    // ICAO address; returns 1 when the message can be trusted.
    int check_parity()
    {
        if (d_msg_filter == "All Messages") {
            if (d_df == 0 || d_df == 4 || d_df == 5)
                return check_address_parity(56);

            if (d_df == 11) {
                d_payload_length = 56;
                // Parity/Interrogator ID, 24 bits
                const std::uint64_t pi = bin2dec(32, 24);
                const std::uint64_t crc = bin2dec(compute_crc(0, d_payload_length - 24));
                if (pi == crc) {
                    log("CRC", "Passed");
                    return 1;
                }
                log("CRC", "Failed", "PI^CRC = " + std::to_string(pi ^ crc));
                return 0;
            }

            if (d_df == 16 || d_df == 20 || d_df == 21 || d_df == 24)
                return check_address_parity(112);
        }

        // Extended squitter: the parity field is a plain CRC.
        if (d_df == 17 || d_df == 18 || d_df == 19) {
            d_payload_length = 112;
            const std::uint64_t pi = bin2dec(88, 24);
            const std::uint64_t crc = bin2dec(compute_crc(0, d_payload_length - 24));
            if (pi == crc) {
                log("CRC", "Passed");
                return 1;
            }
            log("CRC", "Failed", "PI^CRC = " + std::to_string(pi ^ crc));
            return 0;
        }

        log("DF", d_df, "Unknown DF");
        return 0;
    }

    // DF 0/4/5 (56 bit) and DF 16/20/21/24 (112 bit) carry Address/Parity: the
    // CRC XORed with the interrogated aircraft's ICAO address. Recovering an
    // address already being tracked is what stands in for a parity check.
    int check_address_parity(int payload_length)
    {
        d_payload_length = payload_length;
        const int ap_offset = payload_length - 24;

        const std::vector<int> crc_bits = compute_crc(0, payload_length - 24);
        std::vector<int> aa_bits(24);
        for (int i = 0; i < 24; i++)
            aa_bits[i] = crc_bits[i] ^ (d_bits[ap_offset + i] & 1);

        d_aa = static_cast<long>(bin2dec(aa_bits));
        char buf[16];
        std::snprintf(buf, sizeof(buf), "%06lx", d_aa);
        d_aa_str = buf;

        if (d_planes.count(d_aa_str)) {
            log("CRC", "Passed", "Recognized AA from AP");
            log("Address Announced (AA)", d_aa_str);
            log("Callsign", callsign_of(d_aa_str));
            return 1;
        }
        log("CRC", "Failed", "Unrecognized AA from AP");
        log("Address Announced (AA)", d_aa_str);
        return 0;
    }

    std::string callsign_of(const std::string& aa_str) const
    {
        auto it = d_planes.find(aa_str);
        if (it == d_planes.end() || !it->second.has_callsign)
            return std::string();
        return it->second.callsign;
    }

    // Flip the contiguous burst of bits whose syndrome matches, then confirm the
    // codeword divides cleanly.
    int correct_burst_errors()
    {
        if (d_payload_length < 1)
            return 0;

        std::vector<int> codeword(d_bits.begin(), d_bits.begin() + d_payload_length);
        const std::uint64_t syndrome = bin2dec(compute_crc_2(codeword));

        auto lut_it = d_crc_fix_lookup.find(d_payload_length);
        if (lut_it == d_crc_fix_lookup.end()) {
            log("FEC", "Conservative error correction lookup failed to get syndromes for "
                       "length " + std::to_string(d_payload_length));
            return 0;
        }

        auto fix_it = lut_it->second.find(syndrome);
        if (fix_it == lut_it->second.end()) {
            log("FEC", "Conservative error correction lookup failed to get syndrome");
            return 0;
        }

        std::string positions;
        for (int bit : fix_it->second)
            positions += (positions.empty() ? "" : ", ") + std::to_string(bit);
        log("FEC", "detected faulty bits", positions);

        for (int bit : fix_it->second)
            d_bits[bit] ^= 1;

        codeword.assign(d_bits.begin(), d_bits.begin() + d_payload_length);
        const bool success = bin2dec(compute_crc_2(codeword)) == 0;
        log("FEC", std::string("Conservative error correction:") +
                       (success ? "True" : "False"));
        return success ? 1 : 0;
    }

    int correct_errors()
    {
        if (d_error_corr == "Conservative")
            return correct_burst_errors();
        if (d_error_corr == "Brute Force") {
            log("FEC", "Brute Force error correction to be implemented");
            return 0;
        }
        return 0;
    }

    void decode_message()
    {
        if (d_msg_filter == "All Messages") {
            // DF 0  (3.1.2.8.2) Short Air-Air Surveillance (ACAS)
            // DF 16 (3.1.2.8.3) Long Air-Air Surveillance (ACAS)
            if (d_df == 0 || d_df == 16) {
                const int vs = d_bits[5];
                log("Vertical Status (VS)", vs, kVsStr[vs]);

                const int ri = static_cast<int>(bin2dec(13, 4));
                log("Reply Information (RI)", ri, kRiStr[ri]);

                const long altitude = decode_ac13(19);
                log("Altitude", std::to_string(altitude) + " ft");

                if (d_df == 0) {
                    const int cc = d_bits[6];
                    log("Crosslink Capability (CC)", kCcStr[cc]);
                } else {
                    // (4.3.8.4.2.4) MV is not decoded upstream either.
                    const std::uint64_t mv = bin2dec(32, 56);
                    log("VDS1", static_cast<long>(bin2dec(32, 4)));
                    log("VDS2", static_cast<long>(bin2dec(36, 4)));
                    log("MV", "To be implemented", hex(mv));
                }

                Plane& plane = update_plane(d_aa_str);
                if (altitude != -1)
                    plane.altitude = static_cast<double>(altitude);
            }

            // DF 4  (3.1.2.6.5) Surveillance Altitude Reply
            // DF 5  (3.1.2.6.7) Surveillance Identity Reply
            // DF 20 (3.1.2.6.6) Comm-B Altitude Reply
            // DF 21 (3.1.2.6.8) Comm-B Identity Reply
            if (d_df == 4 || d_df == 5 || d_df == 20 || d_df == 21) {
                const int fs = static_cast<int>(bin2dec(5, 3));
                log("Flight Status (FS)", fs, kFsStr[fs]);

                const int dr = static_cast<int>(bin2dec(8, 5));
                log("Downlink Request (DR)", dr, kDrStr[dr]);

                // Utility Message, 6 bits
                log("IIS", static_cast<long>(bin2dec(13, 4)));
                const int ids = static_cast<int>(bin2dec(17, 2));
                log("IDS", ids, kIdsStr[ids]);

                if (d_df == 4 || d_df == 20) {
                    const long alt = decode_ac13(19);
                    log("Altitude", std::to_string(alt) + " ft");

                    if (d_df == 20)
                        log("Message Comm-B", "To be implemented", hex(bin2dec(32, 56)));

                    Plane& plane = update_plane(d_aa_str);
                    if (alt != -1)
                        plane.altitude = static_cast<double>(alt);
                } else {
                    // Identity Code, 13 bits
                    log("Identity Code (IC)", static_cast<long>(bin2dec(19, 13)));
                    update_plane(d_aa_str);

                    if (d_df == 21)
                        log("Message Comm-B", "To be implemented", hex(bin2dec(32, 56)));
                }
            }
            // DF 11 (3.1.2.5.2.2) All-Call Reply
            else if (d_df == 11) {
                const int ca = static_cast<int>(bin2dec(5, 3));
                set_aa_from_bits();
                update_plane(d_aa_str);

                log("Capability (CA)", ca, kCaStr[ca]);
                log("Address Announced (AA)", d_aa_str);
                log("Callsign", callsign_of(d_aa_str));
            }
        }

        // Both filter settings reach the extended squitter formats. Upstream has
        // an `elif self.df == 28 / 31 / else` chain hanging off this condition,
        // which is unreachable because the condition is a tautology over the two
        // options the block offers; it is not reproduced.
        if (d_df == 17) {
            const int ca = static_cast<int>(bin2dec(5, 3));
            log("Capability (CA)", ca, kCaStr[ca]);

            set_aa_from_bits();
            log("Address Announced (AA)", d_aa_str);
            log("Callsign", callsign_of(d_aa_str));

            // All CA types contain ADS-B messages.
            decode_me();
        } else if (d_df == 18) {
            const int cf = static_cast<int>(bin2dec(5, 3));
            log("CF", cf, kCfStr[cf]);

            set_aa_from_bits();
            log("Address Announced (AA)", d_aa_str);
            log("Callsign", callsign_of(d_aa_str));
            log("DF=18 CF=" + std::to_string(cf), "Spotted in the wild!");

            if (cf == 0 || cf == 1 || cf == 6) {
                if (cf == 1)
                    log("CF=1", "Look into this, the AA is not the ICAO address");
                decode_me();
            } else if (cf == 2 || cf == 3 || cf == 5) {
                decode_tisb_me();
            } else if (cf == 4) {
                log("TIS-B and ADS-B Management Message", "To be implemented");
            }
        } else if (d_df == 19) {
            const int af = static_cast<int>(bin2dec(5, 3));
            log("Application Field (AF)", af, kAfStr[af]);

            set_aa_from_bits();
            log("Address Announced (AA)", d_aa_str);
            log("Callsign", callsign_of(d_aa_str));
            log("DF=19 AF=" + std::to_string(af), "Spotted in the wild!");

            if (af == 0)
                decode_me();
            else
                log("AF=" + std::to_string(af), "Reserved for Military Use");
        }
    }

    // Address Announced (ICAO address), bits 8..31, for the formats that send it
    // in the clear.
    void set_aa_from_bits()
    {
        d_aa = static_cast<long>(bin2dec(8, 24));
        char buf[16];
        std::snprintf(buf, sizeof(buf), "%06lx", d_aa);
        d_aa_str = buf;
    }

    static std::string hex(std::uint64_t value)
    {
        char buf[32];
        std::snprintf(buf, sizeof(buf), "0x%llx", static_cast<unsigned long long>(value));
        return buf;
    }

    // Message Extended Squitter, 56 bits
    void decode_me()
    {
        const int tc = static_cast<int>(bin2dec(32, 5));
        log("Type Code (TC)", tc, kTcStr[tc]);

        // --- No position information ---
        if (tc == 0) {
            // Upstream reads the message out and does nothing with it.
            return;
        }

        // --- Aircraft Identification ---
        if (tc >= 1 && tc <= 4) {
            std::string callsign;
            for (int i = 0; i < 8; i++) {
                // 8 characters, 6 bits each.
                const char c = kCallsignChars[bin2dec(40 + i * 6, 6)];
                if (c != '_')
                    callsign += c;
            }

            Plane& plane = update_plane(d_aa_str);
            plane.has_callsign = true;
            plane.callsign = callsign;
            publish_decoded_pdu(d_aa_str);
            return;
        }

        // --- Airborne Position (Baro Altitude) ---
        if (tc >= 9 && tc <= 18) {
            const int ss = static_cast<int>(bin2dec(37, 2));
            const int time_bit = d_bits[52];
            const int frame_bit = d_bits[53]; // CPR odd/even frame flag
            const long lat_cpr = static_cast<long>(bin2dec(54, 17));
            const long lon_cpr = static_cast<long>(bin2dec(71, 17));

            Plane& plane = update_plane(d_aa_str);
            plane.cpr[frame_bit][0] = static_cast<double>(lat_cpr);
            plane.cpr[frame_bit][1] = static_cast<double>(lon_cpr);
            plane.cpr[frame_bit][2] = static_cast<double>(now_seconds());

            double lat = std::nan("");
            double lon = std::nan("");
            calculate_lat_lon(plane.cpr, lat, lon);
            const long alt = decode_ac12(40);

            // Upstream's guard against publishing a position that jumped. Both
            // comparisons are against NaN until the plane has a fix, and NaN
            // compares false, so the first position of a track is never
            // published -- kept as-is so the two stay diffable.
            const bool valid_lat_lon = (lat - plane.latitude) < 0.1;
            if (!valid_lat_lon) {
                log("valid_lat_lon", "False");
                log("lat_cpr", lat_cpr);
                log("lon_cpr", lon_cpr);
                log("lat", fmt("%g", lat));
                log("lon", fmt("%g", lon));
            }

            plane.altitude = static_cast<double>(alt);
            if (!std::isnan(lat) && !std::isnan(lon)) {
                plane.latitude = lat;
                plane.longitude = lon;
            }

            if (valid_lat_lon)
                publish_decoded_pdu(d_aa_str);

            log("Surveillance Status (SS)", ss, kSsStr[ss]);
            log("Time", time_bit, kTStr[time_bit]);
            log("Latitude", fmt("%g", lat) + " N");
            log("Longitude", fmt("%g", lon) + " E");
            log("Altitude", std::to_string(alt) + " ft");
            return;
        }

        // --- Airborne Velocities ---
        if (tc == 19) {
            const int st = static_cast<int>(bin2dec(37, 3));

            if (st == 1 || st == 2) {
                const int ic = d_bits[40];        // Intent change flag
                const int s_ew = d_bits[45];      // Velocity sign east-west
                const long v_ew = static_cast<long>(bin2dec(46, 10));
                const int s_ns = d_bits[56];      // Velocity sign north-south
                const long v_ns = static_cast<long>(bin2dec(57, 10));
                const int vr_src = d_bits[67];    // Vertical rate source
                const int s_vr = d_bits[68];      // Vertical rate sign
                const long vr = static_cast<long>(bin2dec(69, 9));

                // s_ew = 0 is west to east, s_ns = 0 is south to north.
                double velocity_we = static_cast<double>(v_ew - 1);
                if (s_ew == 1)
                    velocity_we *= -1.0;
                double velocity_sn = static_cast<double>(v_ns - 1);
                if (s_ns == 1)
                    velocity_sn *= -1.0;

                const double speed =
                    std::sqrt(velocity_sn * velocity_sn + velocity_we * velocity_we);
                const double heading =
                    std::atan2(velocity_sn, velocity_we) * 360.0 / (2.0 * M_PI);

                // s_vr = 0 is ascending.
                double vertical_rate = static_cast<double>((vr - 1) * 64);
                if (s_vr == 1)
                    vertical_rate *= -1.0;

                Plane& plane = update_plane(d_aa_str);
                plane.speed = speed;
                plane.heading = heading;
                plane.vertical_rate = vertical_rate;
                publish_decoded_pdu(d_aa_str);

                log("Subtype (ST)", st, "Ground Velocity");
                log("Intent Change (IC)", ic, "No Change in Intent");
                log("Speed", fmt("%1.0f kt", speed));
                log("Heading", fmt("%1.0f", heading) + " deg (" + get_direction(heading) + ")");
                log("Climb", std::to_string(static_cast<long>(vertical_rate)) + " ft/min");
                log("Climb Source", vr_src,
                    vr_src == 0 ? "Geometric Source (GNSS or INS)" : "Barometric Source");
            } else if (st == 3 || st == 4) {
                log("Subtype (ST)", st, "Air Velocity");
            } else {
                log("DF=" + std::to_string(d_df) + " TC=" + std::to_string(tc) +
                        " ST=" + std::to_string(st),
                    "To be implemented");
            }
            return;
        }

        // Every remaining type code -- surface position, GNSS-height position,
        // test messages, status and the reserved ranges -- is unimplemented
        // upstream and goes out on the "unknown" port.
        log("TC", tc, "To be implemented");
        publish_unknown_pdu();
    }

    void decode_tisb_me()
    {
        log("TIS-B", "To be implemented");
        publish_unknown_pdu();
    }

    // -----------------------------------------------------------------------
    // Field decoders
    // -----------------------------------------------------------------------

    // Altitude Code, 12 bits (the ME field's form).
    long decode_ac12(int offset) const
    {
        const int q_bit = d_bits[offset + 7];
        if (q_bit == 0) {
            // Altitude in multiples of 100 ft, Gillham coded. Unimplemented
            // upstream.
            log("AC=12 Q-bit=0", "To be implemented");
            return -1;
        }
        // Q-bit = 1: multiples of 25 ft, with the Q-bit removed from the number.
        std::vector<int> bits;
        for (int i = 0; i < 12; i++) {
            if (i != 7)
                bits.push_back(d_bits[offset + i]);
        }
        return static_cast<long>(bin2dec(bits)) * 25 - 1000;
    }

    // (3.1.2.6.5.4) Altitude Code, 13 bits.
    long decode_ac13(int offset) const
    {
        if (bin2dec(offset, 13) == 0) {
            // All 13 bits zero means the altitude field is invalid.
            return -1;
        }

        const int m_bit = d_bits[offset + 6];
        if (m_bit != 0) {
            log("Units", "Metric", "To be implemented");
            return -1;
        }
        log("Units", "Standard");

        const int q_bit = d_bits[offset + 8];
        if (q_bit == 0) {
            // (3.1.1.7.12.2.3) Multiples of 100 ft, Gillham coded.
            log("AC=13 M-bit=0 Q-bit=0", "To be implemented");
            return -1;
        }

        // (3.1.2.6.5.4) Multiples of 25 ft, with the M- and Q-bits removed.
        std::vector<int> bits;
        for (int i = 0; i < 13; i++) {
            if (i != 6 && i != 8)
                bits.push_back(d_bits[offset + i]);
        }
        return static_cast<long>(bin2dec(bits)) * 25 - 1000;
    }

    // heading 0 is eastbound, 90 northbound, +/-180 westbound, -90 southbound.
    static std::string get_direction(double heading)
    {
        if (heading < 0)
            heading += 360.0;

        const int quad = static_cast<int>(std::floor(heading / 90.0));
        const double residual_angle = heading - quad * 90.0;
        const int sub_quad = static_cast<int>(std::floor((residual_angle + 22.5) / 45.0));

        static const char* const kDirs[4][3] = {
            { "E", "NE", "N" },
            { "N", "NW", "W" },
            { "W", "SW", "S" },
            { "S", "SE", "E" },
        };
        const int q = std::min(std::max(quad, 0), 3);
        const int s = std::min(std::max(sub_quad, 0), 2);
        return kDirs[q][s];
    }

    // Compact Position Reporting: recover a globally unambiguous position from
    // the most recent even and odd frame, if both are still fresh.
    static void calculate_lat_lon(const double cpr[2][3], double& lat_dec, double& lon_dec)
    {
        lat_dec = std::nan("");
        lon_dec = std::nan("");

        const double now = static_cast<double>(now_seconds());
        if (!((now - cpr[0][2]) < kCprTimeoutS && (now - cpr[1][2]) < kCprTimeoutS))
            return;

        const double lat_cpr_even = cpr[0][0] / 131072.0;
        const double lon_cpr_even = cpr[0][1] / 131072.0;
        const double lat_cpr_odd = cpr[1][0] / 131072.0;
        const double lon_cpr_odd = cpr[1][1] / 131072.0;

        // Latitude zone index.
        const int j =
            static_cast<int>(std::floor(59 * lat_cpr_even - 60 * lat_cpr_odd + 0.5));

        double lat_even = 360.0 / 60 * (python_mod(j, 60) + lat_cpr_even);
        if (lat_even >= 270)
            lat_even -= 360;

        double lat_odd = 360.0 / 59 * (python_mod(j, 59) + lat_cpr_odd);
        if (lat_odd >= 270)
            lat_odd -= 360;

        const int nl_even = cpr_nl(lat_even);
        const int nl_odd = cpr_nl(lat_odd);
        if (nl_even != nl_odd) {
            // The two frames are in different latitude zones; wait for more data.
            return;
        }

        if ((cpr[0][2] - cpr[1][2]) > 0) {
            // The even frame is the more recent one.
            lat_dec = lat_even;
            const int ni = cpr_n(lat_even, 0);
            const int m = static_cast<int>(std::floor(lon_cpr_even * (nl_even - 1) -
                                                      lon_cpr_odd * nl_even + 0.5));
            lon_dec = (360.0 / ni) * (python_mod(m, ni) + lon_cpr_even);
        } else {
            lat_dec = lat_odd;
            const int ni = cpr_n(lat_odd, 1);
            const int m = static_cast<int>(std::floor(lon_cpr_even * (nl_odd - 1) -
                                                      lon_cpr_odd * nl_odd + 0.5));
            lon_dec = (360.0 / ni) * (python_mod(m, ni) + lon_cpr_odd);
        }
        if (lon_dec >= 180.0)
            lon_dec -= 360.0;
    }

    // Python's % always returns a non-negative result for a positive modulus;
    // C++'s does not, and j and m here are routinely negative.
    static int python_mod(int value, int modulus)
    {
        const int rem = value % modulus;
        return (rem < 0) ? rem + modulus : rem;
    }

    static int cpr_n(double lat, int frame)
    {
        const int n = cpr_nl(lat) - frame;
        return (n > 1) ? n : 1;
    }

    // Number of longitude zones at a given latitude. The table is the one in the
    // ICAO spec, transcribed in decoder.py.
    static int cpr_nl(double lat)
    {
        if (lat < 0)
            lat = -lat;

        static const double kBounds[58] = {
            10.47047130, 14.82817437, 18.18626357, 21.02939493, 23.54504487,
            25.82924707, 27.93898710, 29.91135686, 31.77209708, 33.53993436,
            35.22899598, 36.85025108, 38.41241892, 39.92256684, 41.38651832,
            42.80914012, 44.19454951, 45.54626723, 46.86733252, 48.16039128,
            49.42776439, 50.67150166, 51.89342469, 53.09516153, 54.27817472,
            55.44378444, 56.59318756, 57.72747354, 58.84763776, 59.95459277,
            61.04917774, 62.13216659, 63.20427479, 64.26616523, 65.31845310,
            66.36171008, 67.39646774, 68.42322022, 69.44242631, 70.45451075,
            71.45986473, 72.45884545, 73.45177442, 74.43893416, 75.42056257,
            76.39684391, 77.36789461, 78.33374083, 79.29428225, 80.24923213,
            81.19801349, 82.13956981, 83.07199445, 83.99173563, 84.89166191,
            85.75541621, 86.53536998, 87.00000000,
        };
        for (int i = 0; i < 58; i++) {
            if (lat < kBounds[i])
                return 59 - i;
        }
        return 1;
    }

    // -----------------------------------------------------------------------
    const std::string d_msg_filter;
    const std::string d_error_corr;
    const bool d_verbose;
    const bool d_brief;

    // payload length -> syndrome -> the bit positions that produce it
    std::map<int, std::map<std::uint64_t, std::vector<int>>> d_crc_fix_lookup;

    std::map<std::string, Plane> d_planes;

    // Per-packet state, reset by decode_packet().
    std::vector<int> d_bits;
    double d_timestamp = 0.0;
    double d_snr = 0.0;
    std::string d_datetime;
    long d_aa = -1;
    std::string d_aa_str;
    int d_df = -1;
    int d_payload_length = -1;
};

} // namespace

framer_sptr make_framer(double fs, double threshold)
{
    return gnuradio::make_block_sptr<framer_impl>(fs, threshold);
}

gr::basic_block_sptr make_demod(double fs)
{
    return gnuradio::make_block_sptr<demod>(fs);
}

gr::basic_block_sptr make_decoder(const std::string& msg_filter,
                                  const std::string& error_corr,
                                  const std::string& print_level)
{
    return gnuradio::make_block_sptr<decoder>(msg_filter, error_corr, print_level);
}

} // namespace wasm_adsb
