<!-- block: blocks_min_xx -->
<!-- title: Min -->
<!-- source: https://wiki.gnuradio.org/index.php/Min -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Compares vectors from multiple streams and determines the minimum value from each vector over all streams.

Data is passed in as a vector of length  from multiple input sources.

If vlen_out == 1 then it will look through these streams of data items and the output stream will contain the minimum value in the vector.

If vlen_out == vlen and not equal to 1 then output will be a vector with individual items selected from the minimum corresponding input vector items.

## Parameters
- Num Inputs
  Number of streams to perform operation on

- Input vec length
  Vector size of input.  Must match previous block in the chain.

- Output vec length
  Vector size of output.  Must match next block in the chain.

## Example Flowgraph
Media:max_min_example.grc

## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  TODO
