//! The `grwire.v1` wire format.
//!
//! One WebSocket carries both planes: control as JSON text frames, IQ as binary
//! frames with the fixed 32-byte header below. The layout is duplicated in
//! `runner/src/grwire_worker.js` because a browser worker cannot import from
//! here; `proto/wire.json` is the shared source of truth and
//! `tests/wire_spec.rs` asserts this file against it.

use serde::{Deserialize, Serialize};

use crate::radio::DeviceInfoJson;

pub const PROTOCOL: &str = "grwire.v1";
pub const SUBPROTOCOL: &str = "grwire.v1";
pub const DEFAULT_PORT: u16 = 8073;

/// `GRW1` read as a little-endian u32. A peer that frames wrongly, or speaks a
/// future version, fails on the first frame instead of producing noise.
pub const MAGIC: u32 = u32::from_le_bytes(*b"GRW1");
pub const HEADER_BYTES: usize = 32;

pub const FRAME_RX_IQ: u8 = 1;
/// Reserved. Tx reuses this header with the direction in `type`, which is why
/// the field exists in v1 rather than being added later.
pub const FRAME_TX_IQ: u8 = 2;

pub const FLAG_DISCONTINUITY: u16 = 1 << 0;

/// How IQ is packed on the wire. `Ci8` is lossless for an 8-bit radio and half
/// the bytes of `Ci16`, which is why it is the default.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    /// The default: two bytes a sample, and lossless for an 8-bit radio.
    #[default]
    Ci8,
    Ci16,
    Cf32,
}

impl Format {
    pub fn code(self) -> u8 {
        match self {
            Format::Ci8 => 1,
            Format::Ci16 => 2,
            Format::Cf32 => 3,
        }
    }

    pub fn bytes_per_sample(self) -> usize {
        match self {
            Format::Ci8 => 2,
            Format::Ci16 => 4,
            Format::Cf32 => 8,
        }
    }
}

/// The fixed header on every binary frame.
///
/// Centre frequency and sample rate are deliberately **not** here. They arrive
/// once per change in the JSON `config` event, keyed by `epoch`, and the client
/// caches that mapping -- so a retune costs one small JSON message rather than
/// 16 bytes on every frame, and the header stays a fixed size forever.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FrameHeader {
    pub kind: u8,
    pub format: u8,
    pub flags: u16,
    pub epoch: u32,
    pub sample_count: u32,
    pub seq: u64,
    /// Absolute output-sample index, **counting samples that were dropped**. A
    /// jump here is exactly how much went missing, which is what makes a drop
    /// measurable rather than merely visible.
    pub sample_index: u64,
}

impl FrameHeader {
    pub fn write_to(&self, out: &mut [u8]) {
        assert!(out.len() >= HEADER_BYTES);
        out[0..4].copy_from_slice(&MAGIC.to_le_bytes());
        out[4] = self.kind;
        out[5] = self.format;
        out[6..8].copy_from_slice(&self.flags.to_le_bytes());
        out[8..12].copy_from_slice(&self.epoch.to_le_bytes());
        out[12..16].copy_from_slice(&self.sample_count.to_le_bytes());
        out[16..24].copy_from_slice(&self.seq.to_le_bytes());
        out[24..32].copy_from_slice(&self.sample_index.to_le_bytes());
    }

    pub fn parse(raw: &[u8]) -> Option<Self> {
        if raw.len() < HEADER_BYTES {
            return None;
        }
        if u32::from_le_bytes(raw[0..4].try_into().ok()?) != MAGIC {
            return None;
        }
        Some(FrameHeader {
            kind: raw[4],
            format: raw[5],
            flags: u16::from_le_bytes(raw[6..8].try_into().ok()?),
            epoch: u32::from_le_bytes(raw[8..12].try_into().ok()?),
            sample_count: u32::from_le_bytes(raw[12..16].try_into().ok()?),
            seq: u64::from_le_bytes(raw[16..24].try_into().ok()?),
            sample_index: u64::from_le_bytes(raw[24..32].try_into().ok()?),
        })
    }
}

// ---------------------------------------------------------------- control plane

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum ClientMsg {
    Hello {
        #[serde(default)]
        client: String,
    },
    /// Enumerate the radios on this host.
    List,
    Open {
        /// A driver args string, e.g. `driver=rtlsdr,serial=00000001`.
        device: String,
        #[serde(default = "default_direction")]
        direction: String,
        #[serde(default)]
        channel: usize,
    },
    Configure(Box<ConfigureRequest>),
    Start,
    Stop,
    /// Consumer-side flow control. See `docs/grwire.md` -- TCP cannot reveal a
    /// browser that has stopped draining, so the client says so itself.
    Flow {
        ack_seq: u64,
        #[serde(default)]
        ring_used: f32,
    },
    Ping {
        #[serde(default)]
        t: f64,
    },
}

fn default_direction() -> String {
    "rx".into()
}

