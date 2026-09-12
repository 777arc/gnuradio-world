<!-- block: blocks_add_const_vxx -->
<!-- title: Add Const -->
<!-- source: https://wiki.gnuradio.org/index.php/Add_Const -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This block adds a constant value to each item that passes through it.
output[m] = input[m] + constant vector

## Parameters
(R): Run-time adjustable

- IO Type
  Supported data types
  * Complex
  * Float
  * Int
  * Short

- Constant (R)
  The value to be added to the input stream. It must be of the same type as the block IO type.

- Vec Length
  Length of the vector

## Example Flowgraph
This flowgraph shows the use of the Add Const and the Multiply blocks to create an amplitude modulated signal.

## Source Files
- C++ files
  add_const_bb_impl.cc
  add_const_cc_impl.cc
  add_const_ff_impl.cc
  add_const_ii_impl.cc
  add_const_ss_impl.cc
  add_const_v_impl.cc

- Header files
  add_const_bb_impl.h
  add_const_cc_impl.h
  add_const_ff_impl.h
  add_const_ii_impl.h
  add_const_ss_impl.h
  add_const_v_impl.h

- Public header files
  add_const_bb.h
  add_const_cc.h
  add_const_ff.h
  add_const_ii.h
  add_const_ss.h
  add_const_v.h

- Block definition
  blocks_add_const_vxx.block.yml
