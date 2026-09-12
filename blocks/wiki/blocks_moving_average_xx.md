<!-- block: blocks_moving_average_xx -->
<!-- title: Moving Average -->
<!-- source: https://wiki.gnuradio.org/index.php/Moving_Average -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Computes a moving average of the input:

Output[i] = scale * sum(input[i-length: i])

In its default parameters, the block actually computes a moving sum.

## Parameters
(R): Run-time adjustable
- Input Type
  Complex, Float, Int or Short

- Length  (R)
  The size of the moving average window to use.

- Scale  (R)
  Factor to scale the sum of the last (Length) samples. To get an actual moving average, the scale should then be set to 1/Length.

- Max Iter
  The maximum number of samples the block will treat in one call of its work function. Larger numbers can improve throughput at the cost of latency and potential numerical instability with float or complex input.
  Max Iter can be smaller than Length without issues.

- vlen
  Used if the input samples are vectors and corresponds to the length of those vectors.
  When operating on vectors, the average is done using only the numbers from the same vector index:
  Output[i][vector_index] = scale * sum(Input[i-length: i][vector_index])

## Example Flowgraph
This flowgraph can be found at [https://raw.githubusercontent.com/gnuradio/gnuradio/master/gr-pdu/examples/tags_to_pdu_example.grc]

## Source Files
- C++ files
  All inputs

- Header files
  All inputs

- Public header files
  All inputs

- Block definition
  GRC yaml
