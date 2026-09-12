<!-- block: blocks_argmax_xx -->
<!-- title: Argmax -->
<!-- source: https://wiki.gnuradio.org/index.php/Argmax -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Compares vectors from multiple streams and determines the index in the vector and stream number where the maximum value occurred.

Data is passed in as a vector of length vlen from multiple input sources. The block analyzes the input streams of data items and outputs two streams:

1. max_vec: Stream 0 will contain the index value in the vector where the maximum value occurred. This output is of short data type.
1. max_inp: Stream 1 will contain the number of the input stream that held the maximum value.  This output is of short data type.

## Parameters
- IO Type
  Supported data types
  * Float
  * Int
  * Short

- Num Inputs
  Number of input streams to include in the operation

- Vec Length
  Length of the vector

## Example Flowgraph
This flowgraph shows the two usecases of the Argmax block.
The top case shows how the max_inp output works.
The bottom case shows how the max_vec output works.

This flowgraph can be downloaded from Media:Argmax.grc.

## Source Files
- C++ files
  argmax_impl.cc

- Header files
  argmax_impl.h

- Public header files
  argmax.h

- Block definition
  blocks_argmax_xx.block.yml
