<!-- block: freq_xlating_fir_filter_xxx -->
<!-- title: Frequency Xlating FIR Filter -->
<!-- source: https://wiki.gnuradio.org/index.php/Frequency_Xlating_FIR_Filter -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

The Frequency Translating Finite Impulse Response Filter block performs a frequency translation on the signal and simultaneously downsamples the signal via a decimating FIR filter. The main use of this block is an effective channelizer, to pull out a narrowband portion of a wideband signal, without that narrowband portion having to be centered in frequency. Channelization in this manner is particularly useful for Software Defined Radios (SDRs) that capture a wide bandwidth via a very high sampling rate, yet the desired signal only occupies a narrow slice of bandwidth.

This block does not support C++ output, so it cannot be used when the output language of a flowgraph in GRC is C++.

See this page for more details.

## Parameters
(R): Run-time adjustable

- Decimation
  The integer ratio between the input and the output signal’s sampling rate.

- Taps (R)
  The vector of the complex or real taps of the FIR filter.  You can generate these taps within the parameter box using firdes (or make use of the taps blocks e.g. https://wiki.gnuradio.org/index.php?title=Low-pass_Filter_Taps ), for example:
  Real taps:
  firdes.low_pass(1,samp_rate,samp_rate/(2*decimation), transition_bw)
  Complex taps:
  firdes.complex_band_pass(1, samp_rate, -samp_rate/(2*decimation), samp_rate/(2*decimation), transition_bw)
  Note: transition_bw is the transition bandwidth of the filter in Hz. The lower it is, the more taps the function will generate, and the more CPU time it will take to apply this filter. This parameter will determine the CPU usage and thus the execution speed of the block.

- Center Frequency (R)
  The frequency translation offset frequency. Note: positive values shift the signal down (lower frequency) while negative values shift the signal up (higher frequency). See Example 3 below.

- Sample Rate
  The sample rate of the input signal.

## Example Flowgraph
### Example 1
Since sampling rate is mathematically correlated to the captured bandwidth via the Nyquist–Shannon sampling theorem, this block can safely downsample while isolating a narrow signal. This makes the block operationally identical to a series of Rotator, Bandpass, and Rational Resampler blocks, except the Frequency Xlating FIR Filter block does all these steps at once much more efficiently. So if your SDR is delivering I/Q samples at 2.56 million samples/second, but your Frequency-Shift Keying signal is 20 kHz wide, you can use the block to downsample to a minimum of 40 kS/s, saving substantial CPU resources in future processing steps. In practice though, it is often handy to use a higher-than-minimum sampling rate; this gives you extra samples that can be used for filter roll-off, averaged out to help pull a pulse signal out of noise, or for other purposes.

File:Freq_Xlating_FIR_Filter_flowgraph.png|An example flowgraph of this block to isolate a narrow signal from within a wideband capture file.
File:Freq_Xlating_FIR_Filter_example.png|The Frequency Translating FIR Filter in practice.

In the above example, Taps is set to firdes.band_pass(1.0, samp_rate, fsk_deviation/2 - bandpass_filter_width, fsk_deviation/2 + bandpass_filter_width, bandpass_filter_width), Center Frequency is set to recording_offset + (fsk_deviation / 2) and Sampling Rate is set to samp_rate. Due to the decimation factor of 2, the sampling rate on the output is now half.

### Example 2
This flowgraph uses the Frequency Xlating FIR Filter block to center Frequency Shift Keying tones around zero. Then a Quadrature Demod block can detect the high and low tones as positive or negative values. This decodes RTTY.

### Example 3
This flowgraph implements a 20 meter amateur radio Single Sideband receiver. It can be downloaded here. Rather than retuning the SDR for every small adjustment in frequency, this method retunes across a fixed bandwidth using the Frequency Xlating FIR Filter. Note that frequency shifts can be either positive or negative.

## Source Files
- C++ files
  freq_xlating_fir_filter_impl.cc

- Header files
  freq_xlating_fir_filter_impl.h

- Block definition
  filter_freq_xlating_fir_filter_xxx.block.yml
