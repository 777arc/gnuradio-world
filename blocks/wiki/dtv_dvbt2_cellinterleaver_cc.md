<!-- block: dtv_dvbt2_cellinterleaver_cc -->
<!-- title: Cell/Time Interleaver -->
<!-- source: https://wiki.gnuradio.org/index.php/Cell/Time_Interleaver -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Cell and time interleaves QPSK/QAM modulated cells.

- Input: QPSK, 16QAM, 64QAM or 256QAM modulated cells.
- Output: Cell and time interleaved QPSK, 16QAM, 64QAM or 256QAM modulated cells.

## Parameters
(R): Run-time adjustable

- FECFRAME size : FEC frame size (normal or short).

- Constellation : DVB-T2 constellation.

- FEC blocks per frame : number of FEC frames in a T2 frame.

- TI blocks per frame : number of time interleaving blocks in a T2 frame.

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
