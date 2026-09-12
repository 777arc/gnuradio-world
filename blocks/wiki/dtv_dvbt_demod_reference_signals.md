<!-- block: dtv_dvbt_demod_reference_signals -->
<!-- title: Demod Reference Signals -->
<!-- source: https://wiki.gnuradio.org/index.php/Demod_Reference_Signals -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Reference signals demodulator. ETSI EN 300 744 Clause 4.5
Data input format: complex(real(float), imag(float)).
Data output format: complex(real(float), imag(float)).

## Parameters
- constellation type
  constellation used.

- hierarchy
  hierarchy used.

- code_rate_HP
  high priority stream code rate.

- code_rate_LP
  low priority stream code rate.

- guard_interval
  guard interval used.

- transmission_mode
  transmission mode used.

- include_cell_id
  include or not Cell ID.

- cell_id
  value of the Cell ID.

## Example Flowgraph
This flowgraph can be found at [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/examples/dvbt_rx_8k.grc].

## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  TODO
