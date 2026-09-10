//! Decimation: a halfband cascade for the power-of-two part of the factor, then
//! one general FIR for whatever is left.
//!
//! Why not a single wideband FIR: a halfband decimator's even-offset taps are
//! all zero by construction, so it costs about half the multiplies for the same
//! stopband, and each stage after the first runs at half the rate of the one
//! before. Decimating by 8 with three halfbands costs roughly a quarter of what
//! one 8x FIR would, which is the difference between comfortable and marginal
//! for 20 MS/s on a Raspberry Pi 5.

use num_complex::Complex32;

/// Kaiser window, used to trade stopband depth against transition width.
fn kaiser(n: usize, beta: f64) -> Vec<f64> {
    fn bessel_i0(x: f64) -> f64 {
        let mut sum = 1.0;
        let mut term = 1.0;
        for k in 1..50 {
            term *= (x / 2.0 / k as f64).powi(2);
            sum += term;
            if term < sum * 1e-12 {
                break;
            }
        }
        sum
    }
    let denominator = bessel_i0(beta);
    let half = (n - 1) as f64 / 2.0;
    (0..n)
        .map(|i| {
            let ratio = (i as f64 - half) / half;
            bessel_i0(beta * (1.0 - ratio * ratio).max(0.0).sqrt()) / denominator
        })
        .collect()
}

/// Windowed-sinc lowpass. `cutoff` is in cycles per sample (0.5 is Nyquist).
fn lowpass(taps: usize, cutoff: f64, beta: f64) -> Vec<f32> {
    let window = kaiser(taps, beta);
    let center = (taps - 1) as f64 / 2.0;
    let mut coefficients: Vec<f64> = (0..taps)
        .map(|i| {
            let x = i as f64 - center;
            let sinc = if x.abs() < 1e-12 {
                2.0 * cutoff
            } else {
                (std::f64::consts::TAU * cutoff * x).sin() / (std::f64::consts::PI * x)
            };
            sinc * window[i]
        })
        .collect();
    // Normalise to unity gain at DC, so a chain of stages does not quietly
    // change the signal's amplitude.
    let sum: f64 = coefficients.iter().sum();
    if sum.abs() > 1e-12 {
        for c in coefficients.iter_mut() {
            *c /= sum;
        }
    }
    coefficients.into_iter().map(|c| c as f32).collect()
}

/// One decimating FIR stage.
///
/// Taps whose value is zero are dropped at construction, which is what makes
/// the halfband case cheap: only the centre tap and the odd offsets survive.
struct Stage {
    /// `(tap offset, coefficient)`, zeros already removed.
    sparse: Vec<(usize, f32)>,
    span: usize,
    factor: usize,
    history: Vec<Complex32>,
    /// Where the next output sits, as an index into `history ++ input`. Carried
    /// between calls so an arbitrary chunk size does not shift the phase.
    next: usize,
}

impl Stage {
    fn new(taps: Vec<f32>, factor: usize) -> Self {
        let span = taps.len();
        let sparse = taps
            .iter()
            .enumerate()
            .filter(|(_, &tap)| tap != 0.0)
            .map(|(index, &tap)| (span - 1 - index, tap))
            .collect();
        Self {
            sparse,
            span,
            factor,
            history: vec![Complex32::new(0.0, 0.0); span - 1],
            next: span - 1,
        }
    }

    fn process(&mut self, input: &[Complex32], output: &mut Vec<Complex32>) {
        let mut work = Vec::with_capacity(self.history.len() + input.len());
        work.extend_from_slice(&self.history);
        work.extend_from_slice(input);

        let mut index = self.next;
        while index < work.len() {
            let mut accumulator = Complex32::new(0.0, 0.0);
            for &(offset, tap) in &self.sparse {
                accumulator += work[index - offset] * tap;
            }
            output.push(accumulator);
            index += self.factor;
        }

        // Keep the tail that the next block needs, and rebase the cursor onto
        // it. Getting this wrong shows up as a periodic click, not as an error.
        let keep = self.span - 1;
        let start = work.len() - keep;
        self.history.clear();
        self.history.extend_from_slice(&work[start..]);
        self.next = index - start;
    }
}

pub struct Decimator {
    stages: Vec<Stage>,
    factor: u32,
    scratch: Vec<Complex32>,
}

impl Decimator {
    /// Build a decimator for `factor`. A factor of 1 is a pass-through and
    /// allocates nothing.
    pub fn new(factor: u32) -> Self {
        let mut stages = Vec::new();
        let mut remaining = factor.max(1);

        // Halfband taps: length 4k+3 puts zeros on every even offset except the
        // centre. 23 taps gives roughly -70 dB stopband with beta 7.
        while remaining % 2 == 0 && remaining > 1 {
            stages.push(Stage::new(lowpass(23, 0.25, 7.0), 2));
            remaining /= 2;
        }

        if remaining > 1 {
            // A general stage for the odd remainder. Taps scale with the factor
            // so the transition band stays proportional.
            let taps = (16 * remaining as usize + 1).min(513);
            let cutoff = 0.5 / remaining as f64;
            stages.push(Stage::new(
                lowpass(taps, cutoff * 0.9, 8.0),
                remaining as usize,
            ));
        }

        Self {
            stages,
            factor: factor.max(1),
            scratch: Vec::new(),
        }
    }

