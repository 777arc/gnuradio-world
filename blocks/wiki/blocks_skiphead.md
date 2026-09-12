<!-- block: blocks_skiphead -->
<!-- title: Skip Head -->
<!-- source: https://wiki.gnuradio.org/index.php/Skip_Head -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Skips the first N items, from then on copies items to the output.  Useful for building test cases and sources which have metadata or junk at the start.

## Parameters
- Num Items
  Number of items/samples to skip at the beginning.

## Example Flowgraph
This flowgraph can be downloaded from Media:Vector_sink_nongui.grc.
## Source Files
- C++ files
  skiphead_impl.cc

- Header files
  skiphead_impl.h

- Public header files
  skiphead.h

- Block definition
  blocks_skiphead.block.yml
