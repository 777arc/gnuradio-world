//! The one-client state machine: hello -> list -> open -> configure -> start.
//!
//! One session owns at most one radio and one stream. The daemon serves a single
//! client by design (see docs/grwire.md): a radio is not shareable, and refusing
//! a second client outright is honest where silently interleaving two tuning
//! requests would not be.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use crate::proto::{AppliedConfig, ConfigureRequest, Format, ServerMsg, StatsReport};
use crate::radio::{self, ChannelInfo, Radio};
use crate::stats::Stats;
use crate::stream::{self, RadioCommand, Stream, StreamConfig};

/// Target frame duration. Small enough that a waterfall feels live, large enough
/// that per-frame overhead is irrelevant.
const FRAME_TARGET_MS: f64 = 15.0;

/// How far ahead of the client's acknowledgements the daemon will run before it
/// starts dropping. A quarter second of frames: enough to ride out a scheduling
/// hiccup in the browser, short enough that a genuinely stuck consumer is
/// noticed rather than buffered.
pub const DEFAULT_FLOW_WINDOW_MS: f64 = 250.0;

/// How long the stream must have been running before its measured rate is
/// trusted enough to contradict the rate the radio reports.
///
/// Measured, not guessed: against a real RTL-SDR the estimate is still ~2% out
/// at 5 s and has converged to under 0.5% by 10 s. Flagging earlier accuses a
/// perfectly good radio at random, which would train everyone to ignore the one
/// warning that matters.
const SETTLE_SECONDS: f64 = 10.0;

/// The largest decimation the daemon will choose on its own. 20 MS/s divided by
/// this is about 78 kS/s, below anything a browser flowgraph wants from a radio.
const MAX_AUTO_DECIM: u32 = 256;

/// How far a candidate hardware rate may sit from one the radio actually offers
/// and still be accepted when choosing a decimation automatically.
const AUTO_RATE_TOLERANCE: f64 = 0.005;

pub struct Session {
    radio: Option<Box<dyn Radio>>,
    info: Option<ChannelInfo>,
    device_args: String,
    channel: usize,
    stream: Option<Stream>,
    applied: AppliedConfig,
    epoch: u32,
    /// Highest frame sequence the client says it has consumed.
    pub ack_seq: Arc<AtomicU64>,
    /// Whether the client has ever sent a `flow` message. A client that never
    /// does -- the throughput probe, say -- must not be throttled to a halt by a
    /// window it does not know about.
    pub flow_seen: Arc<std::sync::atomic::AtomicBool>,
    pub client_ring_used: Arc<std::sync::Mutex<f32>>,
    started: Option<std::time::Instant>,
}

impl Default for Session {
    fn default() -> Self {
        Self::new()
    }
}

impl Session {
    pub fn new() -> Self {
        Self {
            radio: None,
            info: None,
            device_args: String::new(),
            channel: 0,
            stream: None,
            applied: AppliedConfig {
                format: Format::Ci8,
                ..Default::default()
            },
            epoch: 0,
            ack_seq: Arc::new(AtomicU64::new(0)),
            flow_seen: Arc::new(std::sync::atomic::AtomicBool::new(false)),
            client_ring_used: Arc::new(std::sync::Mutex::new(0.0)),
            started: None,
        }
    }

    pub fn stream(&self) -> Option<&Stream> {
        self.stream.as_ref()
    }

    pub fn applied(&self) -> &AppliedConfig {
        &self.applied
    }

    pub fn epoch(&self) -> u32 {
        self.epoch
    }

    pub fn list() -> ServerMsg {
        ServerMsg::Devices {
            devices: radio::enumerate(),
        }
    }

    pub fn open(
        &mut self,
        device: &str,
        direction: &str,
        channel: usize,
    ) -> anyhow::Result<ServerMsg> {
        anyhow::ensure!(
            direction == "rx",
            "this build receives only; '{direction}' is not supported yet"
        );
        // Opening a second radio without closing the first would leak the
        // device handle and, on a half-duplex radio, deadlock against itself.
        self.close();

        let radio = radio::open(device, channel)?;
        let info = radio.info();
        self.device_args = device.to_string();
        self.channel = channel;
        self.info = Some(info.clone());
        self.radio = Some(radio);
        Ok(ServerMsg::Opened {
            device: device.to_string(),
            info: Box::new(info),
        })
    }

