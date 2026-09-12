<!-- block: blocks_probe_rate -->
<!-- title: Probe Rate -->
<!-- source: https://wiki.gnuradio.org/index.php/Probe_Rate -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

__NOTOC__

Used to measure throughput (how many items/samples are flowing through per second).  Note that this block outputs a message, you will need to use a Message Debug to display the probe results in the console.

## Parameters
- Min Update Time (ms)
  Minimum update time in milliseconds

- Update Alpha
  Gain for running average filter

- Name
  Specify for identification of the the Probe Rate block. Useful, for example, when printing the output of multiple Probe Rate blocks, e.g., with Message Debug

## Example Flowgraph
In this flowgraph, the Probe Rate block is measuring the sample rate of the Audio Source block.

## Source Files
- C++ files
  probe_rate_impl.cc

- Header files
  probe_rate_impl.h

- Public header files
  probe_rate.h

- Block definition
  blocks_probe_rate.block.yml
