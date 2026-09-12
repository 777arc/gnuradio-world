<!-- block: blocks_complex_to_interleaved_short -->
<!-- title: Complex To IShort -->
<!-- source: https://wiki.gnuradio.org/index.php/Complex_To_IShort -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Convert stream of complex to a stream of interleaved shorts.  The output stream contains shorts with twice as many output items as input items. For every complex input item, we produce two output shorts that contain the real part and imaginary part converted to shorts.

Opposite of IShort To Complex

## Parameters
- Vector Output
  Instead of producing twice as many output items as input items, setting this to true will use vectors of length 2 as the output.

## Example Flowgraph
This flowgraph can be downloaded from Media:Type_conv.grc.

## Source Files
- C++ files
  complex_to_interleaved_char_impl.cc

- Header files
  complex_to_interleaved_char_impl.h

- Public header files
  complex_to_interleaved_char.h

- Block definition
  blocks_complex_to_interleaved_char.block.yml
