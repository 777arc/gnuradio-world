<!-- block: blocks_stream_to_vector_decimator -->
<!-- title: Stream to Vec Decim -->
<!-- source: https://wiki.gnuradio.org/index.php/Stream_to_Vec_Decim -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This Heir block converts the input stream to a vector, then decimate the vector stream to achieve the vector rate.

## Parameters
(R): Run-time adjustable

- Sample rate (R)
  The rate of incoming samples

- Vec rate (R)
  The rate of outgoing vectors (same units as sample_rate)

- Vec length
  The length of the outgoing vectors in items

## Example Flowgraph
Media:Example_stream_vector_decim.grc
## Source Files
- Python file
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/python/blocks/stream_to_vector_decimator.py]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/grc/blocks_stream_to_vector_decimator.block.yml]
