<!-- block: blocks_streams_to_vector -->
<!-- title: Streams to Vector -->
<!-- source: https://wiki.gnuradio.org/index.php/Streams_to_Vector -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Convert N streams of items to one stream of vector length N.

If Vec Length > 1: Convert N streams of vectors of length M to one stream of vector length N*M.

All the input streams have the same size.

## Parameters
- Num Streams
  Number of input streams

- Vec Length
  Length of the input vectors

## Example Flowgraph
## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/lib/streams_to_vector_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/lib/streams_to_vector_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/include/gnuradio/blocks/streams_to_vector.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/grc/blocks_streams_to_vector.block.yml]
