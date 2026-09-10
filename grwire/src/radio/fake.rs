//! A radio that is not there.
//!
//! `device: fake` (or `fake:<tone Hz>`) generates a paced complex tone. It
//! exists for the same reason `FakeRtl` does in `runner/src/rtlsdr_reader.js`:
//! CI has no hardware, and a bridge whose only test needs a dongle plugged in
//! is a bridge with no tests. It drives the whole daemon -- the reader thread,
//! the DDC, the decimator, every backpressure counter and the socket -- so the
//! only thing it cannot catch is a driver bug.

use std::time::{Duration, Instant};

use num_complex::Complex32;

use super::{ChannelInfo, DeviceInfoJson, Radio, RangeJson, ReadError};

/// How far behind the consumer may fall before samples are actually lost.
/// librtlsdr's default is roughly 0.8 s at 2.4 MS/s; a quarter second is a
/// deliberately less forgiving stand-in.
const FIFO_DEPTH: Duration = Duration::from_millis(250);

pub fn owns(args: &str) -> bool {
    args == "fake" || args.starts_with("fake:") || args.contains("driver=fake")
}

pub fn descriptor() -> DeviceInfoJson {
    DeviceInfoJson {
        args: "fake".into(),
        driver: "fake".into(),
        backend: "builtin".into(),
        kind: "fake".into(),
        label: "Fake radio (generated tone, no hardware)".into(),
        serial: None,
    }
}

pub struct FakeRadio {
    rate: f64,
    freq: f64,
    tone_hz: f64,
    phase: f32,
    /// Wall-clock pacing. A generator that returns instantly would hide a ring
    /// that is too shallow and would make every throughput number meaningless.
    next_deadline: Option<Instant>,
    active: bool,
    gain: f64,
    agc: bool,
}

impl FakeRadio {
    pub fn new(args: &str) -> anyhow::Result<Self> {
        let tone_hz = match args.split_once(':') {
            Some((_, tone)) => tone.parse::<f64>().map_err(|_| {
                anyhow::anyhow!("fake radio: '{tone}' is not a tone frequency in Hz")
            })?,
            None => 100_000.0,
        };
        Ok(Self {
            rate: 2_048_000.0,
            freq: 100e6,
            tone_hz,
            phase: 0.0,
            next_deadline: None,
            active: false,
            gain: 30.0,
            agc: false,
        })
    }
}

impl Radio for FakeRadio {
    fn info(&self) -> ChannelInfo {
        ChannelInfo {
            driver: "fake".into(),
            channel: 0,
            full_duplex: false,
            freq_range: Some(RangeJson {
                min: 0.0,
                max: 6e9,
                ..Default::default()
            }),
            rate_range: Some(RangeJson {
                min: 8_000.0,
                max: 20e6,
                ..Default::default()
            }),
            gain_range: Some(RangeJson {
                min: 0.0,
                max: 50.0,
                ..Default::default()
            }),
            gain_elements: vec!["TUNER".into()],
            antennas: vec!["RX".into()],
            bandwidth_range: None,
            agc_available: true,
            formats: vec!["ci8".into(), "ci16".into(), "cf32".into()],
        }
    }

    fn set_sample_rate(&mut self, rate: f64) -> anyhow::Result<f64> {
        anyhow::ensure!(
            (8_000.0..=20e6).contains(&rate),
            "fake radio: rate out of range"
        );
        self.rate = rate;
        self.next_deadline = None;
        Ok(rate)
    }

    fn set_frequency(&mut self, hz: f64) -> anyhow::Result<f64> {
        self.freq = hz;
        Ok(hz)
    }

    fn set_gain(&mut self, db: f64) -> anyhow::Result<()> {
        self.gain = db;
        Ok(())
    }

    fn set_gain_element(&mut self, _name: &str, db: f64) -> anyhow::Result<()> {
        self.gain = db;
        Ok(())
    }

    fn set_agc(&mut self, on: bool) -> anyhow::Result<()> {
        self.agc = on;
        Ok(())
    }

    fn set_antenna(&mut self, _name: &str) -> anyhow::Result<()> {
        Ok(())
    }

    fn set_bandwidth(&mut self, _hz: f64) -> anyhow::Result<()> {
        Ok(())
    }

    fn set_ppm(&mut self, _ppm: f64) -> anyhow::Result<()> {
        Ok(())
    }

    fn mtu(&self) -> usize {
        65536
    }