    /// Apply a configure request.
    ///
    /// Splits three ways: things only settable before the stream starts (rate,
    /// decimation, format), things the reader thread applies live (frequency,
    /// gain, antenna, bandwidth), and the DDC offset, which the DSP thread owns.
    pub fn configure(&mut self, request: &ConfigureRequest) -> anyhow::Result<ServerMsg> {
        let info = self
            .info
            .clone()
            .ok_or_else(|| anyhow::anyhow!("no radio is open; send 'open' first"))?;
        let mut warnings = Vec::new();

        if self.stream.is_some() {
            for (field, present) in [
                ("rate", request.rate.is_some() || request.hw_rate.is_some()),
                ("decim", request.decim.is_some()),
                ("format", request.format.is_some()),
            ] {
                if present {
                    // Changing the output rate under a running flowgraph would
                    // rescale the QT GUI sinks' axes while GNU Radio's own rate
                    // assumptions stayed put -- a wrong plot rather than no
                    // effect. Refuse, and say why.
                    warnings.push(format!(
                        "'{field}' cannot change while streaming; stop the stream first"
                    ));
                }
            }
        }

        if self.stream.is_none() {
            self.plan_rates(request, &info, &mut warnings)?;
            if let Some(format) = request.format {
                self.applied.format = format;
            }
        }

        if let Some(ppm) = request.ppm {
            self.applied.warnings.clear();
            if ppm != 0.0 {
                warnings.push(
                    "frequency correction is applied by offsetting the tuned frequency".into(),
                );
            }
        }

        // Frequency, with any ppm correction folded in -- seify has no
        // correction capability, and pretending to apply one would be worse
        // than doing it here where it is visible.
        if let Some(freq) = request.freq {
            let corrected = freq * (1.0 + request.ppm.unwrap_or(0.0) / 1e6);
            if let Some(range) = &info.freq_range {
                if !range.contains(corrected) {
                    warnings.push(format!(
                        "{:.6} MHz is outside this radio's {:.3}-{:.3} MHz range",
                        corrected / 1e6,
                        range.min / 1e6,
                        range.max / 1e6
                    ));
                }
            }
            self.applied.freq = corrected;
            self.dispatch(RadioCommand::Frequency(corrected))?;
        }

        if let Some(offset) = request.offset {
            let nyquist = self.applied.out_rate / 2.0;
            if nyquist > 0.0 && offset.abs() > self.applied.hw_rate / 2.0 {
                warnings.push(format!(
                    "an offset of {:.1} kHz is outside the captured band",
                    offset / 1e3
                ));
            }
            self.applied.offset = offset;
            if let Some(stream) = &self.stream {
                stream.set_offset(offset);
            }
        }

        if let Some(agc) = request.agc {
            if !info.agc_available && agc {
                warnings.push("this radio has no AGC".into());
            }
            self.applied.agc = agc;
            self.dispatch(RadioCommand::Agc(agc))?;
        }

        if let Some(gain) = request.gain {
            if let Some(range) = &info.gain_range {
                if !range.contains(gain) {
                    warnings.push(format!(
                        "gain {gain} dB is outside {:.1}-{:.1} dB",
                        range.min, range.max
                    ));
                }
            }
            self.applied.gain = Some(gain);
            self.dispatch(RadioCommand::Gain(gain))?;
        }

        if let Some(gains) = &request.gains {
            for (name, value) in gains {
                if !info.gain_elements.iter().any(|element| element == name) {
                    warnings.push(format!("this radio has no gain element '{name}'"));
                    continue;
                }
                // Remember it, or it is lost: `dispatch` reaches the radio only
                // once the reader thread owns it, and configure almost always
                // happens before start.
                self.applied.gains.insert(name.clone(), *value);
                self.dispatch(RadioCommand::GainElement(name.clone(), *value))?;
            }
        }

        if let Some(antenna) = &request.antenna {
            if !info.antennas.is_empty() && !info.antennas.contains(antenna) {
                warnings.push(format!(
                    "'{antenna}' is not one of this radio's antennas ({})",
                    info.antennas.join(", ")
                ));
            }
            self.applied.antenna = Some(antenna.clone());
            self.dispatch(RadioCommand::Antenna(antenna.clone()))?;
        }

        if let Some(bandwidth) = request.bandwidth {
            if info.bandwidth_range.is_none() {
                warnings.push("this radio has no bandwidth control".into());
            }
            self.applied.bandwidth = Some(bandwidth);
            self.dispatch(RadioCommand::Bandwidth(bandwidth))?;
        }

        self.epoch += 1;
        if let Some(stream) = &self.stream {
            stream.epoch.store(self.epoch, Ordering::Release);
        }
        self.applied.warnings = warnings;
        Ok(ServerMsg::Config {
            epoch: self.epoch,
            applied: Box::new(self.applied.clone()),
        })
    }

