<!-- block: blocks_stream_to_vector -->
<!-- title: Stream to Vector -->
<!-- source: https://wiki.gnuradio.org/index.php/Stream_to_Vector -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Convert a stream of items into a stream of vectors.

The input stream can itself be of vectors. Therefore, this block converts a stream of N items to a vector of M * N items. The most common and intuitive case is where N = 1.

## Parameters
- Num items
  Vector length of the output (M in the above example)

- Vec Length
  Vector length of the input (N in the above example). This is usually 1.

## Example Flowgraph
This flowgraph can be found at [https://github.com/gnuradio/gnuradio/blob/master/gr-vocoder/examples/loopback-codec2.grc]

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/lib/stream_to_vector_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/lib/stream_to_vector_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/include/gnuradio/blocks/stream_to_vector.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/grc/blocks_stream_to_vector.block.yml]
