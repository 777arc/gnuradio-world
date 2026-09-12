<!-- block: blocks_unpack_k_bits_bb -->
<!-- title: Unpack K Bits -->
<!-- source: https://wiki.gnuradio.org/index.php/Unpack_K_Bits -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Opposite of Pack K Bits - Converts a byte with k relevant bits to k output bytes with 1 bit each, located in the LSB.

In other words, this block picks the K least significant bits from a byte, and expands them into K bytes of 0 or 1.

Example:

k = 4

in = [0xf5, 0x08]

out = [0,1,0,1,1,0,0,0]

Each input byte produced four output bytes (that are either 0 or 1).  Remember that there is no item type of "bit" in GNU Radio, so we have to use bytes to represent single bits.

## Parameters
- K
  Constant for unpacking bits

## Example Flowgraph
## Source Files
- C++ files
  Byte implementation
  Base class

- Header files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-blocks/lib/unpack_k_bits_bb_impl.h]

- Public header files
  Byte implementation
  Base class

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/main/gr-blocks/grc/blocks_unpack_k_bits_bb.block.yml]
