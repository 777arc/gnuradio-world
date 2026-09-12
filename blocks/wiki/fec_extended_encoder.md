<!-- block: fec_extended_encoder -->
<!-- title: FEC Extended Encoder -->
<!-- source: https://wiki.gnuradio.org/index.php/FEC_Extended_Encoder -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Forward Error Correction (FEC) is a common technique used in telecommunication systems to control error in the data transmission over noisy transmission channels. The key concept is to encode the signal in a redundant way by using Error Correcting Code (ECC) in the transmitter; this allows the receiver to detect a limited number of error bits in the transmitted signal and often to correct these errors without the need of re-transmitting the signal.

## Parameters
- Encoder Objects
  Object defined by an LDPC_Encoder_Definition block

- Threading Type
  options: [capillary, ordinary, none]

- Puncture Pattern
  default: '11'

## Example Flowgraph
This flowgraph can be found at [https://github.com/gnuradio/gnuradio/blob/master/gr-fec/examples/fecapi_ldpc_encoders.grc]

## Source Files
- Python files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-fec/python/fec/extended_encoder.py]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-fec/grc/fec_extended_encoder.block.yml]
