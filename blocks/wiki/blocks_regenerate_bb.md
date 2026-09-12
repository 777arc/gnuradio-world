<!-- block: blocks_regenerate_bb -->
<!-- title: Regenerate -->
<!-- source: https://wiki.gnuradio.org/index.php/Regenerate -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Detect the peak of a signal and repeat every period samples.

If a peak is detected, this block outputs a 1 repeated every period samples until reset by detection of another 1 on the input or stopped after Max Regen Count regenerations have occurred.

## Parameters
- Period
  The number of samples between regenerations.

- Max Regen Count
  The maximum number of regenerations to perform; if set to -1 or ULONG_MAX, it will regenerate continuously.

## Example Flowgraph
Media:example_regenerate.grc
## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  TODO
