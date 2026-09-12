<!-- block: blocks_tagged_stream_multiply_length -->
<!-- title: Tagged Stream Multiply Length Tag -->
<!-- source: https://wiki.gnuradio.org/index.php/Tagged_Stream_Multiply_Length_Tag -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Allows scaling of a tagged stream length tag for constant rate change blocks in a tagged stream.

Searches for a specific tagged stream length tag and multiplies that length by a constant.

## Parameters
(R): Run-time adjustable

- Length tag names
  Length tag key

- Length scalar (R)
  Value to scale length tag values by

## Example Flowgraph
This flowgraph can be found at packet_tx.grc.

The Polyphase Arbitrary Resampler upsamples the stream by a factor of 2. Because of this, the packet length is also increased (becomes twice the original one). But this change of packet length is not propagated to the tags in the output stream of the PAR block. Tagged stream multiply length tag block is used to update the values of these tags. Length scalar is set to 2 to change the packet length to packet_len*2.

## Source Files
- C++ files
  tagged_stream_multiply_length_impl.cc

- Header files
  tagged_stream_multiply_length_impl.h

- Public header files
  tagged_stream_multiply_length.h

- Block definition
  blocks_tagged_stream_multiply_length.block.yml
