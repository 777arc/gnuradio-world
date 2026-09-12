<!-- block: analog_nbfm_rx -->
<!-- title: NBFM Receive -->
<!-- source: https://wiki.gnuradio.org/index.php/NBFM_Receive -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Narrow Band FM Receiver.

Takes a single complex baseband input stream and produces a single float output stream of audio sample in the range [-1, +1].

## Parameters
(R): Run-time adjustable

- Audio rate: Sample rate of audio stream, >= 16k (integer)
- Quadrature rate: Sample rate of input stream (integer). Must be an integer multiple of Audio rate.
- Tau: Preemphasis time constant (float)
- Max deviation (R): Maximum deviation in Hz (float)

## Example Flowgraph
This flowgraph shows a NBFM Receive block in a working 2 meter receiver.

## Source Files
- Python files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-analog/python/analog/nbfm_rx.py]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-analog/grc/analog_nbfm_rx.block.yml]
