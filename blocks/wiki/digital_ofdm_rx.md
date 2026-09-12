<!-- block: digital_ofdm_rx -->
<!-- title: OFDM Receiver -->
<!-- source: https://wiki.gnuradio.org/index.php/OFDM_Receiver -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Hierarchical block for OFDM demodulation.

The input is a complex baseband signal (e.g. from a UHD source).
The detected packets are output as a stream of packed bits on the output.

## Parameters
- FFT Length
  The length of FFT (integer).

- Cyclic Prefix Length
  The length of cyclic prefix in total samples (integer).

- Packet Length Tag Key
  The name of the tag giving packet length at the input.

- Occupied Carriers
  A vector of vectors describing which OFDM carriers are occupied with data symbols. occupied_carriers[0] identifies the carriers that are used for the first OFDM symbol, and so on.

- Pilot Carriers
  A vector of vectors describing which OFDM carriers are occupied with pilot symbols.

- Pilot Symbols
  A vector of vectors indicating the pilot symbols.

- Sync Word 1
  The first sync preamble symbol. This has to be with zeros on alternating carriers. Used for fine and coarse frequency offset and timing estimation.

- Sync Word 2
  The second sync preamble symbol. This has to be filled entirely. Also used for coarse frequency offset and channel estimation.

- Header Modulation
  It has two options:
  * BPSK (Binary Phase Shift Keying)
  * QPSK (Quadrature Phase Shift Keying)

- Payload Modulation
  It has three options:
  * BPSK (Binary Phase Shift Keying)
  * QPSK (Quadrature Phase Shift Keying)
  * 8-PSK (Eight Phase Shift Keying)

- Scramble Bits
  Activates the scramblers (set this to True unless debugging)

- Log Debug Info
  Write output into log files (Warning: creates lots of data!)

## Example Flowgraph
This flowgraph can be found at https://github.com/gnuradio/gnuradio/blob/master/gr-digital/examples/ofdm/ofdm_loopback.grc

## Source Files
- Python file
  ofdm_txrx.py

- Block definition
  digital_ofdm_rx.block.yml
