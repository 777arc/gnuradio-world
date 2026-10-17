// The recording catalog's spectrogram thumbnail, rendered from a recording's
// samples. Shared by the indexer, which renders one for every recording that
// lacks one each time it rebuilds the catalog, and
// scripts/make-recording-thumbnails.mjs, which re-renders on demand -- so both
// produce the same picture. Platform-neutral: Uint8Array and CompressionStream
// only, nothing from Node.
//
// Three decisions worth knowing:
//
//  - **It samples across the whole recording, not the head.** Eight seek points,
//    sixteen rows at each, is 128 rows of waterfall for a few hundred KB and
//    eight range requests. A single head read would be one request, but a 4 GB
//    capture would be represented by its first fraction of a second.
//  - **A real-valued recording shows only its positive half.** Widening it to
//    I/Q with Q = 0 makes the spectrum Hermitian, so the negative half is the
//    mirror of the positive one and drawing it would spend half the pixels
//    saying nothing twice. The freed bins go into a longer FFT instead, so a
//    real recording gets twice the frequency resolution rather than half a
//    picture.
//  - **PNG is written by hand.** An indexed 8-bit PNG needs only zlib, which
//    every runtime here has as CompressionStream('deflate'), and comes out
//    around 10 KB. Any encoder worth adding as a dependency would be bigger.

export const THUMB_PREFIX = 'thumbs/';

/** The object key a recording's thumbnail lives at, beside its samples. */
export const thumbnailKey = (baseKey) => `${THUMB_PREFIX}${baseKey}.png`;

// Square, because the card gives the thumbnail its left third and a 4:1 strip in
// that box would either crop the frequency axis away or stretch time four times.
const IMAGE_WIDTH = 128;       // columns of spectrum
const ROWS = 128;              // waterfall rows, and the image height

// A complex recording fills the width with its whole two-sided spectrum. A real
// one is Hermitian -- its negative half is the mirror of its positive half, and
// nothing but the same information -- so only the positive half is drawn. Half
// the bins for the same columns means twice the FFT, which is why a real
// recording ends up with twice the frequency resolution rather than half the
// picture. It costs the same bytes either way: a real sample is half a complex
// one, so 256 of them read exactly as far as 128 complex.
const COMPLEX_FFT_SIZE = IMAGE_WIDTH;
const REAL_FFT_SIZE = IMAGE_WIDTH * 2;
const SEEK_POINTS = 8;         // spread across the recording
const ROWS_PER_SEEK = ROWS / SEEK_POINTS;
// Each row averages this many FFTs. A single FFT of noise has enormous variance,
// which renders as speckle that buries a weak signal and defeats PNG's
// compression; averaging four flattens the floor for four times the bytes read.
const FRAMES_PER_ROW = 4;
const FRAMES_PER_SEEK = ROWS_PER_SEEK * FRAMES_PER_ROW;

// ---- SigMF sample decoding -------------------------------------------------

/** Bytes per sample and a reader that widens one sample to [I, Q]. */
export function sampleReader(datatype) {
  const match = /^([rc])([fiu])(\d+)(?:_(le|be))?$/i.exec((datatype || '').trim());
  if (!match) return null;
  const [, shape, kind, widthText, endian] = match;
  if ((endian || 'le').toLowerCase() === 'be') return null; // nothing here is big-endian
  const width = Number(widthText);
  const complex = shape.toLowerCase() === 'c';
  const componentBytes = width / 8;
  if (!Number.isInteger(componentBytes) || componentBytes < 1) return null;

  const scale = kind.toLowerCase() === 'f' ? 1 : 2 ** (width - 1);
  const read = (view, offset) => {
    if (kind.toLowerCase() === 'f')
      return width === 32 ? view.getFloat32(offset, true) : view.getFloat64(offset, true);
    if (kind.toLowerCase() === 'u') {
      const raw = width === 8 ? view.getUint8(offset)
        : width === 16 ? view.getUint16(offset, true) : view.getUint32(offset, true);
      return raw / scale - 1;
    }
    const raw = width === 8 ? view.getInt8(offset)
      : width === 16 ? view.getInt16(offset, true) : view.getInt32(offset, true);
    return raw / scale;
  };

  const componentsPerSample = complex ? 2 : 1;
  return {
    complex,
    bytesPerSample: componentBytes * componentsPerSample,
    /** Fill re[]/im[] with `count` samples starting at sample `index` of the view. */
    fill(view, byteOffset, count, re, im) {
      for (let i = 0; i < count; i++) {
        const at = byteOffset + i * componentBytes * componentsPerSample;
        re[i] = read(view, at);
        // A real recording is widened with Q = 0, matching the viewer. Its
        // spectrum is therefore Hermitian, and only the positive half is drawn.
        im[i] = complex ? read(view, at + componentBytes) : 0;
      }
    },
  };
}

