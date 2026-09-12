<!-- block: digital_ofdm_cyclic_prefixer -->
<!-- title: OFDM Cyclic Prefixer -->
<!-- source: https://wiki.gnuradio.org/index.php/OFDM_Cyclic_Prefixer -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Adds a cyclic prefix and performs pulse shaping on OFDM symbols.

- Input: OFDM symbols (in the time domain, i.e. after the IFFT). Optionally, entire frames can be processed. In this case, Length Tag Key must be specified which holds the key of the tag that denotes how many OFDM symbols are in a frame.

- Output: A stream of (scalar) complex symbols, which include the cyclic prefix and the pulse shaping.
  Note: If complete frames are processed, and Rolloff is greater than zero, the final OFDM symbol is followed by the delay line of the pulse shaping.

The pulse shape is a raised cosine in the time domain.

## Parameters
- FFT Length
  FFT Length (i.e. length of the OFDM symbols)

- CP Length
  Cyclic prefix length (in samples)

- Rolloff
  Length of the rolloff flank (in samples). That parameter can sometimes be found described as a percentage of the FFT Length, so that would be Rolloff (%) = (Rolloff (samples)/ FFT_len) * 100.
  An explanation of this parameter can be found here

- Length Tag Key
  For framed processing, the key of the length tag

## Example Flowgraph
This flowgraph can be found at [https://github.com/gnuradio/gnuradio/blob/master/gr-digital/examples/ofdm/tx_ofdm.grc].

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-digital/lib/ofdm_cyclic_prefixer_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-digital/lib/ofdm_cyclic_prefixer_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-digital/include/gnuradio/digital/ofdm_cyclic_prefixer.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-digital/grc/digital_ofdm_cyclic_prefixer.block.yml]
