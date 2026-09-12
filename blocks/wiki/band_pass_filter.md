<!-- block: band_pass_filter -->
<!-- title: Band Pass Filter -->
<!-- source: https://wiki.gnuradio.org/index.php/Band_Pass_Filter -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This filter is a convenience wrapper for an Decimating FIR Filter (or the interpolating FIR filter) and a firdes taps generating function of band-pass type, i.e. calling firdes.band_pass() or firdes.complex_band_pass().

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
  The beta parameter only applies to the Kaiser window.

## Example Flowgraph
This flowgraph shows the use of a Band Pass Filter block. This is a working AM broadcast band receiver.

## Source Files
