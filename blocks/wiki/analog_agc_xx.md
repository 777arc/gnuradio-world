<!-- block: analog_agc_xx -->
<!-- title: AGC -->
<!-- source: https://wiki.gnuradio.org/index.php/AGC -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

High performance Automatic Gain Control. Power is approximated by absolute value.

Here is a diagram showing how it works:

## Parameters
(R): Run-time adjustable

- Rate (R)
  The update rate of the loop.
- Reference (R)
  Reference value to adjust signal power to.
- Gain (R)
  Initial gain value.
- Max gain (R)
  Maximum gain value (0 for unlimited)

## Example Flowgraph
This flowgraph shows an Automatic Gain Control block in an AM receiver.

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
