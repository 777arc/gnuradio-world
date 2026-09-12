<!-- block: dtv_dvbt2_interleaver_bb -->
<!-- title: Bit Interleaver -->
<!-- source: https://wiki.gnuradio.org/index.php/Bit_Interleaver -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Part of the DVB block set. Bit interleaves DVB-T2 FEC baseband frames.

Input: Normal or short FEC baseband frames with appended LPDC (LDPCFEC).

Output: Bit interleaved (with column twist and bit to cell word de-multiplexed) cells.

## Parameters
- FEC Frame Size
  FEC frame size (normal or short).

- Code Rate
  FEC code rate.

- Constellation
  DVB-T2 constellation.

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
