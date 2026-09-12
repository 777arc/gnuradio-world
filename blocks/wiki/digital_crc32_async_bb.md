<!-- block: digital_crc32_async_bb -->
<!-- title: Async CRC32 -->
<!-- source: https://wiki.gnuradio.org/index.php/Async_CRC32 -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Deprecated in 3.10  This block has been replaced by CRC_Append and CRC_Check blocks.

Byte-stream CRC block for async messages.  Processes packets (as async PDU messages) for CRC32. The  parameter determines if the block acts to check and strip the CRC or to calculate and append the CRC32.  The input PDU is expected to be a message of packet bytes.  When using check mode, if the CRC passes, the output is a payload of the message with the CRC stripped, so the output will be 4 bytes smaller than the input.  When using calculate mode (check == false), then the CRC is calculated on the PDU and appended to it. The output is then 4 bytes longer than the input.  This block implements the CRC32 using the Boost crc_optimal class for 32-bit CRCs with the standard generator 0x04C11DB7.

## Parameters
- Mode
  Set to true if you want to check CRC, false to create CRC.

## Example Flowgraph
This flowgraph can be found at [https://github.com/gnuradio/gnuradio/blob/master/gr-digital/examples/packet/packet_tx.grc]

## Source Files
- C++ files
  crc32_async_bb_impl.cc

- Header files
  crc32_async_bb_impl.h

- Public header files
  crc32_async_bb.h

- Block definition
  digital_crc32_async_bb.block.yml
