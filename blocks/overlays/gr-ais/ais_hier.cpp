// C++ rebuilds of gr-ais's Python hierarchies. Each class mirrors the block set
// and connection order of the file named above it, so a diff against the
// Python stays readable; the table math at the top is cpm_trellis.py line for
// line, with numpy's array steps spelled out as loops.
// SPDX-License-Identifier: GPL-3.0-or-later
#include "ais_hier.hpp"

#include <gnuradio/ais/burst_sync_cc.h>
#include <gnuradio/ais/freqest.h>
#include <gnuradio/ais/invert.h>
#include <gnuradio/ais/viterbi_cpm_cb.h>
#include <gnuradio/analog/feedforward_agc_cc.h>
#include <gnuradio/analog/frequency_modulator_fc.h>
#include <gnuradio/analog/quadrature_demod_cf.h>
#include <gnuradio/blocks/multiply.h>
#include <gnuradio/blocks/repeat.h>
#include <gnuradio/blocks/stream_to_vector.h>
#include <gnuradio/digital/binary_slicer_fb.h>
#include <gnuradio/digital/corr_est_cc.h>
#include <gnuradio/digital/diff_decoder_bb.h>
#include <gnuradio/digital/symbol_sync_cc.h>
#include <gnuradio/digital/timing_error_detector_type.h>
#include <gnuradio/fft/fft_v.h>
#include <gnuradio/fft/window.h>
#include <gnuradio/filter/firdes.h>
#include <gnuradio/fxpt.h>
#include <gnuradio/hier_block2.h>
#include <gnuradio/io_signature.h>

