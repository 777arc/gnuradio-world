<!-- block: fec_extended_tagged_encoder -->
<!-- title: FEC Extended Tagged Encoder -->
<!-- source: https://wiki.gnuradio.org/index.php/FEC_Extended_Tagged_Encoder -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This block encodes an unpacked stream using a variety of Encoder Definition blocks, such as Repetition, CC, Polar, etc. The output stream also is unpacked.

## Parameters
- Encoder Objects
  Encoder Definition blocks are used to define the encoder function.

- MTU (bytes)
  The Maximum Transmission Unit (MTU) of the input frame that the block will be able to process. Specified in bytes and defaults to 1500.

- Puncture Pattern
  a puncture pattern of '11' defines 'no puncture'.

- Length Tag Name
  Key name of the tagged stream frame size, typically "packet_len".

## Example Flowgraph
This flowgraph can be found at [https://github.com/gnuradio/gnuradio/blob/master/gr-fec/examples/fecapi_polar_encoders.grc]

## Source Files
- Python files
  extended_tagged_encoder.py

- Block definition
  fec_extended_tagged_encoder.block.yml
