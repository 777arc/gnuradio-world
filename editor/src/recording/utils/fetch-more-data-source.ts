// Copyright (c) 2022 Microsoft Corporation
// Copyright (c) 2023 Marc Lichtman
// Licensed under the MIT License

export function convolve(array, taps) {
  // make sure its an odd number of taps
  if (taps.length % 2 !== 1) taps.push(0);

  let I = array.filter((element, index) => {
    return index % 2 === 0;
  });
  let Q = array.filter((element, index) => {
    return index % 2 === 1;
  });

  let offset = ~~(taps.length / 2);
  let output = new Float32Array(array.length);
  for (let i = 0; i < array.length / 2; i++) {
    let kmin = i >= offset ? 0 : offset - i;
    let kmax = i + offset < array.length / 2 ? taps.length - 1 : array.length / 2 - 1 - i + offset;
    output[i * 2] = 0; // I
    output[i * 2 + 1] = 0; // Q
    for (let k = kmin; k <= kmax; k++) {
      output[i * 2] += I[i - offset + k] * taps[k]; // I
      output[i * 2 + 1] += Q[i - offset + k] * taps[k]; // Q
    }
  }
  return output;
}

// Upstream has a third processing stage here: a user-supplied Python snippet run
// through Pyodide. It is not part of this port, so taps and squaring are all
// that is applied.
export function applyProcessing(samples, taps, squareSignal) {
  if (squareSignal) {
    for (let i = 0; i < samples.length; i++) samples[i] = samples[i] * samples[i];
  }
  if (taps && taps.length !== 1) {
    samples = convolve(samples, taps); // we apply the taps here and not in the FFT calcs so transients dont hurt us as much
  }
  return samples;
}

export function convertToFloat32(buffer, dataType) {
  if (dataType === 'ci8_le' || dataType === 'ci8' || dataType === 'i8') {
    let samples = Float32Array.from(new Int8Array(buffer));
    for (let i = 0; i < samples.length; i++) samples[i] = samples[i] / 127.0;
    return samples;
  } else if (dataType === 'cu8_le' || dataType === 'cu8' || dataType === 'u8') {
    let samples = Float32Array.from(new Uint8Array(buffer));
    for (let i = 0; i < samples.length; i++) samples[i] = (samples[i] - 127.0) / 127.0;
    return samples;
  } else if (dataType === 'ci16_le' || dataType === 'ci16') {
    let samples = Float32Array.from(new Int16Array(buffer));
    for (let i = 0; i < samples.length; i++) samples[i] = samples[i] / 32767.0;
    return samples;
  } else if (dataType === 'cu16_le' || dataType === 'cu16') {
    let samples = Float32Array.from(new Uint16Array(buffer));
    for (let i = 0; i < samples.length; i++) samples[i] = (samples[i] - 32767.0) / 32767.0;
    return samples;
  } else if (dataType === 'ci32_le' || dataType === 'ci32') {
    let samples = Float32Array.from(new Int32Array(buffer));
    for (let i = 0; i < samples.length; i++) samples[i] = samples[i] / 2147483647.0;
    return samples;
  } else if (dataType === 'cu32_le' || dataType === 'cu32') {
    let samples = Float32Array.from(new Uint32Array(buffer));
    for (let i = 0; i < samples.length; i++) samples[i] = (samples[i] - 2147483647.0) / 2147483647.0;
    return samples;
  } else if (dataType === 'cf32_le' || dataType === 'cf32') {
    return new Float32Array(buffer);
  } else if (dataType === 'cf64_le' || dataType === 'cf64') {
    return Float32Array.from(new Float64Array(buffer));
  } else {
    console.error('Unknown data type: ' + dataType);
    return new Float32Array(buffer);
  }
}
