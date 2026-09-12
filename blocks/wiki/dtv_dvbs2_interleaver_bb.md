<!-- block: dtv_dvbs2_interleaver_bb -->
<!-- title: Interleaver -->
<!-- source: https://wiki.gnuradio.org/index.php/Interleaver -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Bit interleaves DVB-S2 FEC baseband frames.

Bit-interleaves DVB-S2 FEC baseband frames (after LDPC encoding) so that burst errors in the channel get spread across many codeword bits before demapping, improving decoder performance.

- Input: Normal or short FEC baseband frames with appended LPDC (LDPCFEC).
- Output: Bit interleaved baseband frames.

## Parameters
- FECFRAME size : FEC frame size (normal or short).
(NORMAL 64,800 or SHORT 16,200 bits)
- Code rate : FEC code rate.
`rate1..rate3` (the FEC code rate, selects which of the standard's rate tables applies).
- Constellation : DVB-S2 constellation.
(MOD_QPSK/8PSK/16APSK/32APSK)

## Example Flowgraph
[https://github.com/gnuradio/gnuradio/blob/main/gr-dtv/examples/dvbs2_tx.grc]

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-dtv/lib/dvbs2/dvbs2_interleaver_bb_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-dtv/lib/dvbs2/dvbs2_interleaver_bb_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-dtv/include/gnuradio/dtv/dvbs2_interleaver_bb.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/main/gr-dtv/grc/dtv_dvbs2_interleaver_bb.block.yml]
