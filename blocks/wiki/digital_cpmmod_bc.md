<!-- block: digital_cpmmod_bc -->
<!-- title: Continuous Phase Modulation -->
<!-- source: https://wiki.gnuradio.org/index.php/Continuous_Phase_Modulation -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Generic CPM modulator.

The input of this block are symbols from an M-ary alphabet +/-1, +/-3, ..., +/-(M-1). Usually, M = 2 and therefore, the valid inputs are +/-1. The modulator will silently accept any other inputs, though. The output is the phase-modulated signal.

## Parameters
- CPM Type
  The modulation type. Can be one of LREC, LRC, LSRC, TFM or GAUSSIAN. See gr_cpm::phase_response() for a detailed description.

- Modulation Index
  Maximum phase change that can occur between two symbols, i.e., if you only send ones, the phase will increase by  every  samples. Set this to 0.5 for Minimum Shift Keying variants.

- Samples per Symbol
  Self explanatory

- Pulse Duration (symbols)
  The length of the phase duration in symbols. For L=1, this yields full- response CPM symbols, for L > 1, partial-response.

- Phase Response Parameter (BT or beta)
  For LSRC, this is the rolloff factor. For Gaussian pulses, this is the 3 dB time-bandwidth product.

## Example Flowgraph
Insert description of flowgraph here, then show a screenshot of the flowgraph and the output if there is an interesting GUI.  Currently we have no standard method of uploading the actual flowgraph to the wiki or git repo, unfortunately.  The plan is to have an example flowgraph showing how the block might be used, for every block, and the flowgraphs will live in the git repo.

## Source Files
- C++ files
  cpmmod_bc_impl.cc

- Header files
  cpmmod_bc_impl.h

- Public header files
  cpmmod_bc.h

- Block definition
  digital_cpmmod_bc.block.yml
