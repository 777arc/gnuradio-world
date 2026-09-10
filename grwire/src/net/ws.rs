//! The WebSocket half: one client, both planes, and the flow-control window.
//!
//! Frames travel:
//!
//! ```text
//! FrameQueue ──▶ pump task ──▶ outbound channel (8) ──▶ writer task ──▶ socket
//!  drop-oldest    flow window        net_drops                          TCP
//! ```
//!
//! The outbound channel is deliberately tiny. Its whole job is to make a slow
//! socket visible *here*, at a frame boundary, where the loss can be counted --
//! rather than letting frames pile into the kernel's write buffer, which is
//! bufferbloat and shows up to the user as seconds of lag on a live waterfall.

use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket};
use futures_util::{SinkExt, StreamExt};
use tokio::sync::{mpsc, Mutex};

use crate::proto::{ClientMsg, ServerMsg, FLAG_DISCONTINUITY, PROTOCOL};
use crate::queue::FrameQueue;
use crate::session::Session;
use crate::stats::Stats;

/// What the writer task can be asked to put on the wire.
enum Outbound {
    Text(String),
    Frame(Vec<u8>),
}

pub struct SocketConfig {
    pub flow_window_ms: f64,
    pub version: String,
    pub host: String,
}

pub async fn serve(socket: WebSocket, config: SocketConfig) {
    let (mut sink, mut stream) = socket.split();
    let (out_tx, mut out_rx) = mpsc::channel::<Outbound>(8);

    let writer = tokio::spawn(async move {
        while let Some(item) = out_rx.recv().await {
            let message = match item {
                Outbound::Text(text) => Message::Text(text.into()),
                Outbound::Frame(bytes) => Message::Binary(bytes.into()),
            };
            if sink.send(message).await.is_err() {
                break;
            }
        }
        let _ = sink.close().await;
    });

    let session = Arc::new(Mutex::new(Session::new()));
    let mut pump: Option<tokio::task::JoinHandle<()>> = None;
    let mut ticker: Option<tokio::task::JoinHandle<()>> = None;

    let hello = ServerMsg::Hello {
        protocol: PROTOCOL.to_string(),
        version: config.version.clone(),
        host: config.host.clone(),
        backends: crate::radio::backends(),
    };
    if send(&out_tx, &hello).await.is_err() {
        return;
    }

    while let Some(Ok(message)) = stream.next().await {
        let text = match message {
            Message::Text(text) => text.to_string(),
            Message::Binary(_) => {
                // Reserved for Tx. Refusing loudly beats accepting samples this
                // build would silently discard.
                let _ = send(
                    &out_tx,
                    &ServerMsg::Error {
                        code: "unsupported".into(),
                        message: "this build receives only; binary frames from the client are not accepted yet".into(),
                    },
                )
                .await;
                continue;
            }
            Message::Close(_) => break,
            Message::Ping(_) | Message::Pong(_) => continue,
        };

        let request: ClientMsg = match serde_json::from_str(&text) {
            Ok(request) => request,
            Err(error) => {
                let _ = send(
                    &out_tx,
                    &ServerMsg::Error {
                        code: "bad_request".into(),
                        message: format!("could not parse that message: {error}"),
                    },
                )
                .await;
                continue;
            }
        };

        let reply = handle(request, &session, &out_tx, &config, &mut pump, &mut ticker).await;

        if let Some(reply) = reply {
            if send(&out_tx, &reply).await.is_err() {
                break;
            }
        }
    }

    if let Some(pump) = pump.take() {
        pump.abort();
    }
    if let Some(ticker) = ticker.take() {
        ticker.abort();
    }
    session.lock().await.close();
    drop(out_tx);
    let _ = writer.await;
}

async fn handle(
    request: ClientMsg,
    session: &Arc<Mutex<Session>>,
    out_tx: &mpsc::Sender<Outbound>,
    config: &SocketConfig,
    pump: &mut Option<tokio::task::JoinHandle<()>>,
    ticker: &mut Option<tokio::task::JoinHandle<()>>,
) -> Option<ServerMsg> {
    match request {
        ClientMsg::Hello { .. } => None,
        ClientMsg::Ping { t } => Some(ServerMsg::Pong { t }),

        ClientMsg::List => Some(Session::list()),

        ClientMsg::Open {
            device,
            direction,
            channel,
        } => {
            let mut guard = session.lock().await;
            Some(match guard.open(&device, &direction, channel) {
                Ok(message) => message,
                Err(error) => error_event("open_failed", error),
            })
        }

        ClientMsg::Configure(request) => {
            let mut guard = session.lock().await;
            Some(match guard.configure(&request) {
                Ok(message) => message,
                Err(error) => error_event("configure_failed", error),
            })
        }

        ClientMsg::Start => {
            let mut guard = session.lock().await;
            if let Err(error) = guard.start() {
                return Some(error_event("start_failed", error));
            }
            let stream = guard.stream().expect("a started session has a stream");
            let frames = stream.frames.clone();
            let stats = stream.stats.clone();
            let ack_seq = guard.ack_seq.clone();
            let flow_seen = guard.flow_seen.clone();
            let window = window_frames(
                guard.applied().out_rate,
                guard.applied().frame_samples,
                config.flow_window_ms,
            );

            *pump = Some(tokio::spawn(pump_frames(
                frames,
                stats,
                ack_seq,
                flow_seen,
                window,
                out_tx.clone(),
            )));
            *ticker = Some(tokio::spawn(report_stats(session.clone(), out_tx.clone())));

            Some(ServerMsg::Config {
                epoch: guard.epoch(),
                applied: Box::new(guard.applied().clone()),
            })
        }

        ClientMsg::Stop => {
            if let Some(pump) = pump.take() {
                pump.abort();
            }
            if let Some(ticker) = ticker.take() {
                ticker.abort();
            }
            session.lock().await.stop();
            None
        }

        ClientMsg::Flow { ack_seq, ring_used } => {
            let guard = session.lock().await;
            // The first flow message is what arms the window. A client that
            // never sends one -- the throughput probe, a hand-written test --
            // must not be throttled to a stop by a scheme it does not implement.
            guard.flow_seen.store(true, Ordering::Release);
            guard.ack_seq.fetch_max(ack_seq, Ordering::AcqRel);
            *guard.client_ring_used.lock().unwrap() = ring_used;
            None
        }
    }
}

