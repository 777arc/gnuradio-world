//! GRWire: a remote SDR bridge for GNU Radio World.
//!
//! A browser cannot open a raw socket, so a radio on another machine is
//! unreachable from a tab no matter what protocol it speaks. This daemon is the
//! shim: SoapySDR (through seify) downward, one WebSocket upward, with the
//! tuning, decimation and honest loss accounting in between.
//!
//! See docs/grwire.md for the protocol and the backpressure design.

pub mod config;
pub mod dsp;
pub mod net;
pub mod proto;
pub mod queue;
pub mod radio;
pub mod session;
pub mod stats;
pub mod stream;
