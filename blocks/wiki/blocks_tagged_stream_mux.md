<!-- block: blocks_tagged_stream_mux -->
<!-- title: Tagged Stream Mux -->
<!-- source: https://wiki.gnuradio.org/index.php/Tagged_Stream_Mux -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Combines tagged streams.

Takes N streams as input. Each stream is tagged with packet lengths. Packets are output sequentially from each input stream.
The output signal has a new length tag, which is the sum of all individual length tags. The old length tags are discarded.
All other tags are propagated as expected, i.e. they stay associated with the same input item. There are cases when this behaviour is undesirable. One special case is when a tag at the first element (the head item) of one input port must stay on the head item of the output port. To achieve this, set "Tags: Preserve head position on input" to the port that will receive these special tags.

## Parameters
- Number of inputs
  Number of input streams

- Length tag names
  Length tag key

- Tags: Preserve head position on input
  Preserves the head position of tags on this input port

## Example Flowgraph
- Example 1

  This flowgraph can be found at [https://github.com/gnuradio/gnuradio/blob/master/gr-digital/examples/packet/packet_tx.grc]

  - Example 2
  Another flowgraph can be found in Media:Tagged_stream_mux.grc. It shows two tagged streams multiplexed into a tagged output stream.

  : The stream before multiplexing and afterwards:

  ## Source Files
- C++ files
  tagged_stream_mux_impl.cc

- Header files
  tagged_stream_mux_impl.h

- Public header files
  tagged_stream_mux.h

- Block definition
  blocks_tagged_stream_mux.block.yml
