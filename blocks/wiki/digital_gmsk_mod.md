<!-- block: digital_gmsk_mod -->
<!-- title: GMSK Mod -->
<!-- source: https://wiki.gnuradio.org/index.php/GMSK_Mod -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Hierarchical block for Gaussian Minimum Shift Key (GMSK) modulation.

The input is a byte stream (unsigned char with packed bits)

The output is the complex modulated signal at baseband.

## Parameters
- Samples/Symbol
  samples per baud >= 2

- BT
  Gaussian filter bandwidth * symbol time

- Verbose
  Print information about modulator?

- Log
  Print modulation data to files?

- Unpack
  Unpack input byte stream?

## Example Flowgraph
This flowgraph can be found at [https://github.com/gnuradio/gnuradio/blob/master/gr-channels/examples/demo_gmsk.grc]

## Source Files
- Python files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-digital/python/digital/gmsk.py]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-digital/grc/digital_gmsk_mod.block.yml]
