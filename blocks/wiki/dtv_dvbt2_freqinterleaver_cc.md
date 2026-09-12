<!-- block: dtv_dvbt2_freqinterleaver_cc -->
<!-- title: Frequency Interleaver -->
<!-- source: https://wiki.gnuradio.org/index.php/Frequency_Interleaver -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Frequency interleaves a T2 frame.

- Input: T2 frame.
- Output: Frequency interleaved T2 frame.

## Parameters
- Extended Carrier Mode
  number of carriers (normal or extended).

- FFT Size
  OFDM IFFT size.

- Pilot Pattern
  DVB-T2 pilot pattern (PP1 - PP8).

- Guard Interval
  OFDM ISI guard interval.

- Number of Data Symbols
  number of OFDM symbols in a T2 frame.

- PAPR Mode
  PAPR reduction mode.

- Specification Version
  DVB-T2 specification version.

- Preamble
  P1 symbol preamble format.

## Example Flowgraph
This flowgraph can be found at [https://raw.githubusercontent.com/gnuradio/gnuradio/master/gr-dtv/examples/germany-g1.grc]

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/lib/dvbt2/dvbt2_freqinterleaver_cc_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/lib/dvbt2/dvbt2_freqinterleaver_cc_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/include/gnuradio/dtv/dvbt2_freqinterleaver_cc.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/grc/dtv_dvbt2_freqinterleaver_cc.block.yml]
