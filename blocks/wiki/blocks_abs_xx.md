<!-- block: blocks_abs_xx -->
<!-- title: Abs -->
<!-- source: https://wiki.gnuradio.org/index.php/Abs -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

The abs block converts the input data stream into its absolute value i.e. the negative input values become positive output values and the positive values remain the same at both the input and the output.

## Parameters
- Vec Length
  Length of the vector

- IO Type
  Supported data types
  * Float
  * Int
  * Short

## Example Flowgraph
This flowgraph shows a sinusoid being passed through the Abs block, producing full-wave rectification.

## Source Files
- C++ files
  abs_blk_impl.cc

- Header files
  abs_blk_impl.h

- Public header files
  abs_blk.h

- Block definition
  blocks_abs_xx.block.yml