fn error_event(code: &str, error: anyhow::Error) -> ServerMsg {
    ServerMsg::Error {
        code: code.to_string(),
        message: format!("{error:#}"),
    }
}

/// How many frames the daemon may run ahead of the client's acknowledgements.
fn window_frames(out_rate: f64, frame_samples: usize, window_ms: f64) -> u64 {
    if out_rate <= 0.0 || frame_samples == 0 {
        return 16;
    }
    let frame_ms = frame_samples as f64 / out_rate * 1000.0;
    ((window_ms / frame_ms).ceil() as u64).clamp(2, 4096)
}

async fn pump_frames(
    frames: Arc<FrameQueue>,
    stats: Arc<Stats>,
    ack_seq: Arc<std::sync::atomic::AtomicU64>,
    flow_seen: Arc<std::sync::atomic::AtomicBool>,
    window: u64,
    out_tx: mpsc::Sender<Outbound>,
) {
    // Set on the next frame actually sent after any drop, wherever it happened,
    // so the client can tell a gap from a slow link.
    let mut carry_discontinuity = false;

    while let Some(frame) = frames.pop().await {
        let sent = Stats::get(&stats.frames_sent);
        let acked = ack_seq.load(Ordering::Acquire);

        if flow_seen.load(Ordering::Acquire) && sent.saturating_sub(acked) > window {
            // TCP cannot reveal this: the browser's receive buffer will happily
            // absorb frames that JavaScript never drains. Only the client's own
            // acknowledgements can, which is why the window exists.
            Stats::bump(&stats.client_drops, 1);
            Stats::bump(&stats.dropped_samples, frame.samples as u64);
            carry_discontinuity = true;
            continue;
        }

        let mut bytes = frame.bytes;
        if carry_discontinuity {
            // Patch the flag in place rather than re-serialising the header.
            let flags = u16::from_le_bytes([bytes[6], bytes[7]]) | FLAG_DISCONTINUITY;
            bytes[6..8].copy_from_slice(&flags.to_le_bytes());
            carry_discontinuity = false;
        }

        let length = bytes.len() as u64;
        match out_tx.try_send(Outbound::Frame(bytes)) {
            Ok(()) => {
                Stats::bump(&stats.frames_sent, 1);
                Stats::bump(&stats.samples_sent, frame.samples as u64);
                Stats::bump(&stats.bytes_sent, length);
            }
            Err(mpsc::error::TrySendError::Full(_)) => {
                // The socket itself is behind. Drop here, at a frame boundary,
                // where it can be counted -- never queue it deeper.
                Stats::bump(&stats.net_drops, 1);
                Stats::bump(&stats.dropped_samples, frame.samples as u64);
                carry_discontinuity = true;
            }
            Err(mpsc::error::TrySendError::Closed(_)) => break,
        }
    }
}

async fn report_stats(session: Arc<Mutex<Session>>, out_tx: mpsc::Sender<Outbound>) {
    let mut interval = tokio::time::interval(Duration::from_millis(500));
    loop {
        interval.tick().await;
        let (report, failure) = {
            let guard = session.lock().await;
            (
                guard.stats_report(),
                guard.stream().and_then(|stream| stream.error()),
            )
        };
        if let Some(message) = failure {
            // A radio unplugged mid-run must arrive as words, not as a stream
            // that merely stops.
            let _ = send(
                &out_tx,
                &ServerMsg::Error {
                    code: "stream_failed".into(),
                    message,
                },
            )
            .await;
            return;
        }
        let Some(report) = report else { return };
        if send(&out_tx, &ServerMsg::Stats(Box::new(report)))
            .await
            .is_err()
        {
            return;
        }
    }
}

async fn send(out_tx: &mpsc::Sender<Outbound>, message: &ServerMsg) -> Result<(), ()> {
    let text = serde_json::to_string(message).map_err(|_| ())?;
    out_tx.send(Outbound::Text(text)).await.map_err(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_window_is_measured_in_time_not_frames() {
        // 15 ms frames, 250 ms of slack -> about 17 frames.
        let window = window_frames(2_048_000.0, 30_720, 250.0);
        assert!((16..=18).contains(&window), "unexpected window {window}");

        // A slow stream has longer frames, so the same 250 ms is fewer of them.
        let slow = window_frames(48_000.0, 720, 250.0);
        assert!((16..=18).contains(&slow), "unexpected window {slow}");
    }

    #[test]
    fn the_window_never_collapses_to_zero() {
        // A pathological frame size must not stall the stream outright.
        assert!(window_frames(1_000_000.0, 1_000_000, 1.0) >= 2);
        assert_eq!(window_frames(0.0, 0, 250.0), 16);
    }
}
