//! The seify backend: every line in this file is the price of seify's 0.x
//! churn, and it is confined here on purpose.
//!
//! seify 0.23 is capability-trait shaped -- `GainControl`, `FrequencyControl`
//! and friends, each of which a given driver may simply not implement. A
//! missing capability comes back as `Error::Unsupported`, and this module turns
//! that into "absent" rather than "failed", because a radio without a bandwidth
//! control should still stream.

use num_complex::Complex32;
use seify::{
    AgcControl, AntennaControl, BandwidthControl, Direction, DynDevice, DynRxStreamer,
    FrequencyControl, GainControl, Range, RangeItem, RxStreamer, SampleRateControl,
};

use super::{ChannelInfo, DeviceInfoJson, Radio, RangeJson, ReadError};

const RX: Direction = Direction::Rx;

pub fn enumerate() -> Vec<DeviceInfoJson> {
    let found = match seify::enumerate() {
        Ok(found) => found,
        Err(error) => {
            tracing::warn!("enumeration failed: {error}");
            return Vec::new();
        }
    };
    found
        .into_iter()
        .map(|args| {
            let outer = args.get::<String>("driver").unwrap_or_default();
            let serial = args.get::<String>("serial").ok().filter(|s| !s.is_empty());

            // "soapy" is how we got there, not what the radio is. Report the
            // sub-driver as the driver, so a HackRF says "hackrf" whichever
            // stack reached it.
            let soapy_driver = args
                .get::<String>("soapy_driver")
                .ok()
                .filter(|s| !s.is_empty());
            let via_soapy = outer == "soapy";
            let driver = soapy_driver.clone().unwrap_or_else(|| outer.clone());
            let backend = if via_soapy { "soapy" } else { "native" };
            let kind = if driver == "audio" { "audio" } else { "radio" };

            // A human name, in decreasing order of how much it tells you.
            // SoapySDR sets `label` ("HackRF One #0 66a0..."); the native
            // drivers set `product` or `description` instead; the driver name
            // is the last resort.
            let name = ["label", "product", "description"]
                .iter()
                .find_map(|key| {
                    args.get::<String>(key)
                        .ok()
                        .filter(|value| !value.is_empty())
                })
                .or_else(|| serial.clone().map(|s| format!("{driver} ({s})")))
                .unwrap_or_else(|| driver.clone());

            // The same physical radio can appear once per backend. Saying which
            // is which turns a confusing duplicate into a choice.
            let label = if kind == "audio" {
                format!("{name} (sound card, not a radio)")
            } else if via_soapy {
                format!("{name} — via SoapySDR")
            } else {
                format!("{name} — via the built-in {driver} driver")
            };

            DeviceInfoJson {
                // Not seify's own `to_string()`: that is a pretty-printed dump
                // of every key it knows, including values with spaces in them
                // ("device=HackRF One"), and feeding it back to `from_args`
                // fails with "failed to convert args". What goes on the wire --
                // and into a .grc -- is the smallest string that identifies
                // this radio and parses again.
                args: identity(&outer, soapy_driver.as_deref(), &args, serial.as_deref()),
                driver,
                backend: backend.to_string(),
                kind: kind.to_string(),
                label,
                serial,
            }
        })
        .collect()
}

/// The smallest args string that names one radio and can be parsed back.
///
/// Only space-free identifiers are used, because seify's args parser splits on
/// commas and cannot read a value containing a space -- which is exactly what
/// its own `to_string()` emits for a HackRF.
fn identity(
    outer: &str,
    soapy_driver: Option<&str>,
    args: &seify::Args,
    serial: Option<&str>,
) -> String {
    let mut parts = Vec::new();
    if !outer.is_empty() {
        parts.push(format!("driver={outer}"));
    }
    if let Some(driver) = soapy_driver {
        parts.push(format!("soapy_driver={driver}"));
    }
    // A serial is the only identifier that survives replugging. Fall back to a
    // positional one where a device has none -- a sound card, say -- and skip
    // anything with a space in it, which would not parse back.
    let positional = ["index", "device_id"].iter().find_map(|key| {
        args.get::<String>(key)
            .ok()
            .filter(|value| !value.is_empty())
    });
    match serial.filter(|value| !value.contains(' ')) {
        Some(serial) => parts.push(format!("serial={serial}")),
        None => {
            if let Some(value) = positional.filter(|value| !value.contains(' ')) {
                let key = if args.get::<String>("index").is_ok() {
                    "index"
                } else {
                    "device_id"
                };
                parts.push(format!("{key}={value}"));
            }
        }
    }
    parts.join(",")
}

