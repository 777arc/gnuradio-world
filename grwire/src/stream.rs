//! The sample path, and the two threads that carry it.
//!
//! ```text
//! radio.read() ─▶ [pool, bounded] ─▶ DSP thread ─▶ [FrameQueue, drop-oldest] ─▶ writer task
//!   dev_overruns        host_drops     ddc+decim+pack        net_drops            client_drops
//! ```
//!
//! Neither thread is a tokio task. `read()` blocks, the DSP is CPU-bound, and
//! putting either on the async runtime would stall every other connection's
//! timers. The only thing that crosses into async is the frame queue.
//!
//! The reader owns the radio, so live retunes travel to it as messages rather
//! than through a lock -- the same shape as the command mailbox the RTL-SDR
//! block uses to reach its worker.

use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;

use crossbeam_channel::{bounded, Receiver, Sender, TrySendError};
use num_complex::Complex32;

use crate::dsp::{pack, Ddc, Decimator};
use crate::proto::{Format, FrameHeader, FLAG_DISCONTINUITY, FRAME_RX_IQ, HEADER_BYTES};
use crate::queue::{Frame, FrameQueue};
use crate::radio::{Radio, ReadError};
use crate::stats::Stats;

/// How much buffering sits between the radio and the DSP. Half a second is the
/// same figure the RTL-SDR block uses for its ring, for the same reason: deeper
/// only delays the moment losses start, shallower loses on any scheduler hiccup.
const READER_QUEUE_SECONDS: f64 = 0.5;
/// How much sits between the DSP and the socket, as a multiple of the frame
/// duration. Bounded latency matters more than depth here.
const WRITER_QUEUE_FRAMES: usize = 24;

#[derive(Debug, Clone)]
pub enum RadioCommand {
    Frequency(f64),
    Gain(f64),
    GainElement(String, f64),
    Agc(bool),
    Antenna(String),
    Bandwidth(f64),
}

#[derive(Debug, Clone)]
pub enum DspCommand {
    Offset(f64),
}

pub struct StreamConfig {
    pub hw_rate: f64,
    pub decim: u32,
    pub offset: f64,
    pub format: Format,
    pub frame_samples: usize,
}

/// A running stream. Dropping it stops both threads.
pub struct Stream {
    pub frames: Arc<FrameQueue>,
    pub stats: Arc<Stats>,
    pub epoch: Arc<AtomicU32>,
    radio_tx: Sender<RadioCommand>,
    dsp_tx: Sender<DspCommand>,
    stop: Arc<AtomicBool>,
    error: Arc<Mutex<Option<String>>>,
    threads: Vec<JoinHandle<()>>,
}

impl Stream {
    pub fn retune(&self, command: RadioCommand) {
        let _ = self.radio_tx.send(command);
    }

    pub fn set_offset(&self, offset_hz: f64) {
        let _ = self.dsp_tx.send(DspCommand::Offset(offset_hz));
    }

    pub fn bump_epoch(&self) -> u32 {
        self.epoch.fetch_add(1, Ordering::AcqRel) + 1
    }

    /// The fatal error that ended the stream, if one did. A radio unplugged
    /// mid-run must surface as a readable message, not as a stream that simply
    /// stops producing.
    pub fn error(&self) -> Option<String> {
        self.error.lock().unwrap().clone()
    }

    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Release);
        self.frames.close();
        for handle in self.threads.drain(..) {
            let _ = handle.join();
        }
    }
}

impl Drop for Stream {
    fn drop(&mut self) {
        self.stop();
    }
}

