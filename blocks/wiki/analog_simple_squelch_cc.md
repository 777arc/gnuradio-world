<!-- block: analog_simple_squelch_cc -->
<!-- title: Simple Squelch -->
<!-- source: https://wiki.gnuradio.org/index.php/Simple_Squelch -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Simple squelch block based on average signal power and threshold in dB. The output equals the input if the average input is >= the threshold, and zero otherwise.

The average is computed using a Single Pole IIR filter. It uses the magnitude squared for both averaging and for comparing to the threshold.

## Parameters
(R): Run-time adjustable

- Threshold (R)
  Threshold for muting.

- Alpha
  Gain parameter for the running average filter.

## Example Flowgraph
This flowgraph shows a Simple Squelch block in a working 2 meter receiver.

## Source Files
- C++ files
  simple_squelch_cc_impl.cc

- Header files
  simple_squelch_cc_impl.h

- Public header files
  TODO

- Block definition
  analog_simple_squelch_cc.block.yml
