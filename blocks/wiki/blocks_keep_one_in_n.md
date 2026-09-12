<!-- block: blocks_keep_one_in_n -->
<!-- title: Keep 1 in N -->
<!-- source: https://wiki.gnuradio.org/index.php/Keep_1_in_N -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Decimate a stream, keeping the last item out of every N.

Also see Keep M in N.

## Parameters
(R): Run-time adjustable

- Type
  Supported types are: complex, float, int, short, and byte.

- N (R)
  Block size, in items/samples. Acts as decimation rate.

- Vector Length
  The length of the vectors for the input stream.

## Example Flowgraph
Here is a simple flowgraph showing Keep 1 in N using the values in the description above.

The settings are:

The output is:

## Source Files
- C++ files
  keep_one_in_n_impl.cc

- Header files
  keep_one_in_n_impl.h

- Public header files
  keep_one_in_n.h

- Block definition
  blocks_keep_one_in_n.block.yml
