<!-- block: vocoder_cvsd_decode_bf -->
<!-- title: CVSD Decoder -->
<!-- source: https://wiki.gnuradio.org/index.php/CVSD_Decoder -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This is a wrapper for the CVSD decoder that performs decimation and filtering necessary to work with the vocoding.
It converts an incoming CVSD-encoded short to a float, decodes it to a float, decimates it, and scales it (by 32000, slightly below the maximum value to avoid clipping).

The sampling rate can be anything, though, of course, the higher the sampling rate and the higher the interpolation rate are, the better the sound quality.

When using the CVSD vocoder, appropriate sampling rates are from 8k to 64k with resampling rates from 1 to 8. A rate of 8k with a resampling rate of 8 provides a good quality signal.

## Parameters
- Resample
  Resampling (decimation) rate after vocoder decoding

- Frac. Bandwidth
  Low pass filter bandwidth (relative , should be <= 0.5)

## Example Flowgraph
Small GRC flowgraph to experiment with the use of the blocks.
Specifically to understand: Oversampling requirement, Float to short conversion and impact on audio quality across frequency.

Media:cvsd.grc

## Source Files
- Python file
  Here

- Block definition
  Yaml
