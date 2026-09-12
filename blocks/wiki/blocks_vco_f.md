<!-- block: blocks_vco_f -->
<!-- title: VCO -->
<!-- source: https://wiki.gnuradio.org/index.php/VCO -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

VCO - Voltage controlled oscillator.  Produces a sinusoid of frequency based on the amplitude of the input.  See VCO (complex) for a complex sinusoidal output.

input: float stream of control voltages;

output: float oscillator output

## Parameters
- Sample Rate
  sampling rate (Hz)

- Sensitivity
  units are radians/sec/(input unit)

- Amplitude
  output amplitude

## Example Flowgraph
This flowgraph can be found at [https://github.com/duggabe/gr-RTTY-basics/tree/master/RTTY_xmt]

For this flowgraph, the standard RTTY tones of 2295 (mark) and 2125 (space) are generated. The calculations for this follow:

- Choosing a full-scale frequency of 2500Hz with an input of +1.0, the VCO Sensitivity = (2 * math.pi * 2500 / 1.0) = 15708
- At the output of the Low Pass Filter, a Mark has a value of +1.0 and a Space has a value of 0.0
- When the output of the Low Pass Filter is +1.0, the input of the VCO is (1.0 * 0.068) + 0.850 = 0.918&nbsp;&nbsp;That generates a frequency of 0.918 * 2500 => 2295
- When the output of the Low Pass Filter is 0.0, the input of the VCO is (0.0 * 0.068) + 0.850 = 0.850&nbsp;&nbsp;That generates a frequency of 0.850 * 2500 => 2125

See Sample_Rate_Tutorial#Sink_hardware_example for a discussion of the timing involved in a similar flowgraph.

## Source Files
- C++ files
  vco_f_impl.cc

- Header files
  vco_f_impl.h

- Public header files
  vco_f.h

- Block definition
  blocks_vco_f.block.yml
