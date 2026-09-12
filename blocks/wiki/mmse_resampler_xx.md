<!-- block: mmse_resampler_xx -->
<!-- title: Fractional Resampler -->
<!-- source: https://wiki.gnuradio.org/index.php/Fractional_Resampler -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Resampling MMSE filter.

The resampling ratio and mu parameters can be set with a pmt dict message. Keys are pmt symbols with the strings "resamp_ratio" and "mu" and values are pmt floats.

## Parameters
(R): Run-time adjustable

- Phase Shift
  type: real

- Resampling Ratio (R)
  The Resampling Ratio is the fraction of (input_rate/output_rate). (type: real)

## Example Flowgraph
In this example, the Resampling Ratio has an additional adjustment to compensate for Underruns at the transmitter. The factor = 1.0/((usrp_rate/samp_rate)*rs_ratio)

## Source Files
- C++ files
  Complex Input
  Real Input

- Header files
  Complex Input
  Real Input

- Public header files
  Complex Input
  Real Input

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-filter/grc/filter_mmse_resampler_xx.block.yml]
