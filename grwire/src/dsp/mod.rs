//! The signal path between the radio and the socket: mix, decimate, pack.
//!
//! Decimation is the whole reason this daemon exists. A HackRF at 20 MS/s is
//! 320 Mbit/s as ci8 and unusable over WiFi; decimated by 8 it is 40 Mbit/s and
//! ordinary. See docs/grwire.md.

pub mod convert;
pub mod ddc;
pub mod decim;

pub use convert::pack;
pub use ddc::Ddc;
pub use decim::Decimator;
