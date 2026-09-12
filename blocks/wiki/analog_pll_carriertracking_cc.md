<!-- block: analog_pll_carriertracking_cc -->
<!-- title: PLL Carrier Tracking -->
<!-- source: https://wiki.gnuradio.org/index.php/PLL_Carrier_Tracking -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Implements a Phase Locked Loop (PLL) which locks to the carrier of the input frequency and outputs the input signal mixed with that carrier.

This PLL locks onto a [possibly noisy] reference carrier on the input and outputs that signal, downconverted to DC.

### Notes
- Important: The frequency parameters below are in radians per sample rather than Hz.

```
radians per sample = 2 * pi * centerfreq / sample rate
```

- Example:
- input signal, centered at 0Hz, centerfreq = 0 Hz.
- Sample rate = 48kHz.
- frequency variations to track +- 500Hz.
- Max Phase/sample = 2*pi*(0+500)/48,000 = 0.0654
- Min Phase/sample = 2*pi*(0-500)/48,000 = -0.0654
- If the input signal were centered at 10kHz,
- Then:
- The Max Phase/sample = 2*pi*(10,000+500)/48,000 = 1.374
- The Min Phase/sample = 2*pi*(10,000-500)/48,000 = 1.246

- This block seems to require an input signal of at least -30db in order to lock to the carrier.

## Parameters
(R): Run-time adjustable

- Loop bandwidth (R)
  The loop bandwidth determines the lock range and should be set in the range of pi/200 to 2pi/100 (0.0157 to 0.0628).

- Max freq
  Maximum frequency of the carrier in radians per sample. See Notes above.

- Min freq
  Minimum frequency of the carrier in radians per sample. See Notes above.

## Example Flowgraph
This flowgraph shows the use of a PLL Carrier Tracking block in an AM receiver.

## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  TODO
