<!-- block: dtv_catv_randomizer_bb -->
<!-- title: Randomizer -->
<!-- source: https://wiki.gnuradio.org/index.php/Randomizer -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

An ITU-T J.83B randomizer.

Randomizer: x^3 + x + alpha^3, 7-bit symbols.

- Input: Interleaved MPEG-2 + RS parity bitstream packets of 128 7-bit symbols.
- Output: Scrambled FEC Frame packets of 60 * 128 (64QAM) or 88 * 128 (256QAM) 7-bit symbols.

## Parameters
- Constellation
  64QAM or 256QAM constellation.

## Example Flowgraph
Insert description of flowgraph here, then show a screenshot of the flowgraph and the output if there is an interesting GUI.  Currently we have no standard method of uploading the actual flowgraph to the wiki or git repo, unfortunately.  The plan is to have an example flowgraph showing how the block might be used, for every block, and the flowgraphs will live in the git repo.

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/lib/catv/catv_randomizer_bb_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/lib/catv/catv_randomizer_bb_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/include/gnuradio/dtv/catv_randomizer_bb.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/grc/dtv_catv_randomizer_bb.block.yml]
