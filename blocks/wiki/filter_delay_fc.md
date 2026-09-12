<!-- block: filter_delay_fc -->
<!-- title: Filter Delay -->
<!-- source: https://wiki.gnuradio.org/index.php/Filter_Delay -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

The purpose of this block is to compensate the delay that a linear-phase filter introduces.

It does that by introducing a delay of half the length of the FIR tap vector on passed-through samples.

The block takes one or two float stream and outputs a stream composed of pairs of floats. (In GNU Radio, pairs of floats are identical to complex numbers, where the real and imaginary parts are the first and second element, respectively.)

If only one float stream is input, the first element of each output item is a delayed version of this input and the second element is the filtered output.

If two floats are connected to the input, then the first element of each output item is the delayed version of the first input, and the second element is the filtered second input.

The delay in the first elements of the output accounts for the group delay introduced by the filter in the second elements path under the assumption of linear-phase filtering. The filter taps need to be calculated before initializing this block.

## Parameters
- Taps
  The vector of real-valued taps. Half of the length of this vector is the delay introduced by this block.

## Example Flowgraph
Media:example_filter_delay.grc

## Source Files
- C++ files
  filter_delay_fc_impl.cc

- Header files
  filter_delay_fc_impl.h

- Public header files
  filter_delay_fc.h

- Block definition
  filter_filter_delay_fc.block.yml
