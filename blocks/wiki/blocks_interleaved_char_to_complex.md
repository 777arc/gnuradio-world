<!-- block: blocks_interleaved_char_to_complex -->
<!-- title: IChar To Complex -->
<!-- source: https://wiki.gnuradio.org/index.php/IChar_To_Complex -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Convert stream of interleaved chars to a stream of complex.

See Complex To IChar for the creation of such a stream.

## Parameters
- Vector input
  Yes or No. Use vector input instead of interleaved samples for the I and Q channels. If vector input is chosen, then the input must be of type short. (The input does not change color but the output of the block at input must be in short.)

## Example Flowgraph
The following flowgraph takes an input from a vector source (short type) and converts it into complex data.

It has the following output.

## Source Files
- C++ files
  interleaved_char_to_complex_impl.h

- Header files
  interleaved_char_to_complex_impl.cc

- Public header files
  interleaved_char_to_complex.h

- Block definition
  blocks_interleaved_char_to_complex.block.yml
