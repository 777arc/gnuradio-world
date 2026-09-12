<!-- block: blocks_exponentiate_const_cci -->
<!-- title: Exponentiate Const Int -->
<!-- source: https://wiki.gnuradio.org/index.php/Exponentiate_Const_Int -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Exponentiates a complex stream with an integer exponent. This block raises a complex stream to an integer exponent.

NOTE: The algorithm uses iterative multiplication to achieve exponentiation, hence it is O(exponent). Therefore, this block could be inefficient for large exponents.

## Parameters
(R): Run-time adjustable

- Exponent (R)
  Exponent that the stream is raised to.  Must be a positive integer.

- Num Ports
  Number of input streams to apply the operation on.

## Example Flowgraph
This grc file for the following flowgraph can be downloaded from Media:exponentiate_const_int.grc.

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/lib/exponentiate_const_cci_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/lib/exponentiate_const_cci_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/include/gnuradio/blocks/exponentiate_const_cci.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/grc/blocks_exponentiate_const_cci.block.yml]
