<!-- block: analog_wfm_rcv -->
<!-- title: WBFM Receive -->
<!-- source: https://wiki.gnuradio.org/index.php/WBFM_Receive -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Hierarchical block for demodulating a broadcast FM signal.

The input is the downconverted complex baseband signal (gr_complex).

The output is the demodulated audio (float).

Compared to WBFM Receive PLL, this one does a simple mono demodulation with deemphasis

## Parameters
- Channel Rate
  Input sample rate of complex baseband input. (float)

- Audio Decimation
  How much to decimate Channel Rate to get to audio. (integer)

- Deviation
  FM modulation deviation. Standard FM broadcast uses 75 kHz

- Audio Pass
  Low pass filter rolloff frequency

- Audio Stop
  Low pass filter cutoff frequency

- Gain
  Audio gain

- Tau
  Preemphasis time constant (float) - typically 75e-6 (US) or 50e-6 (Europe)

## Example Flowgraph
Implementing an FM broadcast band receiver is really easy with the WBFM Receive Block.

## Source Files
- Python files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-analog/python/analog/wfm_rcv.py]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-analog/grc/analog_wfm_rcv.block.yml]
