<!-- block: blocks_stretch_ff -->
<!-- title: Stretch -->
<!-- source: https://wiki.gnuradio.org/index.php/Stretch -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Adjust y-range of an input vector by mapping to range (max-of-input, stipulated-min).

Primarily for spectral signature matching by normalizing spectrum dynamic ranges.

## Parameters
- Low
  Set low value for range.

## Example Flowgraph
Below example uses a vector of 12 characters (1,0,2,0,1,0,1,0,1,0,1,0)

The Stretch block maps the vector values to the max item in the input vector.

Media:example_stretch.grc

## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  TODO
