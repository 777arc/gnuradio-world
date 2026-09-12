<!-- block: dtv_catv_reed_solomon_enc_bb -->
<!-- title: Reed-Solomon Encoder -->
<!-- source: https://wiki.gnuradio.org/index.php/Reed-Solomon_Encoder -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

ITU-T J.83B Reed Solomon Encoder, t=3, (128,122), 7-bit symbols.

- Input: MPEG-2 bitstream packets of 122 7-bit symbols.
- Output: MPEG-2 + RS parity bitstream packets of 128 7-bit symbols.

This is the ITU-T J.83B Reed Solomon Encoder. For the DVB-T one, go to Reed-Solomon Encoder DVBT

## Parameters
TO DO

## Example Flowgraph
## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/lib/catv/catv_reed_solomon_enc_bb_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/lib/catv/catv_reed_solomon_enc_bb_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/include/gnuradio/dtv/catv_reed_solomon_enc_bb.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/grc/dtv_catv_reed_solomon_enc_bb.block.yml]
