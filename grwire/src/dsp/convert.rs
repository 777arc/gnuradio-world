//! Packing complex float samples into the wire formats.
//!
//! `ci8` is the default and the interesting one: an RTL-SDR and a HackRF are
//! both 8-bit radios, so it is lossless for them at half the bytes of `ci16`.
//! The browser's `work()` inverts exactly these scalings -- see
//! `blocks/src/grwire_source.cpp`, which divides by the same constants.

use num_complex::Complex32;

use crate::proto::Format;

/// Encode with 127 and decode with 127, so a full-scale sample round-trips to
/// itself instead of to 127/128 of itself.
const I8_SCALE: f32 = 127.0;
const I16_SCALE: f32 = 32767.0;

/// Append `samples` to `out` in `format`.
pub fn pack(samples: &[Complex32], format: Format, out: &mut Vec<u8>) {
    out.reserve(samples.len() * format.bytes_per_sample());
    match format {
        Format::Ci8 => {
            for sample in samples {
                out.push(quantize_i8(sample.re) as u8);
                out.push(quantize_i8(sample.im) as u8);
            }
        }
        Format::Ci16 => {
            for sample in samples {
                out.extend_from_slice(&quantize_i16(sample.re).to_le_bytes());
                out.extend_from_slice(&quantize_i16(sample.im).to_le_bytes());
            }
        }
        Format::Cf32 => {
            for sample in samples {
                out.extend_from_slice(&sample.re.to_le_bytes());
                out.extend_from_slice(&sample.im.to_le_bytes());
            }
        }
    }
}

/// Clamping, not wrapping. A sample that overflows should saturate like an ADC,
/// not wrap to the opposite rail and appear as an impulse.
fn quantize_i8(value: f32) -> i8 {
    (value * I8_SCALE).round().clamp(-127.0, 127.0) as i8
}

fn quantize_i16(value: f32) -> i16 {
    (value * I16_SCALE).round().clamp(-32767.0, 32767.0) as i16
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ci8_is_two_bytes_a_sample_and_round_trips() {
        let samples = vec![
            Complex32::new(1.0, -1.0),
            Complex32::new(0.0, 0.0),
            Complex32::new(0.5, -0.25),
        ];
        let mut out = Vec::new();
        pack(&samples, Format::Ci8, &mut out);
        assert_eq!(out.len(), samples.len() * 2);

        let decoded: Vec<Complex32> = out
            .chunks_exact(2)
            .map(|pair| {
                Complex32::new(
                    pair[0] as i8 as f32 / I8_SCALE,
                    pair[1] as i8 as f32 / I8_SCALE,
                )
            })
            .collect();
        for (original, decoded) in samples.iter().zip(decoded.iter()) {
            assert!((original - decoded).norm() < 1.0 / I8_SCALE);
        }
    }

    #[test]
    fn saturates_rather_than_wrapping() {
        // A wrapped overflow would read as a full-scale spike of the opposite
        // sign, which looks exactly like a real impulse in a waterfall.
        let mut out = Vec::new();
        pack(&[Complex32::new(4.0, -4.0)], Format::Ci8, &mut out);
        assert_eq!(out[0] as i8, 127);
        assert_eq!(out[1] as i8, -127);

        let mut out16 = Vec::new();
        pack(&[Complex32::new(4.0, -4.0)], Format::Ci16, &mut out16);
        assert_eq!(i16::from_le_bytes([out16[0], out16[1]]), 32767);
        assert_eq!(i16::from_le_bytes([out16[2], out16[3]]), -32767);
    }

    #[test]
    fn every_format_reports_its_own_width() {
        let samples = vec![Complex32::new(0.25, 0.25); 8];
        for format in [Format::Ci8, Format::Ci16, Format::Cf32] {
            let mut out = Vec::new();
            pack(&samples, format, &mut out);
            assert_eq!(out.len(), samples.len() * format.bytes_per_sample());
        }
    }

    #[test]
    fn cf32_is_native_little_endian_floats() {
        let mut out = Vec::new();
        pack(&[Complex32::new(0.5, -0.5)], Format::Cf32, &mut out);
        assert_eq!(f32::from_le_bytes(out[0..4].try_into().unwrap()), 0.5);
        assert_eq!(f32::from_le_bytes(out[4..8].try_into().unwrap()), -0.5);
    }
}
