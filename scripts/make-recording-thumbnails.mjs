#!/usr/bin/env node
// Render a small spectrogram for every hosted recording and upload it beside the
// samples, so the catalog can show what a recording *looks like* instead of only
// what its metadata says.
//
//   node scripts/make-recording-thumbnails.mjs --out /tmp/thumbs --limit 6   # local only
//   node scripts/make-recording-thumbnails.mjs --upload                      # to R2
//   node scripts/make-recording-thumbnails.mjs --upload --force              # redo all
//   node scripts/make-recording-thumbnails.mjs --upload --force --only ri16   # one datatype
//
// Thumbnails live at `thumbs/<base key>.png`. The indexer sets `thumbnail: true`
// on an index entry when it sees that object, and the palette renders it; a
// recording without one simply shows no strip. Nothing here is required for the
// catalog to work.
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
//  - **PNG is written by hand.** An indexed 8-bit PNG needs only zlib, which is
//    in Node, and comes out around 3 KB. Any encoder worth adding as a
//    dependency would produce a bigger file.

import { writeFile, mkdir } from 'node:fs/promises';
import { deflateSync } from 'node:zlib';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const RECORDINGS_BASE = process.env.RECORDINGS_R2_BASE ||
  'https://recordings.gnuradioworld.com';
const BUCKET = process.env.R2_BUCKET || 'gnuradio-wasm-recordings';
export const THUMB_PREFIX = 'thumbs/';

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
const CONCURRENCY = 6;

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
  const bytes = Buffer.alloc(256 * 3);
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

function crc32(buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 0);
  head.write(type, 4, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
  return Buffer.concat([head, data, crc]);
}

/** An 8-bit palettized PNG. `pixels` is width*height palette indices. */
export function encodePng(width, height, pixels, paletteBytes) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 3;    // colour type: indexed
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0; // filter: none. The data is noise; filtering costs more than it saves.
    pixels.copy
      ? pixels.copy(raw, y * (width + 1) + 1, y * width, (y + 1) * width)
      : Buffer.from(pixels.subarray(y * width, (y + 1) * width))
        .copy(raw, y * (width + 1) + 1);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('PLTE', paletteBytes),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---- building one thumbnail ------------------------------------------------

async function readRange(url, start, length) {
  const response = await fetch(url, {
    headers: { Range: `bytes=${start}-${start + length - 1}` },
  });
  if (response.status !== 206)
    throw new Error(`expected 206 for a range request, got ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

/**
 * Sixty-four rows of dB magnitude, sampled evenly across the recording.
 * Returns null when the recording is too short to fill even one frame.
 */
export async function spectrogramRows(url, byteLength, reader) {
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
    const block = await readRange(url, start, want);
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
  const pixels = Buffer.alloc(rows.length * IMAGE_WIDTH);
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

export async function makeThumbnail(recording) {
  const reader = sampleReader(recording.datatype);
  if (!reader) return { skipped: `unsupported datatype ${recording.datatype}` };
  const url = `${RECORDINGS_BASE}/` +
    `${recording.base_filename.split('/').map(encodeURIComponent).join('/')}.sigmf-data`;
  const rows = await spectrogramRows(url, recording.byte_length, reader);
  if (!rows) return { skipped: 'too short for one FFT frame' };
  return { png: encodePng(IMAGE_WIDTH, rows.length, quantize(rows), palette()) };
}

// ---- driver ----------------------------------------------------------------

const runWrangler = (args) => new Promise((resolve, reject) => {
  const child = spawn('npx', ['wrangler', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', c => { stdout += c; });
  child.stderr.on('data', c => { stderr += c; });
  child.on('error', error => reject(new Error(
    `wrangler could not be started (${error.message}). Is npx on PATH?`)));
  child.on('close', code => code === 0 ? resolve(stdout)
    : reject(new Error(`wrangler exited ${code}:\n${stderr.trim() || stdout.trim()}`)));
});

async function mapConcurrent(items, limit, operation) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await operation(items[index], index);
    }
  });
  await Promise.all(workers);
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (name) => { const i = args.indexOf(name); return i !== -1 ? args[i + 1] : null; };
  const upload = args.includes('--upload');
  const force = args.includes('--force');
  const outDir = flag('--out');
  const limit = Number(flag('--limit') ?? Infinity);
  // Re-render a subset without churning the rest: a rendering change usually
  // affects one datatype or one collection, and re-uploading the others only
  // changes their ETags and makes every browser fetch them again.
  const only = flag('--only');

  if (!upload && !outDir) {
    console.error('Nothing to do: pass --out <dir> to write locally, --upload to publish.');
    process.exitCode = 1;
    return;
  }
  if (upload) {
    try { await runWrangler(['whoami']); } catch (error) {
      throw new Error(`--upload writes to R2 through the wrangler session:\n` +
        `  npx wrangler login\n\n${error.message}`);
    }
  }

  const index = await (await fetch(`${RECORDINGS_BASE}/index.json`, { cache: 'no-store' })).json();
  const matching = only
    ? index.filter(entry => `${entry.base_filename} ${entry.datatype ?? ''}`.includes(only))
    : index;
  const todo = matching
    .filter(entry => force || !entry.thumbnail)
    .slice(0, Number.isFinite(limit) ? limit : undefined);
  console.log(`${index.length} recordings` +
    (only ? ` · ${matching.length} matching "${only}"` : '') +
    ` · ${todo.length} to render` + (force ? ' (--force)' : ''));

  let made = 0, skipped = 0, failed = 0, bytes = 0;
  await mapConcurrent(todo, CONCURRENCY, async (entry) => {
    try {
      const result = await makeThumbnail(entry);
      if (result.skipped) {
        skipped++;
        console.log(`  skip ${entry.base_filename} — ${result.skipped}`);
        return;
      }
      bytes += result.png.length;
      made++;
      if (outDir) {
        const file = join(outDir, `${entry.base_filename}.png`);
        await mkdir(dirname(file), { recursive: true });
        await writeFile(file, result.png);
      }
      if (upload) {
        const staged = join(tmpdir(), `grw-thumb-${process.pid}-${made}.png`);
        await writeFile(staged, result.png);
        await runWrangler(['r2', 'object', 'put',
          `${BUCKET}/${THUMB_PREFIX}${entry.base_filename}.png`,
          '--file', staged, '--content-type', 'image/png',
          // Revalidate rather than bypass: a thumbnail lives at a stable,
          // unversioned key, so re-rendering one has to be able to reach a
          // browser that already has it. The ETag makes the usual answer a 304.
          '--cache-control', 'no-cache', '--remote']);
      }
      console.log(`  [${made}] ${entry.base_filename} — ${(result.png.length / 1024).toFixed(1)} KiB`);
    } catch (error) {
      failed++;
      console.log(`  FAIL ${entry.base_filename} — ${error.message}`);
    }
  });

  console.log(`\n${made} rendered (${(bytes / 1024).toFixed(0)} KiB total, ` +
    `${made ? (bytes / made / 1024).toFixed(1) : 0} KiB average), ` +
    `${skipped} skipped, ${failed} failed`);
  if (upload && made)
    console.log('Thumbnails are not .sigmf-* objects, so they fire no index rebuild. ' +
      'Re-put any .sigmf-meta, or wait for the daily cron, to set `thumbnail: true`.');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error => { console.error(error); process.exitCode = 1; });
