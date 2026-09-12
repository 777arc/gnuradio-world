<!-- block: dc_blocker_xx -->
<!-- title: DC Blocker -->
<!-- source: https://wiki.gnuradio.org/index.php/DC_Blocker -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

A computationally efficient controllable DC blocker that blocks the DC component of a signal. This can be useful when working with AM signals, as taking the magnitude of the envelope will always be positive and thus introduce a DC bias on the signal.

This block implements a computationally efficient DC blocker that produces a tighter notch filter around DC for a smaller group delay than an equivalent FIR filter or using a single pole IIR filter (though the IIR filter is computationally cheaper).

The block defaults to using a delay line of length 32 and the long form of the filter. Optionally, the delay line length can be changed to alter the width of the DC notch (longer lines will decrease the width).

The long form of the filter produces a nearly flat response outside of the notch but at the cost of a group delay of 2D-2.

The short form of the filter does not have as flat a response in the passband but has a group delay of only D-1 and is cheaper to compute.

## Parameters
- Length
  Specifies the length of the delay line used for determining the DC level. Only applicable to the long form.

- Long Form
  When set to True, use the long form DC blocker, with delay line. When set to False, use the short form (faster).

## Example Flowgraph
This flowgraph can be downloaded from Media:dc_blocker.grc.

The DC Blocker is a computationally efficient block designed to remove the DC component from a signal, useful for applications like AM signal processing where a DC bias may be introduced. It creates a tight notch filter around DC, outperforming simpler IIR filters, with configurable parameters: a delay line length (default 32, adjustable to widen/narrow the notch) and a long form option (True for a flatter response with higher group delay, False for faster processing with lower delay).

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-filter/lib/dc_blocker_cc_impl.cc]
  [https://github.com/gnuradio/gnuradio/blob/main/gr-filter/lib/dc_blocker_ff_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-filter/lib/dc_blocker_cc_impl.h]
  [https://github.com/gnuradio/gnuradio/blob/main/gr-filter/lib/dc_blocker_ff_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-filter/include/gnuradio/filter/dc_blocker_ff.h]
  [https://github.com/gnuradio/gnuradio/blob/main/gr-filter/include/gnuradio/filter/dc_blocker_cc.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/main/gr-filter/grc/filter_dc_blocker_xx.block.yml]
