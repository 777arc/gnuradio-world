#!/usr/bin/env node
// Propose (and, with --apply, write) the grworld: catalog fields for every
// hosted recording, plus a core:datetime where the collection implies one.
//
// The rules are NOT in this file. It bundles editor/src/recording-taxonomy.ts --
// the same module the Recordings palette browses with -- so what it writes is
// exactly what the palette already infers. Applying it therefore changes no
// grouping anywhere; it moves each answer from a guess made in the browser to a
// fact recorded in the recording's own .sigmf-meta, after which the fallback
// never runs for that recording again and a human can correct it in one place.
//
//   node scripts/backfill-recording-metadata.mjs               # review, writes nothing
//   node scripts/backfill-recording-metadata.mjs --out p.json  # the full proposal
//   node scripts/backfill-recording-metadata.mjs --apply --limit 3   # a trial batch
//   node scripts/backfill-recording-metadata.mjs --apply             # all of them
//
// --apply rewrites objects in the production bucket, through `wrangler r2 object
// put` and the `wrangler login` session -- no long-lived access keys, and no AWS
// SDK dependency in a repository that has none. Three things make it safe to run:
// it never removes or overwrites a field a recording already declares, it
// re-reads each .sigmf-meta immediately before writing so a hand edit made since
// the index was built is merged into rather than clobbered, and it saves every
// original under --backup before replacing it. R2 has no undo; that directory is
// the undo, and the script prints the command that uses it.

import { writeFile, mkdtemp, mkdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// esbuild is the editor's dev dependency, not a root one, and this script is the
// only thing at the root that needs it: resolve it from there rather than adding
// a second copy to the repository.
const editorRequire = createRequire(new URL('../editor/package.json', import.meta.url));

const RECORDINGS_BASE = process.env.RECORDINGS_R2_BASE ||
  'https://recordings.gnuradioworld.com';
const BUCKET = process.env.R2_BUCKET || 'gnuradio-wasm-recordings';

// Event dates for the collections whose recordings carry no core:datetime at
// all. Only where the date is genuinely known -- these captures really were made
// at the event. Anything not listed here keeps a null datetime rather than being
// given an invented one, because a confidently wrong timestamp sorts wrong
// forever and nothing downstream can tell it from a real one.
const COLLECTION_DATETIMES = {
  'GRCon 2023 CTF': '2023-09-05T00:00:00Z',
  'GRCon 2024 CTF': '2024-09-16T00:00:00Z',
  'GRCon 2025 CTF': '2025-09-08T00:00:00Z',
};

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const flag = (name) => {
  const index = args.indexOf(name);
  return index !== -1 ? args[index + 1] : null;
};
const outPath = flag('--out');
const limit = Number(flag('--limit') ?? Infinity);
const backupDir = flag('--backup') ??
  `recordings-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;

async function loadTaxonomy() {
  let build;
  try {
    ({ build } = editorRequire('esbuild'));
  } catch {
    throw new Error('esbuild was not found. It is the editor\'s dev dependency and ' +
      'this script bundles editor/src/recording-taxonomy.ts with it:\n' +
      '  (cd editor && npm ci)');
  }
  const dir = await mkdtemp(join(tmpdir(), 'grw-taxonomy-'));
  const out = join(dir, 'taxonomy.mjs');
  await build({
    entryPoints: [new URL('../editor/src/recording-taxonomy.ts', import.meta.url).pathname],
    bundle: true, format: 'esm', outfile: out, logLevel: 'silent',
    define: { 'import.meta.env': JSON.stringify({}) },
  });
  return import(pathToFileURL(out));
}

const fetchJson = async (url) => {
  const response = await fetch(url, { cache: 'no-store' });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText} for ${url}`);
  return response.json();
};

// The index carries what the palette reads; the taxonomy wants an
// ExampleRecording, which is the same fields under editor-side names.
const asRecording = (entry) => ({
  name: entry.base_filename,
  title: entry.title ?? entry.base_filename.split('/').pop(),
  datatype: entry.datatype ?? null,
  sampleRate: entry.sample_rate ?? null,
  author: entry.author ?? null,
  description: entry.description ?? null,
  frequency: entry.frequency ?? null,
  annotationCount: entry.number_of_annotations ?? 0,
  annotationLabels: entry.annotation_labels ?? [],
  captureDatetime: entry.capture_datetime ?? null,
  category: entry.category ?? null,
  collection: entry.collection ?? null,
  tags: entry.tags ?? [],
  sampleCount: entry.number_of_samples ?? null,
  byteLength: entry.byte_length ?? 0,
});

