//! Per-layer loss accounting.
//!
//! The rule this whole daemon follows is that a dropped sample is reported at
//! the layer that dropped it. "Some samples went missing" is not a diagnosis;
//! "the network could not keep up" and "the browser stopped draining" lead to
//! opposite fixes, and the user is the only one who can apply either.

use std::sync::atomic::{AtomicU64, Ordering};

#[derive(Debug, Default)]
pub struct Stats {
    pub samples_sent: AtomicU64,
    pub frames_sent: AtomicU64,
    pub bytes_sent: AtomicU64,
    /// The radio's own overruns: it lost these before we saw them.
    pub dev_overruns: AtomicU64,
    /// The reader queue was full -- this host could not keep up with the radio.
    pub host_drops: AtomicU64,
    /// The writer queue was full -- the socket could not keep up with us.
    pub net_drops: AtomicU64,
    /// The client stopped acknowledging -- it is not draining fast enough.
    pub client_drops: AtomicU64,
    /// Output samples lost to any of the above.
    pub dropped_samples: AtomicU64,
}

impl Stats {
    pub fn bump(counter: &AtomicU64, by: u64) {
        counter.fetch_add(by, Ordering::Relaxed);
    }

    pub fn get(counter: &AtomicU64) -> u64 {
        counter.load(Ordering::Relaxed)
    }

    /// The single number a user actually asks for: what fraction of the stream
    /// never made it. Kept here so every caller computes it the same way.
    pub fn loss_fraction(&self) -> f64 {
        let sent = Self::get(&self.samples_sent);
        let lost = Self::get(&self.dropped_samples);
        let total = sent + lost;
        if total == 0 {
            0.0
        } else {
            lost as f64 / total as f64
        }
    }

    /// Which layer is responsible for most of the loss, in words. Empty when
    /// nothing has been lost.
    pub fn bottleneck(&self) -> Option<&'static str> {
        let candidates = [
            (
                Self::get(&self.dev_overruns),
                "the radio (its own buffer overflowed)",
            ),
            (
                Self::get(&self.host_drops),
                "this host (the CPU could not keep up)",
            ),
            (
                Self::get(&self.net_drops),
                "the network (the socket could not keep up)",
            ),
            (
                Self::get(&self.client_drops),
                "the browser (it stopped draining)",
            ),
        ];
        candidates
            .into_iter()
            .filter(|(count, _)| *count > 0)
            .max_by_key(|(count, _)| *count)
            .map(|(_, name)| name)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_worst_layer_not_merely_a_failing_one() {
        let stats = Stats::default();
        Stats::bump(&stats.net_drops, 3);
        Stats::bump(&stats.client_drops, 40);
        assert_eq!(
            stats.bottleneck(),
            Some("the browser (it stopped draining)")
        );
    }

    #[test]
    fn silent_when_nothing_was_lost() {
        let stats = Stats::default();
        Stats::bump(&stats.samples_sent, 1_000_000);
        assert_eq!(stats.bottleneck(), None);
        assert_eq!(stats.loss_fraction(), 0.0);
    }

    #[test]
    fn loss_fraction_is_of_the_whole_stream() {
        let stats = Stats::default();
        Stats::bump(&stats.samples_sent, 750);
        Stats::bump(&stats.dropped_samples, 250);
        assert!((stats.loss_fraction() - 0.25).abs() < 1e-9);
    }
}
