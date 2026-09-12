<!-- block: analog_dpll_bb -->
<!-- title: Detect Peak -->
<!-- source: https://wiki.gnuradio.org/index.php/Detect_Peak -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Detect the peak of a signal. If a peak is detected, this block outputs a 1, or it outputs 0's.

Possible more information here, but this block's wiki page needs to be improved.

## Parameters
(R): Run-time adjustable

- Period
  - Gain (R)
  ## Example Flowgraph
Media:example_detect_peak.grc

## Source Files
dpll_bb is the referenced name for most files. Look at the Block definition below to see how the analog dpll_bb is built with the block name detect peak

- C++ files
  dpll_bb_impl.cc

- Header files
  dpll_bb_impl.h

- Public header files
  dpll_bb.h

- Block definition
  analog_dpll_bb.block.yml

- Test File
  qa_dpll.py
