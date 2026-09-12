<!-- block: dtv_dvbt2_framemapper_cc -->
<!-- title: Frame Mapper -->
<!-- source: https://wiki.gnuradio.org/index.php/Frame_Mapper -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Maps T2 frames.

- Input: Cell and time interleaved QPSK, 16QAM, 64QAM or 256QAM modulated cells.
- Output: T2 frame.

## Parameters
- FECFRAME size
  FEC frame size (normal or short).

- Code rate
  FEC code rate.

- Constellation
  DVB-T2 constellation.

- Constellation rotation
  DVB-T2 constellation rotation (on or off).

- FEC blocks per frame
  number of FEC frames in a T2 frame.

- TI blocks per frame
  number of time interleaving blocks in a T2 frame.

- Extended Carrier Mode
  number of carriers (normal or extended).

- FFT Size
  OFDM IFFT size.

- Guard Interval
  OFDM ISI guard interval.

- L1 Constellation
  L1 constellation.

- Pilot Pattern
  DVB-T2 pilot pattern (PP1 - PP8).

- T2 Frames per Super-frame
  number of T2 frames in a super-frame.

- Number of Data Symbols
  number of OFDM symbols in a T2 frame.

- PAPR Mode
  PAPR reduction mode.

- Specification Version
  DVB-T2 specification version.

- Preamble
  P1 symbol preamble format.

- Baseband Framing Mode
  Baseband Header mode.

- Reserved Bits Bias Balancing
  set all L1 bias bits to 1 (on or off).

- L1-post Scrambling
  scramble L1 post signalling (on or off).

- In-band Signalling
  In-band type B signalling (on or off).

## Example Flowgraph
This flowgraph can be found at [https://raw.githubusercontent.com/gnuradio/gnuradio/master/gr-dtv/examples/germany-g1.grc]

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/lib/dvbt2/dvbt2_framemapper_cc_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/lib/dvbt2/dvbt2_framemapper_cc_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/include/gnuradio/dtv/dvbt2_framemapper_cc.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/grc/dtv_dvbt2_framemapper_cc.block.yml]
