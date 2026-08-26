#pragma once

// Thread-safe note state and the Qt-free oscillator behind the SamSonic
// Musical Keyboard Source. Keeping this half independent of Qt and GNU Radio
// makes the signal behavior testable with an ordinary host compiler.

#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>
#include <cstddef>
#include <mutex>

namespace grworld {

enum class KeyboardChord {
    None,
    MajorTriad,
    MinorTriad,
    Tritone,
    MajorSeventh,
    MinorSeventh,
    FullyDiminishedSeventh,
};

enum class KeyboardWaveform { Sine, Triangle, Saw, Square };

struct ChordDefinition {
    std::array<int, 4> intervals{};
    int count = 1;
};

inline constexpr ChordDefinition chord_definition(KeyboardChord chord)
{
    switch (chord) {
    case KeyboardChord::MajorTriad:
        return { { 0, 4, 7, 0 }, 3 };
    case KeyboardChord::MinorTriad:
        return { { 0, 3, 7, 0 }, 3 };
    case KeyboardChord::Tritone:
        return { { 0, 6, 0, 0 }, 2 };
    case KeyboardChord::MajorSeventh:
        return { { 0, 4, 7, 11 }, 4 };
    case KeyboardChord::MinorSeventh:
        return { { 0, 3, 7, 10 }, 4 };
    case KeyboardChord::FullyDiminishedSeventh:
        return { { 0, 3, 6, 9 }, 4 };
    case KeyboardChord::None:
    default:
        return { { 0, 0, 0, 0 }, 1 };
    }
}

// The widget can receive the same root from more than one input path (a touch
// and a computer key, for example), hence counts rather than booleans. A chord
// is captured on the first press and deliberately does not morph if the combo
// box changes before that root is released.
class KeyboardNoteState
{
public:
    struct Snapshot {
        std::array<bool, 128> notes{};
        std::array<bool, 128> roots{};
    };

    void set_selected_chord(KeyboardChord chord)
    {
        std::lock_guard<std::mutex> lock(d_mutex);
        d_selected_chord = chord;
    }

    KeyboardChord selected_chord() const
    {
        std::lock_guard<std::mutex> lock(d_mutex);
        return d_selected_chord;
    }

    void press_root(int note)
    {
        if (note < 0 || note >= 128)
            return;
        std::lock_guard<std::mutex> lock(d_mutex);
        if (d_root_counts[static_cast<std::size_t>(note)]++ == 0)
            d_root_chords[static_cast<std::size_t>(note)] = d_selected_chord;
    }

    void release_root(int note)
    {
        if (note < 0 || note >= 128)
            return;
        std::lock_guard<std::mutex> lock(d_mutex);
        auto& count = d_root_counts[static_cast<std::size_t>(note)];
        if (count > 0)
            --count;
    }

    void release_all()
    {
        std::lock_guard<std::mutex> lock(d_mutex);
        d_root_counts.fill(0);
    }

    Snapshot snapshot() const
    {
        std::lock_guard<std::mutex> lock(d_mutex);
        Snapshot result;
        for (int root = 0; root < 128; ++root) {
            if (d_root_counts[static_cast<std::size_t>(root)] <= 0)
                continue;
            result.roots[static_cast<std::size_t>(root)] = true;
            const ChordDefinition chord =
                chord_definition(d_root_chords[static_cast<std::size_t>(root)]);
            for (int i = 0; i < chord.count; ++i) {
                const int note = root + chord.intervals[static_cast<std::size_t>(i)];
                if (note >= 0 && note < 128)
                    result.notes[static_cast<std::size_t>(note)] = true;
            }
        }
        return result;
    }

private:
    mutable std::mutex d_mutex;
    KeyboardChord d_selected_chord = KeyboardChord::None;
    std::array<int, 128> d_root_counts{};
    std::array<KeyboardChord, 128> d_root_chords{};
};

class MusicalKeyboardSynth
{
public:
    MusicalKeyboardSynth(double sample_rate,
                         double amplitude,
                         double tuning_hz,
                         double attack_ms,
                         double decay_ms,
                         double sustain_level,
                         double release_ms,
                         KeyboardWaveform waveform,
                         int unison_voices,
                         double unison_detune_cents,
                         double filter_cutoff_hz,
                         double filter_resonance,
                         double filter_envelope_octaves,
                         double saturation_drive)
        : d_sample_rate(std::max(1.0, sample_rate)),
          d_amplitude(clamp_amplitude(amplitude)),
          d_tuning_hz(clamp_positive(tuning_hz, 440.0)),
          d_attack_ms(clamp_time(attack_ms)),
          d_decay_ms(clamp_time(decay_ms)),
          d_sustain_level(clamp_unit(sustain_level)),
          d_release_ms(clamp_time(release_ms)),
          d_unison_voices(clamp_unison_voices(unison_voices)),
          d_unison_detune_cents(clamp_nonnegative(unison_detune_cents)),
          d_filter_cutoff_hz(clamp_positive(filter_cutoff_hz, 1200.0)),
          d_filter_resonance(clamp_unit(filter_resonance)),
          d_filter_envelope_octaves(clamp_nonnegative(filter_envelope_octaves)),
          d_saturation_drive(clamp_nonnegative(saturation_drive)),
          d_waveform(waveform)
    {
    }

