<!-- block: dtv_catv_frame_sync_enc_bb -->
<!-- title: Frame Sync Encoder -->
<!-- source: https://wiki.gnuradio.org/index.php/Frame_Sync_Encoder -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

ITU-T J.83B Frame Sync Encoder. Adds a 42-bit (64QAM) or 40-bit (256QAM) frame sync pattern with control word.

- Input: Scrambled FEC Frame packets of 60 * 128 (64QAM) or 88 * 128 (256QAM) 7-bit symbols.

- Output: Scrambled FEC Frame packets of 60 * 128 (64QAM) or 88 * 128 (256QAM) 7-bit symbols with 42-bit (64QAM) or 40-bit (256QAM) FSYNC word.

## Parameters
- Constellation
  64QAM or 256QAM constellation.

- Control Word
  Convolutional interleaver control word.

## Example Flowgraph
Insert description of flowgraph here, then show a screenshot of the flowgraph and the output if there is an interesting GUI.  Currently we have no standard method of uploading the actual flowgraph to the wiki or git repo, unfortunately.  The plan is to have an example flowgraph showing how the block might be used, for every block, and the flowgraphs will live in the git repo.

## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  TODO
