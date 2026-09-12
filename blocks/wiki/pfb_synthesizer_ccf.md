<!-- block: pfb_synthesizer_ccf -->
<!-- title: Polyphase Synthesizer -->
<!-- source: https://wiki.gnuradio.org/index.php/Polyphase_Synthesizer -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Builds a polyphase synthesis filterbank.

See [http://www.trondeau.com/examples/2014/1/23/pfb-channelizers-and-synthesizers.html] for a guide on these polyphase filterbank blocks.

## Parameters
- Channels
  Specifies the number of channels

- Connections
  - Taps
  The prototype filter to populate the filterbank.

- 2x Sample Rate
  Use 2x oversampling or not (default is no)

- Sample Delay
  The sample delay of the underlying filters

- Channel Map
  The Channel Map can be used to rearrange which channels go to which output stream.  See Channel Map.
