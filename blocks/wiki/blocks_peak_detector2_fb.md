<!-- block: blocks_peak_detector2_fb -->
<!-- title: Peak Detector2 -->
<!-- source: https://wiki.gnuradio.org/index.php/Peak_Detector2 -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Detect the peak of a signal.

If a peak is detected, this block outputs a 1, else it outputs 0's. A separate debug output may be connected, to view the internal estimated mean described below.

## Parameters
(R): Run-time adjustable

- TH factor rise (R)
  Determines when a peak is present. An average of the input signal is calculated (through a single-pole autoregressive filter) and when the value of the input signal goes over threshold_factor_rise*average, we assume we are in the neighborhood of a peak. The block will then find the position of the maximum within a window of look_ahead samples starting at the point where the threshold was crossed upwards.

- Look ahead (R)
  Used when the threshold is found to look if there another peak within this step range.

- Alpha (R)
  One minus the pole of a single-pole autoregressive filter that evaluates the average of the input signal.

## Example Flowgraph
This flowgraph can be found at [https://github.com/gnuradio/gnuradio/blob/master/gr-blocks/examples/peak_detector2.grc].

## Example Output
## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  TODO
