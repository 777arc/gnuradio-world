<!-- block: fec_extended_decoder -->
<!-- title: FEC Extended Decoder -->
<!-- source: https://wiki.gnuradio.org/index.php/FEC_Extended_Decoder -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Forward Error Correction (FEC) is a common technique used in telecommunication systems to control error in the data transmission over noisy transmission channels. The key concept is to encode the signal in a redundant way by using Error Correcting Code (ECC) in the transmitter; this allows the receiver to detect a limited number of error bits in the transmitted signal and often to correct these errors without the need of re-transmitting the signal.

## Parameters
- Decoder Objects
  Object defined by an Decoder Definition block

- Threading Type
  options: [capillary, ordinary, none]

- Annihilator
  - Puncture Pattern
  a puncture pattern of '11' defines 'no puncture'.

## Example Flowgraph
This flowgraph can be found at [https://github.com/gnuradio/gnuradio/blob/master/gr-fec/examples/fecapi_ldpc_decoders.grc]

## Source Files
- Python files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-fec/python/fec/extended_decoder.py]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-fec/grc/fec_extended_decoder.block.yml]