#include <cmath>
#include <complex>
#include <cstdint>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace wasm_ais {
namespace {

constexpr double kPi = 3.14159265358979323846;

// cpm_trellis.py's module constants.
constexpr int kRampSymbols = 8;
constexpr int kPreambleSymbols = 24;
constexpr int kFlagBits[8] = { 0, 1, 1, 1, 1, 1, 1, 0 };
constexpr int kReferenceStartSymbol = 16;
constexpr int kReferenceSymbols = 24;
constexpr int kSlotSymbols = 256;
constexpr int kDefaultTracebackLen = 48;
constexpr float kDefaultPhaseGain = 0.1F;

// burst_demod.py
constexpr double kHypothesisSpacingHz = 200.0;

// ais_demod.py's fixed choices: the feedforward AGC window and reference, the
// GMSK BT of the correlator's reference, corr_est's mark delay and threshold,
// symbol_sync's damping and TED gain, and the discriminator's sensitivity.
constexpr int kAgcSamples = 512;
constexpr float kAgcReference = 2.0F;
constexpr double kGmskBt = 0.4;
constexpr unsigned kMarkDelay = 1;
constexpr float kCorrThreshold = 0.9F;
constexpr float kLoopDamping = 1.0F;
constexpr float kTedGain = 1.0F;
constexpr int kDiffModulus = 2;

// gmsk_mod's pulse: firdes.gaussian convolved with a one-symbol rectangle
// (numpy.convolve(gaussian_taps, (1,)*sps)).
std::vector<double> gaussian_nrz_taps(int sps, double bt)
{
    const std::vector<float> gauss =
        gr::filter::firdes::gaussian(1.0, sps, bt, 4 * sps);
    std::vector<double> taps(gauss.size() + sps - 1, 0.0);
    for (std::size_t i = 0; i < gauss.size(); ++i)
        for (int j = 0; j < sps; ++j)
            taps[i + j] += gauss[i];
    return taps;
}

// digital.modulate_vector_bc(digital.gmsk_mod(sps, bt), data, [1]) without
// the nested top_block it runs -- a flowgraph cannot be run from inside a
// constructor here. Same arithmetic as the chain: packed_to_unpacked
// (MSB first) -> chunks_to_symbols {-1, +1} -> interp_fir_filter_fff, which is
// a zero-history causal convolution of the upsampled symbols -> the fixed-point
// frequency_modulator_fc, reproduced through the same gr::fxpt sincos so the
// reference matches what native GRC would hand corr_est_cc.
std::vector<gr_complex> gmsk_modulate_packed(const std::vector<std::uint8_t>& data,
                                             int sps,
                                             double bt)
{
    const std::vector<double> taps = gaussian_nrz_taps(sps, bt);
    std::vector<float> nrz;
    nrz.reserve(data.size() * 8);
    for (std::uint8_t byte : data)
        for (int b = 7; b >= 0; --b)
            nrz.push_back(((byte >> b) & 1) ? 1.0F : -1.0F);

    const float sensitivity = static_cast<float>((kPi / 2.0) / sps);
    std::vector<gr_complex> out(nrz.size() * sps);
    float phase = 0.0F;
    for (std::size_t k = 0; k < out.size(); ++k) {
        // y[k] = sum_j taps[j] * u[k - j], u the zero-stuffed symbols.
        float y = 0.0F;
        for (std::size_t j = k % sps; j < taps.size() && j <= k; j += sps)
            y += static_cast<float>(taps[j]) * nrz[(k - j) / sps];
        phase += sensitivity * y;
        phase = std::fmod(phase + static_cast<float>(kPi), 2.0F * static_cast<float>(kPi)) -
                static_cast<float>(kPi);
        float oi, oq;
        gr::fxpt::sincos(gr::fxpt::float_to_fixed(phase), &oq, &oi);
        out[k] = gr_complex(oi, oq);
    }
    return out;
}

// cpm_trellis.py _nrzi()
std::vector<int> nrzi(const std::vector<int>& bits)
{
    std::vector<int> out;
    out.reserve(bits.size());
    int level = 1;
    for (int bit : bits) {
        if (bit == 0)
            level ^= 1;
        out.push_back(level);
    }
    return out;
}

// cpm_trellis.py _chain(): run `nsym` NRZI levels through the trellis from
// symbol `start`, seeding the history with the levels before it. Returns the
// modulated waveform and the state reached.
std::pair<std::vector<gr_complex>, int> chain(const GmskTrellis& t,
                                              int sps,
                                              const std::vector<int>& levels,
                                              int start,
                                              int nsym)
{
    int history_bits = 0;
    for (int n = t.num_states / 4; n > 1; n >>= 1)
        ++history_bits;
    int state = 0;
    for (int i = start - history_bits; i < start; ++i)
        state = state * 2 + levels[i];
    std::vector<gr_complex> out;
    out.reserve(static_cast<std::size_t>(nsym) * sps);
    for (int i = start; i < start + nsym; ++i) {
        const int branch = state * 2 + levels[i];
        out.insert(out.end(),
                   t.signals.begin() + static_cast<std::ptrdiff_t>(branch) * sps,
                   t.signals.begin() + static_cast<std::ptrdiff_t>(branch + 1) * sps);
        state = t.next_state[branch];
    }
    return { out, state };
}

// cpm_trellis.py gmsk_burst_reference()
struct BurstReference {
    std::vector<gr_complex> reference;
    int tag_offset;
    int seed_state_a;
    int seed_state_b;
};
BurstReference gmsk_burst_reference(int sps, double bt = kGmskBt)
{
    const GmskTrellis t = gmsk_trellis(sps, bt);
    std::vector<int> prefix;
    for (int i = 0; i < (kRampSymbols + kPreambleSymbols) / 2; ++i) {
        prefix.push_back(0);
        prefix.push_back(1);
    }
    prefix.insert(prefix.end(), std::begin(kFlagBits), std::end(kFlagBits));
    const std::vector<int> levels_a = nrzi(prefix);
    std::vector<int> levels_b;
    for (int lvl : levels_a)
        levels_b.push_back(1 - lvl);
    const int tag_symbol = kRampSymbols + kPreambleSymbols - 1;
    BurstReference ref;
    ref.reference = chain(t, sps, levels_a, kReferenceStartSymbol, kReferenceSymbols).first;
    ref.seed_state_a =
        chain(t, sps, levels_a, kReferenceStartSymbol, tag_symbol - kReferenceStartSymbol).second;
    ref.seed_state_b =
        chain(t, sps, levels_b, kReferenceStartSymbol, tag_symbol - kReferenceStartSymbol).second;
    ref.tag_offset = (tag_symbol - kReferenceStartSymbol) * sps;
    return ref;
}

// python/ais/gmsk_sync.py
class SquareAndFftSync : public gr::hier_block2
{
public:
    SquareAndFftSync(double samplerate, double bits_per_sec, int fftlen)
        : gr::hier_block2("square_and_fft_sync_cc",
                          gr::io_signature::make(1, 1, sizeof(gr_complex)),
                          gr::io_signature::make(1, 1, sizeof(gr_complex)))
    {
        if (fftlen < 2)
            throw std::invalid_argument("square_and_fft_sync_cc: fftlen must be at least 2");
        // this is just the old square-and-fft method
        // ais.freqest is simply looking for peaks spaced bits-per-sec apart
        auto square = gr::blocks::multiply_cc::make(1);
        auto fftvect = gr::blocks::stream_to_vector::make(sizeof(gr_complex), fftlen);
        auto fft = gr::fft::fft_v<gr_complex, true>::make(
            fftlen, gr::fft::window::rectangular(fftlen), true);
        auto freqest = gr::ais::freqest::make(static_cast<float>(static_cast<int>(samplerate)),
                                              static_cast<int>(bits_per_sec),
                                              fftlen);
        auto repeat = gr::blocks::repeat::make(sizeof(float), fftlen);
        auto fm = gr::analog::frequency_modulator_fc::make(
            static_cast<float>(-1.0 / (samplerate / (2 * kPi))));
        auto mix = gr::blocks::multiply_cc::make(1);

        connect(self(), 0, square, 0);
        connect(self(), 0, square, 1);
        // this is the feedforward branch
        connect(self(), 0, mix, 0);
        // this is the feedback branch
        connect(square, 0, fftvect, 0);
        connect(fftvect, 0, fft, 0);
        connect(fft, 0, freqest, 0);
        connect(freqest, 0, repeat, 0);
        connect(repeat, 0, fm, 0);
        connect(fm, 0, mix, 1);
        // and this is the output
        connect(mix, 0, self(), 0);
    }
};

// python/ais/ais_demod.py
class AisDemod : public gr::hier_block2
{
public:
    AisDemod(double samples_per_symbol,
             double bits_per_sec,
             double clockrec_gain,
             double omega_relative_limit,
             int fftlen,
             bool coherent)
        : gr::hier_block2("ais_demod",
                          gr::io_signature::make(1, 1, sizeof(gr_complex)),
                          gr::io_signature::make(1, 1, sizeof(char)))
    {
        // gmsk_mod truncates to an integer rate and refuses anything under 2.
        const int mod_sps = static_cast<int>(samples_per_symbol);
        if (mod_sps < 2)
            throw std::invalid_argument("ais_demod: samples_per_symbol must be at least 2");
        const double samplerate = samples_per_symbol * bits_per_sec;
        auto freq_sync = gnuradio::make_block_sptr<SquareAndFftSync>(
            samplerate, bits_per_sec, fftlen);
        auto agc = gr::analog::feedforward_agc_cc::make(kAgcSamples, kAgcReference);
        // Upstream hands gmsk_mod the *packed* bytes [1,1,0,0]*7 with its
        // default do_unpack, so the correlator's reference is the modulation
        // of those 28 bytes' 224 bits. Reproduced as is: it is what the
        // shipped receiver correlates against, and its QA passes with it.
        std::vector<std::uint8_t> preamble;
        for (int i = 0; i < 7; ++i)
            preamble.insert(preamble.end(), { 1, 1, 0, 0 });
        const std::vector<gr_complex> mod_vector =
            gmsk_modulate_packed(preamble, mod_sps, kGmskBt);
        auto preamble_detect = gr::digital::corr_est_cc::make(
            mod_vector, static_cast<float>(samples_per_symbol), kMarkDelay, kCorrThreshold);

        const int clockrec_osps = coherent ? 2 : 1;
        // the D'Andrea-Mengali generalized MSK TED operates on the CPM signal
        // directly and is seeded by the time_est tags from the correlator.
        auto clockrec = gr::digital::symbol_sync_cc::make(
            gr::digital::TED_DANDREA_AND_MENGALI_GEN_MSK,
            static_cast<float>(samples_per_symbol),
            static_cast<float>(clockrec_gain),
            kLoopDamping,
            kTedGain,
            static_cast<float>(omega_relative_limit * samples_per_symbol),
            clockrec_osps);

        auto diff = gr::digital::diff_decoder_bb::make(kDiffModulus);
        // NRZI signal diff decoded and inverted should give original signal
        auto invert = gr::ais::invert::make();

        std::vector<gr::basic_block_sptr> chain{ self(), freq_sync, agc, preamble_detect,
                                                 clockrec };
        if (coherent) {
            const GmskTrellis t = gmsk_trellis(clockrec_osps);
            auto trellis_demod = gr::ais::viterbi_cpm_cb::make(
                t.signals, t.next_state, clockrec_osps, kDefaultTracebackLen, kDefaultPhaseGain);
            chain.push_back(trellis_demod);
        } else {
            auto demod = gr::analog::quadrature_demod_cf::make(
                static_cast<float>(kPi / 2)); // param is gain
            auto slicer = gr::digital::binary_slicer_fb::make();
            chain.push_back(demod);
            chain.push_back(slicer);
        }
        chain.push_back(diff);
        chain.push_back(invert);
        chain.push_back(self());
        for (std::size_t i = 1; i < chain.size(); ++i)
            connect(chain[i - 1], 0, chain[i], 0);
    }
};

// python/ais/burst_demod.py
class AisBurstDemod : public gr::hier_block2
{
public:
    AisBurstDemod(int sps,
                  double bits_per_sec,
                  double freq_span,
                  double threshold,
                  int burst_slots)
        : gr::hier_block2("ais_burst_demod",
                          gr::io_signature::make(1, 1, sizeof(gr_complex)),
                          gr::io_signature::make(1, 1, sizeof(char)))
    {
        if (sps < 1)
            throw std::invalid_argument("ais_burst_demod: samples_per_symbol must be a positive integer");
        if (burst_slots < 1)
            throw std::invalid_argument("ais_burst_demod: burst_slots must be a positive integer");

        const GmskTrellis t = gmsk_trellis(sps);
        const BurstReference ref = gmsk_burst_reference(sps);
        // np.arange(-freq_span, freq_span + 1.0, HYPOTHESIS_SPACING_HZ)
        std::vector<float> hypotheses;
        for (double f = -freq_span; f < freq_span + 1.0; f += kHypothesisSpacingHz)
            hypotheses.push_back(static_cast<float>(f));

        // Resume one reference window before the next expected peak, so
        // its preamble shoulders enter the synchronizer's peak search.
        const int holdoff = (burst_slots * kSlotSymbols - kReferenceSymbols) * sps;
        auto sync = gr::ais::burst_sync_cc::make(ref.reference,
                                                 sps * bits_per_sec,
                                                 hypotheses,
                                                 static_cast<float>(threshold),
                                                 ref.tag_offset,
                                                 ref.seed_state_a,
                                                 ref.seed_state_b,
                                                 holdoff);
        auto trellis_demod = gr::ais::viterbi_cpm_cb::make(
            t.signals, t.next_state, sps, kDefaultTracebackLen, kDefaultPhaseGain);
        auto diff = gr::digital::diff_decoder_bb::make(kDiffModulus);
        auto invert = gr::ais::invert::make();

        connect(self(), 0, sync, 0);
        connect(sync, 0, trellis_demod, 0);
        connect(trellis_demod, 0, diff, 0);
        connect(diff, 0, invert, 0);
        connect(invert, 0, self(), 0);
    }
};

} // namespace

