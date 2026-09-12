<!-- block: low_pass_filter -->
<!-- title: Low Pass Filter -->
<!-- source: https://wiki.gnuradio.org/index.php/Low_Pass_Filter -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This filter is a convenience wrapper for an Decimating FIR Filter and a firdes taps generating function of low-pass type, i.e. calling firdes.low_pass().

## Parameters
(R): Run-time adjustable

- FIR Type (R)
  Specify whether input/output is real or complex

- Decimation
  Decimation rate of filter, must be an integer, and cannot change in realtime.

- Gain (R)
  Scaling factor applied to output.

- Sample Rate (R)
  Input sample rate.

- Cutoff Freq (R)
  Cutoff frequency in Hz

- Transition Width (R)
  Transition width between stop-band and pass-band in Hz

- Window (R)
  Type of window to use

- Beta (R)
  The beta paramater only applies to the Kaiser window.

## Example Flowgraph
This flowgraph shows a Low Pass Filter block.

## Source Files
