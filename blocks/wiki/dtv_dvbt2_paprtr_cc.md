<!-- block: dtv_dvbt2_paprtr_cc -->
<!-- title: Tone Reservation PAPR -->
<!-- source: https://wiki.gnuradio.org/index.php/Tone_Reservation_PAPR -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Peak to Average Power Ratio (PAPR) reduction.

- Input: A T2 frame of OFDM symbols.
- Output: A T2 frame of PAPR reduced OFDM symbols.

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

- Vclip
  PAPR clipping level.

- Iterations
  PAPR algorithm number of iterations.

## Example Flowgraph
Insert description of flowgraph here, then show a screenshot of the flowgraph and the output if there is an interesting GUI.  Currently we have no standard method of uploading the actual flowgraph to the wiki or git repo, unfortunately.  The plan is to have an example flowgraph showing how the block might be used, for every block, and the flowgraphs will live in the git repo.

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/lib/dvbt2/dvbt2_paprtr_cc_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/lib/dvbt2/dvbt2_paprtr_cc_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/include/gnuradio/dtv/dvbt2_paprtr_cc.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/grc/dtv_dvbt2_paprtr_cc.block.yml]
