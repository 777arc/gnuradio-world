<!-- block: dtv_dvb_ldpc_bb -->
<!-- title: LDPC Encoder -->
<!-- source: https://wiki.gnuradio.org/index.php/LDPC_Encoder -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Encodes a LDPC (Low-Density Parity-Check) FEC

- Input: Variable length FEC baseband frames with appended BCH (BCHFEC).
- Output: Normal, medium or short FEC baseband frames with appended LPDC (LDPCFEC).

## Parameters
- Standard
  DVB standard

- FECFRAME size
  FEC frame size

- Code rate
  FEC code rate

- Constellation
  DVB-S2 constellation

## Example Flowgraph
This flowgraph can be found at [https://raw.githubusercontent.com/gnuradio/gnuradio/master/gr-dtv/examples/germany-g1.grc]

## Source Files
- C++ files
  dvb_ldpc_bb_impl.cc

- Header files
  dvb_ldpc_bb_impl.h

- Public header files
  dvb_ldpc_bb.h

- Block definition
  dtv_dvb_ldpc_bb.block.yml
