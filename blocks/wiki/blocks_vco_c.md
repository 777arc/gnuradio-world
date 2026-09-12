<!-- block: blocks_vco_c -->
<!-- title: VCO (complex) -->
<!-- source: https://wiki.gnuradio.org/index.php/VCO_(complex) -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

VCO - Voltage controlled oscillator.  Produces a sinusoid of frequency based on the amplitude of the input.  See VCO for a real (not complex) sinusoidal output.

input: float stream of control voltages;

output: complex oscillator output

## Parameters
- Sample Rate
  sampling rate (Hz)

- Sensitivity
  units are radians/sec/(input unit)

- Amplitude
  output amplitude

## Example Flowgraph
This flowgraph shows a Radioteletype (RTTY) transmitter and receiver. The upper portion is the transmitter. The parameters for the VCO are explained in VCO.

The lower portion of the flowgraph is a single sideband (SSB) receiver. The audio can be fed into a RTTY decoder such as shown in Sample_Rate_Tutorial#Source_hardware_example.

## Source Files
- C++ files
  vco_c_impl.cc

- Header files
  vco_c_impl.h

- Public header files
  vco_c.h

- Block definition
  blocks_vco_c.block.yml
