<!-- block: digital_clock_recovery_mm_xx -->
<!-- title: Clock Recovery MM -->
<!-- source: https://wiki.gnuradio.org/index.php/Clock_Recovery_MM -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This block is meant to act as a clock recovery, to synchronize to a signal's frequency and phase, so that symbols can be extracted.

Deprecated in 3.9 (Favor Symbol_Sync instead.)

Specifically, this implements the Mueller and Mueller (M&M) discrete-time error-tracking synchronizer.  The peak to peak input signal amplitude must be symmetrical about zero, as the M&M timing error detector (TED) is a decision directed TED, and this block uses a symbol decision slicer referenced at zero.  The input signal peak amplitude should be controlled to a consistent level (e.g. +/- 1.0) before this block to achieve consistent results for given gain settings; as the TED's output error signal is directly affected by the input amplitude.  The input signal must have peaks in order for the TED to output a correct error signal. If the input signal pulses do not have peaks (e.g. rectangular pulses) the input signal should be conditioned with a matched pulse filter or other appropriate filter to peak the input pulses. For a rectangular base pulse that is N samples wide, the matched filter taps would be [1.0/float(N)]*N, or in other words a moving average over N samples. This block will output samples at a rate of one sample per recovered symbol, and is thus not outputting at a constant rate.  Output symbols are not a subset of input, but may be interpolated.

The complex version here is based on: Modified Mueller and Muller clock recovery circuit: G. R. Danesfahani, T.G. Jeans, "Optimisation of modified Mueller  and Muller algorithm," Electronics Letters, Vol. 31, no. 13, 22 June 1995, pp. 1032 - 1033.

For more info see [https://www.tablix.org/~avian/blog/archives/2015/03/notes_on_m_m_clock_recovery/]

## Parameters
(R): Run-time adjustable

- Omega (R)
  Initial estimate of samples per symbol

- Gain Omega (R)
  Gain setting for omega update loop

- Mu (R)
  Initial estimate of phase of sample

- Gain Mu (R)
  Gain setting for mu update loop

- Omega Relative Limit
  Limit on omega

## Example Flowgraph
## Source Files
