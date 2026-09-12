<!-- block: digital_pn_correlator_cc -->
<!-- title: PN Correlator -->
<!-- source: https://wiki.gnuradio.org/index.php/PN_Correlator -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

PN code sequential search correlator.

Receives complex baseband signal, outputs complex correlation against reference PN code, one sample per PN code period. The PN sequence is generated using a GLFSR.

## Parameters
- Degree
  Degree of shift register must be in [1, 32]. If mask is 0, the degree determines a default mask (see digital_impl_glfsr.cc for the mapping).

- Mask
  Allows a user-defined bit mask for indexes of the shift register to feed back.

- Seed
  Initial setting for values in shift register.

## Example Flowgraph
This flowgraph can be downloaded from Media:Pn_correlator.grc.

## Source Files
- C++ files
  pn_correlator_cc_impl.cc

- Header files
  pn_correlator_cc_impl.h

- Public header files
  pn_correlator_cc.h

- Block definition
  digital_pn_correlator_cc.block.yml
