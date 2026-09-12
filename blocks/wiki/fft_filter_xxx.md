<!-- block: fft_filter_xxx -->
<!-- title: FFT Filter -->
<!-- source: https://wiki.gnuradio.org/index.php/FFT_Filter -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This block implements a decimating filter using the fast convolution method via an FFT.  It is an alternative to the Decimating FIR Filter, useful when there is a large number of taps.

This filter is implemented by using the FFTW package to perform the required FFTs. An optional argument, nthreads, may be passed to the constructor (or set using the set_nthreads member function) to split the FFT among N number of threads. This can improve performance on very large FFTs (that is, if the number of taps used is very large) if you have enough threads/cores to support it.

For standard filters such as lowpass, highpass, bandpass, etc., the filter.firdes and filter.optfir classes provide convenient generating methods.

## Parameters
(R): Run-time adjustable

- Decimation
  Decimation rate.  The output stream will have this decimation applied to it.  A decimation rate of 1 simply means no decimation.  If decimation is set higher than 1, make sure the filter will remove energy outside of the "output region", i.e. -Fs/2 to Fs/2 where Fs is the input sample rate divided by the decimation rate.

- Taps (R)
  Taps to use in FIR filter.

- Sample Delay
  Number of additional samples to delay signal by.

- Number of Threads
  Number of threads to use for this block, i.e. to increase performance on multicore CPUs.

## Example Flowgraph
This flowgraph implements a Broadcast FM stereo receiver using basic blocks.

## Source Files
- C++ files
  Complex input/output and complex taps
  Complex input/output and float taps
  Float input/output and float taps
  Algorithms implementation

- Header files
  Complex input/output and complex taps
  Complex input/output and float taps
  Float input/output and float taps

- Public header files
  Complex input/output and complex taps
  Complex input/output and float taps
  Float input/output and float taps

- Block definition
  Yaml

## Outside References
  To Use or Not to Use FFT Filters
