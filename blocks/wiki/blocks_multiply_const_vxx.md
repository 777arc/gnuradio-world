<!-- block: blocks_multiply_const_vxx -->
<!-- title: Multiply Const -->
<!-- source: https://wiki.gnuradio.org/index.php/Multiply_Const -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Multiplies the input stream by a scalar or vector constant (element-wise if vector).

output = input * constant

See Fast_Multiply_Const for a more performant version of this block for scalar values only.

 If the input is a not a vector, the "Fast" version is automatically invoked (done behind the scenes).

- Constant (R)
  Scalar or vector constant. If the input is a vector, this parameter must be a vector of the same size. To multiply all the input items by the same value, use Fast_Multiply_Const.

## Example Flowgraph
This flowgraph uses three Multiply type blocks. The top Multiply Const Block and middle Multiply Block are driven by the GUI Chooser to act as a Transmit / Receive switch. The bottom Multiply Const Block is a Volume control, the 'constant' being the 'volume' parameter from the QT GUI Range block.

Note: The lower section is a working 2 meter NBFM receiver.

## Source Files
- C++ files
  If single sample input
  If vector input

- Header files
  If single sample input
  If vector input

- Public header files
  If single sample input
  If vector input

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/grc/blocks_multiply_const_vxx.block.yml]
