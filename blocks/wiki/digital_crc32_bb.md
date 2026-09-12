<!-- block: digital_crc32_bb -->
<!-- title: Stream CRC32 -->
<!-- source: https://wiki.gnuradio.org/index.php/Stream_CRC32 -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Byte-stream CRC block. The generated CRC uses little-endian or LSB format.

- Input: stream of bytes, which form a packet. The first byte of the packet has a tag with key "length" and the value being the number of bytes in the packet.

- Output: The same bytes as incoming, but trailing a CRC32 of the packet. The tag is re-set to the new length.

## Parameters
- Mode
  Set to true if you want to check CRC, false to create CRC.

- Length tag name
  Length tag key for the tagged stream.

- Packed
  If the data is packed or unpacked bits.

## Example Flowgraph
The following flowgraph adds tags to the output of the signal source. This is done because Stream CRC32 is a tagged stream block and needs a Length tag key.

The data plot after CRC32 is as follows. As seen, a CRC has been added at the end of each packet and the packet length tag has been updated from 100 bytes to 104 bytes, where the extra 4 bytes are for the CRC.

## Source Files
- C++ files
  crc32_bb_impl.cc

- Header files
  crc32_bb_impl.h

- Public header files
  crc32_bb.h

- Block definition
  digital_crc32_bb.block.yml