    pub fn factor(&self) -> u32 {
        self.factor
    }

    /// Decimate `input` into `output`. `output` is appended to, not replaced.
    pub fn process(&mut self, input: &[Complex32], output: &mut Vec<Complex32>) {
        if self.stages.is_empty() {
            output.extend_from_slice(input);
            return;
        }
        let last = self.stages.len() - 1;
        let mut current: Vec<Complex32> = Vec::new();
        for (index, stage) in self.stages.iter_mut().enumerate() {
            let source: &[Complex32] = if index == 0 { input } else { &current };
            if index == last {
                stage.process(source, output);
            } else {
                self.scratch.clear();
                stage.process(source, &mut self.scratch);
                current = std::mem::take(&mut self.scratch);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(freq: f64, rate: f64, n: usize) -> Vec<Complex32> {
        (0..n)
            .map(|i| {
                let phase = std::f64::consts::TAU * freq * i as f64 / rate;
                Complex32::new(phase.cos() as f32, phase.sin() as f32)
            })
            .collect()
    }

    fn rms(samples: &[Complex32]) -> f64 {
        if samples.is_empty() {
            return 0.0;
        }
        (samples.iter().map(|s| s.norm_sqr() as f64).sum::<f64>() / samples.len() as f64).sqrt()
    }

    /// Skip the filter's start-up transient before measuring.
    fn settled(samples: &[Complex32]) -> &[Complex32] {
        let skip = (samples.len() / 4).min(512);
        &samples[skip..]
    }

    #[test]
    fn passes_a_tone_inside_the_new_band() {
        let rate = 2_048_000.0;
        let input = tone(50_000.0, rate, 65536);
        let mut output = Vec::new();
        Decimator::new(8).process(&input, &mut output);
        assert_eq!(output.len(), 65536 / 8);
        let level = rms(settled(&output));
        assert!(
            (level - 1.0).abs() < 0.05,
            "in-band tone should survive at unity, got {level}"
        );
    }

    /// The point of the anti-alias filter. Without it this tone folds back into
    /// the output band and is indistinguishable from real signal.
    #[test]
    fn rejects_a_tone_that_would_alias() {
        let rate = 2_048_000.0;
        // Output band after /8 is +/-128 kHz. 500 kHz must not survive.
        let input = tone(500_000.0, rate, 65536);
        let mut output = Vec::new();
        Decimator::new(8).process(&input, &mut output);
        let level = rms(settled(&output));
        assert!(
            level < 0.01,
            "out-of-band tone should be rejected, got {level} (would alias into the passband)"
        );
    }

    #[test]
    fn an_odd_factor_uses_the_general_stage() {
        let rate = 1_200_000.0;
        let input = tone(20_000.0, rate, 48000);
        let mut output = Vec::new();
        Decimator::new(3).process(&input, &mut output);
        assert_eq!(output.len(), 48000 / 3);
        assert!((rms(settled(&output)) - 1.0).abs() < 0.1);
    }

    #[test]
    fn factor_one_is_a_pass_through() {
        let input = tone(1000.0, 48_000.0, 512);
        let mut output = Vec::new();
        Decimator::new(1).process(&input, &mut output);
        assert_eq!(output, input);
    }

    /// The chunk size the radio happens to deliver must not change the result.
    /// A stage that reset its phase per call would pass every other test here
    /// and produce a periodic click in the field.
    #[test]
    fn chunking_does_not_change_the_output() {
        let rate = 2_048_000.0;
        let input = tone(70_000.0, rate, 16384);

        let mut whole = Vec::new();
        Decimator::new(4).process(&input, &mut whole);

        let mut pieces = Vec::new();
        let mut decimator = Decimator::new(4);
        for chunk in input.chunks(333) {
            decimator.process(chunk, &mut pieces);
        }

        assert_eq!(whole.len(), pieces.len());
        for (a, b) in whole.iter().zip(pieces.iter()) {
            assert!((a - b).norm() < 1e-5, "chunked output diverged: {a} vs {b}");
        }
    }
}

#[cfg(test)]
mod cascade_tests {
    use super::*;

    /// Every input sample must produce exactly 1/factor outputs, for every
    /// factor, across many streaming calls. A cascade that loses a fraction of
    /// its samples per call still produces a correct-looking signal -- the tone
    /// is at the right frequency and the spectrum is clean -- and only shows up
    /// as a sample rate that is quietly a few percent low, which is the exact
    /// failure this whole daemon is supposed to make impossible.
    #[test]
    fn every_factor_conserves_samples_across_streaming_calls() {
        for factor in [1u32, 2, 3, 4, 5, 8, 10, 16] {
            let mut decimator = Decimator::new(factor);
            let mut output = Vec::new();
            let chunk = vec![Complex32::new(0.1, 0.1); 65536];
            let calls = 16;
            for _ in 0..calls {
                decimator.process(&chunk, &mut output);
            }
            let total_in = chunk.len() * calls;
            let expected = total_in / factor as usize;
            let produced = output.len();
            // Allow only the filter's start-up: at most one output per stage.
            let shortfall = expected.saturating_sub(produced);
            assert!(
                shortfall <= 8,
                "factor {factor}: got {produced} outputs for {total_in} inputs, expected ~{expected} (short by {shortfall})"
            );
        }
    }
}
