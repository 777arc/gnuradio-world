// Copyright (c) 2022 Microsoft Corporation
// Copyright (c) 2023 Marc Lichtman
// Licensed under the MIT License

/*
stage0 - raw IQ straight from the recording
stage1 - pre-FFT processing performed on stage1, eg FIR filter, python snippet
stage2 - FFT output in floats, in units of dB
stage3 - after doing decimation (max, mean, or skip) for zooming out in time
stage4 - uint8 values after having the min/max and colormap applied
*/

// @ts-ignore
import { fftshift } from 'fftshift';
import { FFT } from '@/utils/fft';
//import webfft from 'webfft';

export function calcFfts(samples: Float32Array, fftSize: number, windowFunction: string, numberOfFfts: number) {
  //let startTime = performance.now();

  /*
  if (typeof window.webfft === 'undefined') {
    window.webfft = new webfft(fftSize);
    window.webfft.profile(0.5, true, true); // causes webfft to switch to using the fastest sublibrary
  } else {
    if (window.webfft.size !== fftSize) {
      console.log('Changing to FFT Size:', window.webfft.size);
      window.webfft = new webfft(fftSize);
      window.webfft.profile(0.5, true, true); // causes webfft to switch to using the fastest sublibrary
    }
  }
  */

  let fftsConcatenated = new Float32Array(numberOfFfts * fftSize);

  // loop through each row
  for (let i = 0; i < numberOfFfts; i++) {
    let samples_slice = samples.slice(i * fftSize * 2, (i + 1) * fftSize * 2); // mult by 2 because this is int/floats not IQ samples

    // Apply a hamming window and hanning window
    if (windowFunction === 'hamming') {
      for (let window_i = 0; window_i < fftSize; window_i++) {
        samples_slice[window_i] =
          samples_slice[window_i] * (0.54 - 0.46 * Math.cos((2 * Math.PI * window_i) / (fftSize - 1)));
      }
    } else if (windowFunction === 'hanning') {
      for (let window_i = 0; window_i < fftSize; window_i++) {
        samples_slice[window_i] =
          samples_slice[window_i] * (0.5 - 0.5 * Math.cos((2 * Math.PI * window_i) / (fftSize - 1)));
      }
    } else if (windowFunction === 'bartlett') {
      for (let window_i = 0; window_i < fftSize; window_i++) {
        samples_slice[window_i] =
          samples_slice[window_i] *
          ((2 / (fftSize - 1)) * ((fftSize - 1) / 2) - Math.abs(window_i - (fftSize - 1) / 2));
      }
    } else if (windowFunction === 'blackman') {
      for (let window_i = 0; window_i < fftSize; window_i++) {
        samples_slice[window_i] =
          samples_slice[window_i] *
          (0.42 -
            0.5 * Math.cos((2 * Math.PI * window_i) / fftSize) +
            0.08 * Math.cos((4 * Math.PI * window_i) / fftSize));
      }
    }

    /*
    if (samples_slice.length !== fftSize * 2) {
      console.error('samples_slice.length is', samples_slice.length, 'but should be fftSize * 2 which is', fftSize * 2);
      continue;
    }
    let out = window.webfft.fft(samples_slice); // assumes input is in form IQIQIQIQ and twice the length of fftsize
    */

    const f = new FFT(fftSize);
    let out = f.createComplexArray(); // creates an empty array the length of fft.size*2
    f.transform(out, samples_slice); // assumes input (2nd arg) is in form IQIQIQIQ and twice the length of fft.size

    out = out.map((x) => x / fftSize); // divide by fftsize

    // convert to magnitude
    let magnitudes = new Array(out.length / 2);
    for (let j = 0; j < out.length / 2; j++) {
      magnitudes[j] = Math.sqrt(Math.pow(out[j * 2], 2) + Math.pow(out[j * 2 + 1], 2)); // take magnitude
    }

    fftshift(magnitudes); // in-place
    magnitudes = magnitudes.map((x) => 10.0 * Math.log10(x)); // convert to dB
    magnitudes = magnitudes.map((x) => (isFinite(x) ? x : 0)); // get rid of -infinity which happens when the input is all 0s

    fftsConcatenated.set(magnitudes, i * fftSize);
  }
  //let endTime = performance.now();
  //console.debug('Calculating FFTs took', endTime - startTime, 'milliseconds'); // first cut of our code processed+rendered 0.5M samples in 760ms on marcs computer
  return fftsConcatenated;
}

