<!-- block: analog_am_demod_cf -->
<!-- title: AM Demod -->
<!-- source: https://wiki.gnuradio.org/index.php/AM_Demod -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Generalized AM demodulation hierarchical block with audio filtering.

This block demodulates a band-limited, complex down-converted AM channel into the the original baseband signal, applying low pass filtering to the audio output. It produces a float stream in the range [-1.0, +1.0].

Note: The AM Demod block is the same as a Complex to Mag block feeding an Add Const block feeding a Low Pass Filter. See Complex_to_Mag#Example_Flowgraph.

## Parameters
(R): Run-time adjustable

- Channel rate
  Incoming sample rate of the AM baseband
- Audio decimation
  Input to output decimation rate
- Audio pass
  Audio low pass filter passband frequency
- Audio stop
  Audio low pass filter stop frequency

## Example Flowgraph
This flowgraph shows the use of an AM Demod block to implement an AM broadcast receiver.

## Source Files
- Python file
  Here

- Block definition
  TODO
