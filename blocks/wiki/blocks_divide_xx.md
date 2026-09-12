<!-- block: blocks_divide_xx -->
<!-- title: Divide -->
<!-- source: https://wiki.gnuradio.org/index.php/Divide -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Divide across all input streams.  output = input[0] / input[1] / ... / input[M-1]

## Parameters
- IO Type
  Supported data types
  * Complex
  * Float
  * Int
  * Short

- Vec Length
  Length of the vector

- Num Inputs
  Number of streams to use in divide operation. If there are more than 2 input streams, the output is calculated in the following order:
  output = input[0] / input[1] / ... / input[M-1]

## Example Flowgraph
This flowgraph can be downloaded from Media:Example_divide.grc.

## Source Files
- C++ files
  divide_impl.cc

- Header files
  divide_impl.h

- Public header files
  divide.h

- Block definition
  blocks_divide_XX.block.yml
