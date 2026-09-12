<!-- block: pdu_tagged_stream_to_pdu -->
<!-- title: Tagged Stream to PDU -->
<!-- source: https://wiki.gnuradio.org/index.php/Tagged_Stream_to_PDU -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Turns received stream data and tags into PDUs and sends them through a message port.

The sent message is a PMT-pair (created by pmt::cons()). The first element is a dictionary containing all the tags. The second is a vector containing the actual data.

Opposite of PDU to Tagged Stream.

Note for 3.10 This block has been moved from gr-blocks to gr-pdu, which causes a name change of the id. See Porting_Existing_Flowgraphs_to_a_Newer_Version#PDU_blocks_moved_from_gr-blocks_to_gr-pdu for details.

## Parameters
- Length tag name
  The name of the tag that specifies how long the packet is.

## Example Flowgraph
This flowgraph can be found at [https://github.com/gnuradio/gnuradio/blob/master/gr-fec/examples/fecapi_polar_encoders.grc]

## Source Files
- C++ files
  tagged_stream_to_pdu_impl.cc

- Header files
  tagged_stream_to_pdu.h

- Public header files
  tagged_stream_to_pdu_impl.h

- Block definition
  pdu_tagged_stream_to_pdu.block.yml
