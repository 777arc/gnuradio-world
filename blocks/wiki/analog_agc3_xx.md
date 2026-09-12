<!-- block: analog_agc3_xx -->
<!-- title: AGC3 -->
<!-- source: https://wiki.gnuradio.org/index.php/AGC3 -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

High performance Automatic Gain Control class with attack and decay rates.

Unlike the AGC2 loop, this uses an initial linear calculation at the beginning for very fast initial acquisition. Moves to IIR model for tracking purposes.
For Power the absolute value of the complex number is used.

## Parameters
(R): Run-time adjustable

- Attack rate (R)
  The update rate of the loop when in attack mode.
- Decay rate (R)
  The update rate of the loop when in decay mode.
- Reference (R)
  Reference value to adjust signal power to.
- Gain (R)
  Initial gain value.
- Max gain (R)
  Maximum gain value (0 for unlimited)
- IIR update decimation
  Stride by this number of samples before computing an IIR gain update

## Example Flowgraph
Media:example_agc3.grc
## Source Files
- C++ files
  Here

- Header files
  Here

- Public header files
  Here

- Block definition
  Yaml