/// Start streaming. `radio` is moved onto the reader thread and stays there.
pub fn start(
    mut radio: Box<dyn Radio>,
    config: StreamConfig,
    epoch: u32,
) -> anyhow::Result<Stream> {
    radio.activate()?;

    let stats = Arc::new(Stats::default());
    let frames = Arc::new(FrameQueue::new(WRITER_QUEUE_FRAMES));
    let epoch = Arc::new(AtomicU32::new(epoch));
    let stop = Arc::new(AtomicBool::new(false));
    let error: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));

    let read_chunk = radio.mtu().clamp(1024, 262_144);
    let queue_depth = ((config.hw_rate * READER_QUEUE_SECONDS) / read_chunk as f64)
        .ceil()
        .clamp(4.0, 512.0) as usize;

    let (samples_tx, samples_rx) = bounded::<Vec<Complex32>>(queue_depth);
    // Buffers cycle: the DSP hands each one back rather than freeing it, so the
    // steady state allocates nothing.
    let (pool_tx, pool_rx) = bounded::<Vec<Complex32>>(queue_depth + 4);
    let (radio_tx, radio_rx) = bounded::<RadioCommand>(64);
    let (dsp_tx, dsp_rx) = bounded::<DspCommand>(64);

    // Input samples the reader threw away, so the DSP can advance the absolute
    // sample index across the gap instead of pretending the stream is
    // continuous.
    let dropped_input = Arc::new(AtomicU64::new(0));

    let reader = std::thread::Builder::new()
        .name("grwire-reader".into())
        .spawn({
            let stats = stats.clone();
            let stop = stop.clone();
            let error = error.clone();
            let dropped_input = dropped_input.clone();
            move || {
                reader_thread(
                    &mut *radio,
                    read_chunk,
                    &samples_tx,
                    &pool_rx,
                    &radio_rx,
                    &stats,
                    &stop,
                    &error,
                    &dropped_input,
                );
                let _ = radio.deactivate();
            }
        })?;

    let dsp = std::thread::Builder::new()
        .name("grwire-dsp".into())
        .spawn({
            let stats = stats.clone();
            let frames = frames.clone();
            let epoch = epoch.clone();
            let stop = stop.clone();
            let dropped_input = dropped_input.clone();
            move || {
                dsp_thread(
                    config,
                    &samples_rx,
                    &pool_tx,
                    &dsp_rx,
                    &frames,
                    &stats,
                    &epoch,
                    &stop,
                    &dropped_input,
                );
                frames.close();
            }
        })?;

    Ok(Stream {
        frames,
        stats,
        epoch,
        radio_tx,
        dsp_tx,
        stop,
        error,
        threads: vec![reader, dsp],
    })
}

