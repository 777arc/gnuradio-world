<!-- block: fec_bercurve_generator -->
<!-- title: BER Curve Gen. -->
<!-- source: https://wiki.gnuradio.org/index.php/BER_Curve_Gen. -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This is a hier block that... (someone fill this in)

Note that this block tries to launch many parallel codes to run simultaneously. Thus, it requires that the definitions for each encoder and decoder (specified in the "Encoder list" and "Decoder list") be configured with a parallelism > 0. If the parallelism for one of the encoder or decoder definition blocks is configured to 0, you will likely see an error like:

    generic_decoder=decoder_list[i],
    TypeError: 'generic_decoder_sptr' object does not support indexing

or

    generic_encoder=encoder_list[i],
    TypeError: 'generic_encoder_sptr' object does not support indexing

## Parameters
- Es/N0
  - Sample Rate
  - Encoder List
  - Decoder List
  - Puncture Pat.
  - Threading Type
  - Noise Seed
  ## Example Flowgraph
This flowgraph is derived from https://github.com/gnuradio/gnuradio/blob/master/gr-fec/examples/ber_curve_gen.grc

## Source Files
- Python Code for Hier Block
  [https://github.com/gnuradio/gnuradio/blob/master/gr-fec/python/fec/bercurve_generator.py]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-fec/grc/fec_bercurve_generator.block.yml]
