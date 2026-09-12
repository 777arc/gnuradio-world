<!-- block: dtv_dvbt_ofdm_sym_acquisition -->
<!-- title: OFDM Symbol Acquisition -->
<!-- source: https://wiki.gnuradio.org/index.php/OFDM_Symbol_Acquisition -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

OFDM symbol acquisition.

- Data input format
  complex(real(float), imag(float)).

- Data output format
  complex(real(float), imag(float)).

## Parameters
- FFT Length
  FFT size, 2048 or 8192.

- Occupied Tones
  Active OFDM carriers, 1705 or 6817.

- Cyclic prefix length
  Length of Cyclic Prefix (FFT size / 32, 16, 8 or 4).

- SNR
  Signal to Noise Ratio.

## Example Flowgraph
This flowgraph can be found at [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/examples/dvbt_rx_8k.grc].

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/lib/dvbt/dvbt_ofdm_sym_acquisition_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/lib/dvbt/dvbt_ofdm_sym_acquisition_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/include/gnuradio/dtv/dvbt_ofdm_sym_acquisition.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/grc/dtv_dvbt_ofdm_sym_acquisition.block.yml]
