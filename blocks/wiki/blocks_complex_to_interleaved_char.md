<!-- block: blocks_complex_to_interleaved_char -->
<!-- title: Complex To IChar -->
<!-- source: https://wiki.gnuradio.org/index.php/Complex_To_IChar -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Convert stream of complex to a stream of interleaved chars.  The output stream contains chars with twice as many output items as input items. For every complex input item, we produce two output chars that contain the real part and imaginary part converted to chars.

## Parameters
- Vector Output
  Instead of producing twice as many output items as input items, setting this to true will use vectors of length 2 as the output.

## Example Flowgraph
This flowgraph can be downloaded from Media:Type_conv.grc.

## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  TODO
