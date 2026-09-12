<!-- block: interp_fir_filter_xxx -->
<!-- title: Interpolating FIR Filter -->
<!-- source: https://wiki.gnuradio.org/index.php/Interpolating_FIR_Filter -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Interpolating FIR filter with various I/O and taps types.

The block create finite impulse response (FIR) filters that perform the convolution in the time domain:
    out = 0
    for i in ntaps:
       out += input[n-i] * taps[i]

## Parameters
(R): Run-time adjustable

- Interpolation
  Interpolation rate

- Taps (R)
  The taps are a C++ vector (or Python list) of values of the type specified in the type selection list. Taps can be created using the firdes or optfir tools.

- Sample delay
  This delay is mostly used to adjust the placement of the tags and is not currently used for any signal processing. When a tag is passed through a block with internal delay, its location should be moved based on the delay of the block.

## Example Flowgraph
This flowgraph can be downloaded from Media:Interpolating_fir_filter.grc.

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-filter/lib/interp_fir_filter_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-filter/lib/interp_fir_filter_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-filter/include/gnuradio/filter/interp_fir_filter.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-filter/grc/filter_interp_fir_filter_xxx.block.yml]
