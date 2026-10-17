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
// The rendering itself lives in workers/sigmf-indexer/src/thumbnail.js, which
// the indexer also uses to render a thumbnail for every recording that lacks
// one each time it rebuilds the catalog -- so new recordings need nothing from
// here. This is for re-rendering (--force, after a rendering change) and for
// looking at the output locally (--out).

import { writeFile, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { renderThumbnail, thumbnailKey } from '../workers/sigmf-indexer/src/thumbnail.js';

const RECORDINGS_BASE = process.env.RECORDINGS_R2_BASE ||
  'https://recordings.gnuradioworld.com';
const BUCKET = process.env.R2_BUCKET || 'gnuradio-wasm-recordings';
const CONCURRENCY = 6;

async function readRange(url, start, length) {
  const response = await fetch(url, {
    headers: { Range: `bytes=${start}-${start + length - 1}` },
  });
  if (response.status !== 206)
    throw new Error(`expected 206 for a range request, got ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

export function makeThumbnail(recording) {
  const url = `${RECORDINGS_BASE}/` +
    `${recording.base_filename.split('/').map(encodeURIComponent).join('/')}.sigmf-data`;
  return renderThumbnail({
    datatype: recording.datatype,
    byteLength: recording.byte_length,
    readRange: (start, length) => readRange(url, start, length),
  });
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
          `${BUCKET}/${thumbnailKey(entry.base_filename)}`,
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
