<!-- block: fec_encode_ccsds_27_bb -->
<!-- title: Encode CCSDS 27 -->
<!-- source: https://wiki.gnuradio.org/index.php/Encode_CCSDS_27 -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

A rate 1/2, k=7 convolutional encoder for the CCSDS standard.

This block performs convolutional encoding using the CCSDS standard polynomial ("Voyager").

The input is an MSB first packed stream of bits.
The output is a stream of symbols 0 or 1 representing the encoded data.

As a rate 1/2 code, there will be 16 output symbols for every input byte.

This block is designed for continuous data streaming, not packetized data. There is no provision to "flush" the encoder.

This block goes with Decode CCSDS 27

## Example Flowgraph
This flowgraph can be downloaded from Media:Encode_ccds.grc.

## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  TODO
