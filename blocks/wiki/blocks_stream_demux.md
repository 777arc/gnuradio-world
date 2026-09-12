<!-- block: blocks_stream_demux -->
<!-- title: Stream Demux -->
<!-- source: https://wiki.gnuradio.org/index.php/Stream_Demux -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Stream demuxing block to demultiplex one stream into N output streams.

Demuxes a stream producing N outputs streams that contains n_0 items in the first stream, n_1 items in the second, etc., and repeats. Tags are propagated. The number of items in each output stream is specified using the lengths parameter like so [n_0, n_1, ..., n_N-1].

Example:

lengths = [2, 3, 4]

input stream = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, ...]

output_stream_0 = [0, 1, 9, 10, ...]

output_stream_1 = [2, 3, 4, 11, ...]

output_stream_2 = [5, 6, 7, 8, ...]

## Parameters
- Lengths
  a vector (list/tuple) specifying the number of items to copy to each output stream.

- Num outputs
  Number of output streams.

## Example Flowgraph
This flowgraph shows the Stream Demux block demuxing an input stream into three output streams with lengths = [2, 3, 4].

The block will put 2 items into the first output stream, 3 items into the second output stream, 4 items into the third output stream, and repeat. Notice that tags are preserved.

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/lib/stream_demux_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/lib/stream_demux_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/include/gnuradio/blocks/stream_demux.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/grc/blocks_stream_demux.block.yml]
