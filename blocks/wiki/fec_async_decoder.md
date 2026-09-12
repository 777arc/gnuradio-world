<!-- block: fec_async_decoder -->
<!-- title: FEC Async Decoder -->
<!-- source: https://wiki.gnuradio.org/index.php/FEC_Async_Decoder -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Decodes frames received as async messages over a message port. This decoder deployment expects messages of soft decision symbols as input (i.e. float data), and can produce either packed PDU messages (packed = True) or messages full of unpacked bits (packed = False).

This decoder works off a full message as one frame or block to decode. The message length is used to calculate the frame length. To support this, the decoder variable used will have had its frame_size set. This block treats that initial frame_size value as the maximum transmission unit (MTU) and will not process frames larger than that after being decoded.

The packed PDU form of this deployment is designed to work well with other PDU-based blocks to operate within the processing flow of data packets or frames.

Due to differences in how data is packed and processed, this block also offers the ability to change the direction of how bits are packed. All inputs messages are one soft decision per item. By default, the rev_pack mode is set to True. Using this setup allows the async block to behave with PDUs in the same operation and format as the tagged stream decoders. That is, putting the same data into both the tagged stream decoder deployment and this with the default setting should produce the same data.

Because the block handles data as a full frame per message, this decoder deployment cannot work with any decoders that require history. For example, the gr::fec::code::cc_decoder decoder in streaming mode requires an extra rate*(K-1) bits to complete the decoding, so it would have to wait for the next message to come in and finish processing. Therefore, the streaming mode of the CC decoder is not allowed. The other three modes will work with this deployment since the frame is self-contained for decoding.

## Parameters
- Decoder Obj.
  An FECAPI decoder object child of the generic_decoder class.

- MTU (bytes)
  The Maximum Transmission Unit (MTU) of the output frame that the block will be able to process. Specified in bytes and defaults to 1500.

- Packed
  Sets output to packed bytes if true; otherwise, 1 bit per byte.

- Rev. Packing
  If packing bits, should they be reversed?

## Example Flowgraph
This flowgraph converts the Message Strobe bytes into a PDU of unpacked bits and then encodes them with a Repetition encoder. The encoder output is converted to a stream of float values which are put into a PDU. The Async Decoder reverses the bit order and creates packed bytes of output.

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-fec/lib/async_decoder_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-fec/lib/async_decoder_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-fec/include/gnuradio/fec/async_decoder.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-fec/grc/fec_async_decoder.block.yml]
