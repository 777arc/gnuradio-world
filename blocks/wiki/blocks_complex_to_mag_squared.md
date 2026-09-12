<!-- block: blocks_complex_to_mag_squared -->
<!-- title: Complex to Mag^2 -->
<!-- source: https://wiki.gnuradio.org/index.php/Complex_to_Mag^2 -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This block inputs a complex sample, then calculates the squared magnitude of each sample.

## Overview
The block appears as follows. Its input is a complex sample; the output will be real-only samples.

The only adjustable parameter is the vector length.

## Mathematical Description
The magnitude of a complex sample can be expressed as c[n] = \sqrt{r[n]^2 + i[n]^2}

The magnitude squared of a complex sample is just c[n]^2 = r[n]^2 + i[n]^2

If the input signal is a simple complex sinusoid, then r[n] = A cos[2\pi n fc/fs] and i[n] = A sin[2\pi n fc/fs]. The result of the complex magnitude squared would be equivalent to:

c[n]^2 = r[n]^2 + i[n]^2, so c[n]^2 = (A cos[2\pi n fc/fs])^2 + (A sin[2\pi n fc/fs])^2 = A^2 (cos^2[2\pi n fc/fs] + sin^2[2\pi n fc/fs])

cos^2 + sin^2 = 1, so A^2 (cos^2[2\pi n fc/fs] + sin^2[2\pi n fc/fs]) = A^2

## Parameters
- Vector Length
  integer value for the grouping of samples into a vector. Default value: 1.

## Example Flowgraphs
### Example #1: Measuring Signal-to-Noise Ratio
This flowgraph will measure the signal-to-noise ratio from a RTL-SDR for a FM broadcast station. (NOTE: This requires having a portion of the spectrum that has no signals present. This portion will be used to measure the noise power.)

The output of the RTL-SDR is split between a lowpass filter (used to filter out the signal) and a bandpass filter (used to filter out a portion of noise with the same bandwidth as the signal). The output of each filter is input to the Complex to Mag^2 block, which essentially calculates the power of each.

The output shows the original RF spectrum (black trace), the filtered signal (green trace) and the filtered noise (red trace). It calculates the signal-to-noise ratio (SNR) between the two and displays them at the top of the window. As the RTL-SDR does not provide calibrated power measurements, the measurements for both the signal and noise are measured as dBfs, or "decibels relative to full scale".

Flowgraph used for this demonstration:

### Example #2: Creating a Spectral Display
The following flowgraph creates a basic spectral display. The Complex to Mag^2 block calculates the power of each spectral point.

The FFT block creates a vector that is the frequency domain version of the input signal. The Complex to Mag^2 block calculates the power of each frequency point at the output of the FFT.

Flowgraph used for this demonstration:

## Source Files
- C++ files
  complex_to_mag_squared_impl.cc

- Header files
  complex_to_mag_squared_impl.h

- Public header files
  complex_to_mag_squared.h

- Block definition
  blocks_complex_to_mag_squared.block.yml
