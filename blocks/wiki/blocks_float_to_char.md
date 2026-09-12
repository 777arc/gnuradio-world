<!-- block: blocks_float_to_char -->
<!-- title: Float To Char -->
<!-- source: https://wiki.gnuradio.org/index.php/Float_To_Char -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This block will convert a stream of signed 32-bit floating point values (floats) to a stream of signed 8-bit integers (char), with an optional scaling factor. The Float to Char block will quantize the input values, after being multiplied by the Scale factor, to integer values between -128 to +127. Values are rounded to the nearest integer. Any values less than -128 or greater than +127 will be clipped to these limits.

## Parameters
(R): Run-time adjustable

- Scale (R)
  Scaling factor applied to input stream.

## Example Flowgraph
An example flowgraph showing the affect that the Float to Char block has on an input signal.

The Signal Source block provides a sinusoid with an amplitude of 1. Using a Scale value of the Float to Char block of 1, the input signal will be quantized to values of -1, 0, and 1. Note that the input is multiplied by the Scale value before being quantized into the char data type.

Using a Scale value of 127 for the Float to Char, and 1 for the Char to Float, the sinusoid looks more natural.

However, zooming in on the sinusoid that has passed through the Float to Char shows that the amplitudes have been quantized to integer values.

If the amplitude of the input signal is higher than 127 or less than -128, the signal amplitudes will be clipped at these limits. For example, here's an example using a Scale value of 150 for the Float to Char block.

## Source Files
- C++ files
  float_to_char_impl.cc

- Header files
  float_to_char_impl.h

- Block Definition
  blocks_float_to_char.block.yml