// ---- FFT -------------------------------------------------------------------

const HANN = new Map();
function hann(size) {
  let window = HANN.get(size);
  if (!window) {
    window = Float64Array.from({ length: size }, (_, i) =>
      0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
    HANN.set(size, window);
  }
  return window;
}

// Iterative radix-2, in place. Only ever called with a power-of-two length.
function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wRe = Math.cos(angle), wIm = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      for (let k = 0; k < len / 2; k++) {
        const aRe = re[i + k], aIm = im[i + k];
        const bRe = re[i + k + len / 2] * curRe - im[i + k + len / 2] * curIm;
        const bIm = re[i + k + len / 2] * curIm + im[i + k + len / 2] * curRe;
        re[i + k] = aRe + bRe; im[i + k] = aIm + bIm;
        re[i + k + len / 2] = aRe - bRe; im[i + k + len / 2] = aIm - bIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

// ---- colour ----------------------------------------------------------------

// Viridis-like, with the floor pulled toward the palette's own background so an
// empty recording reads as empty rather than as a purple block.
const RAMP = [
  [0.00, [16, 18, 28]],
  [0.20, [39, 45, 92]],
  [0.45, [40, 110, 150]],
  [0.70, [70, 190, 120]],
  [0.88, [180, 220, 80]],
  [1.00, [253, 231, 37]],
];

export function palette() {
  const bytes = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let a = RAMP[0], b = RAMP[RAMP.length - 1];
    for (let s = 0; s < RAMP.length - 1; s++) {
      if (t >= RAMP[s][0] && t <= RAMP[s + 1][0]) { a = RAMP[s]; b = RAMP[s + 1]; break; }
    }
    const span = b[0] - a[0];
    const f = span > 0 ? (t - a[0]) / span : 0;
    for (let c = 0; c < 3; c++) bytes[i * 3 + c] = Math.round(a[1][c] + (b[1][c] - a[1][c]) * f);
  }
  return bytes;
}

// ---- PNG (indexed, 8-bit) --------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
})();

