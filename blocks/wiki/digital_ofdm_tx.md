<!-- block: digital_ofdm_tx -->
<!-- title: OFDM Transmitter -->
<!-- source: https://wiki.gnuradio.org/index.php/OFDM_Transmitter -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Hierarchical block for OFDM modulation.

The input is a byte stream (unsigned char) and the output is the complex modulated signal at baseband.

## Parameters
- FFT Length
  The number of sub-carriers.

- Cyclic Prefix Length
  The maximum possible length of multi-paths in their time dispersion

- Packet Length Tag Key
  The name of the tag giving packet length at the input.

- Occupied Carriers
  A vector of vectors describing which OFDM carriers are occupied with data symbols. occupied_carriers[0] identifies the carriers that are used for the first OFDM symbol, and so on.

- Pilot Carriers
  A vector of vectors describing which OFDM carriers are occupied with pilot symbols.

- Pilot Symbols
  A vector of vectors indicating the pilot symbols.

- Sync Word 1
  The first sync preamble symbol. This has to be with zeros on alternating carriers (0., 1.536, 0., -1.536, 0., ...). Used for fine and coarse frequency offset and timing estimation. Length of sync sequence must be the same as the value of  FFT length. To not use a sync word, None can be entered as this parameter's value.

- Sync Word 2
  The second sync preamble symbol. This has to be filled entirely. Also used for coarse frequency offset and channel estimation. Length of sync sequence must be the same as the value of  FFT length. To not use a sync word, None can be entered as this parameter's value.

- Header Modulation
  It has two options:
  * BPSK (Binary Phase Shift Keying)
  * QPSK (Quadrature Phase Shift Keying)

- Payload Modulation
  It has three options:
  * BPSK (Binary Phase Shift Keying)
  * QPSK (Quadrature Phase Shift Keying)
  * 8-PSK (Eight Phase Shift Keying)

- Rolloff length (samples)
  The rolloff length in samples. Must be smaller than the CP.

- Scramble Bits
  Activates the scramblers (set this to True unless debugging)

- Log Debug Info
  Write output into log files (Warning: creates lots of data!)

## Example Flowgraph
This flowgraph can be found at https://github.com/gnuradio/gnuradio/blob/master/gr-digital/examples/ofdm/ofdm_loopback.grc

## Source Files
- Python files
  ofdm_txrx.py

- Block definition
  digital_ofdm_tx.block.yml
