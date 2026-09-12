<!-- block: analog_agc2_xx -->
<!-- title: AGC2 -->
<!-- source: https://wiki.gnuradio.org/index.php/AGC2 -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

High performance Automatic Gain Control class with attack and decay rates.

For Power the absolute value of the complex number is used.

If the attack and decay rates are the same, this block is identical to AGC
## Parameters
(R): Run-time adjustable

- Attack_rate (R)
  The update rate of the loop when in attack mode.
- Decay_rate (R)
  The update rate of the loop when in decay mode.
- Reference (R)
  Reference value to adjust signal power to.
- Gain (R)
  Initial gain value.
- Max gain (R)
  Maximum gain value (0 for unlimited)

## Example Flowgraph
Media:example_agc2.grc
## Source Files
- C++ files
  Complex input
  Float input
  Algorithms implementation

- Header files
  Complex input
  Float input

- Public header files
  Complex input
  Float input

- Block definition
  Yaml
