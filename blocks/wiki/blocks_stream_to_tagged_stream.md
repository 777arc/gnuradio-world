<!-- block: blocks_stream_to_tagged_stream -->
<!-- title: Stream to Tagged Stream -->
<!-- source: https://wiki.gnuradio.org/index.php/Stream_to_Tagged_Stream -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Converts a regular stream into a tagged stream.

All this block does is add length tags in regular intervals. It can be used to connect a regular stream to a gr::tagged_stream_block.

This block is meant to be connected directly to a tagged stream block. If there are blocks between this block and a tagged stream block, make sure they either don't change the rate, or modify the tag value to make sure the length tags actually represent the packet length.

## Parameters
(R): Run-time adjustable

- Packet length (R)
  Number of items per tagged stream packet. One tag is written every Packet length items and contains that number.

- Length Tag Key
  Key of the length tag.

## Example Flowgraph
This flowgraph can be found at [https://github.com/gnuradio/gnuradio/blob/master/gr-fec/examples/fecapi_polar_encoders.grc]

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/lib/stream_to_tagged_stream_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/lib/stream_to_tagged_stream_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/include/gnuradio/blocks/stream_to_tagged_stream.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/grc/blocks_stream_to_tagged_stream.block.yml]
