<!-- block: dtv_dvbt2_modulator_bc -->
<!-- title: DVB-T2 Modulator -->
<!-- source: https://wiki.gnuradio.org/index.php/DVB-T2_Modulator -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Modulates DVB-T2 cells.

Input: Bit interleaved (with column twist and bit to cell word de-multiplexing) cells.

Output: QPSK, 16QAM, 64QAM or 256QAM modulated complex IQ values (cells).

## Parameters
- FECFRAME Size
  FEC frame size (normal or short).

- Constellation
  DVB-T2 constellation.

- Constellation Rotation
  DVB-T2 constellation rotation (on or off).

## Example Flowgraph
This flowgraph can be found at [https://raw.githubusercontent.com/gnuradio/gnuradio/master/gr-dtv/examples/germany-g1.grc]

## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  TODO
