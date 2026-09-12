<!-- block: digital_map_bb -->
<!-- title: Map -->
<!-- source: https://wiki.gnuradio.org/index.php/Map -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This block maps an incoming signal to the value in the map. The block expects that the incoming signal has a maximum value of len(map)-1.

output[i] = map[input[i]]

This block only takes byte input, and only produces byte output.

For a more in-depth look at mapping, take a look at the  Constellation Mapping Tutorial.

## Parameters
- Map
  A vector of integers that maps x to map[x].

## Example Flowgraph
This flowgraph can be found in the  QPSK Mod and Demod Tutorial.

## Source Files
- C++ files
  map_bb_impl.cc

- Header files
  map_bb_impl.h

- Public header files
  map_bb.h

- Block definition
  digital_map_bb.block.yml
