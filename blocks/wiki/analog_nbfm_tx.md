<!-- block: analog_nbfm_tx -->
<!-- title: NBFM Transmit -->
<!-- source: https://wiki.gnuradio.org/index.php/NBFM_Transmit -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Narrow Band FM Transmitter.

Takes a single float input stream of audio samples in the range [-1,+1] and produces a single FM modulated complex baseband output.

The only difference with WBFM Transmit is the size of the internal low pass filter for interpolation.
Here it has a cutoff frequency of 4.5kHz with 2.5KHz of transition width.

## Parameters
(R): Run-time adjustable

- Audio rate: Sample rate of audio stream, >= 16k (integer)
- Quadrature rate: Sample rate of output stream (integer). Must be an integer multiple of Audio rate.
- Tau: Preemphasis time constant (float)
- Max deviation (R): Maximum deviation in Hz (float)
- Preemphasis High Corner Freq: High frequency at which to flatten preemphasis; < 0 means default of 0.925*Quadrature rate/2.0 (float)

## Example Flowgraph
This flowgraph shows a signal source feeding a Narrow Band FM modulator driving a PlutoSDR Sink block.

## Source Files
- Python files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-analog/python/analog/nbfm_tx.py]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-analog/grc/analog_nbfm_tx.block.yml]
