//! Digital down-conversion: a numerically controlled oscillator that shifts a
//! signal within the captured band before decimation.
//!
//! This is what lets a client fine-tune without retuning the hardware. A
//! hardware retune walks the tuner PLL and costs a visible glitch in the
//! waterfall (see docs/rtlsdr.md, where the RTL2832U must have its streaming
//! stopped across the write); an offset change costs nothing and is
//! sample-accurate.

use num_complex::Complex32;

pub struct Ddc {
    /// Radians per sample. Kept in f64 because an f32 accumulator visibly
    /// drifts in phase over a few seconds at megasample rates.
    step: f64,
    phase: f64,
    offset_hz: f64,
    rate: f64,
}

impl Ddc {
    pub fn new(offset_hz: f64, rate: f64) -> Self {
        let mut ddc = Self {
            step: 0.0,
            phase: 0.0,
            offset_hz: 0.0,
            rate,
        };
        ddc.set_offset(offset_hz, rate);
        ddc
    }

    pub fn set_offset(&mut self, offset_hz: f64, rate: f64) {
        self.offset_hz = offset_hz;
        self.rate = rate;
        // Negative: shifting the band so that `offset_hz` lands at DC is a
        // mix by -offset.
        self.step = if rate > 0.0 {
            -std::f64::consts::TAU * offset_hz / rate
        } else {
            0.0
        };
    }

    pub fn offset_hz(&self) -> f64 {
        self.offset_hz
    }

    /// True when the mixer would be a no-op, which is the common case and worth
    /// skipping outright rather than multiplying by 1.
    pub fn is_bypass(&self) -> bool {
        self.offset_hz == 0.0
    }

    pub fn process(&mut self, samples: &mut [Complex32]) {
        if self.is_bypass() {
            return;
        }
        for sample in samples.iter_mut() {
            let (sin, cos) = self.phase.sin_cos();
            let rotation = Complex32::new(cos as f32, sin as f32);
            *sample *= rotation;
            self.phase += self.step;
            // Wrap every sample rather than letting the accumulator grow: at
            // 20 MS/s an unwrapped f64 phase loses precision within minutes.
            if self.phase > std::f64::consts::PI {
                self.phase -= std::f64::consts::TAU;
            } else if self.phase < -std::f64::consts::PI {
                self.phase += std::f64::consts::TAU;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Returns the frequency, in Hz, of the strongest component of `samples`,
    /// found by a plain DFT over a coarse grid then refined. Small and exact
    /// enough for a test; nothing in the daemon needs an FFT.
    fn dominant_frequency(samples: &[Complex32], rate: f64) -> f64 {
        let n = samples.len();
        let mut best = (0.0f64, f64::NEG_INFINITY);
        for bin in 0..n {
            let f = bin as f64 * rate / n as f64;
            let f = if f > rate / 2.0 { f - rate } else { f };
            let mut acc = Complex32::new(0.0, 0.0);
            for (i, sample) in samples.iter().enumerate() {
                let angle = -std::f64::consts::TAU * bin as f64 * i as f64 / n as f64;
                acc += sample * Complex32::new(angle.cos() as f32, angle.sin() as f32);
            }
            let power = acc.norm_sqr() as f64;
            if power > best.1 {
                best = (f, power);
            }
        }
        best.0
    }

    fn tone(freq: f64, rate: f64, n: usize) -> Vec<Complex32> {
        (0..n)
            .map(|i| {
                let phase = std::f64::consts::TAU * freq * i as f64 / rate;
                Complex32::new(phase.cos() as f32, phase.sin() as f32)
            })
            .collect()
    }

    #[test]
    fn shifts_a_tone_to_dc() {
        let rate = 1_000_000.0;
        let mut samples = tone(100_000.0, rate, 256);
        let mut ddc = Ddc::new(100_000.0, rate);
        ddc.process(&mut samples);
        let found = dominant_frequency(&samples, rate);
        assert!(found.abs() < 5_000.0, "expected DC, found {found} Hz");
    }

    #[test]
    fn a_zero_offset_changes_nothing() {
        let rate = 1_000_000.0;
        let original = tone(123_000.0, rate, 64);
        let mut samples = original.clone();
        Ddc::new(0.0, rate).process(&mut samples);
        assert_eq!(samples, original);
    }
}
