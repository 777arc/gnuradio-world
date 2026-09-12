<!-- block: blocks_add_xx -->
<!-- title: Add -->
<!-- source: https://wiki.gnuradio.org/index.php/Add -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Add samples across all input streams.

For all n samples on all M input streams x_m:
 output[n] = sum( x_0[n], x_1[n], ..., x_m[n])

## Supported Data Types
- Complex
- Float
- Int
- Short

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
  Number of streams to add

## Example Flowgraph
This flowgraph uses an Add Block to generate the classic "dial tone".

## Source Files
- C++ files
  add_blk_impl.cc

- Header files
  add_blk_impl.h

- Public header files
  add_blk.h

- Block definition
  blocks_add_xx.block.yml
