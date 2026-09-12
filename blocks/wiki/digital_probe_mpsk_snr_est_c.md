<!-- block: digital_probe_mpsk_snr_est_c -->
<!-- title: MPSK SNR Estimator Probe -->
<!-- source: https://wiki.gnuradio.org/index.php/MPSK_SNR_Estimator_Probe -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

See MPSK SNR Estimator, this block makes the same calculation but outputs the resulting SNR as a message instead of a tag, which can be outputted to the console using a Message Debug block.

This is a probe block (a sink) that can be used to monitor and retrieve estimations of the signal SNR. This probe is designed for use with M-PSK signals especially. The type of estimator is specified as the  parameter in the constructor. The estimators tend to trade off performance for accuracy, although experimentation should be done to figure out the right approach for a given implementation. Further, the current set of estimators are designed and proven theoretically under AWGN conditions; some amount of error should be assumed and/or estimated for real channel conditions.

The estimator is normally placed before clock recovery.

The block has three output message ports that will emit a message every msg_samples number of samples.  These message ports are:
- snr: the current SNR estimate (in dB)
- signal: the current signal power estimate (in dBx)
- noise: the current noise power estimate (in dBx)

Some calibration is required to convert dBx of the signal and noise power estimates to real measurements, such as dBm.

## Parameters
(R): Run-time adjustable

- Type (R)
  The type of estimator to use. See MPSK SNR Estimator for details about the types.

- Samples between SNR messages (R)
  [not implemented yet] after this many samples, a message containing the SNR (key='snr') will be sent

- Filter Alpha (R)
  The update rate of internal running average calculations.  Needs to be between 0 and 1, where higher value adjusts faster to new data.

## Example Flowgraph
## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-digital/lib/probe_mpsk_snr_est_c_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-digital/lib/probe_mpsk_snr_est_c_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/master/gr-digital/include/gnuradio/digital/probe_mpsk_snr_est_c.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/master/gr-digital/grc/digital_probe_mpsk_snr_est_c.block.yml]
