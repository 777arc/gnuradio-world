<!-- block: digital_scrambler_bb -->
<!-- title: Scrambler -->
<!-- source: https://wiki.gnuradio.org/index.php/Scrambler -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

The Scrambler block is an implementation of a multiplicative scrambler. It takes an input bit stream and randomizes it using a linear feedback shift register (LFSR) where the feedback is fed into the LFSR itself.

This is a block diagram of a 7-stage multiplicative scrambler with a LFSR with feedback taps (7,4).

This block works at the bit level. This means it works on the LSB only of the input data stream, i.e., on an "unpacked binary" stream, and produces the same format on its output.

This block is typically used for the transmit portion of a digital communication system, and works in conjunction with the Descrambler block. The Descrambler block, which is typically used in the receive system, will derandomize the output of the Scrambler block so long as they are each using the same Mask and Length. Further, because of the fundamental nature of multiplicative scramblers, the Descrambler block will self-synchronize with the randomized bitstream coming from the Scrambler block.

## Parameters
- Mask
  Polynomial mask for LFSR. To calculate the required mask, reverse the order of the desired polynomial. For example, a maximal-length 7-stage LFSR could use taps (7,4). A mask for this implementation would be the binary value 0b001001, or in hex 0x9. A 5-stage LFSR with taps (5,3) would be 0b00101, or in hex 0x5.

- Seed
  Initial shift register contents. This is the fill condition of the LFSR.

- Length
  Shift register length. Must be <=63, meaning that the maximum polynomial is 64. The value of the Length is one less than the polynomial size. For example, a 7-stage LFSR also means a polynomial size of 7. The Length for this block would be 6.

## Example Flowgraph
Here is a simple example flowgraph. This flowgraph uses a text file as a source. The text file consists of ASCII characters, meaning 8-bit characters.

When the flowgraph is running, the following time domain display shows the randomized bitstream.

The receiver is a separate flowgraph, as follows:

The Descrambler flowgraph takes in the bitstream, derandomizes it, and sends it on. The Delay block, once accurately set, ensures that the follow-on block will align with the byte boundary such that the ASCII text will be readable.

Once the delay is properly set, the terminal outputs the readable text:

## Python Function to Create Mask and Length from Polynomial Exponents
Here is a simple python-function to create the mask and length from the exponents of a polynomial:

  def make_mask(*exp):
      from functools import reduce
      return reduce(int.__xor__,map(lambda x:2**x,exp)),max(exp)-1
  mask,k = make_mask(5,3,0) # mask and length for p(x) = x^5 + x^3 + 1, a primitive polynomial in GF(2)

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-digital/lib/scrambler_bb_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-digital/include/gnuradio/digital/scrambler_bb.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-digital/lib/scrambler_bb_impl.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/main/gr-digital/grc/digital_scrambler_bb.block.yml]
