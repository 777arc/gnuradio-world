<!-- block: variable_ccsds_encoder_def -->
<!-- title: CCSDS Encoder Definition -->
<!-- source: https://wiki.gnuradio.org/index.php/CCSDS_Encoder_Definition -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

CCSDS Encoding class for convolutional encoding with rate 1/2, K=7, and polynomials [109, 79].

Uses Phil Karn's (KA9Q) implementation of the CCSDS encoder for rate 1/2, K=7, and CC polynomial [109, 79]. These are non-adjustable in this encoder. For an adjustable CC encoder where we can set the rate, constraint length, and polynomial, see CC Encoder Definition.

## Parameters
(R): Run-time adjustable

- Parallelism
  It seems that one can create a tensor of one or two dimensions of encoders. More info is needed on this.

- Dimension 1
  Active when parallelism > 0

- Dimension 2
  Active when parallelism > 1

- Frame bits
  When not being used in a tagged stream mode, this encoder will only process frames of the length provided here. If used in a tagged stream block, this setting becomes the maximum allowable frame size that the block may process.

- Start state
  Initialization state of the shift register.

- Streaming behaviour
  Specifies how the convolutional encoder will behave and under what conditions.
  ; Streaming: This mode expects an uninterrupted flow of samples into the encoder, and the output stream is continually encoded.
  ; Terminated: Mode designed for packet-based systems. This mode adds rate*(k-1) bits to the output as a way to help flush the decoder.
  ; Tailbiting: Another packet-based method. Instead of adding bits onto the end of the packet, this mode will continue the code between the payloads of packets by pre-initializing the state of the new packet based on the state of the last packet for (k-1) bits.
  ; Truncated: A truncated code always resets the registers to the start state between frames.

## Example Flowgraph
This flowgraph can be found at [https://github.com/gnuradio/gnuradio/blob/master/gr-fec/examples/fecapi_async_decoders.grc]

## Source Files
- C++ files
  ccsds_encoder_impl.cc

- Header files
  ccsds_encoder_impl.h

- Public header files
  ccsds_encoder.h

- Block definition
  variable_ccsds_encoder_def_list.block.yml
