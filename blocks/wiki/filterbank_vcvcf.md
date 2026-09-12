<!-- block: filterbank_vcvcf -->
<!-- title: Generic Filterbank -->
<!-- source: https://wiki.gnuradio.org/index.php/Generic_Filterbank -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

A filter bank with generic taps.

This block takes in a vector of N complex inputs, passes them through N FIR filters, and outputs a vector of N complex outputs.

The only advantage of using this block over N individual FIR filter blocks is that it places less of a load on the scheduler.

The number of filters cannot be changed dynamically, however filters can be deactivated (i.e. no processing is done for them) by passing a vector of filter taps containing all zeros to them.  In this case their entry in the output vector is a zero.

## Parameters
(R): Run-time adjustable

- Taps(list of lists) (R)
  (vector of vector of floats / list of list of floats) Populates the filters.
  e.g. [low_pass_taps_0,low_pass_taps_1,low_pass_taps_2]

## Example Flowgraph
In the example, three separate stream signals are combined into a vector of length 3.
The generic filterbank contains 3 low pass filters, one applied to each vector on the input.
At the output, the vector is split into 3 separate streams again to display.
If this was a channeliser, setting the filter taps to all zeros would blank out one of the signals for the respective signal.

## Source Files
- C++ files
  Work function
  Helper functions

- Header files
  Work function

- Public header files
  Work function
  Helper functions

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-filter/grc/filter_filterbank_vcvcf.block.yml]
