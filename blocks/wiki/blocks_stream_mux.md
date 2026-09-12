<!-- block: blocks_stream_mux -->
<!-- title: Stream Mux -->
<!-- source: https://wiki.gnuradio.org/index.php/Stream_Mux -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Stream muxing block to multiplex many streams into one with a specified format.

Muxes N streams together producing an output stream that contains N0 items from the first stream, N1 items from the second, etc. and repeats:
        [N0, N1, N2, ..., Nm, N0, N1, ...]

## Parameters
- Lengths
  A vector (list/tuple) specifying the number of items from each stream the mux together. Warning: this requires that at least as many items per stream are available or the system will wait indefinitely for the items.

- Num inputs
  Number of input streams.

## Example Flowgraph
This flowgraph shows the Stream Mux block muxing 2 input streams into an output stream with lengths = [3, 2].

The block will take 3 items from the first stream, 2 items from the second stream, and repeat. Notice that tags are preserved.

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/lib/stream_mux_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/lib/stream_mux_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/include/gnuradio/blocks/stream_mux.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/grc/blocks_stream_mux.block.yml]
