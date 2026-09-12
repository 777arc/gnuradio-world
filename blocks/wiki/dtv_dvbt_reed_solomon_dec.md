<!-- block: dtv_dvbt_reed_solomon_dec -->
<!-- title: Reed-Solomon Decoder -->
<!-- source: https://wiki.gnuradio.org/index.php/Reed-Solomon_Decoder -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Reed Solomon decoder.

ETSI EN 300 744 Clause 4.3.2

RS(N=204,K=239,T=8).

## Parameters
- p
  characteristic of GF(p^m).

- m
  we use GF(p^m).

- GF polynomial
  Generator Polynomial.

- N
  length of codeword of RS coder.

- K
  length of information sequence of RS decoder.

- t
  number of corrected errors.

- Shortening size
  shortened length.

- Blocks
  number of blocks to process at once.

## Example Flowgraph
This flowgraph can be found at [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/examples/dvbt_rx_8k.grc].

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/lib/dvbt/dvbt_reed_solomon_dec_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/lib/dvbt/dvbt_reed_solomon_dec_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/include/gnuradio/dtv/dvbt_reed_solomon_dec.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/grc/dtv_dvbt_reed_solomon_dec.block.yml]
