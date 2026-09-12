<!-- block: blocks_vector_to_streams -->
<!-- title: Vector to Streams -->
<!-- source: https://wiki.gnuradio.org/index.php/Vector_to_Streams -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Convert one stream of vectors of length N to N streams of items.

More precisely: Convert one stream of vectors of length N*M to N streams of vectors of length M.

## Parameters
- Num streams
  Number of different streams to output

- Vec Length
  Length of the vectors at the output.

## Example Flowgraph
Media:example_vector_to_streams.grc

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-blocks/lib/vector_to_streams_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-blocks/lib/vector_to_streams_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-blocks/include/gnuradio/blocks/vector_to_streams.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/main/gr-blocks/grc/blocks_vector_to_streams.block.yml]
