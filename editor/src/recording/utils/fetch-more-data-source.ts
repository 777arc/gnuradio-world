// Copyright (c) 2022 Microsoft Corporation
// Copyright (c) 2023 Marc Lichtman
// Licensed under the MIT License

import { dataTypeIsComplex } from './selector';

// Upstream has two more processing stages here: a user-supplied FIR filter and a
// Python snippet run through Pyodide. Neither is part of this port, so squaring
// is all that is applied.
export function applyProcessing(samples, squareSignal) {
  if (squareSignal) {
    // Samples are interleaved complex values. (I + jQ)^2 is
    // (I^2 - Q^2) + j(2IQ), not two independent scalar squares.
    for (let i = 0; i + 1 < samples.length; i += 2) {
      const real = samples[i];
      const imaginary = samples[i + 1];
      samples[i] = real * real - imaginary * imaginary;
      samples[i + 1] = 2 * real * imaginary;
    }
  }
  return samples;
}

// How one stored component is read and normalized to roughly -1..1, keyed by the
// <f|i|u><bits> half of a SigMF datatype. The real/complex half says how many of
// these make up a sample, and is handled by convertToFloat32 below.
const COMPONENT_READERS: Record<string, {
  view: (buffer) => any;
  bytes: number;
  dataView: (view: DataView, offset: number) => number;
  zero: number;
  full: number;
}> = {
  i8: { view: (buffer) => new Int8Array(buffer), bytes: 1,
    dataView: (view, offset) => view.getInt8(offset), zero: 0, full: 127.0 },
  u8: { view: (buffer) => new Uint8Array(buffer), bytes: 1,
    dataView: (view, offset) => view.getUint8(offset), zero: 127.0, full: 127.0 },
  i16: { view: (buffer) => new Int16Array(buffer), bytes: 2,
    dataView: (view, offset) => view.getInt16(offset, false), zero: 0, full: 32767.0 },
  u16: { view: (buffer) => new Uint16Array(buffer), bytes: 2,
    dataView: (view, offset) => view.getUint16(offset, false), zero: 32767.0, full: 32767.0 },
  i32: { view: (buffer) => new Int32Array(buffer), bytes: 4,
    dataView: (view, offset) => view.getInt32(offset, false), zero: 0, full: 2147483647.0 },
  u32: { view: (buffer) => new Uint32Array(buffer), bytes: 4,
    dataView: (view, offset) => view.getUint32(offset, false), zero: 2147483647.0, full: 2147483647.0 },
  f32: { view: (buffer) => new Float32Array(buffer), bytes: 4,
    dataView: (view, offset) => view.getFloat32(offset, false), zero: 0, full: 1.0 },
  f64: { view: (buffer) => new Float64Array(buffer), bytes: 8,
    dataView: (view, offset) => view.getFloat64(offset, false), zero: 0, full: 1.0 },
};

// 'ci16_le' -> 'i16'. The leading r/c is optional so that the loose spellings
// this has always accepted ('i8', 'u8') keep working.
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
  // Typed arrays are the zero-copy little-endian path. Big-endian datatypes
  // need an explicit DataView read; otherwise the host byte order silently
  // reverses every multi-byte component.
  let components;
  if (/_be$/i.test(String(dataType ?? '').trim()) && reader.bytes > 1) {
    const view = new DataView(buffer);
    components = Array.from(
      { length: Math.floor(buffer.byteLength / reader.bytes) },
      (_, index) => reader.dataView(view, index * reader.bytes),
    );
  } else {
    components = reader.view(buffer);
  }
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