    /// Choose a hardware rate and a decimation factor that reach the requested
    /// output rate. The client asks for what it wants to receive; picking how to
    /// get there is this daemon's job, and `applied` reports what it chose.
    fn plan_rates(
        &mut self,
        request: &ConfigureRequest,
        info: &ChannelInfo,
        warnings: &mut Vec<String>,
    ) -> anyhow::Result<()> {
        let want_out = request.rate.unwrap_or(if self.applied.out_rate > 0.0 {
            self.applied.out_rate
        } else {
            2_048_000.0
        });
        anyhow::ensure!(want_out > 0.0, "sample rate must be positive");

        let (hw_target, decim) = match (request.hw_rate, request.decim) {
            // Fully pinned: trust the client entirely.
            (Some(hw), Some(decim)) => (hw, decim.max(1)),
            (Some(hw), None) => {
                let decim = (hw / want_out).round().max(1.0) as u32;
                (hw, decim)
            }
            (None, Some(decim)) => (want_out * decim.max(1) as f64, decim.max(1)),
            (None, None) => {
                // Prefer no decimation when the radio can sample at the wanted
                // rate directly: fewer stages, less CPU, no filter transient.
                let direct = info
                    .rate_range
                    .as_ref()
                    .map(|range| range.contains(want_out))
                    .unwrap_or(true);
                if direct {
                    (want_out, 1)
                } else {
                    // Otherwise find the *smallest* factor that lands the
                    // hardware rate on something the radio can really do.
                    // Smallest, because a lower hardware rate is less USB
                    // traffic and less filtering to do.
                    //
                    // Every integer factor, not a hand-picked list: a HackRF
                    // offers whole megasamples per second, so 333.333 kS/s
                    // needs a factor of 3 and 250 kS/s needs 4. A list that
                    // happened to omit one silently handed the client a rate it
                    // did not ask for.
                    let ceiling = info.rate_range.as_ref().map(|r| r.max).unwrap_or(f64::MAX);
                    let mut chosen = (want_out, 1u32);
                    for factor in 2..=MAX_AUTO_DECIM {
                        let candidate = want_out * factor as f64;
                        if candidate > ceiling {
                            break;
                        }
                        // Near enough, not exactly: 333.333 kS/s times 3 is
                        // 999,999, and refusing that because the radio lists
                        // 1,000,000 would hand the client 1 MS/s instead of a
                        // third of a megasample it asked for. Snap to the rate
                        // the radio really has and let the division be the
                        // truth.
                        let snapped = match info.rate_range.as_ref() {
                            Some(range) => match range.closest(candidate) {
                                Some(snapped) => snapped,
                                None => continue,
                            },
                            None => candidate,
                        };
                        if (snapped - candidate).abs() <= candidate * AUTO_RATE_TOLERANCE {
                            chosen = (snapped, factor);
                            break;
                        }
                    }
                    chosen
                }
            }
        };

        // Snap to something the radio can really do, then report it.
        let hw_rate = info
            .rate_range
            .as_ref()
            .and_then(|range| range.closest(hw_target))
            .unwrap_or(hw_target);
        if (hw_rate - hw_target).abs() > hw_target * 1e-6 {
            warnings.push(format!(
                "requested {:.0} S/s from the radio; it can do {:.0} S/s",
                hw_target, hw_rate
            ));
        }

        let actual_hw = match self.radio.as_mut() {
            Some(radio) => radio.set_sample_rate(hw_rate)?,
            None => hw_rate,
        };

        self.applied.hw_rate = actual_hw;
        self.applied.decim = decim;
        self.applied.out_rate = actual_hw / decim as f64;
        self.applied.frame_samples =
            stream::frame_samples_for(self.applied.out_rate, self.applied.format, FRAME_TARGET_MS);

        if (self.applied.out_rate - want_out).abs() > want_out * 0.001 {
            warnings.push(format!(
                "output rate is {:.1} S/s, not the {:.1} S/s requested",
                self.applied.out_rate, want_out
            ));
        }
        Ok(())
    }

