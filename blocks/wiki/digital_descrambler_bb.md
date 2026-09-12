<!-- block: digital_descrambler_bb -->
<!-- title: Descrambler -->
<!-- source: https://wiki.gnuradio.org/index.php/Descrambler -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

The Descrambler block is an implementation of a multiplicative descrambler. It takes an input of bits as output by the Scrambler block and derandomizes the output. So long as the Mask and Length of the two blocks are identical, the Descrambler block will self-synchronize with the Scrambler block output.

This is a block diagram of a multiplicative descrambler using a 7-stage linear feedback shift register (LFSR) with taps at (7,4).

This block works at the bit level, mean this block works on the LSB only of the input data stream, i.e., on an "unpacked binary" stream. It produces the same format on its output.

## Parameters
- Mask
  Polynomial mask for LFSR. This should be identical to the mask used in the Scrambler block.

- Seed
  Initial shift register contents

- Length
  Shift register length. Must be <=63, meaning it can handle up to a polynomial of size 64. The Length will be one less than the polynomial size. Thus, a 7-stage LFSR (as shown in the block diagram above) would correspond to a polynomial of size 7, and the Length would be 6.

## Example Flowgraph
NOTE: This is the same example as used in the Scrambler block.

Here is a simple example flowgraph. This flowgraph uses a text file as a source. The text file consists of ASCII characters, meaning 8-bit characters.

When the flowgraph is running, the following time domain display shows the randomized bitstream.

The receiver is a separate flowgraph, as follows:

The Descrambler flowgraph takes in the bitstream, derandomizes it, and sends it on. The Delay block, once accurately set, ensures that the follow-on block will align with the byte boundary such that the ASCII text will be readable.

Once the delay is properly set, the terminal outputs the readable text:

## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  TODO