    void set_amplitude(double value)
    {
        d_amplitude.store(clamp_amplitude(value), std::memory_order_relaxed);
    }

    void set_tuning_hz(double value)
    {
        d_tuning_hz.store(clamp_positive(value, 440.0), std::memory_order_relaxed);
    }

    void set_attack_ms(double value)
    {
        d_attack_ms.store(clamp_time(value), std::memory_order_relaxed);
    }

    void set_decay_ms(double value)
    {
        d_decay_ms.store(clamp_time(value), std::memory_order_relaxed);
    }

    void set_sustain_level(double value)
    {
        d_sustain_level.store(clamp_unit(value), std::memory_order_relaxed);
    }

    void set_release_ms(double value)
    {
        d_release_ms.store(clamp_time(value), std::memory_order_relaxed);
    }

    void set_unison_voices(double value)
    {
        d_unison_voices.store(clamp_unison_voices(static_cast<int>(std::lround(value))),
                              std::memory_order_relaxed);
    }

    void set_unison_detune_cents(double value)
    {
        d_unison_detune_cents.store(clamp_nonnegative(value),
                                    std::memory_order_relaxed);
    }

    void set_filter_cutoff_hz(double value)
    {
        d_filter_cutoff_hz.store(clamp_positive(value, 1200.0),
                                 std::memory_order_relaxed);
    }

    void set_filter_resonance(double value)
    {
        d_filter_resonance.store(clamp_unit(value), std::memory_order_relaxed);
    }

    void set_filter_envelope_octaves(double value)
    {
        d_filter_envelope_octaves.store(clamp_nonnegative(value),
                                        std::memory_order_relaxed);
    }

    void set_saturation_drive(double value)
    {
        d_saturation_drive.store(clamp_nonnegative(value),
                                 std::memory_order_relaxed);
    }