pub fn open(args: &str, channel: usize) -> anyhow::Result<Box<dyn Radio>> {
    let device = DynDevice::from_args(args)
        .map_err(|error| anyhow::anyhow!("could not open '{args}': {error}"))?;
    let channels = device.num_channels(RX).unwrap_or(1);
    anyhow::ensure!(
        channel < channels,
        "channel {channel} does not exist; this radio has {channels}"
    );
    Ok(Box::new(SeifyRadio {
        device,
        channel,
        stream: None,
    }))
}

/// seify reports a range as a list of intervals, fixed values and stepped
/// intervals. The browser only needs to know what it may ask for, so flatten it.
fn range_to_json(range: Range) -> RangeJson {
    let mut out = RangeJson::default();
    let mut min = f64::INFINITY;
    let mut max = f64::NEG_INFINITY;
    for item in range.items {
        match item {
            RangeItem::Interval(a, b) => {
                out.intervals.push((a, b));
                min = min.min(a);
                max = max.max(b);
            }
            RangeItem::Value(v) => {
                out.values.push(v);
                min = min.min(v);
                max = max.max(v);
            }
            RangeItem::Step(a, b, _step) => {
                out.intervals.push((a, b));
                min = min.min(a);
                max = max.max(b);
            }
        }
    }
    if min.is_finite() {
        out.min = min;
        out.max = max;
    }
    out
}

/// An unsupported capability is missing information, not a failure. Anything
/// else is worth logging, because a driver that errors on a gain read is a
/// driver about to misbehave.
fn optional<T>(what: &str, result: Result<T, seify::Error>) -> Option<T> {
    match result {
        Ok(value) => Some(value),
        Err(seify::Error::Unsupported { .. }) => None,
        Err(error) => {
            tracing::debug!("{what} unavailable: {error}");
            None
        }
    }
}

/// Treat "this radio has no such control" as success. Asking a dongle with no
/// bandwidth filter to set one should not abort the stream; the request is
/// reported back as a warning in `config.applied` instead.
fn tolerate_unsupported(what: &str, result: Result<(), seify::Error>) -> anyhow::Result<()> {
    match result {
        Ok(()) => Ok(()),
        Err(seify::Error::Unsupported { .. }) => {
            tracing::debug!("{what} is not supported by this radio; ignoring");
            Ok(())
        }
        Err(error) => Err(anyhow::anyhow!("{what} failed: {error}")),
    }
}

pub struct SeifyRadio {
    device: DynDevice,
    channel: usize,
    stream: Option<DynRxStreamer>,
}

impl SeifyRadio {
    fn streamer(&mut self) -> Result<&mut DynRxStreamer, ReadError> {
        self.stream
            .as_mut()
            .ok_or_else(|| ReadError::Fatal("the receive stream is not active".into()))
    }
}

impl Radio for SeifyRadio {
    fn info(&self) -> ChannelInfo {
        ChannelInfo {
            driver: format!("{:?}", self.device.driver()).to_lowercase(),
            channel: self.channel,
            full_duplex: self.device.full_duplex().unwrap_or(false),
            freq_range: optional(
                "frequency range",
                self.device.frequency_range(RX, self.channel),
            )
            .map(range_to_json),
            rate_range: optional(
                "sample rate range",
                self.device.get_sample_rate_range(RX, self.channel),
            )
            .map(range_to_json),
            gain_range: optional("gain range", self.device.gain_range(RX, self.channel))
                .map(range_to_json),
            gain_elements: optional("gain elements", self.device.gain_elements(RX, self.channel))
                .unwrap_or_default(),
            antennas: optional("antennas", self.device.antennas(RX, self.channel))
                .unwrap_or_default(),
            bandwidth_range: optional(
                "bandwidth range",
                self.device.get_bandwidth_range(RX, self.channel),
            )
            .map(range_to_json),
            agc_available: optional("agc", self.device.agc_available(RX, self.channel))
                .unwrap_or(false),
            formats: vec!["ci8".into(), "ci16".into(), "cf32".into()],
        }
    }

