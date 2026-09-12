<!-- block: blocks_pack_k_bits_bb -->
<!-- title: Pack K Bits -->
<!-- source: https://wiki.gnuradio.org/index.php/Pack_K_Bits -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Converts a stream of bytes with 1 bit in the LSB to a byte with K relevant bits.  It's the opposite of Unpack K Bits

In other words, it packs K unpacked bits (one bit per byte, since the byte is the smallest item size in GNU Radio) into a single packed byte containing K bits and 8 - K zeros.

This block takes in K bytes at a time, and uses the least significant bit to form a new byte.

Example:

K = 4

in = [0, 1, 0, 1, 0x81, 0x00, 0x00, 0x00]

out = [0x05, 0x08]

The first four bytes coming in get combined to form binary 0101 which is 0x05

The next four bytes get combined to form binary 1000 which is 0x08. Note that even though one of the input bytes was 0x81, all that mattered was the least significant bit, which was a 1, the rest of the bits in that byte got discarded.

## Parameters
- K
  Number of bits to be packed.

## Example Flowgraph
This flowgraph can be downloaded from Media:Pack_test.grc.

## Source Files
- C++ files
  Byte implementation
  Base class

- Header files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-blocks/lib/pack_k_bits_bb_impl.h]

- Public header files
  Byte implementation
  Base class

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/main/gr-blocks/grc/blocks_pack_k_bits_bb.block.yml]
