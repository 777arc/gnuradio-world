<!-- block: rational_resampler_xxx -->
<!-- title: Rational Resampler -->
<!-- source: https://wiki.gnuradio.org/index.php/Rational_Resampler -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Rational resampling polyphase FIR filter.

Either taps or fractional_bw may be specified, but not both.

If neither is specified, a reasonable default, 0.4, is used as the fractional_bw.

If the input signal is at rate fs, then the output signal will be at a rate of interpolation · fs / decimation.

The interpolation and decimation rates should be kept as small as possible, and generally should be relatively prime to help reduce complexity in memory and computation.

The set of taps supplied to this filterbank should be designed around the resampling amount and must avoid aliasing (when interpolation/decimation  1).

As with any filter, the behavior of the filter taps (or coefficients) is determined by the highest sampling rate that the filter will ever see. In the case of a resampler that increases the sampling rate, the highest sampling rate observed interpolation since in the filterbank, the number of
filter arms is equal to \p interpolation. When the resampler decreases the sampling rate (decimation > interpolation), then the highest rate is the input sample rate of the original signal. We must create a filter based around this value to reduce any aliasing that may occur from out-of-band signals.

Another way to think about how to create the filter taps is that the filter is effectively applied after interpolation and before decimation. And yet another way to think of it is that the taps should be a LPF that is at least as narrow as the narrower of the required anti-image postfilter or anti-alias prefilter.

## Parameters
(R): Run-time adjustable

- Interpolation
  Interpolation factor (integer > 0)

- Decimation
  Decimation factor (integer > 0)

- Taps (R)
  Optional filter coefficients (sequence)

- Fractional BW
  Fractional bandwidth in (0, 0.5), measured at final freq (use 0.4) (float). In GNU Radio 3.8, the default value is 0, which should either be changed to a value 'between' 0 and 0.5; or just removed. Removing the value of fractional bandwidth will cause the block to use the default value of 0.4.

## Example Flowgraph
This flowgraph shows a Rational Resampler block changing the sample rate from 960 to 500.

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-filter/lib/rational_resampler_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-filter/lib/rational_resampler_impl.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-filter/grc/filter_rational_resampler_xxx.block.yml]
