<!-- block: digital_packet_headerparser_b_default -->
<!-- title: Packet Header Parser (Default) -->
<!-- source: https://wiki.gnuradio.org/index.php/Packet_Header_Parser_(Default) -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Post header metadata as a PMT. In a sense, this is the inverse block to Packet Header Generator (Default). The difference is, the parsed header is not output as a stream, but as a PMT dictionary, which is published to message port with the id "header_data".

The dictionary consists of the tags created by the header formatter object, as well as the tags already present at the input of this block.
Note that if several tags (created and already present) have the same key (name), only one, the last, will be output. And that may cause conflicts that are hard to investigate.

## Parameters
- Header Length
  Number of bytes per header

- Length Tag Name
  Length Tag Key

## Example Flowgraph
Insert description of flowgraph here, then show a screenshot of the flowgraph and the output if there is an interesting GUI.  Currently we have no standard method of uploading the actual flowgraph to the wiki or git repo, unfortunately.  The plan is to have an example flowgraph showing how the block might be used, for every block, and the flowgraphs will live in the git repo.

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-digital/lib/packet_headerparser_b_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-digital/lib/packet_headerparser_b_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-digital/include/gnuradio/digital/packet_headerparser_b.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-digital/grc/digital_packet_headerparser_b.block.yml]
