<!-- block: blocks_char_to_float -->
<!-- title: Char To Float -->
<!-- source: https://wiki.gnuradio.org/index.php/Char_To_Float -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Convert stream of chars to a stream of float and applies a scaling factor (set to 1 by default).

## Parameters
(R): Run-time adjustable

- Scale (R)
  Scaling factor applied to input stream.

## Example Flowgraph
This flowgraph compares this block with the Char To Short which multiplies by 256 by default.  Note that the signal source is generating random numbers between 0 and 128.

## Source Files
- C++ files
  char_to_float_impl.cc

- Header files
  char_to_float_impl.h

- Public header files
  char_to_float.h

- Block definition
  blocks_char_to_float.block.yml
