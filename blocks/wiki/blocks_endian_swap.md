<!-- block: blocks_endian_swap -->
<!-- title: Endian Swap -->
<!-- source: https://wiki.gnuradio.org/index.php/Endian_Swap -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Convert stream of items into their byte swapped version.

## Parameters
Item Size
Default: 4 (swaps 32-bit integers).
Values: 2 (16-bit), 4 (32-bit), 8 (64-bit).

## Example Flowgraph
This flowgraph can be downloaded from Media:Endian Swap.grc.

In the example flowgraph, the default item size of 4 is used, treating the input stream as 32-bit integers and swapping their byte order.

## Source Files
- C++ files
  endian_swap_impl.cc

- Header files
  endian_swap_impl.h

- Public header files
  endian_swap.h

- Block definition
  blocks_endian_swap.block.yml
