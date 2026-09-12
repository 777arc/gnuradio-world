<!-- block: dtv_dvbt2_p1insertion_cc -->
<!-- title: P1 Symbol Insertion -->
<!-- source: https://wiki.gnuradio.org/index.php/P1_Symbol_Insertion -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Inserts a P1 symbol.

Input: OFDM T2 frame.
Output: OFDM T2 frame with P1 symbol.

## Parameters
- Extender carrier mode
  Number of carriers

- FFT size
  OFDM IFFT size

- Guard interval
  OFDM ISI guard interval

- Number of data symbols
  Number of OFDM symbols in a T2 frame.

- Specification version
  Changes available preamble types

- Preamble
  P1 symbol preamble format.

- Show peak IQ levels
  print peak IQ levels.

- Vclip
  Set peak IQ level threshold.

## Example Flowgraph
This flowgraph can be found at [https://raw.githubusercontent.com/gnuradio/gnuradio/master/gr-dtv/examples/germany-g1.grc]

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/lib/dvbt2/dvbt2_p1insertion_cc_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/lib/dvbt2/dvbt2_p1insertion_cc_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/include/gnuradio/dtv/dvbt2_p1insertion_cc.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/grc/dtv_dvbt2_p1insertion_cc.block.yml]
