<!-- block: blocks_rms_xx -->
<!-- title: RMS -->
<!-- source: https://wiki.gnuradio.org/index.php/RMS -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

Calculates RMS average power.

## Parameters
(R): Run-time adjustable

- Alpha (R)
  Gain for running average filter as a value between 0 and 1 where higher values mean less averaging (see below).

## Running average filter
The running average filter is described by the following relations:

  out[i+1]^2 = in[i]^2 * alpha + out[i]^2 * (1 - alpha)

out_n = \sqrt{ \sum_{i=0}^n \alpha (1-\alpha)^i \cdot in_{n-i}^2 }

For alpha = 1 the averaging is disabled, smaller values reduce the gain and increase the averaging.

For a step response the running average filter responds as depicted below.

The number of samples n to reach a fraction f of the step input is given by

n = \frac{\ln(1-f^2)}{\ln(1-\alpha^2)}

\alpha = 1 - \left(1 - f^2\right)^{(1/n)}

Example: For alpha=1e-3 it takes n=287 samples the step for the output value to reach half way towards the value of the (constant) input. Any fluctuations on that timescale would be smoothened by the averaging.

## Example Flowgraph
This flowgraph can be found at [https://raw.githubusercontent.com/gnuradio/gnuradio/master/gr-channels/examples/demo_spec_an.grc]

## Example Output
## Source Files
- C++ files
  TODO

- Header files
  TODO

- Public header files
  TODO

- Block definition
  TODO
