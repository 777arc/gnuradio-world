#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const WORKER_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_RECORDINGS_DIR = join(WORKER_DIR, '..', '..', 'example_recordings');
const DEFAULT_BUCKET = 'gnuradio-wasm-recordings';
const WRANGLER = join(WORKER_DIR, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

function valueAfter(flag) {
  const index = process.argv.indexOf(flag);
  if (index === -1) return null;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

const apply = process.argv.includes('--apply');
const bucket = valueAfter('--bucket') ?? DEFAULT_BUCKET;
const recordingsDir = valueAfter('--recordings-dir') ?? DEFAULT_RECORDINGS_DIR;
const concurrency = 4;

const files = (await readdir(recordingsDir, { recursive: true }))
  .map(file => file.split(sep).join('/'))
  .filter(file => file.endsWith('.sigmf-meta'))
  .sort((a, b) => a.localeCompare(b));

// Validate every sidecar before touching R2. A partial upload caused by invalid
// JSON is harder to diagnose than a local failure with no remote changes.
for (const key of files) {
  const path = join(recordingsDir, key);
  try {
    JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`Invalid JSON in ${relative(process.cwd(), path)}`, { cause: error });
  }
}

console.log(`${apply ? 'Uploading' : 'Would upload'} ${files.length} metadata sidecars`);
console.log(`  source: ${recordingsDir}`);
console.log(`  bucket: ${bucket}`);

if (!apply) {
  for (const key of files.slice(0, 10)) console.log(`  ${key}`);
  if (files.length > 10) console.log(`  ... and ${files.length - 10} more`);
  console.log('Preview only; rerun with --apply to write to R2.');
  process.exit(0);
}

function upload(key) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      WRANGLER,
      'r2', 'object', 'put', `${bucket}/${key}`,
      `--file=${join(recordingsDir, key)}`,
      '--content-type=application/json; charset=utf-8',
      '--cache-control=no-cache',
      '--remote',
      '--force',
    ], { cwd: WORKER_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; });
    child.stderr.on('data', chunk => { output += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`Upload failed for ${key} (exit ${code})\n${output.trim()}`));
    });
  });
}

let nextIndex = 0;
let completed = 0;
async function uploader() {
  while (nextIndex < files.length) {
    const key = files[nextIndex++];
    await upload(key);
    completed++;
    console.log(`[${completed}/${files.length}] ${key}`);
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, files.length) }, uploader));
console.log(`Uploaded ${completed} metadata sidecars to ${bucket}.`);
