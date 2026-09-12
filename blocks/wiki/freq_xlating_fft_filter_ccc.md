<!-- block: freq_xlating_fft_filter_ccc -->
<!-- title: Frequency Xlating FFT Filter -->
<!-- source: https://wiki.gnuradio.org/index.php/Frequency_Xlating_FFT_Filter -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This is a hier block, consisting of a FFT Filter block and a Rotator block.  It performs the same function as the Frequency Xlating FIR Filter, except using an FFT Filter.  See Frequency Xlating FIR Filter for more information.

## Parameters
(R): Run-time adjustable

- Decimation
  The integer ratio between the input and the output signal’s sampling rate.

- Taps (R)
  The vector of the complex or real taps of the FIR filter.  You can generate these taps within the parameter box using firdes, for example:
  Real taps:
  firdes.low_pass(1,samp_rate,samp_rate/(2*decimation), transition_bw)
  Complex taps:
  firdes.complex_band_pass(1, samp_rate, -samp_rate/(2*decimation), samp_rate/(2*decimation), transition_bw)
  Note: transition_bw is the transition bandwidth of the filter in Hz. The lower it is, the more taps the function will generate, and the more CPU time it will take to apply this filter. This parameter will determine the CPU usage and thus the execution speed of the block.

- Center Frequency (R)
  The frequency translation offset frequency.

- Sample Rate
  The sample rate of the input signal.

- Sample Delay
  Sets the sample delay of the filter block, see FFT Filter for more info.

- Num Threads (R)
  Sets the number of threads used by the filter block, see FFT Filter for more info.

## Example Flowgraph
The following flowgraph sets a SDR to a fixed frequency, then uses the Frequency Xlating FFT Filter to center and filter the signal.

## Source Files
Python Hier Block
