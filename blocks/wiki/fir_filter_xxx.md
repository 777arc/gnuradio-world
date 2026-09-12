<!-- block: fir_filter_xxx -->
<!-- title: Decimating FIR Filter -->
<!-- source: https://wiki.gnuradio.org/index.php/Decimating_FIR_Filter -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This is GNU Radio's "normal" FIR Filter.

For a large number of taps, consider using an FFT Filter, see [http://www.trondeau.com/blog/2014/2/27/to-use-or-not-to-use-fft-filters.html]

For standard filters such as lowpass, highpass, bandpass, etc., the filter.firdes and filter.optfir classes provide convenient generating methods.

## Parameters
(R): Run-time adjustable

- Decimation
  Decimation rate.  The output stream will have this decimation applied to it.  A decimation rate of 1 simply means no decimation.  If decimation is set higher than 1, make sure the filter will remove energy outside of the "output region", i.e. -Fs/2 to Fs/2 where Fs is the input sample rate divided by the decimation rate.

- Taps (R)
  Taps to use in FIR filter.

- Sample Delay
  Additional samples to delay by, default is 0 or no delay.

## Example Flowgraph
This flowgraph implements a Broadcast FM stereo receiver using basic blocks.

## Source Files
- C++ files
  fir_filter.cc

- Public header files
  fir_filter.h

- Block definition
  filter_fir_filter_xxx.block.yml
