<!-- block: analog_phase_modulator_fc -->
<!-- title: Phase Mod -->
<!-- source: https://wiki.gnuradio.org/index.php/Phase_Mod -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Phase modulator.  output = complex(cos(in*sensitivity), sin(in*sensitivity))

## Parameters
(R): Run-time adjustable

- Sensitivity(R)
  See equation above.

## Example Flowgraph
Media:example_phase_mod.grc

## Source Files
- C++ files
  TODO

- Header files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-analog/lib/phase_modulator_fc_impl.h]
- Public header files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-analog/include/gnuradio/analog/phase_modulator_fc.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/main/gr-analog/lib/phase_modulator_fc_impl.cc]
