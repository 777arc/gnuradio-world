<!-- block: digital_packet_headergenerator_bb_default -->
<!-- title: Packet Header Generator (Default) -->
<!-- source: https://wiki.gnuradio.org/index.php/Packet_Header_Generator_(Default) -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Generates a default header for a tagged, streamed packet based on the specified length. This block is a special case of Packet Header Generator

Input: A tagged stream of bytes. This is consumed entirely, it is not appended to the output stream. Note that all 8 bits per byte are used.

Output: An tagged stream containing the header.

## Parameters
- Header Length
  This is the number of bits per header.

- Length Tag Name
  Length tag key.

## Example Flowgraph
Insert description of flowgraph here, then show a screenshot of the flowgraph and the output if there is an interesting GUI.  Currently we have no standard method of uploading the actual flowgraph to the wiki or git repo, unfortunately.  The plan is to have an example flowgraph showing how the block might be used, for every block, and the flowgraphs will live in the git repo.

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-digital/lib/packet_headergenerator_bb_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-digital/lib/packet_headergenerator_bb_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-digital/include/gnuradio/digital/packet_headergenerator_bb.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-digital/grc/digital_packet_headergenerator_bb_default.block.yml]