    fn activate(&mut self) -> anyhow::Result<()> {
        self.active = true;
        self.next_deadline = None;
        Ok(())
    }

    fn deactivate(&mut self) -> anyhow::Result<()> {
        self.active = false;
        Ok(())
    }

    fn read(&mut self, buffer: &mut [Complex32], timeout_us: i64) -> Result<usize, ReadError> {
        if !self.active {
            return Err(ReadError::Fatal("fake radio: stream is not active".into()));
        }
        let count = buffer.len().min(self.mtu());
        if count == 0 {
            return Ok(0);
        }

        // Claim the deadline before sleeping, not after: several concurrent
        // readers advancing it afterwards would let them all wake together, and
        // the long-run rate would survive while delivery came in bursts that do
        // not resemble a radio.
        let span = Duration::from_secs_f64(count as f64 / self.rate);
        let now = Instant::now();
        let deadline = self.next_deadline.unwrap_or(now);

        // Model the device's FIFO, and do not forgive lateness.
        //
        // `deadline.max(now)` would silently absorb a consumer that is a little
        // late on every read, and a persistent 8% shortfall would then appear
        // as a sample rate a few percent low with every drop counter reading
        // zero -- which is exactly what it did during development. A real radio
        // keeps sampling into a fixed buffer, so lateness accumulates as debt
        // until the buffer overflows and the device says so.
        if now > deadline + FIFO_DEPTH {
            self.next_deadline = Some(now + span);
            return Err(ReadError::Overrun);
        }

        self.next_deadline = Some(deadline + span);
        if deadline > now {
            let wait = deadline - now;
            if timeout_us >= 0 && wait > Duration::from_micros(timeout_us as u64) {
                return Err(ReadError::Timeout);
            }
            std::thread::sleep(wait);
        }

        let step = (std::f64::consts::TAU * self.tone_hz / self.rate) as f32;
        for sample in buffer.iter_mut().take(count) {
            *sample = Complex32::new(self.phase.cos() * 0.5, self.phase.sin() * 0.5);
            self.phase += step;
            if self.phase > std::f32::consts::TAU {
                self.phase -= std::f32::consts::TAU;
            }
        }
        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn owns_the_spellings_the_worker_uses() {
        // These must agree with isFakeDevice() on the browser side, or the
        // editor offers a fake the daemon then refuses.
        assert!(owns("fake"));
        assert!(owns("fake:250000"));
        assert!(owns("driver=fake"));
        assert!(!owns("driver=rtlsdr,serial=00000001"));
    }

    /// The fake must behave like a radio when the host is too slow, because a
    /// generator that silently shrinks its output turns a CPU problem into an
    /// unattributable rate error. This is the exact failure that hid an 8%
    /// shortfall during development.
    #[test]
    fn reports_an_overrun_when_the_consumer_falls_behind() {
        let mut radio = FakeRadio::new("fake").unwrap();
        radio.set_sample_rate(1_000_000.0).unwrap();
        radio.activate().unwrap();
        let mut buffer = vec![Complex32::new(0.0, 0.0); 4096];
        radio.read(&mut buffer, 1_000_000).unwrap();

        // Simulate a consumer that stalled for longer than the device's FIFO.
        std::thread::sleep(FIFO_DEPTH + Duration::from_millis(60));
        match radio.read(&mut buffer, 1_000_000) {
            Err(ReadError::Overrun) => {}
            other => panic!("expected an overrun after a stall, got {other:?}"),
        }

        // And it must recover rather than latching into the error.
        assert!(radio.read(&mut buffer, 1_000_000).is_ok());
    }

    #[test]
    fn generates_a_tone_at_about_the_requested_rate() {
        let mut radio = FakeRadio::new("fake:100000").unwrap();
        radio.set_sample_rate(1_000_000.0).unwrap();
        radio.activate().unwrap();
        let mut buffer = vec![Complex32::new(0.0, 0.0); 16384];
        let start = Instant::now();
        let mut total = 0usize;
        while total < 200_000 {
            total += radio.read(&mut buffer, 1_000_000).unwrap();
        }
        let rate = total as f64 / start.elapsed().as_secs_f64();
        // Paced, not free-running: a generator that ignored the clock would
        // come out orders of magnitude high here.
        assert!(rate < 3_000_000.0, "fake radio ran unpaced at {rate} S/s");
        assert!(buffer.iter().any(|s| s.norm() > 0.1), "no signal produced");
    }
}
