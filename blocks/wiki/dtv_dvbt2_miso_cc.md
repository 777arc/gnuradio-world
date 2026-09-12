<!-- block: dtv_dvbt2_miso_cc -->
<!-- title: MISO Processing -->
<!-- source: https://wiki.gnuradio.org/index.php/MISO_Processing -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Splits the stream for MISO (Multiple Input Single Output).

- Input: Frequency interleaved T2 frame.
- Output1: Frequency interleaved T2 frame (copy of input).
- Output2: Frequency interleaved T2 frame with modified Alamouti processing.

## Parameters
- Extended carrier mode
  Number of carriers

- FFT size
  OFDM IFFT size

- Pilot pattern
  DVB-T2 pilot pattern

- Guard interval
  OFDM ISI guard interval.

- Number of data symbols
  Number of OFDM symbols in a T2 frame

- PAPR mode
  PAPR reduction mode

- Specification version
  Changes PAPR modes available

## Example Flowgraph
Insert description of flowgraph here, then show a screenshot of the flowgraph and the output if there is an interesting GUI.  Currently we have no standard method of uploading the actual flowgraph to the wiki or git repo, unfortunately.  The plan is to have an example flowgraph showing how the block might be used, for every block, and the flowgraphs will live in the git repo.

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/lib/dvbt2/dvbt2_miso_cc_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/lib/dvbt2/dvbt2_miso_cc_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/include/gnuradio/dtv/dvbt2_miso_cc.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/grc/dtv_dvbt2_miso_cc.block.yml]
