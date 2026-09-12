<!-- block: variable_cc_encoder_def -->
<!-- title: CC Encoder Definition -->
<!-- source: https://wiki.gnuradio.org/index.php/CC_Encoder_Definition -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This class performs convolutional encoding for unpacked bits for frames of a constant length. This class is general in its application of the convolutional encoding and allows us to specify the constraint length, the coding rate, and the polynomials used in the coding process.

The encoding object holds a shift register that takes in each bit from the input stream and then ANDs the shift register with each polynomial, and places the parity of the result into the output stream. The output stream is therefore also unpacked bits.

A common convolutional encoder uses K=7, Rate=1/2, and the polynomials:
   1 + x^2 + x^3 + x^5 + x^6
   1 + x   + x^2 + x^3 + x^6
This is the Voyager code from NASA.

See also CCSDS Encoder Definition, which implements the above code that is more highly optimized for just those specific settings.

## Parameters
- Parallelism
  It seems that one can create a tensor of one or two dimensions of encoders. More info is needed on this.

- Dimension 1
  Active when parallelism > 0

- Dimension 2
  Active when parallelism > 1

- Frame Bits
  When not being used in a tagged stream mode, this encoder will only process frames of the length provided here. If used in a tagged stream block, this setting becomes the maximum allowable frame size that the block may process.

- Constraint Length (K)
  Must be in the range [2, 31]. K = 1 implies a code without memory which does not make sense; upper limit is due the way the polynomials of the code are passed in \p polys.

- Rate Inverse
  We set the coding rate by setting rate to R given a desired rate of 1/R. That is, for a rate 1/2 coder, we would set rate to 2.

- Polynomials
  Vector of polynomials as integers. The least significant bit (LSB) denotes the coefficient of exponent zero of the coding polynomial. The position of the most significant set bit (zero based counting) is \p K-1. Note: this representation is reversed compared to the common representation as found in most books and references. The common representation puts the coefficient of the highest exponent into the LSB and the coefficient of exponent zero is the highest set bit.  Example: The common binary representation of the Voyager code polynomials (see above) is 1011011 and 1111001; the octal representation is 133 and 171. For this block, the binary representation must be reversed: 1101101 and 1001111; octal this is 155 and 117; decimal this is 109 and 79. Some standards (e.g. CCSDS 131.0-B-3) require the inversion of some outputs. This is supported by providing the negative value of the polynomial, e.g. -109.

- Start State
  Initialization state of the shift register; must be in range [0, 2^(K-1)-1] where K is the constraint length. The bits in \p start_state are also used to flush the encoder in mode 'CC_TERMINATED'. Note: Most books and references use a shift register shifting from left to right. This implementation, however, shifts from right to left. This means that the start state must be reversed. (The different shift direction is also the reason why the polynomials must be reversed as described above).

- Streaming behavior
  Specifies how the convolutional encoder will behave and under what conditions.
  ; Streaming: This mode expects an uninterrupted flow of samples into the encoder, and the output stream is continually encoded.
  ; Terminated: mode designed for packet-based systems. This mode flushes the encoder with K-1 bits which adds rate*(K-1) bits to the output. This improves the protection of the last bits of a block and helps the decoder.
  ; Tailbiting: another packet-based method. Instead of adding bits onto the end of a packet (as with 'CC_TERMINATED'), this mode will pre-initialize the state of the encoder with a packet’s last (k-1) bits.
  ; Truncated: A truncated code always resets the registers to the start state between frames.

- Byte Padding
  If the encoded frame should be padded to the nearest byte.

## Example Flowgraph
This flowgraph can be found at [https://github.com/gnuradio/gnuradio/blob/master/gr-fec/examples/fecapi_async_decoders.grc]

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-fec/lib/cc_encoder_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-fec/lib/cc_encoder_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-fec/include/gnuradio/fec/cc_encoder.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-fec/grc/variable_cc_encoder_def_list.block.yml]
