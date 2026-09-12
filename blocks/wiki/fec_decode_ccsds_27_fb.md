<!-- block: fec_decode_ccsds_27_fb -->
<!-- title: Decode CCSDS 27 -->
<!-- source: https://wiki.gnuradio.org/index.php/Decode_CCSDS_27 -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

A rate 1/2, k=7 convolutional decoder for the CCSDS standard.

This block performs soft-decision convolutional decoding using the Viterbi algorithm.  The input is a stream of (possibly noise corrupted) floating point values nominally spanning [-1.0, 1.0], representing the encoded channel symbols 0 (-1.0) and 1 (1.0), with erased symbols at 0.0.

The output is MSB first packed bytes of decoded values.
As a rate 1/2 code, there will be one output byte for every 16 input symbols.
This block is designed for continuous data streaming, not packetized data. The first 32 bits out will be zeroes, with the output delayed four bytes from the corresponding inputs.

## Parameters
None

## Example Flowgraph
This flowgraph can be downloaded from Media:Decode_ccsds_27.grc.

## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  TODO
