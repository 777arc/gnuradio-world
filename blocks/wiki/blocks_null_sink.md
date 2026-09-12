<!-- block: blocks_null_sink -->
<!-- title: Null Sink -->
<!-- source: https://wiki.gnuradio.org/index.php/Null_Sink -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

The "bit bucket". Use as a termination point when a sink is required but we don't want to do anything with the stream.

## Parameters
None

## Example Flowgraph
The Detector, Mark, and Space outputs of the RTTY Demod block are unused, so they are connected to Null Sink blocks to satisfy the requirement that all ports are connected to something.

## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  TODO
