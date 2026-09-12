<!-- block: digital_meas_evm_cc -->
<!-- title: EVM Measurement -->
<!-- source: https://wiki.gnuradio.org/index.php/EVM_Measurement -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Calculates the error vector magnitude to a given constellation.

## Parameters
(R): Run-time adjustable

- Digital Constellation Object
  Constellation Object
- EVM Meas Type
  options: [Percent, Power-Ratio (dB)]

The reference value used here is the average magnitude of the constellation. More about EVM can be found here
## Example Flowgraph
## Example Output
This flowgraph can be downloaded from Media:Ex_evm_meas.grc.
## Source Files
- C++ files
  meas_evm_cc_impl.cc

- Header files
  meas_evm_cc_impl.h

- Public header files
  meas_evm_cc.h

- Block definition
  digital_meas_evm_cc.block.yml
