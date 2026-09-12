<!-- block: digital_constellation_modulator -->
<!-- title: Constellation Modulator -->
<!-- source: https://wiki.gnuradio.org/index.php/Constellation_Modulator -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Hierarchical block for RRC-filtered differential generic modulation.  The input is a byte stream (unsigned char) and the output is the complex modulated signal at baseband.

## Parameters
- Constellation
  determines the modulation type, provide a Constellation Object here.

- Samples per Symbol
  samples per baud >= 2 (int)

- Differential Encoding
  whether to use differential encoding (boolean)

- Excess BW
  Root-raised cosine (RRC) filter excess bandwidth (float)

- Verbose
  Print information about modulator? (boolean)

- Log
  Log modulation data to files? (boolean)

## Example Flowgraph
This flowgraph modulates random bits with 8-PSK.

Flowgraph demonstrating the Constellation Modulator block. The output of a random source feeds the modulator block, which takes every 3 bits and outputs a RRC-filtered 8PSK signal. The signal is passed through another RRC filter, which acts as a matched filter and ensures that the total of the two filters (transmit and receive) creates a Nyquist filter with no intersymbol interference (ISI).

The output of the filter on an eye diagram shows that the sync points are well defined (the points where the various signals all line up at the same amplitude and create 4 well-defined levels). The output of the Symbol Sync block shows that the constellation is 8 well-defined points, and also shows the points overlaid with the filtered signal.

This is the output of the matched filter (the FFT Root Raised Cosine Filter) showing that he signal has 8 well-defined points. Note that this would not appear this way in an actual transmitted signal due to the timing differences between the transmitter and receiver.

This is the output of the Symbol Sync block showing the 8 points of the 8PSK signal. This shows both the points and the transitions between them.

## Source Files
- Python
  [https://github.com/gnuradio/gnuradio/blob/af78fad36d41b7c0d653ad21ec5ad8d58585d230/gr-digital/python/digital/generic_mod_demod.py#L64]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/main/gr-digital/grc/digital_constellation_modulator.block.yml]
