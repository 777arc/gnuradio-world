<!-- block: blocks_integrate_xx -->
<!-- title: Integrate -->
<!-- source: https://wiki.gnuradio.org/index.php/Integrate -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Integrate successive samples and decimate.  Set decimation to 1 in order to not decimate.

## Parameters
- IO Type
  Supported types are: complex, float, int,and short.

- Decimation
  Number of successive samples to integrate (and thus decimate).  Set decimation to 1 in order to not decimate.

- Vector Length
  The vector length for the input stream

## Example Flowgraph
Here is a simple flow graph showing the integrate block with different decimation values:

The expected output is:

The settings page looks like:

## Source Files
- C++ files
  integrate_impl.cc

- Header files
  integrate_impl.h

- Public header files
  integrate.h

- Block definition
  blocks_integrate_xx.block.yml
