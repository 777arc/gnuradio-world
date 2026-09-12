<!-- block: variable_dummy_encoder_def -->
<!-- title: Dummy Encoder Definition -->
<!-- source: https://wiki.gnuradio.org/index.php/Dummy_Encoder_Definition -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

A dummy encoder class that simply passes the input to the output. It is meant to allow us to easily use the FEC API encoder and decoder blocks in an application with no coding.

## Parameters
- Parallelism
  - Frame Bits
  ## Example Flowgraph
This flowgraph can be found at [https://github.com/gnuradio/gnuradio/blob/master/gr-fec/examples/fecapi_async_decoders.grc]

## Source Files
- C++ files
  dummy_encoder_impl.cc

- Header files
  dummy_encoder_impl.h

- Public header files
  dummy_encoder.h

- Block definition
  variable_dummy_encoder_def_list.block.yml