    fn dispatch(&self, command: RadioCommand) -> anyhow::Result<()> {
        if let Some(stream) = &self.stream {
            stream.retune(command);
        }
        // Before the stream exists there is no reader thread to receive the
        // command; `start` replays the whole applied configuration instead.
        Ok(())
    }

    pub fn start(&mut self) -> anyhow::Result<()> {
        anyhow::ensure!(self.stream.is_none(), "the stream is already running");
        let mut radio = self
            .radio
            .take()
            .ok_or_else(|| anyhow::anyhow!("no radio is open; send 'open' first"))?;

        if self.applied.hw_rate <= 0.0 {
            let info = radio.info();
            self.radio = Some(radio);
            self.info = Some(info);
            anyhow::bail!("send 'configure' with a sample rate before 'start'");
        }

        // Replay the configuration onto the radio now that we own it again.
        // Anything that fails here is a warning, not a refusal to stream: a
        // missing antenna control should not cost the user their signal.
        if self.applied.freq > 0.0 {
            radio.set_frequency(self.applied.freq)?;
        }
        if let Some(gain) = self.applied.gain {
            let _ = radio.set_gain(gain);
        }
        // After the overall gain, so an explicitly named stage wins over the
        // radio's own distribution of it.
        for (name, value) in &self.applied.gains {
            let _ = radio.set_gain_element(name, *value);
        }
        let _ = radio.set_agc(self.applied.agc);
        if let Some(antenna) = &self.applied.antenna {
            let _ = radio.set_antenna(antenna);
        }
        if let Some(bandwidth) = self.applied.bandwidth {
            let _ = radio.set_bandwidth(bandwidth);
        }

        let config = StreamConfig {
            hw_rate: self.applied.hw_rate,
            decim: self.applied.decim,
            offset: self.applied.offset,
            format: self.applied.format,
            frame_samples: self.applied.frame_samples,
        };
        self.stream = Some(stream::start(radio, config, self.epoch)?);
        self.started = Some(std::time::Instant::now());
        Ok(())
    }

    pub fn stop(&mut self) {
        if let Some(mut stream) = self.stream.take() {
            stream.stop();
        }
        self.started = None;
        // The radio is gone with the stream's reader thread; reopening is the
        // client's job. Say so rather than pretending it is still open.
        self.radio = None;
    }

    pub fn close(&mut self) {
        self.stop();
        self.radio = None;
        self.info = None;
        self.device_args.clear();
    }

