<!-- block: dtv_dvbt_convolutional_deinterleaver -->
<!-- title: Convolutional Deinterleaver -->
<!-- source: https://wiki.gnuradio.org/index.php/Convolutional_Deinterleaver -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

A DVB-T convolutional deinterleaver. ETSI EN 300 744 Clause 4.3.1. Forney (Ramsey type III) convolutional deinterleaver.

Data input: Stream of 1 byte elements.

Data output: Blocks of I bytes size.

## Parameters
- Blocks (12 Bytes)
  number of blocks to process.

- Number of Shift Registers
  size of a block.

- Depth of Shift Registers
  depth length for each element in shift registers.

## Example Flowgraph
This flowgraph can be found at [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/examples/dvbt_rx_8k.grc].

## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  TODO
