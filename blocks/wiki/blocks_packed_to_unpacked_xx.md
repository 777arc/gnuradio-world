<!-- block: blocks_packed_to_unpacked_xx -->
<!-- title: Packed to Unpacked -->
<!-- source: https://wiki.gnuradio.org/index.php/Packed_to_Unpacked -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Converts a stream of packed bytes, shorts or ints into a stream of unpacked bytes, shorts or ints.

This is the inverse of Unpacked to Packed

The bits in the input stream are separated into groups of bits according to the number of bits per chunk. All 8, 16 or 32 bits of the each input are processed. The resulting chunk is written right-justified to the output stream of bytes, shorts or ints.

The combination of this block followed by Chunks to Symbols handles the general case of mapping from a stream of bytes or shorts into arbitrary float or complex symbols.

## Parameters
- Bits per Chunk
  How many bits to include in each output byte/short/int

- Endianness
  Whether to start with the MSB or LSB when processing the input bits

- Number of Ports
  Number of input and output ports, in case you need multiple parallel streams

## Example Flowgraph
(This is not actually a flowgraph, it's just an example of the block being used)

If bits_per_chunk = 1 and MSB is selected,

input :  0b11110000

output : 0b00000001 0b00000001 0b00000001 0b00000001 0b00000000 0b00000000 0b00000000 0b00000000

## Source Files
- C++ files
  packed_to_unpacked_impl.cc

- Header files
  packed_to_unpacked_impl.h

- Public header files
  packed_to_unpacked.h

- Block definition
  blocks_packed_to_unpacked_xx.block.yml
