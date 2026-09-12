<!-- block: logpwrfft_x -->
<!-- title: Log Power FFT -->
<!-- source: https://wiki.gnuradio.org/index.php/Log_Power_FFT -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Create a log10(|fft|²) stream chain, with real or complex input.

## Parameters
(R): Run-time adjustable

- FFT Size
  Number of FFT bins

- Reference Scale
  Sets 0 dB value input amplitude

- Frame Rate
  Output frame rate

- Average (R)
  Whether to average [True, False]

- Average Alpha (R)
  FFT averaging (over time) constant [0.0-1.0]

## Example Flowgraph
This flowgraph can be downloaded from Media:Log Power FFT.grc.

Flowgraph Description: Log Power FFT Spectrum Analysis

This flowgraph, created in GNU Radio Companion (GRC), showcases the Log Power FFT block's ability to compute and display the logarithmic power spectrum of a 1 kHz sine wave. Below is a concise overview of its components, configuration, and output:

- Signal Source: Generates a 1 kHz sine wave with an amplitude of 1, sampled at 32 kHz (32,000 samples per second). This provides a single-tone input for analysis.
- Throttle: Set to 32 kHz to regulate the data flow, ensuring real-time visualization without overwhelming the system.
- Log Power FFT: Processes the input signal to produce a logarithmic power spectrum. Key parameters include:

  - FFT Size: 1024, creating 1024 frequency bins with a resolution of 31.25 Hz (32,000 Hz / 1024).
  - Reference Scale: 512, setting the sine wave's peak at 0 dB in the output.
  - FFT Shift: Enabled, centering the spectrum with 0 Hz in the middle.
- QT GUI Vector Sink: Visualizes the spectrum, spanning -16,000 Hz to +16,000 Hz on the x-axis. The output displays a prominent peak at ±1,000 Hz at 0 dB, reflecting the input sine wave, with a noise floor between -200 dB and -150 dB.

This flowgraph effectively illustrates how the Log Power FFT block converts a time-domain signal into a frequency-domain representation, offering a clear view of the signal’s spectral characteristics.

## Source Files
- Python Source
  Here

- Block definition
  Here
