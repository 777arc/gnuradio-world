<!-- block: digital_mpsk_snr_est_cc -->
<!-- title: MPSK SNR Estimator -->
<!-- source: https://wiki.gnuradio.org/index.php/MPSK_SNR_Estimator -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

A block for computing SNR of a M-PSK signal (e.g., BPSK, QPSK, 8-PSK).  It copies the input stream to the output stream, but adds a tag that contains the estimated SNR every N samples.  It may work with other types of signals, but with a certain amount of error.  See each Type for how it works under the hood.

## Parameters
- Type
  There are currently four implemented estimators. See here for more details.

1. Simple - A very simple SNR estimator that just uses mean and variance estimates of an M-PSK constellation. This esimator is quick and cheap and accurate for high SNR (above 7 dB or so) but quickly starts to overestimate the SNR at low SNR.
1. Skewness - SNR Estimator using skewness correction.  This is an estimator that came from a discussion between Tom Rondeau and fred harris with no known paper reference. The idea is that at low SNR, the variance estimations will be affected because of fold-over around the decision boundaries, which results in a skewness to the samples. We estimate the skewness and use this as a correcting term.  Best used with SNRs above 5 dB.
1. 2nd and 4th Moment - An SNR estimator for M-PSK signals that uses 2nd (M2) and 4th (M4) order moments. This estimator uses knowledge of the kurtosis of the signal (k_a) and noise (k_w) to make its estimation. We use Beaulieu's approximations here to M-PSK signals and AWGN channels such that k_a=1 and k_w=2. These approximations significantly reduce the complexity of the calculations (and computations) required.  Works best for SNR above 1 dB.  Reference: D. R. Pauluzzi and N. C. Beaulieu, "A comparison of SNR estimation techniques for the AWGN channel," IEEE Trans. Communications, Vol. 48, No. 10, pp. 1681-1691, 2000.
1. SVR - Signal-to-Variation Ratio SNR Estimator.  This estimator actually comes from an SNR estimator for M-PSK signals in fading channels, but this implementation is specifically for AWGN channels. The math was simplified to assume a signal and noise kurtosis (k_a and k_w) for M-PSK signals in AWGN. These approximations significantly reduce the complexity of the calculations (and computations) required.  Works best for SNR above 0 dB.  Original paper: A. L. Brandao, L. B. Lopes, and D. C. McLernon, "In-service monitoring of multipath delay and cochannel interference for indoor mobile communication systems," Proc. IEEE Int. Conf. Communications, vol. 3, pp. 1458-1462, May 1994.

- Samples between tags
  After this many samples, a tag containing the SNR (key='snr') will be sent on the output port.

- Filter Alpha
  The update rate of internal running average calculations.

## Example Flowgraph
## Source Files
- C++ files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-digital/lib/mpsk_snr_est_cc_impl.cc]

- Header files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-digital/lib/mpsk_snr_est_cc_impl.h]

- Public header files
  [https://github.com/gnuradio/gnuradio/blob/main/gr-digital/include/gnuradio/digital/mpsk_snr_est.h]

- Block definition
  [https://github.com/gnuradio/gnuradio/blob/main/gr-digital/grc/digital_mpsk_snr_est_cc.block.yml]
