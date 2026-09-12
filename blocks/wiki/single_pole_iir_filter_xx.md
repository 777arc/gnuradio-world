<!-- block: single_pole_iir_filter_xx -->
<!-- title: Single Pole IIR Filter -->
<!-- source: https://wiki.gnuradio.org/index.php/Single_Pole_IIR_Filter -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

The input and output satisfy a difference equation of the form  y[n] - (1-\alpha) y[n-1] = \alpha x[n]

with the corresponding rational system function  H(z) = \frac{\alpha}{1 - (1-\alpha) z^{-1}}

Note that some texts define the system function with a + in the denominator. If you're using that convention, you'll need to negate the feedback tap.

## Parameters
(R): Run-time adjustable

- Alpha (R)
  ## Example Flowgraph
## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-filter/lib/single_pole_iir_filter_ff_impl.cc]
  [https://github.com/gnuradio/gnuradio/blob/master/gr-filter/lib/single_pole_iir_filter_ff_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-filter/lib/single_pole_iir_filter_ff_impl.h]
  [https://github.com/gnuradio/gnuradio/blob/master/gr-filter/lib/single_pole_iir_filter_ff_impl.h]

- Public header files
  Base
  Complex input
  Float input

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-filter/grc/filter_single_pole_iir_filter_xx.block.yml]
