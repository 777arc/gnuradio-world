<!-- block: analog_noise_source_x -->
<!-- title: Noise Source -->
<!-- source: https://wiki.gnuradio.org/index.php/Noise_Source -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Produces a "noise" signal using either a Gaussian or Uniform distribution

Supports output of type complex, float, int, or short.

## Parameters
- Noise Type
  The random distribution to use, only Gaussian and Uniform are supported

- Amplitude
  The standard deviation of a 1-d noise process. If this is the complex source, this parameter is split among the real and imaginary parts

- Seed
  Seed for random generators. If 0, the seed will be selected using the system clock such that the output sequence is different on each run. Use a non-zero seed to get the same output on each run.

## Example Flowgraph
## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-analog/lib/noise_source_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-analog/lib/noise_source_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-analog/include/gnuradio/analog/noise_source.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/main/gr-analog/grc/analog_noise_source_x.block.yml]