    void render(float* output,
                int count,
                const KeyboardNoteState::Snapshot& requested)
    {
        if (!output || count <= 0)
            return;

        const double tuning = d_tuning_hz.load(std::memory_order_relaxed);
        const int unison_voices =
            d_unison_voices.load(std::memory_order_relaxed);
        const double detune_cents =
            d_unison_detune_cents.load(std::memory_order_relaxed);
        const double nyquist = d_sample_rate * 0.49;
        for (int note = 0; note < 128; ++note) {
            Voice& voice = d_voices[static_cast<std::size_t>(note)];
            const double frequency =
                tuning * std::pow(2.0, (static_cast<double>(note) - 69.0) / 12.0);
            const bool target = requested.notes[static_cast<std::size_t>(note)] &&
                                frequency < nyquist;
            if (target && !voice.target) {
                if (voice.stage == EnvelopeStage::Idle) {
                    voice.phases.fill(0.0);
                    reset_filter(voice);
                }
                voice.stage = EnvelopeStage::Attack;
            } else if (!target && voice.target) {
                voice.stage = EnvelopeStage::Release;
                const double release_ms =
                    d_release_ms.load(std::memory_order_relaxed);
                voice.release_step = release_ms <= 0.0
                                         ? 1.0
                                         : voice.envelope * 1000.0 /
                                               (release_ms * d_sample_rate);
            }
            voice.target = target;
            for (int oscillator = 0; oscillator < unison_voices; ++oscillator) {
                const double position = unison_voices <= 1
                                            ? 0.0
                                            : static_cast<double>(oscillator) /
                                                      (unison_voices - 1) -
                                                  0.5;
                const double cents = position * detune_cents;
                voice.phase_steps[static_cast<std::size_t>(oscillator)] =
                    frequency * std::pow(2.0, cents / 1200.0) / d_sample_rate;
            }
        }

        const double attack_ms = d_attack_ms.load(std::memory_order_relaxed);
        const double decay_ms = d_decay_ms.load(std::memory_order_relaxed);
        const double sustain =
            d_sustain_level.load(std::memory_order_relaxed);
        const double attack_step = attack_ms <= 0.0
                                       ? 1.0
                                       : 1000.0 / (attack_ms * d_sample_rate);
        const double decay_step = decay_ms <= 0.0
                                      ? 1.0
                                      : (1.0 - sustain) * 1000.0 /
                                            (decay_ms * d_sample_rate);
        const double amplitude = d_amplitude.load(std::memory_order_relaxed);
        const double base_cutoff =
            d_filter_cutoff_hz.load(std::memory_order_relaxed);
        const double resonance =
            d_filter_resonance.load(std::memory_order_relaxed);
        const double filter_envelope_octaves =
            d_filter_envelope_octaves.load(std::memory_order_relaxed);
        const double saturation_drive =
            d_saturation_drive.load(std::memory_order_relaxed);

        for (int sample = 0; sample < count; ++sample) {
            double mixed = 0.0;
            int active_voices = 0;
            for (Voice& voice : d_voices) {
                advance_envelope(
                    voice, attack_step, decay_step, sustain);
                if (voice.stage == EnvelopeStage::Idle)
                    continue;

                double oscillators = 0.0;
                for (int oscillator = 0; oscillator < unison_voices; ++oscillator) {
                    auto& phase = voice.phases[static_cast<std::size_t>(oscillator)];
                    const double phase_step =
                        voice.phase_steps[static_cast<std::size_t>(oscillator)];
                    oscillators += waveform_sample(phase, phase_step);
                    phase += phase_step;
                    phase -= std::floor(phase);
                }
                oscillators /= unison_voices;

                const double cutoff = std::clamp(
                    base_cutoff *
                        std::pow(2.0, filter_envelope_octaves * voice.envelope),
                    10.0,
                    d_sample_rate * 0.45);
                const double filtered = lowpass(voice, oscillators, cutoff, resonance);
                mixed += filtered * voice.envelope;
                ++active_voices;
            }
            // Average the sounding voices, but never divide by their envelope
            // values: doing that cancels a single voice's attack/release gain
            // and leaves it at full volume until an abrupt cutoff. Counting a
            // releasing voice until it reaches zero keeps chords bounded while
            // preserving the actual envelope on every oscillator.
            if (active_voices <= 0) {
                output[sample] = 0.0F;
                continue;
            }
            const double dry = amplitude * mixed / active_voices;
            output[sample] = static_cast<float>(soft_saturate(dry, saturation_drive));
        }
    }

private:
    enum class EnvelopeStage { Idle, Attack, Decay, Sustain, Release };

    struct Voice {
        std::array<double, 3> phases{};
        std::array<double, 3> phase_steps{};
        double envelope = 0.0;
        double release_step = 1.0;
        double filter_ic1 = 0.0;
        double filter_ic2 = 0.0;
        bool target = false;
        EnvelopeStage stage = EnvelopeStage::Idle;
    };

    static double clamp_amplitude(double value)
    {
        return std::clamp(std::isfinite(value) ? value : 0.0, 0.0, 1.0);
    }

    static double clamp_positive(double value, double fallback)
    {
        return std::isfinite(value) && value > 0.0 ? value : fallback;
    }

    static double clamp_time(double value)
    {
        return std::max(0.0, std::isfinite(value) ? value : 0.0);
    }

    static double clamp_unit(double value)
    {
        return std::clamp(std::isfinite(value) ? value : 0.0, 0.0, 1.0);
    }

    static double clamp_nonnegative(double value)
    {
        return std::max(0.0, std::isfinite(value) ? value : 0.0);
    }

