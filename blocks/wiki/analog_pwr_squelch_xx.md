<!-- block: analog_pwr_squelch_xx -->
<!-- title: Power Squelch -->
<!-- source: https://wiki.gnuradio.org/index.php/Power_Squelch -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This will either pass the input unchanged, or block it, depending on whether its envelope is over a certain threshold. The envelope is calculated by taking the squared magnitude of the signal and lowpassing it with a single pole IIR filter (with the specified alpha).

The ramp parameter specifies the attack / release time, in samples.  A sinusodial ramp is used to progressively mute / unmute the input.  If ramp is set to 0, input is muted / unmuted without a ramp.

For realtime applications you'll want to set the gate parameter to false, which produces zeros when the input is muted. If it is true, the block will stop producing samples when in muted state.

The block will emit a tag with the key "squelch_sob" with the value of PMT_NIL on the first item it passes, and with the key "squelch_eob" on the last item it passes.

## Parameters
(R): Run-time adjustable

- Threshold (R)
  Threshold (in dB) for power squelch

- Alpha (R)
  Gain of averaging filter. Defaults to 0.0001.

- Ramp
  Attack/release time in samples; a sinusodial ramp is used. Set to 0 to disable.

- Gate
  If true, no output if no squelch tone. if false, output 0's if no squelch tone.

## Example Flowgraph
Media:example_power_squelch.grc
## Source Files
- C++ files
  Float Input
  Complex Input
  Base squelch class, Float Input
  Base squelch class, Complex Input

- Header files
  Float Input
  Complex Input
  Base squelch class, Float Input
  Base squelch class, Complex Input

- Public header files
  Float Input
  Complex Input
  Base squelch class, Float Input
  Base squelch class, Complex Input

- Block definition
  Yaml
