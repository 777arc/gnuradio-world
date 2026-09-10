//! The radio seam.
//!
//! Everything above this module works in `Complex32` and knows nothing about
//! seify, SoapySDR or USB. That is deliberate: seify is a fast-moving 0.x (five
//! breaking releases between April and August 2026), the fake backend must not
//! depend on it at all, and if the `Complex32`-only read path ever costs too
//! much on a Pi, dropping to raw `soapysdr` for a CS8 fast path is a change
//! confined to `seify_backend.rs`.

use num_complex::Complex32;
use serde::Serialize;

pub mod fake;
#[cfg(feature = "seify-backend")]
pub mod seify_backend;

/// What went wrong reading samples. The distinction between `Overrun` and
/// everything else is load-bearing: an overrun means *the radio* dropped
/// samples, which is a different diagnosis from us dropping them, and the
/// per-layer stats keep the two apart.
#[derive(Debug)]
pub enum ReadError {
    /// The device's own buffer overflowed. Samples are gone; keep streaming.
    Overrun,
    /// Nothing arrived within the timeout. Not an error on its own.
    Timeout,
    /// The stream cannot continue.
    Fatal(String),
}

impl std::fmt::Display for ReadError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ReadError::Overrun => write!(f, "device overrun"),
            ReadError::Timeout => write!(f, "read timed out"),
            ReadError::Fatal(message) => write!(f, "{message}"),
        }
    }
}

/// One enumerated radio, as the browser's device picker sees it.
#[derive(Debug, Clone, Serialize)]
pub struct DeviceInfoJson {
    /// The args string to hand back in `open`. This is what a `.grc` stores,
    /// verbatim -- never normalised, because it is the driver's own identifier.
    pub args: String,
    /// The hardware driver: `hackrf`, `rtlsdr`, `audio`. For a SoapySDR device
    /// this is Soapy's sub-driver, not the string "soapy", because "soapy" says
    /// nothing about what the radio is.
    pub driver: String,
    /// How this daemon reaches it: `soapy` or `native`. One physical radio can
    /// legitimately appear once per backend -- same hardware, different driver
    /// stack -- and the label says so rather than leaving it looking like two
    /// radios that happen to share a name.
    pub backend: String,
    /// `radio`, or `audio` for a sound card SoapySDR happens to expose. The
    /// latter is not what anyone means by an SDR and is listed last.
    pub kind: String,
    pub label: String,
    pub serial: Option<String>,
}

/// A range as the wire reports it. seify's own `Range` is re-shaped into plain
/// intervals so the browser does not have to understand `RangeItem`'s enum
/// encoding to grey out an impossible frequency.
#[derive(Debug, Clone, Default, Serialize)]
pub struct RangeJson {
    pub min: f64,
    pub max: f64,
    /// Discrete choices, when the radio has them rather than a continuum.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub values: Vec<f64>,
    /// Disjoint intervals, e.g. an RTL-SDR's two sample-rate windows.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub intervals: Vec<(f64, f64)>,
}

impl RangeJson {
    pub fn contains(&self, value: f64) -> bool {
        if self
            .intervals
            .iter()
            .any(|&(a, b)| value >= a && value <= b)
        {
            return true;
        }
        if self.values.iter().any(|&v| (v - value).abs() < 1e-6) {
            return true;
        }
        self.intervals.is_empty()
            && self.values.is_empty()
            && value >= self.min
            && value <= self.max
    }

    /// The representable value closest to `value`. Used to turn a requested
    /// hardware rate into one the radio will actually accept, so the daemon can
    /// report what it really did instead of what it was asked for.
    pub fn closest(&self, value: f64) -> Option<f64> {
        if self.contains(value) {
            return Some(value);
        }
        let mut best: Option<f64> = None;
        let mut consider = |candidate: f64| {
            let better = match best {
                None => true,
                Some(current) => (candidate - value).abs() < (current - value).abs(),
            };
            if better {
                best = Some(candidate);
            }
        };
        for &(a, b) in &self.intervals {
            consider(value.clamp(a, b));
        }
        for &v in &self.values {
            consider(v);
        }
        if self.intervals.is_empty() && self.values.is_empty() && self.max >= self.min {
            consider(value.clamp(self.min, self.max));
        }
        best
    }
}

/// Everything the browser needs to render a control panel for one channel.
/// Every field is optional-shaped because a capability really can be absent:
/// an RTL-SDR reports `Unsupported` for bandwidth, and the picker should say so
/// rather than offer a control that does nothing.
#[derive(Debug, Clone, Default, Serialize)]
pub struct ChannelInfo {
    pub driver: String,
    pub channel: usize,
    pub full_duplex: bool,
    pub freq_range: Option<RangeJson>,
    pub rate_range: Option<RangeJson>,
    pub gain_range: Option<RangeJson>,
    pub gain_elements: Vec<String>,
    pub antennas: Vec<String>,
    pub bandwidth_range: Option<RangeJson>,
    pub agc_available: bool,
    /// Wire formats this daemon can produce. Not device-dependent -- the
    /// conversion happens here -- but the client should not have to hard-code
    /// the list.
    pub formats: Vec<String>,
}

/// One opened receive channel.
///
/// Implementations are used from a single dedicated OS thread and never from
/// the async runtime, which is why nothing here is async and why blocking in
/// `read` is fine.
pub trait Radio: Send {
    fn info(&self) -> ChannelInfo;

