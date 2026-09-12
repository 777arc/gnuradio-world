<!-- block: band_reject_filter -->
<!-- title: Band Reject Filter -->
<!-- source: https://wiki.gnuradio.org/index.php/Band_Reject_Filter -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This filter is a convenience wrapper for an Decimating FIR Filter and a firdes taps generating function of band-reject type, i.e. calling firdes.band_reject().

## Parameters
(R): Run-time adjustable

- FIR Type (R)
  Specify whether input/output is real or complex, and if the taps are real or complex.

- Decimation
  Decimation rate of filter, must be an integer, and cannot change in realtime.

- Gain (R)
  Scaling factor applied to output.

- Sample Rate (R)
  Input sample rate.

- Low Cutoff Freq (R)
  Lower cutoff frequency in Hz

- High Cutoff Freq (R)
  Upper cutoff frequency in Hz

- Transition Width (R)
  Transition width between stop-band and pass-band in Hz

- Window (R)
  Type of window to use

- Beta (R)
  The beta paramater only applies to the Kaiser window.

## Example Flowgraph
This flowgraph can be downloaded from Media:Example_band_reject.grc.
## Source Files