export function fftToRGB(
  fftsConcatenated: Float32Array,
  fftSize: number,
  magnitude_min: number,
  magnitude_max: number,
  colMap: any
) {
  let startOfs = 0;
  let newFftData = new Uint8ClampedArray(fftsConcatenated.length * 4); // 4 because RGBA

  // this doesnt appear to be happening anymore
  if (fftsConcatenated[0] === Number.NEGATIVE_INFINITY) {
    newFftData.fill(255);
    return newFftData;
  }

  // loop through each row
  for (let i = 0; i < fftsConcatenated.length / fftSize; i++) {
    let magnitudes = fftsConcatenated.slice(i * fftSize, (i + 1) * fftSize);

    // This happens when the FFTs are being loaded
    let sum = 0;
    magnitudes.map((e) => (sum += e));
    if (sum == 0) {
      newFftData.fill(100, i * fftSize * 4, (i + 1) * fftSize * 4); // gray
      continue;
    }

    // this doesnt appear to be happening anymore
    if (magnitudes[0] === Number.NEGATIVE_INFINITY) {
      newFftData.fill(255, i * fftSize * 4, (i + 1) * fftSize * 4);
      continue;
    }

    // apply magnitude min and max (which are in dB, same units as magnitudes prior to this point) and convert to 0-255
    const dbPer1 = 255 / (magnitude_max - magnitude_min);
    magnitudes = magnitudes.map((x) => x - magnitude_min);
    magnitudes = magnitudes.map((x) => x * dbPer1);
    magnitudes = magnitudes.map((x) => (x > 255 ? 255 : x)); // clip above 255
    magnitudes = magnitudes.map((x) => (x < 0 ? 0 : x)); // clip below 0
    let ipBuf8 = Uint8ClampedArray.from(magnitudes); // anything over 255 or below 0 at this point will become a random number, hence clipping above

    // Apply colormap
    let line_offset = i * fftSize * 4;
    for (let sigVal, opIdx = 0, ipIdx = startOfs; ipIdx < fftSize + startOfs; opIdx += 4, ipIdx++) {
      sigVal = ipBuf8[ipIdx] || 0; // if input line too short add zeros
      newFftData[line_offset + opIdx] = colMap[sigVal][0]; // red
      newFftData[line_offset + opIdx + 1] = colMap[sigVal][1]; // green
      newFftData[line_offset + opIdx + 2] = colMap[sigVal][2]; // blue
      newFftData[line_offset + opIdx + 3] = 255; // alpha
    }
  }
  return newFftData;
}

// mimicing python's range() function which gives array of integers between two values non-inclusive of end
export function range(start: number, end: number): number[] {
  return Array.apply(0, Array(end - start)).map((element, index) => index + start);
}

// SigMF spells a datatype as <r|c><f|i|u><bits>[_le|_be]: 'c' for complex, 'r'
// for a real-valued recording, which stores one component per sample instead of
// two. Anything not explicitly marked real is treated as complex -- that is the
// common case, and it also preserves how the loose spellings convertToFloat32
// accepts ('i8', 'u8') were handled before real recordings were supported.
export function dataTypeIsComplex(dataType: string): boolean {
  return !/^r/i.test(String(dataType ?? '').trim());
}

// Components per sample: 2 for complex, 1 for real. This is the only place the
// difference in file layout matters -- real samples are widened to interleaved
// I/Q with Q = 0 as they are read (see convertToFloat32), so everything past
// that point works on one layout.
export function dataTypeToComponentsPerSample(dataType: string): number {
  return dataTypeIsComplex(dataType) ? 2 : 1;
}

export function dataTypeToBytesPerIQSample(dataType: string): number {
  const bits = Number(/(\d+)/.exec(String(dataType ?? ''))?.[1]);
  if (bits !== 8 && bits !== 16 && bits !== 32 && bits !== 64) {
    console.error('unsupported datatype');
    return 2;
  }
  return (bits / 8) * dataTypeToComponentsPerSample(dataType);
}
