<!-- block: dtv_dvb_bch_bb -->
<!-- title: BCH Encoder -->
<!-- source: https://wiki.gnuradio.org/index.php/BCH_Encoder -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Part of the DVB block set.  Encodes a BCH ((Bose, Chaudhuri, Hocquenghem) FEC.

Input: Variable length FEC baseband frames (BBFRAME).

Output: Variable length FEC baseband frames with appended BCH (BCHFEC).

## Parameters
- Standard
  DVB standard (DVB-S2 or DVB-T2).

- FEC Frame Size
  FEC frame size (normal, medium or short).

- Code Rate
  FEC code rate.

## Example Flowgraph
This flowgraph can be found at [https://raw.githubusercontent.com/gnuradio/gnuradio/master/gr-dtv/examples/germany-g1.grc]

## Source Files
