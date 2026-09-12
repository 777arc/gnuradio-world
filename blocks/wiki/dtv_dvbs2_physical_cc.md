<!-- block: dtv_dvbs2_physical_cc -->
<!-- title: Physical Layer Framer -->
<!-- source: https://wiki.gnuradio.org/index.php/Physical_Layer_Framer -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Signals DVB-S2 physical layer frames.

- Input: QPSK, 8PSK, 16APSK or 32APSK modulated complex IQ values (XFECFRAME).

- Output: DVB-S2 PLFRAME.

## Parameters
- FECFRAME size
  FEC frame size

- Code rate
  FEC code rate

- Constellation
  DVB-S2 constellation

- Pilots
  Pilot symbols

- Gold Code
  Physical layer scrambler Gold code (0 to 262141 inclusive).

## Example Flowgraph
[https://github.com/gnuradio/gnuradio/blob/main/gr-dtv/examples/dvbs2_tx.grc]

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-dtv/lib/dvbs2/dvbs2_physical_cc_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-dtv/lib/dvbs2/dvbs2_physical_cc_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-dtv/include/gnuradio/dtv/dvbs2_physical_cc.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/main/gr-dtv/grc/dtv_dvbs2_physical_cc.block.yml]
