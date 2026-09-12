<!-- block: fec_extended_tagged_decoder -->
<!-- title: FEC Extended Tagged Decoder -->
<!-- source: https://wiki.gnuradio.org/index.php/FEC_Extended_Tagged_Decoder -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This block decodes an unpacked stream using a variety of Decoder Definition blocks, such as Repetition, CC, Polar, etc. The output stream also is unpacked.

## Parameters
- Decoder Objects
  Decoder Definition blocks are used to define the decoder function.

- MTU (bytes)
  The Maximum Transmission Unit (MTU) of the input frame that the block will be able to process. Specified in bytes and defaults to 1500.

- Annihilator
  - Puncture Pattern
  a puncture pattern of '11' defines 'no puncture'.

- Length Tag Name
  Key name of the tagged stream frame size, typically "packet_len".

## Example Flowgraph
This flowgraph can be found at [https://github.com/gnuradio/gnuradio/blob/main/gr-fec/examples/fecapi_tagged_decoders.grc].

## Source Files
- Python files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-fec/python/fec/extended_tagged_decoder.py]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-fec/grc/fec_extended_tagged_decoder.block.yml]