#[allow(clippy::too_many_arguments)]
fn reader_thread(
    radio: &mut dyn Radio,
    chunk: usize,
    samples_tx: &Sender<Vec<Complex32>>,
    pool_rx: &Receiver<Vec<Complex32>>,
    commands: &Receiver<RadioCommand>,
    stats: &Stats,
    stop: &AtomicBool,
    error: &Mutex<Option<String>>,
    dropped_input: &AtomicU64,
) {
    while !stop.load(Ordering::Acquire) {
        // Retunes are applied between reads, never during one.
        while let Ok(command) = commands.try_recv() {
            let outcome = match command {
                RadioCommand::Frequency(hz) => radio.set_frequency(hz).map(|_| ()),
                RadioCommand::Gain(db) => radio.set_gain(db),
                RadioCommand::GainElement(name, db) => radio.set_gain_element(&name, db),
                RadioCommand::Agc(on) => radio.set_agc(on),
                RadioCommand::Antenna(name) => radio.set_antenna(&name),
                RadioCommand::Bandwidth(hz) => radio.set_bandwidth(hz),
            };
            if let Err(failure) = outcome {
                // A retune that fails is worth saying out loud, but it is not a
                // reason to tear down a working stream.
                tracing::warn!("retune failed: {failure}");
            }
        }

        let mut buffer = pool_rx
            .try_recv()
            .unwrap_or_else(|_| Vec::with_capacity(chunk));
        buffer.resize(chunk, Complex32::new(0.0, 0.0));

        match radio.read(&mut buffer, 200_000) {
            Ok(0) => continue,
            Ok(count) => {
                buffer.truncate(count);
                match samples_tx.try_send(buffer) {
                    Ok(()) => {}
                    Err(TrySendError::Full(dropped)) => {
                        // We could not keep up with the radio. Drop and count:
                        // blocking here would only push the overflow down into
                        // the device's own FIFO, where nothing reports it.
                        Stats::bump(&stats.host_drops, 1);
                        dropped_input.fetch_add(dropped.len() as u64, Ordering::Relaxed);
                        // The buffer is simply freed; the pool refills from the
                        // DSP side, which is the only place that can return one.
                    }
                    Err(TrySendError::Disconnected(_)) => break,
                }
            }
            Err(ReadError::Overrun) => {
                // The radio's own buffer overflowed. Its samples are already
                // gone; this is not our loss and is counted separately.
                Stats::bump(&stats.dev_overruns, 1);
            }
            Err(ReadError::Timeout) => {}
            Err(ReadError::Fatal(message)) => {
                *error.lock().unwrap() = Some(message);
                break;
            }
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn dsp_thread(
    config: StreamConfig,
    samples_rx: &Receiver<Vec<Complex32>>,
    pool_tx: &Sender<Vec<Complex32>>,
    commands: &Receiver<DspCommand>,
    frames: &FrameQueue,
    stats: &Stats,
    epoch: &AtomicU32,
    stop: &AtomicBool,
    dropped_input: &AtomicU64,
) {
    let mut ddc = Ddc::new(config.offset, config.hw_rate);
    let mut decimator = Decimator::new(config.decim);
    let format = config.format;
    let frame_samples = config.frame_samples.max(1);

    let mut decimated: Vec<Complex32> = Vec::with_capacity(frame_samples * 2);
    let mut sample_index: u64 = 0;
    let mut seen_dropped_input: u64 = 0;
    let mut pending_discontinuity = false;
    let mut seq: u64 = 0;

    while !stop.load(Ordering::Acquire) {
        while let Ok(DspCommand::Offset(offset)) = commands.try_recv() {
            ddc.set_offset(offset, config.hw_rate);
        }

        let mut buffer = match samples_rx.recv_timeout(std::time::Duration::from_millis(200)) {
            Ok(buffer) => buffer,
            Err(crossbeam_channel::RecvTimeoutError::Timeout) => continue,
            Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
        };

        // A gap upstream means the samples about to be processed are not
        // contiguous with the last ones. Say so, and skip the index forward by
        // as much as was lost, so the client can measure the hole.
        let dropped_now = dropped_input.load(Ordering::Relaxed);
        if dropped_now > seen_dropped_input {
            let lost_input = dropped_now - seen_dropped_input;
            seen_dropped_input = dropped_now;
            let lost_output = lost_input / config.decim.max(1) as u64;
            sample_index += lost_output;
            Stats::bump(&stats.dropped_samples, lost_output);
            pending_discontinuity = true;
        }

        ddc.process(&mut buffer);
        decimator.process(&buffer, &mut decimated);
        buffer.clear();
        let _ = pool_tx.try_send(buffer);

        while decimated.len() >= frame_samples {
            let chunk: Vec<Complex32> = decimated.drain(..frame_samples).collect();
            let mut bytes =
                Vec::with_capacity(HEADER_BYTES + chunk.len() * format.bytes_per_sample());
            bytes.resize(HEADER_BYTES, 0);
            let header = FrameHeader {
                kind: FRAME_RX_IQ,
                format: format.code(),
                flags: if pending_discontinuity {
                    FLAG_DISCONTINUITY
                } else {
                    0
                },
                epoch: epoch.load(Ordering::Acquire),
                sample_count: chunk.len() as u32,
                seq,
                sample_index,
            };
            header.write_to(&mut bytes);
            pack(&chunk, format, &mut bytes);

            pending_discontinuity = false;
            seq += 1;
            sample_index += chunk.len() as u64;

            if let Some(displaced) = frames.push(Frame {
                bytes,
                samples: chunk.len() as u32,
            }) {
                // The socket is not keeping up. The displaced frame is the
                // oldest, so latency stays bounded rather than growing.
                Stats::bump(&stats.net_drops, 1);
                Stats::bump(&stats.dropped_samples, displaced.samples as u64);
                pending_discontinuity = true;
            }
        }
    }
}

/// Frame size in samples for a target latency, clamped to sane byte sizes.
///
/// Time-bounded rather than byte-bounded on purpose: a fixed 64 KB frame is
/// 13 ms at 2.4 MS/s but 131 ms at 250 kS/s, and the second one is felt as lag.
pub fn frame_samples_for(out_rate: f64, format: Format, target_ms: f64) -> usize {
    let by_time = (out_rate * target_ms / 1000.0).round().max(1.0) as usize;
    let bytes = format.bytes_per_sample();
    let min_samples = (4096 / bytes).max(1);
    let max_samples = (262_144 / bytes).max(1);
    by_time.clamp(min_samples, max_samples)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn frame_size_tracks_time_not_bytes() {
        // ~15 ms at each rate, which is the point: a fixed byte size would be
        // an order of magnitude out at one end or the other.
        let fast = frame_samples_for(2_400_000.0, Format::Ci8, 15.0);
        let slow = frame_samples_for(250_000.0, Format::Ci8, 15.0);
        assert!((fast as f64 / 2_400_000.0 * 1000.0 - 15.0).abs() < 1.0);
        assert!((slow as f64 / 250_000.0 * 1000.0 - 15.0).abs() < 1.0);
        assert!(fast > slow);
    }

    #[test]
    fn frame_size_stays_within_the_byte_clamps() {
        let huge = frame_samples_for(50_000_000.0, Format::Cf32, 15.0);
        assert!(huge * 8 <= 262_144);
        let tiny = frame_samples_for(100.0, Format::Ci8, 15.0);
        assert!(tiny * 2 >= 4096);
    }
}
