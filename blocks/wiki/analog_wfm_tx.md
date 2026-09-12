<!-- block: analog_wfm_tx -->
<!-- title: WBFM Transmit -->
<!-- source: https://wiki.gnuradio.org/index.php/WBFM_Transmit -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Wide Band FM Transmitter.

Takes a single float input stream of audio samples in the range [-1,+1] and produces a single FM modulated complex baseband output.

The only difference with NBFM Transmit is the size of the internal low pass filter for interpolation.
Here it has a cutoff frequency of 16kHz with 2KHz of transition width.

## Parameters
- Audio Rate
  Sample rate of audio stream, >= 16k (integer)

- Quadrature Rate
  Sample rate of output stream (integer). Must be an integer multiple of audio_rate.

- Tau
  Preemphasis time constant (default 75e-6) (float)

- Max Deviation
  Maximum deviation in Hz (default 75e3) (float)

- Preemphasis High Corner Freq
  High frequency at which to flatten preemphasis; < 0 means default of 0.925*quad_rate/2.0 (float)

## Example Flowgraph
This example flowgraph can be found at [https://github.com/gnuradio/gnuradio/blob/main/gr-analog/examples/fm_tx.grc].

## Source Files
- Python files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-analog/python/analog/wfm_tx.py]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-analog/grc/analog_wfm_tx.block.yml]
