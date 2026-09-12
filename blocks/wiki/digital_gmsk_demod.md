<!-- block: digital_gmsk_demod -->
<!-- title: GMSK Demod -->
<!-- source: https://wiki.gnuradio.org/index.php/GMSK_Demod -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Hierarchical block for Gaussian Minimum Shift Key (GMSK) demodulation.

The input is the complex modulated signal at baseband.

The output is a stream of bits packed 1 bit per byte (the LSB)

## Parameters
- Samples/Symbol
  Samples per baud

- Gain Mu
  Controls rate of mu adjustment

- Mu
  Fractional delay [0.0, 1.0]

- Omega Relative Limit
  Sets max variation in omega

- Freq Error
  Bit rate error as a fraction

- Verbose
  Print information about modulator?

- Log
  Print modulation data to files?

## Example Flowgraph
This is an example flowgraph modified from https://github.com/gnuradio/gnuradio/blob/main/gr-channels/examples/demo_gmsk.grc to use a GMSK Demod block

## Source Files
- Python files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-digital/python/digital/gmsk.py]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-digital/grc/digital_gmsk_demod.block.yml]
