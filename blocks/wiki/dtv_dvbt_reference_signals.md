<!-- block: dtv_dvbt_reference_signals -->
<!-- title: Reference Signals -->
<!-- source: https://wiki.gnuradio.org/index.php/Reference_Signals -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Reference signals generator

ETSI EN 300 744 Clause 4.5

- Data input format:  complex(real(float), imag(float)).
- Data output format: complex(real(float), imag(float)).

## Parameters
- Constellation Type
  constellation used.

- Hierarchy Type
  hierarchy used.

- Code rate HP
  high priority stream code rate.

- Code rate LP
  low priority stream code rate.

- Guard Interval
  guard interval used.

- Transmission Mode
  transmission mode used.

- Include Cell ID
  include or not Cell ID.

- Cell Id
  value of the Cell ID.

## Example Flowgraph
This flowgraph can be found at [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/examples/dvbt_tx_8k.grc].

## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/lib/dvbt/dvbt_reference_signals_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/lib/dvbt/dvbt_reference_signals_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/include/gnuradio/dtv/dvbt_reference_signals.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-dtv/grc/dtv_dvbt_reference_signals.block.yml]
