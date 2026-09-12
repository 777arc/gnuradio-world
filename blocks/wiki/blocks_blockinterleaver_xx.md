<!-- block: blocks_blockinterleaver_xx -->
<!-- title: Block interleaver -->
<!-- source: https://wiki.gnuradio.org/index.php/Block_interleaver -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Fully parameterizable block interleaver.

This block accepts item multiples of size interleaver_indices.size() and interleaves or deinterleaves them on the output.

The idea is to define a static interleaving pattern, which is repeatedly applied to segments of the input stream. For example, if the interleaver indices are

```
0, 2, 3, 1
```

and our input is

```
A, B, C, D, E, F, G, H, I, J, K, L, M
```

then the input is considered in segments of the same length as the interleaver index vector:

```
A, B, C, D, E, F, G, H, I, J, K, L, M, …
|––––––––––||––––––––––||––––––––––||––÷
 0, 1, 2, 3  0, 1, 2, 3  0, 1, 2, 3  0, …
```

which are then individually permuted according to the index vector

```
0, 2, 3, 1  0, 2, 3, 1  0, 2, 3, 1  0, …
|––––––––––||––––––––––||––––––––––||––÷
 A, C, D, B, E, G, H, F, I, K, L, J, M, …
```

## Parameters
(R): Run-time adjustable

- IO Type
  type of the in- and output streams
  options: [byte, complex, float, int, short]
- Interleaver indices
  indices of items in output vector
  default: '[1, 2, 0]'
- Mode
  switch between interleaverand deinterleaver mode
  options: [interleave, deinterleave]
- Packed bytes
  Assume packed bytes. For uint8_t I/O only.
  default: False

## Example Flowgraph
## Example Output
## Source Files
- C++ files
  blockinterleaver_xx_impl.cc

- Header files
  blockinterleaver_xx_impl.h

- Public header files
  blockinterleaver_xx.h

- Block definition
  yaml file