    fn set_sample_rate(&mut self, rate: f64) -> anyhow::Result<f64> {
        self.device
            .set_sample_rate(RX, self.channel, rate)
            .map_err(|error| anyhow::anyhow!("setting sample rate to {rate} failed: {error}"))?;
        // Ask rather than assume: the RTL2832U divides a 28.8 MHz clock, so the
        // rate a graph really runs at is frequently not the one requested, and
        // reporting the request would make every plot's axis a lie.
        Ok(self.device.sample_rate(RX, self.channel).unwrap_or(rate))
    }

    fn set_frequency(&mut self, hz: f64) -> anyhow::Result<f64> {
        self.device
            .set_frequency(RX, self.channel, hz, Default::default())
            .map_err(|error| anyhow::anyhow!("tuning to {hz} Hz failed: {error}"))?;
        Ok(self.device.frequency(RX, self.channel).unwrap_or(hz))
    }

    fn set_gain(&mut self, db: f64) -> anyhow::Result<()> {
        tolerate_unsupported("setting gain", self.device.set_gain(RX, self.channel, db))
    }

    fn set_gain_element(&mut self, name: &str, db: f64) -> anyhow::Result<()> {
        tolerate_unsupported(
            &format!("setting gain element '{name}'"),
            self.device.set_gain_element(RX, self.channel, name, db),
        )
    }

    fn set_agc(&mut self, on: bool) -> anyhow::Result<()> {
        tolerate_unsupported(
            "setting AGC",
            self.device.set_agc_enabled(RX, self.channel, on),
        )
    }

    fn set_antenna(&mut self, name: &str) -> anyhow::Result<()> {
        tolerate_unsupported(
            &format!("selecting antenna '{name}'"),
            self.device.set_antenna(RX, self.channel, name),
        )
    }

    fn set_bandwidth(&mut self, hz: f64) -> anyhow::Result<()> {
        tolerate_unsupported(
            "setting bandwidth",
            self.device.set_bandwidth(RX, self.channel, hz),
        )
    }

    fn set_ppm(&mut self, ppm: f64) -> anyhow::Result<()> {
        // seify has no frequency-correction capability trait. Rather than lie
        // about applying it, the caller folds ppm into the tuned frequency.
        let _ = ppm;
        Ok(())
    }

    fn mtu(&self) -> usize {
        self.stream
            .as_ref()
            .and_then(|stream| stream.mtu().ok())
            .unwrap_or(65536)
    }

    fn activate(&mut self) -> anyhow::Result<()> {
        let mut stream = self
            .device
            .rx_streamer(&[self.channel])
            .map_err(|error| anyhow::anyhow!("could not create the receive stream: {error}"))?;
        stream
            .activate()
            .map_err(|error| anyhow::anyhow!("could not start the receive stream: {error}"))?;
        self.stream = Some(stream);
        Ok(())
    }

    fn deactivate(&mut self) -> anyhow::Result<()> {
        if let Some(mut stream) = self.stream.take() {
            let _ = stream.deactivate();
        }
        Ok(())
    }

    fn read(&mut self, buffer: &mut [Complex32], timeout_us: i64) -> Result<usize, ReadError> {
        let stream = self.streamer()?;
        match stream.read(&mut [buffer], timeout_us) {
            Ok(count) => Ok(count),
            // The two that are not failures: the radio lost samples, or none
            // arrived yet. Both must keep the stream running.
            Err(seify::Error::Overrun) => Err(ReadError::Overrun),
            Err(seify::Error::Timeout) => Err(ReadError::Timeout),
            Err(seify::Error::DeviceDisconnected) => {
                Err(ReadError::Fatal("the radio was disconnected".into()))
            }
            Err(error) => Err(ReadError::Fatal(format!("read failed: {error}"))),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_disjoint_range_keeps_both_windows() {
        let json = range_to_json(Range::new(vec![
            RangeItem::Interval(225_001.0, 300_000.0),
            RangeItem::Interval(900_001.0, 3_200_000.0),
        ]));
        assert_eq!(json.min, 225_001.0);
        assert_eq!(json.max, 3_200_000.0);
        assert_eq!(json.intervals.len(), 2);
        // The hole between the windows must survive the flattening, or the
        // daemon will happily request a rate the dongle cannot produce.
        assert!(!json.contains(500_000.0));
    }
}
