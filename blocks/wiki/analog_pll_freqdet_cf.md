<!-- block: analog_pll_freqdet_cf -->
<!-- title: PLL Frequency Detector -->
<!-- source: https://wiki.gnuradio.org/index.php/PLL_Frequency_Detector -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Implements a PLL which locks to the input frequency and outputs an estimate of that frequency. Useful for FM Demod.

This PLL locks onto a [possibly noisy] reference carrier on the input and outputs an estimate of that frequency in radians per sample

## Parameters
(R): Run-time adjustable

- Loop bandwidth (R)
  The loop bandwidth determines the lock range and should be set around pi/200  2pi/100.

- Max freq
  Maximum frequency of the carrier in radians per sample

- Min freq
  Minimum frequency of the carrier in radians per sample

## Example Flowgraph
### Simple Usage Example
PLL Freq Det can be used to detect the frequency of a (noisy) single tone.

This minimal demo does nothing than allow the user to adjust a Signal Source's frequency, and then estimate the same.

### Doppler Sonar
The flow graph below demonstrates a functioning Doppler sonar, which allows the user to estimate the speed of an object moving towards the speaker. (For this to work, the microphone and the speaker need to point into the same direction, not at each other; ideally, the microphone is directive, so that it doesn't pick up as much crosstalk from the speaker next to it.)

## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  TODO
