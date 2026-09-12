<!-- block: blocks_complex_to_arg -->
<!-- title: Complex to Arg -->
<!-- source: https://wiki.gnuradio.org/index.php/Complex_to_Arg -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This block takes in a complex stream and outputs each complex value's arg (a.k.a. arctan, see  The output is a float.

## Parameters
None

## Mathematical Description
Assuming an input of c[n = r[n] + i[n]j, then the output of this block corresponds to arctan(i[n]/r[n]).

## Example Flowgraph
This is a frequency demodulator. The blocks from the output of the FFT Low Pass Filter to the output of the Multiply Const block is equal to the Quadrature Demod block.

## Source Files
- C++ files
  complex_to_arg_impl.cc

- Header files
  complex_to_arg_impl.h

- Public header files
  complex_to_arg.h

- Block definition
  blocks_complex_to_arg.block.yml
