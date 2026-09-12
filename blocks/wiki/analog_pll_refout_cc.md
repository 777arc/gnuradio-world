<!-- block: analog_pll_refout_cc -->
<!-- title: PLL Carrier Regeneration -->
<!-- source: https://wiki.gnuradio.org/index.php/PLL_Carrier_Regeneration -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Implements a PLL which locks to the input frequency and outputs a carrier.

This PLL locks onto a [possibly noisy] reference carrier on the input and outputs a clean version which is phase and frequency aligned to it.

## Parameters
(R): Run-time adjustable

- Loop bandwidth (R)
  The loop bandwidth determines the lock range and should be set around pi/200  2pi/100.

- Max freq
  Maximum frequency of the carrier in radians per sample

- Min freq
  Minimum frequency of the carrier in radians per sample

## Example Flowgraph
This flowgraph implements a Broadcast FM stereo receiver using basic blocks. The PLL captures the 19kHz pilot carrier.

## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  TODO
