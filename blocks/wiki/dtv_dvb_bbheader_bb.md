<!-- block: dtv_dvb_bbheader_bb -->
<!-- title: BBheader -->
<!-- source: https://wiki.gnuradio.org/index.php/BBheader -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Part of the DVB block set.  Formats MPEG-2 Transport Stream packets into FEC baseband frames and adds a 10-byte header.

Input: 188-byte MPEG-2 Transport Stream packets.

Output: Variable length FEC baseband frames (BBFRAME). The output frame length is based on the FEC rate.

## Parameters
- Standard
  DVB standard (DVB-S2 or DVB-T2).

- FEC FRAME Size
  FEC frame size (normal, medium or short).

- Code Rate
  FEC code rate

- Rolloff Factor
  DVB-S2 root-raised-cosine filter roll-off

## Example Flowgraph
This flowgraph can be found at [https://raw.githubusercontent.com/gnuradio/gnuradio/master/gr-dtv/examples/germany-g1.grc]

## Source Files
