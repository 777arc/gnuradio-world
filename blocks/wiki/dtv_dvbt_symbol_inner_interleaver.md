<!-- block: dtv_dvbt_symbol_inner_interleaver -->
<!-- title: Symbol Inner Interleaver -->
<!-- source: https://wiki.gnuradio.org/index.php/Symbol_Inner_Interleaver -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Symbol interleaver.

ETSI EN 300 744 Clause 4.3.4.2

One block is 12 groups x 126 datawords = 1512 datawords.

- Data Input format:
  000000I0I1 - QPSK.
  0000I0I1I2I3 - 16QAM.
  00I0I1I2I3I4I5 - 64QAM.
- Data Output format:
  000000Y0Y1 - QPSK.
  0000Y0Y1Y2Y3 - 16QAM.
  00Y0Y1Y2Y3Y4Y5 - 64QAM.

## Parameters
- Transmission Mode
  transmission mode used

- Direction
  interleave or deinterleave.

## Example Flowgraph
This flowgraph can be found at [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/examples/dvbt_rx_8k.grc].

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/lib/dvbt/dvbt_symbol_inner_interleaver_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/lib/dvbt/dvbt_symbol_inner_interleaver_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/include/gnuradio/dtv/dvbt_symbol_inner_interleaver.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/grc/dtv_dvbt_symbol_inner_interleaver.block.yml]
