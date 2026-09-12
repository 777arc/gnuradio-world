<!-- block: qtgui_auto_correlator_sink -->
<!-- title: QT GUI Fast Auto-Correlator Sink -->
<!-- source: https://wiki.gnuradio.org/index.php/QT_GUI_Fast_Auto-Correlator_Sink -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This block uses the Wiener Khinchin theorem that the FFT of a signal's power spectrum is its auto-correlation function.

FAC Size controls the FFT size and therefore the length of time (samp_rate/fac_size) the auto-correlation runs over.

Added in 3.9

## Parameters
(R): Run-time adjustable

- Sample Rate
  default: samp_rate

- FAC Size
  FAC Size controls the FFT size (default: 512)

- FAC Decimation
  default: 10

- Output
  options: [dB, Normalized]

- Title
  display title

- Show Grid
  options: [Yes, No]

- Auto-Scale
  options: [Yes, No]

- Y Min
  default: 0

- Y Max
  default: 1

See GUI Hint for how to position the GUI within a window.

## Example Flowgraph
This flowgraph can be found at [https://github.com/gnuradio/gnuradio/blob/master/gr-qtgui/examples/test_autocorrelator.grc]

## Example Output
## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  TODO