GmskTrellis gmsk_trellis(int sps, double bt)
{
    if (sps < 1)
        throw std::invalid_argument("gmsk_trellis: samples_per_symbol must be positive");
    const std::vector<double> taps = gaussian_nrz_taps(sps, bt);
    const int memory = static_cast<int>(std::ceil(static_cast<double>(taps.size()) / sps));
    const double sensitivity = (kPi / 2) / sps;
    // cum = concatenate([cumsum(taps), full(memory * sps, taps.sum())])
    std::vector<double> cum;
    cum.reserve(taps.size() + static_cast<std::size_t>(memory) * sps);
    double sum = 0.0;
    for (double tap : taps) {
        sum += tap;
        cum.push_back(sum);
    }
    cum.insert(cum.end(), static_cast<std::size_t>(memory) * sps, sum);

    const int history_states = 1 << (memory - 1);
    GmskTrellis t;
    t.num_states = 4 * history_states;
    t.signals.assign(static_cast<std::size_t>(t.num_states) * 2 * sps, gr_complex(0, 0));
    t.next_state.assign(static_cast<std::size_t>(t.num_states) * 2, 0);
    std::vector<int> history(memory - 1), symbols(memory);
    std::vector<double> phase(sps);
    for (int phase_idx = 0; phase_idx < 4; ++phase_idx) {
        for (int hist = 0; hist < history_states; ++hist) {
            // the last memory-1 input bits, oldest first (most significant)
            for (int m = 0; m < memory - 1; ++m)
                history[m] = (hist >> (memory - 2 - m)) & 1;
            for (int bit = 0; bit < 2; ++bit) {
                for (int m = 0; m < memory - 1; ++m)
                    symbols[m] = history[m];
                symbols[memory - 1] = bit;
                for (int i = 0; i < sps; ++i)
                    phase[i] = phase_idx * kPi / 2;
                for (int age = 0; age < memory; ++age) {
                    const int nrz = 2 * symbols[memory - 1 - age] - 1;
                    for (int i = 0; i < sps; ++i)
                        phase[i] += sensitivity * nrz * cum[static_cast<std::size_t>(age) * sps + i];
                }
                const int branch = (phase_idx * history_states + hist) * 2 + bit;
                for (int i = 0; i < sps; ++i)
                    t.signals[static_cast<std::size_t>(branch) * sps + i] =
                        gr_complex(static_cast<float>(std::cos(phase[i])),
                                   static_cast<float>(std::sin(phase[i])));
                // Python's % is non-negative; the phase step is +-1.
                const int next_phase_idx = (phase_idx + (2 * history[0] - 1) + 4) % 4;
                int next_hist = 0;
                for (int m = 1; m < memory - 1; ++m)
                    next_hist = next_hist * 2 + history[m];
                next_hist = next_hist * 2 + bit;
                t.next_state[branch] = next_phase_idx * history_states + next_hist;
            }
        }
    }
    return t;
}

