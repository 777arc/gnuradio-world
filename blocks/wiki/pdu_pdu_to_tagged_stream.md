<!-- block: pdu_pdu_to_tagged_stream -->
<!-- title: PDU to Tagged Stream -->
<!-- source: https://wiki.gnuradio.org/index.php/PDU_to_Tagged_Stream -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Turns received PDUs into a tagged stream of items.

Opposite of Tagged Stream to PDU.

Note for 3.10 This block has been moved from gr-blocks to gr-pdu, which causes a name change of the id. See Porting_Existing_Flowgraphs_to_a_Newer_Version#PDU_blocks_moved_from_gr-blocks_to_gr-pdu for details.

## Parameters
- Length tag name
  The name of the tag that specifies the length of the packet. Default value is 'packet_len'.

## Example Flowgraph
This flowgraph can be found at [https://github.com/gnuradio/gnuradio/blob/master/gr-fec/examples/fecapi_polar_encoders.grc]

## Source Files
- C++ files
  pdu_to_tagged_stream_impl.cc

- Header files
  pdu_to_tagged_stream.h

- Public header files
  pdu_to_tagged_stream_impl.h

- Block definition
  pdu_pdu_to_tagged_stream.block.yml
