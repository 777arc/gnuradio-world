<!-- block: blocks_patterned_interleaver -->
<!-- title: Patterned Interleaver -->
<!-- source: https://wiki.gnuradio.org/index.php/Patterned_Interleaver -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Interleave items from multiple streams based on a provided pattern (given as a vector).

## Parameters
- IO Type
  Supported types are: complex, float, int, short, and byte

- Pattern
  Vector that represents the interleaving pattern.
  For example, the pattern [ 0, 0, 1, 2 ] means to pass one item of data from port 0 twice, then from port 1 once, then from port 2 once, then repeat.
  The number of inputs is set by max(pattern,0) + 1.
  Note, all inputs must be connected even if all are not used in the pattern. For example, the pattern [0, 0, 1, 2, 4] would create 5 inputs. The fourth input (pattern val 3) is unused but the flowgraph will not run.

- Vector Length
  The vector length for the input stream(s).

## Example Flowgraph
Example 1

An example flowgraph using the default pattern with vector length 1 streams:

An example of the settings field:

An example of the beginning of the output sequence:

The output pattern begins with: 0, 1, 10, 20, 2, 3, 11, 21, 4, 0, 12, 22, ....

Example 2

This example shows a vector length 2 example:

An example of the beginning of the output sequence:

The output pattern for the first stream begins with: 0, 1, 10, 20, 2, 3, 11, 21, 4, 0, 12, 22, ....

The output pattern for the second stream begins with: 1, 2, 11, 21, 3, 4, 12, 22, 5, 0, 13, 23, ....

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/lib/patterned_interleaver_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/lib/patterned_interleaver_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/include/gnuradio/blocks/patterned_interleaver.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/grc/blocks_patterned_interleaver.block.yml]