    /// Returns the rate the hardware actually settled on, which is frequently
    /// not the one requested.
    fn set_sample_rate(&mut self, rate: f64) -> anyhow::Result<f64>;
    fn set_frequency(&mut self, hz: f64) -> anyhow::Result<f64>;
    fn set_gain(&mut self, db: f64) -> anyhow::Result<()>;
    fn set_gain_element(&mut self, name: &str, db: f64) -> anyhow::Result<()>;
    fn set_agc(&mut self, on: bool) -> anyhow::Result<()>;
    fn set_antenna(&mut self, name: &str) -> anyhow::Result<()>;
    fn set_bandwidth(&mut self, hz: f64) -> anyhow::Result<()>;
    fn set_ppm(&mut self, ppm: f64) -> anyhow::Result<()>;

    /// Largest read the device wants to do at once.
    fn mtu(&self) -> usize;

    fn activate(&mut self) -> anyhow::Result<()>;
    fn deactivate(&mut self) -> anyhow::Result<()>;
    fn read(&mut self, buffer: &mut [Complex32], timeout_us: i64) -> Result<usize, ReadError>;
}

/// Every radio this binary can see, from every backend it was built with.
pub fn enumerate() -> Vec<DeviceInfoJson> {
    let mut devices = Vec::new();
    #[cfg(feature = "seify-backend")]
    devices.extend(seify_backend::enumerate());
    devices.push(fake::descriptor());

    // Most useful first: real radios through SoapySDR (the recommended path),
    // then the same hardware through a native driver, then sound cards, then
    // the generator. A list that opens with two PulseAudio loopbacks makes the
    // radio look missing.
    devices.sort_by_key(|device| {
        let group = match (device.kind.as_str(), device.backend.as_str()) {
            ("radio", "soapy") => 0,
            ("radio", "native") => 1,
            ("radio", _) => 2,
            ("audio", _) => 3,
            _ => 4,
        };
        (group, device.label.clone())
    });
    devices
}

/// Open a radio by args string. `fake` (optionally `fake:<tone Hz>`) selects the
/// generator, which is what lets every test and the CI smoke run exercise the
/// whole daemon with no hardware and no SoapySDR present.
pub fn open(args: &str, channel: usize) -> anyhow::Result<Box<dyn Radio>> {
    if fake::owns(args) {
        return Ok(Box::new(fake::FakeRadio::new(args)?));
    }
    #[cfg(feature = "seify-backend")]
    {
        seify_backend::open(args, channel)
    }
    #[cfg(not(feature = "seify-backend"))]
    {
        let _ = channel;
        anyhow::bail!(
            "this build has no radio backends compiled in; only 'fake' is available (args: {args})"
        )
    }
}

/// The backend names this binary carries, reported in the `hello` event so a
/// user can see at a glance why their radio is or is not listed.
pub fn backends() -> Vec<String> {
    // `mut` is conditional: with no backend features compiled in, nothing below
    // pushes, and an unconditional `mut` warns on that build.
    #[allow(unused_mut)]
    let mut names = vec!["fake".to_string()];
    #[cfg(feature = "soapy")]
    names.push("soapy".to_string());
    #[cfg(feature = "rtlsdr")]
    names.push("rtlsdr".to_string());
    #[cfg(feature = "hackrf")]
    names.push("hackrf".to_string());
    names
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The round trip that matters: whatever `enumerate` puts in `args` is what
    /// a `.grc` stores and what `open` is later handed, so every one of them
    /// must parse back.
    ///
    /// This was broken: the args were seify's own `to_string()`, which contains
    /// values with spaces in them ("device=HackRF One"), and its parser cannot
    /// read those back -- so picking a radio from the list failed with "failed
    /// to convert args" while leaving the field empty worked. On a machine with
    /// no radios this exercises only the fake, which is still worth having.
    #[test]
    fn every_enumerated_device_opens_by_its_own_args() {
        for device in enumerate() {
            // A sound card is listed because SoapySDR exposes it, not because
            // it is a radio; opening one proves nothing and may not be possible.
            if device.kind == "audio" {
                continue;
            }
            if let Err(error) = open(&device.args, 0) {
                panic!(
                    "enumerate() offered args that open() rejects:\n  args:  {}\n  label: {}\n  {error}",
                    device.args, device.label
                );
            }
        }
    }

    fn rtlsdr_like_rates() -> RangeJson {
        // The real thing, from a dongle: two disjoint windows with a hole
        // between 300 kS/s and 900 kS/s.
        RangeJson {
            min: 225_001.0,
            max: 3_200_000.0,
            values: vec![],
            intervals: vec![(225_001.0, 300_000.0), (900_001.0, 3_200_000.0)],
        }
    }

    #[test]
    fn closest_snaps_into_a_window_rather_than_across_the_hole() {
        let rates = rtlsdr_like_rates();
        assert_eq!(rates.closest(2_048_000.0), Some(2_048_000.0));
        // 400 kS/s falls in the gap; 300 kS/s is nearer than 900 kS/s.
        assert_eq!(rates.closest(400_000.0), Some(300_000.0));
        assert_eq!(rates.closest(800_000.0), Some(900_001.0));
        assert_eq!(rates.closest(10_000_000.0), Some(3_200_000.0));
    }

    #[test]
    fn contains_respects_the_gap() {
        let rates = rtlsdr_like_rates();
        assert!(rates.contains(2_400_000.0));
        assert!(!rates.contains(500_000.0));
    }
}
