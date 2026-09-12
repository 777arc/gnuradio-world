<!-- block: digital_constellation_receiver_cb -->
<!-- title: Constellation Receiver -->
<!-- source: https://wiki.gnuradio.org/index.php/Constellation_Receiver -->
<!-- license: CC BY-SA 4.0 — https://wiki.gnuradio.org -->
<!-- fetched: 2026-09-12 -->

This block makes hard decisions about the received symbols (using a constellation object) and also fine tunes phase synchronization.

The phase and frequency synchronization are based on a Costas loop that finds the error of the incoming signal point compared to its nearest constellation point. The frequency and phase of the NCO are updated according to this error.

## Parameters
- Constellation
  constellation of points for generic modulation, see Constellation Object

- Loop BW
  Loop bandwidth of the Costas Loop.  A good starting point is 2&pi;/100, or about 0.06.

- Min Freq Deviation
  minimum normalized frequency value the loop can achieve

- Max Freq Deviation
  maximum normalized frequency value the loop can achieve
