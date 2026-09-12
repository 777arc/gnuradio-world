<!-- block: analog_wfm_rcv_pll -->
<!-- title: WBFM Receive PLL -->
<!-- source: https://wiki.gnuradio.org/index.php/WBFM_Receive_PLL -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Hierarchical block for demodulating a broadcast FM signal.

The input is the downconverted complex baseband signal (gr_complex).

The output is the demodulated audio (float)

Compared to WBFM Receive, this one does a full stereo demodulation.

## Parameters
- Quadrature Rate
  Input sample rate of complex baseband input. (float)

- Audio Decimation
  How much to decimate quad_rate to get to audio. (integer)

- Deemphasis Tau
  Deemphasis time constant (float) - typically 75e-6 (US) or 50e-6 (Europe)

## Example Flowgraph
This flowgraph shows the stereo version of the WBFM receiver. The flowgraph file can be found in https://github.com/gnuradio/gnuradio/blob/master/gr-analog/examples/USRP_FM_stereo.grc

## Source Files
- Python files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-analog/python/analog/wfm_rcv_pll.py]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-analog/grc/analog_wfm_rcv_pll.block.yml]
