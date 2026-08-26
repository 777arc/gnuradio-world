#include "../../blocks/src/musical_keyboard_synth.hpp"

#include <algorithm>
#include <cassert>
#include <cmath>
#include <iostream>
#include <vector>

using namespace grworld;

int main()
{
    assert((chord_definition(KeyboardChord::MajorTriad).intervals ==
            std::array<int, 4>{ 0, 4, 7, 0 }));
    assert((chord_definition(KeyboardChord::MinorTriad).intervals ==
            std::array<int, 4>{ 0, 3, 7, 0 }));
    assert((chord_definition(KeyboardChord::Tritone).intervals ==
            std::array<int, 4>{ 0, 6, 0, 0 }));
    assert((chord_definition(KeyboardChord::MajorSeventh).intervals ==
            std::array<int, 4>{ 0, 4, 7, 11 }));
    assert((chord_definition(KeyboardChord::MinorSeventh).intervals ==
            std::array<int, 4>{ 0, 3, 7, 10 }));
    assert((chord_definition(KeyboardChord::FullyDiminishedSeventh).intervals ==
            std::array<int, 4>{ 0, 3, 6, 9 }));

    KeyboardNoteState state;
    state.set_selected_chord(KeyboardChord::MajorTriad);
    state.press_root(60);
    auto snapshot = state.snapshot();
    assert(snapshot.roots[60]);
    assert(snapshot.notes[60] && snapshot.notes[64] && snapshot.notes[67]);
    assert(!snapshot.notes[63] && !snapshot.notes[71]);

    // Changing the menu does not morph a chord which is already held.
    state.set_selected_chord(KeyboardChord::MinorTriad);
    snapshot = state.snapshot();
    assert(snapshot.notes[64] && !snapshot.notes[63]);

    // An overlapping root remains active after the original chord is released.
    state.press_root(64);
    state.release_root(60);
    snapshot = state.snapshot();
    assert(snapshot.roots[64] && snapshot.notes[64]);
    assert(snapshot.notes[67] && snapshot.notes[71]);
    assert(!snapshot.notes[60]);
    state.release_all();

    // One sine oscillator, an effectively open filter, sustain at full level,
    // and no saturation give the simple reference signal used by the legacy
    // keyboard tests.
    MusicalKeyboardSynth synth(48000.0,
                               0.5,
                               440.0,
                               0.0,
                               0.0,
                               1.0,
                               10.0,
                               KeyboardWaveform::Sine,
                               1,
                               0.0,
                               20000.0,
                               0.0,
                               0.0,
                               0.0);
    std::vector<float> output(4800, 1.0F);
    synth.render(output.data(), static_cast<int>(output.size()), state.snapshot());
    assert(std::all_of(output.begin(), output.end(), [](float value) {
        return value == 0.0F;
    }));

    state.set_selected_chord(KeyboardChord::None);
    state.press_root(69);
    synth.render(output.data(), static_cast<int>(output.size()), state.snapshot());
    const float peak = *std::max_element(output.begin(), output.end());
    assert(peak > 0.49F && peak <= 0.5F);
    int zero_crossings = 0;
    for (std::size_t i = 1; i < output.size(); ++i) {
        if ((output[i - 1] < 0.0F && output[i] >= 0.0F) ||
            (output[i - 1] >= 0.0F && output[i] < 0.0F))
            ++zero_crossings;
    }
    assert(zero_crossings >= 87 && zero_crossings <= 89);

    state.release_root(69);
    // A 10 ms release must attenuate across the whole tail. The old mixer
    // divided by the sum of envelopes, which canceled the envelope for one
    // voice: all four quarters stayed at full amplitude and only the final
    // sample snapped to zero, heard as a brief high-frequency click/chirp.
    output.assign(480, 1.0F);
    synth.render(output.data(), static_cast<int>(output.size()), state.snapshot());
    const auto quarter_peak = [&output](std::size_t begin, std::size_t end) {
        float result = 0.0F;
        for (std::size_t i = begin; i < end; ++i)
            result = std::max(result, std::abs(output[i]));
        return result;
    };
    assert(quarter_peak(0, 120) > 0.45F);
    assert(quarter_peak(360, 480) < 0.13F);
    assert(quarter_peak(432, 480) < 0.055F);
    assert(output.back() == 0.0F);

    // The synth preset exercises the richer signal path: PolyBLEP saws,
    // detuned unison, ADSR, envelope-driven resonant filtering, and saturation.
    MusicalKeyboardSynth subtractive(48000.0,
                                     0.18,
                                     440.0,
                                     5.0,
                                     180.0,
                                     0.6,
                                     120.0,
                                     KeyboardWaveform::Saw,
                                     2,
                                     9.0,
                                     700.0,
                                     0.25,
                                     3.0,
                                     1.0);
    state.press_root(60);
    output.assign(48000, 0.0F);
    subtractive.render(output.data(), static_cast<int>(output.size()), state.snapshot());
    assert(std::all_of(output.begin(), output.end(), [](float value) {
        return std::isfinite(value) && std::abs(value) <= 1.0F;
    }));
    const float synth_peak = *std::max_element(output.begin(), output.end());
    const float synth_floor = *std::min_element(output.begin(), output.end());
    assert(synth_peak > 0.05F && synth_floor < -0.05F);

    state.release_root(60);
    output.assign(6000, 1.0F);
    subtractive.render(output.data(), static_cast<int>(output.size()), state.snapshot());
    assert(output.back() == 0.0F);
    subtractive.render(output.data(), static_cast<int>(output.size()), state.snapshot());
    assert(std::all_of(output.begin(), output.end(), [](float value) {
        return value == 0.0F;
    }));

    std::cout << "musical keyboard synth tests passed\n";
}
