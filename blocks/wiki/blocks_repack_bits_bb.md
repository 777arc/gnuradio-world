<!-- block: blocks_repack_bits_bb -->
<!-- title: Repack Bits -->
<!-- source: https://wiki.gnuradio.org/index.php/Repack_Bits -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Repack  bits from the input stream onto bits of the output stream.  No bits are lost here; any value for k and l (within [1, 8]) is allowed. On every fresh input byte, it starts reading on the LSB, and starts copying to the LSB as well.

## Parameters
- Bits per input byte (k)
  Number of relevant bits on the input stream

- Bits per output byte (l)
  Number of relevant bits on the output stream

- Length Tag Key
  If not empty, this is the key for the length tag.

- Endianness
  The endianness of the output data stream (LSB or MSB).

- Pack Alignment
  When a Length Tag Key is provided, this controls if the input or the output is aligned.  Repack Bits operates on tagged streams. In this case, it can happen that the input data or the output data becomes unaligned when k * input length is not equal to l * output length. In this case, the Pack Alignment parameter is used to decide which data packet to align.  Usually, Pack Alignment is set to Input for unpacking (k=8, l < 8) and Output for reversing that. For example, say you're tx'ing 8-PSK and therefore set k=8, l=3 on the transmit side before the modulator. Now assume you're transmitting a single byte of data. Your incoming tagged stream has length 1, the outgoing has length 3. However, the third item is actually only carrying 2 bits of relevant data, the bits do not align with the boundaries. So you set Pack Alignment to Input, because the output can be unaligned. Now say you're doing the inverse: packing those three items into full bytes. How do you interpret those three bytes? Without this flag, you'd have to assume there's 9 relevant bits in there, so you'd end up with 2 bytes of output data. But in the packing case, you want the output to be aligned; all output bits must be useful. By asserting this flag, the packing algorithm tries to do this and in this case assumes that since we have alignment after 8 bits, the 9th can be discarded.

## Example Flowgraph
This flowgraph can be found at [https://github.com/gnuradio/gnuradio/blob/master/gr-fec/examples/fecapi_polar_encoders.grc]

## Source Files
- C++ files
  repack_bits_bb_impl.cc

- Header files
  repack_bits_bb_impl.h

- Public header files
  repack_bits_bb.h

- Block definition
  blocks_repack_bits_bb.block.yml
