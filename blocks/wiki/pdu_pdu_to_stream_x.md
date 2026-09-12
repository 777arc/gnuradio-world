<!-- block: pdu_pdu_to_stream_x -->
<!-- title: PDU To Stream -->
<!-- source: https://wiki.gnuradio.org/index.php/PDU_To_Stream -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Added in 3.10

Convert a PDU to stream output with optional early burst.

## Parameters
(R): Run-time adjustable

- PDU Type
  options: [Complex, Float, Int, Short, Byte]

- Early Behavior
  options: [Append, Drop, Balk]

- Queue Depth (R)
  default: '64'

## Messages
### Inputs
- pdu
  input message

## Example Flowgraph
This flowgraph can be found at [https://raw.githubusercontent.com/gnuradio/gnuradio/master/gr-pdu/examples/pdu_lambda_chirp_demo.grc]

## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-pdu/grc/pdu_pdu_to_stream.block.yml]
