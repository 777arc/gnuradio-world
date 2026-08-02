// Copyright (c) 2022 Microsoft Corporation
// Copyright (c) 2023 Marc Lichtman
// Licensed under the MIT License

import { dataTypeIsComplex } from './selector';

// Upstream has two more processing stages here: a user-supplied FIR filter and a
// Python snippet run through Pyodide. Neither is part of this port, so squaring
// is all that is applied.
export function applyProcessing(samples, squareSignal) {
  if (squareSignal) {
    for (let i = 0; i < samples.length; i++) samples[i] = samples[i] * samples[i];
  }
  return samples;
}

// How one stored component is read and normalized to roughly -1..1, keyed by the
// <f|i|u><bits> half of a SigMF datatype. The real/complex half says how many of
// these make up a sample, and is handled by convertToFloat32 below.
const COMPONENT_READERS: Record<string, { view: (buffer) => any; zero: number; full: number }> = {
  i8: { view: (buffer) => new Int8Array(buffer), zero: 0, full: 127.0 },
  u8: { view: (buffer) => new Uint8Array(buffer), zero: 127.0, full: 127.0 },
  i16: { view: (buffer) => new Int16Array(buffer), zero: 0, full: 32767.0 },
  u16: { view: (buffer) => new Uint16Array(buffer), zero: 32767.0, full: 32767.0 },
  i32: { view: (buffer) => new Int32Array(buffer), zero: 0, full: 2147483647.0 },
  u32: { view: (buffer) => new Uint32Array(buffer), zero: 2147483647.0, full: 2147483647.0 },
  f32: { view: (buffer) => new Float32Array(buffer), zero: 0, full: 1.0 },
  f64: { view: (buffer) => new Float64Array(buffer), zero: 0, full: 1.0 },
};

// 'ci16_le' -> 'i16'. The leading r/c is optional so that the loose spellings
// this has always accepted ('i8', 'u8') keep working; endianness is ignored,
// because every reader here is a typed array and so little-endian already.
function componentTypeOf(dataType: string): string {
  const match = /^[rc]?([fiu]\d+)/i.exec(String(dataType ?? '').trim());
  return match ? match[1].toLowerCase() : '';
}

// Everything downstream of this function -- processing, the FFTs, the
// spectrogram and the Time/IQ plots -- works on interleaved I/Q, two floats per
// sample. A real-valued recording is widened to that layout here, with Q = 0,
// which is all real support takes: the FFT of a signal with no imaginary part is
// Hermitian-symmetric, so the spectrogram and frequency plot show the negative
// half mirroring the positive one, exactly as expected of a real signal.
export function convertToFloat32(buffer, dataType) {
  const reader = COMPONENT_READERS[componentTypeOf(dataType)];
  if (!reader) {
    console.error('Unknown data type: ' + dataType);
    return new Float32Array(buffer);
  }
  const components = reader.view(buffer);
  const complex = dataTypeIsComplex(dataType);
  // Complex 32-bit float is already the exact layout used downstream.
  if (complex && components instanceof Float32Array) return components;

  const samples = new Float32Array(complex ? components.length : components.length * 2);
  const stride = complex ? 1 : 2; // real: leave every Q at the zero it starts as
  for (let i = 0; i < components.length; i++) {
    samples[i * stride] = (components[i] - reader.zero) / reader.full;
  }
  return samples;
}