/// A configure request. Every field is optional: an absent field means "leave
/// it alone", which is what makes this both the opening configuration and the
/// live retune path.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ConfigureRequest {
    /// Requested **output** sample rate. The daemon picks the hardware rate and
    /// the decimation that reach it, and `config.applied` says what it chose.
    pub rate: Option<f64>,
    /// Pin the hardware rate instead of letting the daemon choose it.
    pub hw_rate: Option<f64>,
    pub decim: Option<u32>,
    pub freq: Option<f64>,
    /// Digital offset within the captured band, in Hz. Fine-tuning with no
    /// hardware retune and so no glitch.
    pub offset: Option<f64>,
    pub gain: Option<f64>,
    pub gains: Option<std::collections::BTreeMap<String, f64>>,
    pub agc: Option<bool>,
    pub antenna: Option<String>,
    pub bandwidth: Option<f64>,
    pub format: Option<Format>,
    pub ppm: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "ev", rename_all = "snake_case")]
pub enum ServerMsg {
    Hello {
        protocol: String,
        version: String,
        host: String,
        /// Which radio backends this binary was built with.
        backends: Vec<String>,
    },
    Devices {
        devices: Vec<DeviceInfoJson>,
    },
    Opened {
        device: String,
        info: Box<crate::radio::ChannelInfo>,
    },
    Config {
        epoch: u32,
        applied: Box<AppliedConfig>,
    },
    Stats(Box<StatsReport>),
    Error {
        code: String,
        message: String,
    },
    Pong {
        t: f64,
    },
}

/// What the daemon actually did, as opposed to what was asked for. The block
/// reports `out_rate` to the flowgraph console for the same reason the RTL-SDR
/// block reports its divided clock: a graph running at the wrong rate still
/// moves plenty of samples.
#[derive(Debug, Clone, Default, Serialize)]
pub struct AppliedConfig {
    pub hw_rate: f64,
    pub decim: u32,
    pub out_rate: f64,
    pub freq: f64,
    pub offset: f64,
    pub gain: Option<f64>,
    /// Per-stage gains that were accepted, by element name. Reported back so a
    /// client can see which of the ones it asked for the radio actually has.
    #[serde(skip_serializing_if = "std::collections::BTreeMap::is_empty")]
    pub gains: std::collections::BTreeMap<String, f64>,
    pub agc: bool,
    pub antenna: Option<String>,
    pub bandwidth: Option<f64>,
    pub format: Format,
    pub frame_samples: usize,
    /// Anything asked for that this radio could not do, in plain words. Warnings
    /// rather than errors: a dongle without a bandwidth control should still
    /// stream.
    pub warnings: Vec<String>,
}

/// Per-layer loss accounting. Each counter names *where* samples were lost, so
/// the console can say whether the radio, this host, the network or the browser
/// is the bottleneck instead of just that something is wrong.
#[derive(Debug, Clone, Default, Serialize)]
pub struct StatsReport {
    pub uptime_s: f64,
    /// The rate the daemon says it is producing.
    pub out_rate: f64,
    /// The rate it is *actually* producing, measured. These differ when a
    /// driver misreports its sample rate, or when this host cannot keep up. A
    /// wrong rate is the worst kind of failure here, because the plots stay
    /// convincing and only their frequency axis is wrong.
    ///
    /// The estimate needs time to settle -- see SETTLE_SECONDS in session.rs --
    /// so treat a reading from the first few seconds as informational only.
    pub measured_rate: f64,
    /// Set when the two disagree by enough to matter.
    pub rate_suspect: bool,
    /// Samples delivered to the socket.
    pub samples_sent: u64,
    pub frames_sent: u64,
    pub bytes_sent: u64,
    /// The radio's own overruns -- it dropped these before we saw them.
    pub dev_overruns: u64,
    /// We could not keep up with the radio: the reader queue was full.
    pub host_drops: u64,
    /// The socket could not keep up: the writer queue was full.
    pub net_drops: u64,
    /// The client stopped acknowledging: it is not draining fast enough.
    pub client_drops: u64,
    pub dropped_samples: u64,
    /// Frames sent but not yet acknowledged.
    pub in_flight: u64,
    /// Fraction of the browser's ring in use, as last reported by the client.
    pub client_ring_used: f32,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_round_trips() {
        let header = FrameHeader {
            kind: FRAME_RX_IQ,
            format: Format::Ci8.code(),
            flags: FLAG_DISCONTINUITY,
            epoch: 7,
            sample_count: 4096,
            seq: 123_456_789,
            sample_index: 9_876_543_210,
        };
        let mut raw = [0u8; HEADER_BYTES];
        header.write_to(&mut raw);
        assert_eq!(FrameHeader::parse(&raw), Some(header));
    }

    #[test]
    fn a_foreign_frame_is_rejected_rather_than_misread() {
        let mut raw = [0u8; HEADER_BYTES];
        raw[0..4].copy_from_slice(&0xdead_beefu32.to_le_bytes());
        assert_eq!(FrameHeader::parse(&raw), None);
        assert_eq!(FrameHeader::parse(&[0u8; 8]), None);
    }

    #[test]
    fn magic_is_the_ascii_tag() {
        assert_eq!(MAGIC.to_le_bytes(), *b"GRW1");
    }
}