    pub fn stats_report(&self) -> Option<StatsReport> {
        let stream = self.stream.as_ref()?;
        let stats: &Stats = &stream.stats;
        let sent = Stats::get(&stats.frames_sent);
        let acked = self.ack_seq.load(Ordering::Relaxed);
        let uptime = self
            .started
            .map(|start| start.elapsed().as_secs_f64())
            .unwrap_or(0.0);
        let samples_sent = Stats::get(&stats.samples_sent);
        let dropped = Stats::get(&stats.dropped_samples);
        // Count what was dropped: the question is whether the *radio* is
        // producing the rate it claims, not whether we forwarded all of it.
        let measured_rate = if uptime > 1.0 {
            (samples_sent + dropped) as f64 / uptime
        } else {
            0.0
        };
        // Only accuse the radio once the measurement has settled. The first
        // seconds include the daemon's own start-up burst, and a spurious "your
        // plots are lying" warning is worse than a true one arriving late.
        let rate_suspect = uptime >= SETTLE_SECONDS
            && measured_rate > 0.0
            && self.applied.out_rate > 0.0
            && (measured_rate - self.applied.out_rate).abs() / self.applied.out_rate > 0.02;
        Some(StatsReport {
            uptime_s: uptime,
            out_rate: self.applied.out_rate,
            measured_rate,
            rate_suspect,
            samples_sent,
            frames_sent: sent,
            bytes_sent: Stats::get(&stats.bytes_sent),
            dev_overruns: Stats::get(&stats.dev_overruns),
            host_drops: Stats::get(&stats.host_drops),
            net_drops: Stats::get(&stats.net_drops),
            client_drops: Stats::get(&stats.client_drops),
            dropped_samples: dropped,
            in_flight: sent.saturating_sub(acked),
            client_ring_used: *self.client_ring_used.lock().unwrap(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opened_fake() -> Session {
        let mut session = Session::new();
        session.open("fake:100000", "rx", 0).unwrap();
        session
    }

    #[test]
    fn rejects_transmit_until_it_exists() {
        let mut session = Session::new();
        let error = session.open("fake", "tx", 0).unwrap_err().to_string();
        assert!(error.contains("receives only"), "unexpected: {error}");
    }

    #[test]
    fn picks_no_decimation_when_the_radio_can_sample_directly() {
        let mut session = opened_fake();
        session
            .configure(&ConfigureRequest {
                rate: Some(1_000_000.0),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(session.applied().decim, 1);
        assert_eq!(session.applied().hw_rate, 1_000_000.0);
        assert_eq!(session.applied().out_rate, 1_000_000.0);
    }

    #[test]
    fn an_explicit_decim_sets_the_hardware_rate_above_the_output_rate() {
        let mut session = opened_fake();
        session
            .configure(&ConfigureRequest {
                rate: Some(250_000.0),
                decim: Some(8),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(session.applied().decim, 8);
        assert_eq!(session.applied().hw_rate, 2_000_000.0);
        assert_eq!(session.applied().out_rate, 250_000.0);
    }

    /// A HackRF cannot sample below about 2 MS/s, which is the case the rate
    /// planner exists for: the client asks for the rate it wants to *receive*,
    /// and the daemon works out that it must oversample and decimate to get
    /// there. Getting this wrong means a HackRF user simply cannot ask for a
    /// narrow band, which is most of what anyone wants a HackRF for.
    #[test]
    fn plans_around_a_radio_that_cannot_sample_slowly() {
        // The real thing, read off a HackRF One through SoapySDR: whole
        // megasamples per second, as discrete values rather than an interval.
        let hackrf_rates = crate::radio::RangeJson {
            min: 1_000_000.0,
            max: 20_000_000.0,
            values: (1..=20).map(|n| n as f64 * 1e6).collect(),
            intervals: vec![],
        };
        let info = ChannelInfo {
            driver: "hackrf".into(),
            rate_range: Some(hackrf_rates),
            ..Default::default()
        };

        // 300 kS/s out: impossible directly, so oversample and decimate.
        let mut session = Session::new();
        let mut warnings = Vec::new();
        session
            .plan_rates(
                &ConfigureRequest {
                    rate: Some(300_000.0),
                    ..Default::default()
                },
                &info,
                &mut warnings,
            )
            .unwrap();
        assert!(
            session.applied.hw_rate >= 1_000_000.0,
            "picked {} S/s, below what a HackRF can do",
            session.applied.hw_rate
        );
        assert!(session.applied.decim > 1);
        assert!((session.applied.out_rate - 300_000.0).abs() < 1.0);
        assert!(warnings.is_empty(), "should not need to warn: {warnings:?}");

        // Rates whose factor is not a round number. 250 kS/s needs 4 and
        // 333.333 kS/s needs 3; a hand-picked factor list missed the second and
        // silently returned 1 MS/s instead.
        for (asked, expect_decim) in [(250_000.0, 4u32), (333_333.0, 3), (400_000.0, 5)] {
            let mut session = Session::new();
            session
                .plan_rates(
                    &ConfigureRequest {
                        rate: Some(asked),
                        ..Default::default()
                    },
                    &info,
                    &mut Vec::new(),
                )
                .unwrap();
            assert_eq!(
                session.applied.decim, expect_decim,
                "asked {asked} S/s, got decim {} at {} S/s",
                session.applied.decim, session.applied.hw_rate
            );
            assert!((session.applied.out_rate - asked).abs() < 1.0);
        }

        // A rate it can reach directly needs no decimation.
        let mut session = Session::new();
        session
            .plan_rates(
                &ConfigureRequest {
                    rate: Some(8_000_000.0),
                    ..Default::default()
                },
                &info,
                &mut Vec::new(),
            )
            .unwrap();
        assert_eq!(session.applied.decim, 1);
        assert_eq!(session.applied.hw_rate, 8_000_000.0);
    }

    #[test]
    fn configure_before_open_is_a_clear_error_not_a_panic() {
        let mut session = Session::new();
        let error = session
            .configure(&ConfigureRequest::default())
            .unwrap_err()
            .to_string();
        assert!(error.contains("no radio is open"), "unexpected: {error}");
    }

    #[test]
    fn every_configure_advances_the_epoch_so_frames_can_be_attributed() {
        let mut session = opened_fake();
        session
            .configure(&ConfigureRequest {
                rate: Some(1_000_000.0),
                ..Default::default()
            })
            .unwrap();
        let first = session.epoch();
        session
            .configure(&ConfigureRequest {
                freq: Some(101e6),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(session.epoch(), first + 1);
    }

    #[test]
    fn warns_rather_than_fails_when_a_capability_is_missing() {
        let mut session = opened_fake();
        let message = session
            .configure(&ConfigureRequest {
                rate: Some(1_000_000.0),
                bandwidth: Some(200_000.0),
                ..Default::default()
            })
            .unwrap();
        match message {
            ServerMsg::Config { applied, .. } => {
                assert!(
                    applied.warnings.iter().any(|w| w.contains("bandwidth")),
                    "expected a bandwidth warning, got {:?}",
                    applied.warnings
                );
            }
            other => panic!("expected a config event, got {other:?}"),
        }
    }

    /// Per-stage gains asked for before the stream starts must survive to be
    /// applied. They used to be validated, reported as accepted, and then
    /// dropped on the floor -- the radio never saw them, and nothing said so.
    #[test]
    fn per_stage_gains_survive_until_the_stream_starts() {
        let mut session = opened_fake();
        let mut gains = std::collections::BTreeMap::new();
        gains.insert("TUNER".to_string(), 21.0);
        session
            .configure(&ConfigureRequest {
                rate: Some(500_000.0),
                gains: Some(gains),
                ..Default::default()
            })
            .unwrap();
        assert_eq!(session.applied().gains.get("TUNER"), Some(&21.0));
        // And an element the radio does not have is still refused rather than
        // remembered.
        let mut bogus = std::collections::BTreeMap::new();
        bogus.insert("NOPE".to_string(), 5.0);
        session
            .configure(&ConfigureRequest {
                gains: Some(bogus),
                ..Default::default()
            })
            .unwrap();
        assert!(!session.applied().gains.contains_key("NOPE"));
    }

    #[test]
    fn start_without_a_rate_explains_itself() {
        let mut session = opened_fake();
        let error = session.start().unwrap_err().to_string();
        assert!(error.contains("configure"), "unexpected: {error}");
    }

    #[test]
    fn a_configured_fake_actually_streams_frames() {
        let mut session = opened_fake();
        session
            .configure(&ConfigureRequest {
                rate: Some(500_000.0),
                freq: Some(100e6),
                ..Default::default()
            })
            .unwrap();
        session.start().unwrap();

        let frames = session.stream().unwrap().frames.clone();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
        while frames.is_empty() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(!frames.is_empty(), "no frames were produced");
        session.stop();
    }
}
