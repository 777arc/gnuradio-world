<!-- block: blocks_threshold_ff -->
<!-- title: Threshold -->
<!-- source: https://wiki.gnuradio.org/index.php/Threshold -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Output a 1 or zero based on a threshold value.

Test the incoming signal against a threshold. If the signal
excedes the High value, it will change its output to 1, and if the signal
falls below the Low value, it will change its output to 0.

## Parameters
(R): Run-time adjustable

- Low (R)
  Low threshold. Outputs 0 if input goes below it

- High (R)
  High threshold. Outputs 1 if input goes above it

- Initial value
  Value to output before the input reach one of the thresholds. Can be any value, not just 0 or 1.

## Example Flowgraphs
### Simple Example
This flowgraph can be found at Media:threshold_example.grc

### Advanced Example
This flowgraph can be found at [https://raw.githubusercontent.com/gnuradio/gnuradio/master/gr-pdu/examples/tags_to_pdu_example.grc]

### Audio Example
The Sound detector and notifier example on the Audio Source page contains a simple threshold volume detector.

## Source Files
- C++ files
  Here

- Header files
  Here

- Public header files
  Here

- Block definition
  Yaml
