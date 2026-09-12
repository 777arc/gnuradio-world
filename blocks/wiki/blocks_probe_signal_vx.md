<!-- block: blocks_probe_signal_vx -->
<!-- title: Probe Signal Vector -->
<!-- source: https://wiki.gnuradio.org/index.php/Probe_Signal_Vector -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Sink that allows a vector of samples to be grabbed from Python.
The recovered vector is the last item received by the previous work function.

Use with the Function Probe block. Available functions to probe: level()

## Parameters
- Vec Length
  Size of the input vector to recover. If 1, the block is equivalent to Probe Signal

## Example Flowgraph
Insert description of flowgraph here, then show a screenshot of the flowgraph and the output if there is an interesting GUI.  Currently we have no standard method of uploading the actual flowgraph to the wiki or git repo, unfortunately.  The plan is to have an example flowgraph showing how the block might be used, for every block, and the flowgraphs will live in the git repo.

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/lib/probe_signal_v_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/lib/probe_signal_v_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/include/gnuradio/blocks/probe_signal_v.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/grc/blocks_probe_signal_vx.block.yml]