function proposalFor(taxonomy, recording) {
  const {
    recordingCategory, recordingCollectionName, recordingModulation, recordingProtocol,
    UNSORTED_CATEGORY, STANDALONE_COLLECTION,
  } = taxonomy;

  const global = {};
  const notes = [];

  if (!recording.category) {
    const category = recordingCategory(recording);
    if (category === UNSORTED_CATEGORY) notes.push('no category rule matched — classify by hand');
    else global['grworld:category'] = category;
  }
  if (!recording.collection) {
    const collection = recordingCollectionName(recording);
    if (collection !== STANDALONE_COLLECTION) global['grworld:collection'] = collection;
  }

  // Tags are additive: a modulation and a protocol are the two axes the palette
  // offers as refine chips, and both are recoverable from the description.
  const tags = [...recording.tags];
  const present = new Set(tags.map(taxonomy.normalizeTag));
  for (const candidate of [recordingModulation(recording), recordingProtocol(recording)]) {
    // A catalog that already says "adsb" must not be given "ADS-B" beside it.
    if (candidate && !present.has(taxonomy.normalizeTag(candidate))) {
      tags.push(candidate);
      present.add(taxonomy.normalizeTag(candidate));
    }
  }
  if (tags.length > recording.tags.length) global['grworld:tags'] = tags;

  // The title falls back to the basename in the palette, so only propose one
  // where the description opens with a real name -- "AALTO-1 (NORAD 42775): ..."
  if (!recording.title || recording.title === recording.name.split('/').pop()) {
    const named = /^([A-Z0-9][A-Za-z0-9 ._+-]{1,40}?)\s*\((?:NORAD|SATNO)/.exec(
      recording.description ?? '');
    if (named) global['grworld:title'] = named[1].trim();
  }

  const collection = global['grworld:collection'] ?? recording.collection;
  const datetime = !recording.captureDatetime && collection
    ? COLLECTION_DATETIMES[collection] ?? null : null;

  return { global, datetime, notes };
}

const extensionEntry = {
  name: 'grworld', version: '1.0.0', optional: true,
};

const runWrangler = (args) => new Promise((resolve, reject) => {
  // An argument array rather than a shell: some recording keys contain spaces,
  // and one of them is a CTF flag nobody wants word-split.
  const child = spawn('npx', ['wrangler', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.on('error', error => reject(new Error(
    `wrangler could not be started (${error.message}). Is npx on PATH?`)));
  child.on('close', code => code === 0 ? resolve(stdout)
    : reject(new Error(`wrangler exited ${code}:\n${stderr.trim() || stdout.trim()}`)));
});

/**
 * Fail before the first write rather than 184 stack traces in.
 *
 * Writes go through the `wrangler login` session rather than R2 access keys, so
 * the one thing that can be missing is that session.
 */
async function assertWranglerLogin() {
  try {
    await runWrangler(['whoami']);
  } catch (error) {
    throw new Error('wrangler is not logged in, and --apply writes to R2 through ' +
      `its session:\n  npx wrangler login\n\n${error.message}`);
  }
}

/** Merge a proposal into a parsed .sigmf-meta without removing anything. */
export function mergeProposal(metadata, proposal) {
  const next = { ...metadata };
  const global = { ...(next.global ?? {}) };
  let changed = false;

  for (const [key, value] of Object.entries(proposal.global)) {
    if (global[key] !== undefined && global[key] !== null && global[key] !== '') continue;
    global[key] = value; changed = true;
  }
  if (changed && Object.keys(proposal.global).some(key => key.startsWith('grworld:'))) {
    const extensions = Array.isArray(global['core:extensions']) ? [...global['core:extensions']] : [];
    if (!extensions.some(entry => entry && entry.name === 'grworld')) {
      extensions.push(extensionEntry);
      global['core:extensions'] = extensions;
    }
  }
  next.global = global;

  if (proposal.datetime) {
    const captures = Array.isArray(next.captures) && next.captures.length
      ? next.captures.map(capture => ({ ...capture }))
      : [{ 'core:sample_start': 0 }];
    if (!captures[0]['core:datetime']) {
      captures[0]['core:datetime'] = proposal.datetime; changed = true;
    }
    next.captures = captures;
  }
  return { metadata: next, changed };
}

async function main() {
  const taxonomy = await loadTaxonomy();
  const index = await fetchJson(`${RECORDINGS_BASE}/index.json`);
  if (!Array.isArray(index)) throw new Error('recordings index is not an array');

  const proposals = [];
  const counts = { category: 0, collection: 0, tags: 0, title: 0, datetime: 0,
    manual: 0, undated: 0 };
  for (const entry of index) {
    const recording = asRecording(entry);
    const proposal = proposalFor(taxonomy, recording);
    if (proposal.global['grworld:category']) counts.category++;
    if (proposal.global['grworld:collection']) counts.collection++;
    if (proposal.global['grworld:tags']) counts.tags++;
    if (proposal.global['grworld:title']) counts.title++;
    if (proposal.datetime) counts.datetime++;
    if (proposal.notes.length) counts.manual++;
    // Not a problem, just the honest ceiling on the Newest sort: most of these
    // recordings genuinely have no known capture time and inventing one is worse
    // than leaving them undated.
    if (!recording.captureDatetime && !proposal.datetime) counts.undated++;
    if (Object.keys(proposal.global).length || proposal.datetime || proposal.notes.length)
      proposals.push({ key: recording.name, ...proposal });
  }

  console.log(`${index.length} recordings in ${RECORDINGS_BASE}/index.json`);
  console.log(`  category    ${counts.category}`);
  console.log(`  collection  ${counts.collection}`);
  console.log(`  tags        ${counts.tags}`);
  console.log(`  title       ${counts.title}`);
  console.log(`  datetime    ${counts.datetime}`);
  console.log(`  still undated ${counts.undated} (no capture time is known)`);
  console.log(`  needs a human ${counts.manual} (no category rule matched)`);

  const byCategory = new Map();
  for (const proposal of proposals) {
    const category = proposal.global['grworld:category'] ?? '(unchanged / manual)';
    byCategory.set(category, (byCategory.get(category) ?? 0) + 1);
  }
  console.log('\nproposed categories:');
  for (const [category, count] of [...byCategory].sort((a, b) => b[1] - a[1]))
    console.log(`  ${String(count).padStart(4)}  ${category}`);

  if (counts.manual) {
    console.log('\nrecordings no category rule could place:');
    for (const proposal of proposals.filter(entry => entry.notes.length).slice(0, 40))
      console.log(`  ${proposal.key} — ${proposal.notes.join('; ')}`);
  }

  if (outPath) {
    await writeFile(outPath, JSON.stringify(proposals, null, 2) + '\n');
    console.log(`\nwrote ${proposals.length} proposals to ${outPath}`);
  }

  if (!apply) {
    console.log('\nreview only. Re-run with --apply (and R2 credentials) to write these ' +
      'into each recording\'s .sigmf-meta.');
    return;
  }

  const writable = proposals.filter(proposal =>
    Object.keys(proposal.global).length || proposal.datetime);
  const batch = Number.isFinite(limit) ? writable.slice(0, limit) : writable;
  await mkdir(backupDir, { recursive: true });
  console.log(`\napplying ${batch.length} of ${writable.length} · originals saved under ${backupDir}/`);

  let written = 0, skipped = 0;
  for (const proposal of batch) {
    const key = `${proposal.key}.sigmf-meta`;
    const encoded = key.split('/').map(encodeURIComponent).join('/');
    // The live object, not the index: the index is a cache, and a field edited
    // by hand since it was built has to survive this pass.
    const live = await fetchJson(`${RECORDINGS_BASE}/${encoded}`);
    const { metadata, changed } = mergeProposal(live, proposal);
    if (!changed) { skipped++; continue; }

    const backupPath = join(backupDir, `${proposal.key.replace(/\//g, '__')}.sigmf-meta`);
    await writeFile(backupPath, JSON.stringify(live, null, 2) + '\n');

    const staged = join(tmpdir(), `grw-backfill-${process.pid}.sigmf-meta`);
    await writeFile(staged, JSON.stringify(metadata, null, 2) + '\n');
    try {
      await runWrangler(['r2', 'object', 'put', `${BUCKET}/${key}`, '--file', staged,
        '--content-type', 'application/json', '--remote']);
    } catch (error) {
      // The original is already on disk, so say where before giving up.
      throw new Error(`${error.message}\n\n${written} object(s) written before this ` +
        `one; every original is under ${backupDir}/`);
    }
    written++;
    console.log(`  [${written}/${batch.length}] ${key}`);
  }

  if (skipped) console.log(`  ${skipped} already carried every proposed field`);
  console.log(`\nto undo, put the saved originals back:`);
  console.log(`  for f in ${backupDir}/*.sigmf-meta; do k=$(basename "$f" .sigmf-meta | ` +
    `sed 's|__|/|g'); npx wrangler r2 object put ${BUCKET}/"$k".sigmf-meta ` +
    `--file "$f" --content-type application/json --remote; done`);
  console.log(`\n${written} .sigmf-meta objects updated. The indexer's queue consumer ` +
    'rebuilds index.json within about a minute.');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error => { console.error(error); process.exitCode = 1; });
