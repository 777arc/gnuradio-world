<!-- block: blocks_unpacked_to_packed_xx -->
<!-- title: Unpacked to Packed -->
<!-- source: https://wiki.gnuradio.org/index.php/Unpacked_to_Packed -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Convert a stream of unpacked bytes or shorts into a stream of packed bytes or shorts.

This is the inverse of Packed to Unpacked

The low bits are extracted from each input byte or short. These bits are then packed densely into the output bytes or shorts, such that all 8 or 16 bits of the output bytes or shorts are filled with valid input bits.

## Parameters
- Bits per Chunk
  Number of bits to pack into each group

- Endianness
  Most or Least Significant Bit first

- Num Ports
  Number of input streams to operate on

## Example Flowgraph
## Source Files