gr::basic_block_sptr make_square_and_fft_sync(double sample_rate,
                                              double bits_per_sec,
                                              int fftlen)
{
    return gnuradio::make_block_sptr<SquareAndFftSync>(sample_rate, bits_per_sec, fftlen);
}

gr::basic_block_sptr make_ais_demod(double samples_per_symbol,
                                    double bits_per_sec,
                                    double clockrec_gain,
                                    double omega_relative_limit,
                                    int fftlen,
                                    bool coherent)
{
    return gnuradio::make_block_sptr<AisDemod>(samples_per_symbol,
                                               bits_per_sec,
                                               clockrec_gain,
                                               omega_relative_limit,
                                               fftlen,
                                               coherent);
}

gr::basic_block_sptr make_ais_burst_demod(int samples_per_symbol,
                                          double bits_per_sec,
                                          double freq_span,
                                          double threshold,
                                          int burst_slots)
{
    return gnuradio::make_block_sptr<AisBurstDemod>(
        samples_per_symbol, bits_per_sec, freq_span, threshold, burst_slots);
}

gr::basic_block_sptr make_gmsk_viterbi(int samples_per_symbol,
                                       int traceback_len,
                                       double phase_gain)
{
    const GmskTrellis t = gmsk_trellis(samples_per_symbol);
    return gr::ais::viterbi_cpm_cb::make(t.signals,
                                         t.next_state,
                                         samples_per_symbol,
                                         traceback_len,
                                         static_cast<float>(phase_gain));
}

} // namespace wasm_ais
