<!-- block: blocks_matrix_interleaver -->
<!-- title: Matrix Interleaver -->
<!-- source: https://wiki.gnuradio.org/index.php/Matrix_Interleaver -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This block performs interleaving by filling a fixed size matrix row by row and then outputting column by column.

## Parameters
- IO Type
  Supported types are: complex, float, int, short, and byte

- Vector Length
  The vector length for the input stream.

- Rows
  The number of rows for the interleaver.

- Columns
  The number of columns for the interleaver.

- Deinterleave
  A boolean variable indicating if the block should behave as an interleaver (deinterleave=False) or deinterleaver (deinterleave=true).

## Example Flowgraph
Below is a basic interleave/deinterleave example with the matrix interleaver block:

On the interleaver side, the settings are set as follows:

On the deinterleave side, the settings are the same except the deinterleave variable is set to true:

The output is then captured with a QT GUI Time Sink block. The first signal is the input from the vector source (numbers 0 to 11). The second trace is the interleaved signal following the example in the description section. The third trace is the deinterleaved signal which matches the vector source output.

## Source Files
- Python files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/python/blocks/qa_matrix_interleaver.py]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/grc/blocks_matrix_interleaver.block.yml]
