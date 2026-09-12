<!-- block: blocks_head -->
<!-- title: Head -->
<!-- source: https://wiki.gnuradio.org/index.php/Head -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Copies the first N items to the output then signals done.  Very useful for limiting how many samples get saved to a file when using the File Sink.

If the flowgraph options are set to "No GUI" and "Run until completion", then as long as there is only one branch in the flowgraph, this block will cause the flowgraph execution to finish when N samples are reached.

When branching, may block others branches: samples are not consumed and fill upstream buffers.

## Parameters
- Num Items
  Number of samples to copy

- Vec Length
  Size of the input and output vector

## Example Flowgraph
In this setup, both Time sinks will stop after the Head has reach the specified number of items. The Upstream time sink may see more items than the downstream one, depending on the size of the buffer between the source and the head.

## Source Files
- C++ Files
head_impl.cc

- Header files
head_impl.h

- Public header files
head.h

- Block definition
blocks_head.block.yml
