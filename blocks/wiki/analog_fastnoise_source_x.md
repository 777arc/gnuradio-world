<!-- block: analog_fastnoise_source_x -->
<!-- title: Fast Noise Source -->
<!-- source: https://wiki.gnuradio.org/index.php/Fast_Noise_Source -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Similar to the Noise Source block, except it uses less CPU by pre-generating a pool of random variates taken from the specified distribution.  At runtime, samples are then uniform randomly chosen from this pool which is a very fast operation.

Supports output of type complex, float, int, short

## Parameters
- Noise Type
  The random distribution to use, only Gaussian and Uniform are supported

- Amplitude
  The standard deviation of a 1-d noise process. If this is the complex source, this parameter is split among the real and imaginary parts

- Seed
  Seed for random generators. Note that for uniform and Gaussian distributions, this should be a negative number.

- Variate Pool Size
  Number of samples to pre-generate

## Example Flowgraph
Media:example_fast_noise.grc
## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-analog/lib/fastnoise_source_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-analog/lib/fastnoise_source_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-analog/include/gnuradio/analog/fastnoise_source.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/main/gr-analog/grc/analog_fastnoise_source_x.block.yml]
