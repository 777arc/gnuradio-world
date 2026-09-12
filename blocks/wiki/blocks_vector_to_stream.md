<!-- block: blocks_vector_to_stream -->
<!-- title: Vector to Stream -->
<!-- source: https://wiki.gnuradio.org/index.php/Vector_to_Stream -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Convert a stream of vectors into a stream of items

The output stream can itself be vector. Therefore, this block converts a stream of M * N items to a stream of N items. The most common and intuitive case is where N = 1.

## Parameters
- Num items
  Vector length of the input (M in the above example)

- Vec length
  Vector length of the output (N in the above example). This is usually 1.

## Example Flowgraph
This flowgraph can be found at [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/examples/dvbt_rx_8k.grc].

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/lib/vector_to_stream_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/lib/vector_to_stream_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/include/gnuradio/blocks/vector_to_stream.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/grc/blocks_vector_to_stream.block.yml]