function crc32(bytes) {
  let c = 0xffffffff;
  for (const byte of bytes) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function concat(parts) {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}

function chunk(type, data) {
  const typed = concat([Uint8Array.from(type, c => c.charCodeAt(0)), data]);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(typed, 4);
  view.setUint32(8 + data.length, crc32(typed));
  return out;
}

// zlib-wrapped deflate, which is exactly what an IDAT chunk holds.
async function deflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** An 8-bit palettized PNG. `pixels` is width*height palette indices. */
export async function encodePng(width, height, pixels, paletteBytes) {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 3;    // colour type: indexed
  const raw = new Uint8Array((width + 1) * height);
  for (let y = 0; y < height; y++) {
    // Filter byte 0 (none): the data is noise; filtering costs more than it saves.
    raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  return concat([
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    chunk('IHDR', ihdr),
    chunk('PLTE', paletteBytes),
    chunk('IDAT', await deflate(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}

// ---- building one thumbnail ------------------------------------------------

/**
 * Up to ROWS rows of dB magnitude, sampled evenly across the recording.
 * `readRange(start, length)` resolves to those bytes of the data file.
 * Returns null when the recording is too short to fill even one frame.
 */
export async function spectrogramRows(readRange, byteLength, reader) {
  const fftSize = reader.complex ? COMPLEX_FFT_SIZE : REAL_FFT_SIZE;
  const window = hann(fftSize);
  const frameBytes = fftSize * reader.bytesPerSample;
  const blockBytes = frameBytes * FRAMES_PER_SEEK;
  if (byteLength < frameBytes) return null;

  const rows = [];
  const re = new Float64Array(fftSize), im = new Float64Array(fftSize);
  for (let seek = 0; seek < SEEK_POINTS; seek++) {
    // Evenly spaced, and never past the end. Aligned to a sample boundary so a
    // block never starts mid-sample and shears I into Q.
    const span = Math.max(0, byteLength - blockBytes);
    let start = SEEK_POINTS > 1 ? Math.floor((span * seek) / (SEEK_POINTS - 1)) : 0;
    start -= start % reader.bytesPerSample;
    const want = Math.min(blockBytes, byteLength - start);
    const block = await readRange(start, want);
    const view = new DataView(block.buffer, block.byteOffset, block.byteLength);
    const frames = Math.floor(block.byteLength / frameBytes);

    for (let r = 0; r < ROWS_PER_SEEK; r++) {
      const row = new Float64Array(IMAGE_WIDTH);
      let averaged = 0;
      for (let f = 0; f < FRAMES_PER_ROW; f++) {
        const frame = r * FRAMES_PER_ROW + f;
        if (frame >= frames) break;
        reader.fill(view, frame * frameBytes, fftSize, re, im);
        for (let i = 0; i < fftSize; i++) { re[i] *= window[i]; im[i] *= window[i]; }
        fft(re, im);
        for (let i = 0; i < IMAGE_WIDTH; i++) {
          // Complex: fftshift, DC in the middle, the way every other display here
          // shows it. Real: bins 0..N/2, DC at the left and Nyquist at the right,
          // because the other half is only this half backwards.
          const from = reader.complex ? (i + fftSize / 2) % fftSize : i;
          row[i] += re[from] * re[from] + im[from] * im[from];
        }
        averaged++;
      }
      if (!averaged) { rows.push(rows[rows.length - 1] ?? new Float64Array(IMAGE_WIDTH)); continue; }
      // Average power, then dB -- averaging in dB would bias toward the nulls.
      for (let i = 0; i < IMAGE_WIDTH; i++) row[i] = 10 * Math.log10(row[i] / averaged + 1e-20);
      rows.push(row);
    }
  }
  return rows.slice(0, ROWS);
}

// Most recordings are mostly noise, so the median *is* the noise floor: putting
// it at black is what makes a signal show up as a signal. And a recording with
// nothing in it has a median-to-peak spread of only a few dB, which a percentile
// stretch would amplify into a full-brightness field of static -- so the range
// never narrows below MIN_DYNAMIC_RANGE_DB and an empty recording stays legibly
// empty rather than becoming the busiest thumbnail in the catalog.
const MIN_DYNAMIC_RANGE_DB = 25;
const THUMBNAIL_GAMMA = 0.65;

/** Scale dB rows to palette indices, with the noise floor at black. */
export function quantize(rows) {
  const sorted = Float64Array.from(rows.flatMap(row => [...row])).sort();
  const at = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const low = at(0.50);
  const high = Math.max(at(0.999), low + MIN_DYNAMIC_RANGE_DB);
  const span = high - low;
  const pixels = new Uint8Array(rows.length * IMAGE_WIDTH);
  for (let y = 0; y < rows.length; y++) {
    for (let x = 0; x < IMAGE_WIDTH; x++) {
      const linear = Math.max(0, Math.min(1, (rows[y][x] - low) / span));
      // Most of a recording sits in the lower half of its own dynamic range, and
      // the low end of the ramp is nearly black, so a linear map renders a real
      // signal as a dim smudge. The gamma lifts the mid-tones where the content
      // actually is without clipping the peaks.
      pixels[y * IMAGE_WIDTH + x] = Math.round(linear ** THUMBNAIL_GAMMA * 255);
    }
  }
  return pixels;
}

/** Whether renderThumbnail would draw this recording rather than skip it. */
export function canRenderThumbnail(datatype, byteLength) {
  const reader = sampleReader(datatype);
  if (!reader) return false;
  const fftSize = reader.complex ? COMPLEX_FFT_SIZE : REAL_FFT_SIZE;
  return byteLength >= fftSize * reader.bytesPerSample;
}

/**
 * Render one recording's thumbnail: `{ png }`, or `{ skipped: reason }` when
 * the datatype is unsupported or the recording is shorter than one FFT frame.
 */
export async function renderThumbnail({ datatype, byteLength, readRange }) {
  const reader = sampleReader(datatype);
  if (!reader) return { skipped: `unsupported datatype ${datatype}` };
  const rows = await spectrogramRows(readRange, byteLength, reader);
  if (!rows) return { skipped: 'too short for one FFT frame' };
  return { png: await encodePng(IMAGE_WIDTH, rows.length, quantize(rows), palette()) };
}