    static int clamp_unison_voices(int value)
    {
        return std::clamp(value, 1, 3);
    }

    static double poly_blep(double phase, double phase_step)
    {
        const double width = std::clamp(phase_step, 1e-12, 0.499999);
        if (phase < width) {
            const double x = phase / width;
            return x + x - x * x - 1.0;
        }
        if (phase > 1.0 - width) {
            const double x = (phase - 1.0) / width;
            return x * x + x + x + 1.0;
        }
        return 0.0;
    }

    double waveform_sample(double phase, double phase_step) const
    {
        switch (d_waveform) {
        case KeyboardWaveform::Triangle:
            return 1.0 - 4.0 * std::abs(phase - 0.5);
        case KeyboardWaveform::Saw:
            return 2.0 * phase - 1.0 - poly_blep(phase, phase_step);
        case KeyboardWaveform::Square: {
            double value = phase < 0.5 ? 1.0 : -1.0;
            value += poly_blep(phase, phase_step);
            double second_edge = phase + 0.5;
            second_edge -= std::floor(second_edge);
            value -= poly_blep(second_edge, phase_step);
            return value;
        }
        case KeyboardWaveform::Sine:
        default:
            return std::sin(6.28318530717958647692 * phase);
        }
    }

    static void reset_filter(Voice& voice)
    {
        voice.filter_ic1 = 0.0;
        voice.filter_ic2 = 0.0;
    }

    void advance_envelope(Voice& voice,
                          double attack_step,
                          double decay_step,
                          double sustain) const
    {
        switch (voice.stage) {
        case EnvelopeStage::Idle:
            voice.envelope = 0.0;
            return;
        case EnvelopeStage::Attack:
            voice.envelope = std::min(1.0, voice.envelope + attack_step);
            if (voice.envelope >= 1.0)
                voice.stage = EnvelopeStage::Decay;
            break;
        case EnvelopeStage::Decay:
            if (voice.envelope <= sustain + decay_step) {
                voice.envelope = sustain;
                voice.stage = EnvelopeStage::Sustain;
            } else {
                voice.envelope -= decay_step;
            }
            break;
        case EnvelopeStage::Sustain:
            voice.envelope = sustain;
            break;
        case EnvelopeStage::Release:
            if (voice.envelope <= voice.release_step + 1e-12) {
                voice.envelope = 0.0;
                voice.stage = EnvelopeStage::Idle;
                reset_filter(voice);
            } else {
                voice.envelope -= voice.release_step;
            }
            break;
        }
    }

    double lowpass(Voice& voice,
                   double input,
                   double cutoff_hz,
                   double resonance) const
    {
        // Topology-preserving state-variable filter. Resonance maps 0..1 to
        // Q 0.5..20 while the cutoff clamp keeps tan() away from Nyquist.
        const double g = std::tan(3.14159265358979323846 * cutoff_hz / d_sample_rate);
        const double damping = 2.0 - 1.95 * resonance;
        const double a1 = 1.0 / (1.0 + g * (g + damping));
        const double v1 = a1 * (voice.filter_ic1 + g * (input - voice.filter_ic2));
        const double v2 = voice.filter_ic2 + g * v1;
        voice.filter_ic1 = 2.0 * v1 - voice.filter_ic1;
        voice.filter_ic2 = 2.0 * v2 - voice.filter_ic2;
        return v2;
    }

    static double soft_saturate(double value, double drive)
    {
        if (drive <= 0.0)
            return value;
        const double gain = 1.0 + drive;
        return std::tanh(gain * value) / std::tanh(gain);
    }

    double d_sample_rate;
    std::atomic<double> d_amplitude;
    std::atomic<double> d_tuning_hz;
    std::atomic<double> d_attack_ms;
    std::atomic<double> d_decay_ms;
    std::atomic<double> d_sustain_level;
    std::atomic<double> d_release_ms;
    std::atomic<int> d_unison_voices;
    std::atomic<double> d_unison_detune_cents;
    std::atomic<double> d_filter_cutoff_hz;
    std::atomic<double> d_filter_resonance;
    std::atomic<double> d_filter_envelope_octaves;
    std::atomic<double> d_saturation_drive;
    KeyboardWaveform d_waveform;
    std::array<Voice, 128> d_voices{};
};

} // namespace grworld
