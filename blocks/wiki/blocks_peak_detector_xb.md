<!-- block: blocks_peak_detector_xb -->
<!-- title: Peak Detector -->
<!-- source: https://wiki.gnuradio.org/index.php/Peak_Detector -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Detect the peak of a signal.

If a peak is detected, this block outputs a 1, else it outputs 0's.

## Parameters
(R): Run-time adjustable

- TH factor rise (R)
  Determines when a peak has started. An average of the signal is calculated and when the value of the signal goes over threshold_factor_rise*average, we start looking for a peak.

- TH factor fall (R)
  Determines when a peak has ended. An average of the signal is calculated and when the value of the signal goes below threshold_factor_fall*average, we stop looking for a peak.

- Look ahead (R)
  Used when the threshold is found to look if there is another peak within this step range. If there is a larger value, we set that as the peak and look ahead again. This is continued until the highest point is found with this look-ahead range.

- Alpha (R)
  The gain value of a moving average filter

## Example Flowgraph
This flowgraph can be downloaded from Media:Peak_detector.grc.

## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  TODO
