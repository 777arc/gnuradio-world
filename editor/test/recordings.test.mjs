import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { bundleModule } from './bundle-module.mjs';
import { editorSource as main, recordingPaletteSource } from './editor-contract-source.mjs';

const catalog = await bundleModule('../src/recording-catalog.ts', {
  define: { 'import.meta.env': JSON.stringify({
    VITE_RECORDINGS_R2_BASE: 'https://recordings.example.test/',
  }) },
});

assert.equal(catalog.encodeRecordingPath('collection/a b.sigmf-data'),
  'collection/a%20b.sigmf-data');
assert.equal(catalog.indexBytesPerSample('cf32_le'), 8);
assert.equal(catalog.indexBytesPerSample('ci16'), 4);
assert.equal(catalog.indexBytesPerSample('rf32'), 4);
assert.equal(catalog.indexBytesPerSample('bad'), null);

const recording = catalog.recordingFromR2Index({
  base_filename: 'collection/capture one', datatype: 'ci16_le',
  sample_rate: 2_000_000, number_of_samples: 4_000_000, author: 'GNU Radio',
  description: 'A tagged telemetry capture', frequency: 145_900_000,
  number_of_annotations: 2, annotation_labels: ['packet', ' packet '],
  capture_datetime: '2026-08-25T12:00:00Z', title: 'AO-73 telemetry',
  category: 'Satellite', tags: ['BPSK', 'telemetry', 'BPSK'],
});
assert.ok(recording);
assert.equal(recording.byteLength, 16_000_000, 'byte length is derived when the index omits it');
assert.equal(recording.title, 'AO-73 telemetry');
assert.deepEqual(recording.tags, ['BPSK', 'telemetry']);
assert.deepEqual(recording.annotationLabels, ['packet']);
assert.equal(recording.annotationCount, 2);
assert.equal(catalog.recordingDuration(recording), 2);
assert.equal(catalog.displayDuration(2), '2 s');
assert.equal(recording.downloadUrl,
  'https://recordings.example.test/collection/capture%20one.sigmf-data');
assert.equal(recording.metadataUrl,
  'https://recordings.example.test/collection/capture%20one.sigmf-meta');
assert.equal(catalog.recordingFromR2Index({ base_filename: '../escape', byte_length: 1 }), null);
assert.equal(catalog.recordingFromR2Index({ base_filename: 'missing-size' }), null);

// ---- taxonomy: categories, collections and the facet that splits one --------
// The same module scripts/backfill-recording-metadata.mjs bundles, which is what
// makes the proposals it writes identical to what the palette already infers.
const taxonomy = await bundleModule('../src/recording-taxonomy.ts', {
  define: { 'import.meta.env': JSON.stringify({}) },
});

const rec = (fields) => ({
  name: 'x', title: 'x', datatype: 'cf32_le', sampleRate: null, author: null,
  description: null, frequency: null, annotationCount: 0, annotationLabels: [],
  captureDatetime: null, category: null, collection: null, tags: [],
  sampleCount: null, byteLength: 1, dataFile: '', metaFile: '',
  downloadUrl: '', metadataUrl: '', ...fields,
});

// Declared metadata always beats a guess -- that is what makes the derivation a
// migration path rather than a permanent second source of truth.
assert.equal(taxonomy.recordingCategory(rec({ category: 'HF Utility',
  name: 'GRCon25_CTF/thing' })), 'HF Utility');
assert.equal(taxonomy.recordingCollectionName(rec({ collection: 'My set',
  name: 'estevez/ao73' })), 'My set');

assert.equal(taxonomy.recordingCategory(rec({ name: 'GRCon25_CTF/sigid1' })), 'CTF / Puzzle');
assert.equal(taxonomy.recordingCategory(rec({ name: 'estevez/ao73',
  description: 'AO-73 (NORAD 39444): BPSK at 1200 baud.' })), 'Satellite');
// A synthetic GPS Gold code is a test vector, not a navigation capture: the key
// prefix is the publisher saying so, and it outranks the description's keyword.
assert.equal(taxonomy.recordingCategory(rec({ name: 'synthetic/GPSL1CA_PRN09',
  description: 'GPS L1 C/A Gold code' })), 'Synthetic / Test');
assert.equal(taxonomy.recordingCategory(rec({ name: 'gps_capture',
  description: 'Recording of GPS L1 signals' })), 'Navigation');
assert.equal(taxonomy.recordingCategory(rec({ name: 'mystery' })),
  taxonomy.UNSORTED_CATEGORY);

assert.equal(taxonomy.recordingCollectionName(rec({ name: 'GRCon23_CTF/demod' })),
  'GRCon 2023 CTF');
assert.equal(taxonomy.recordingCollectionName(rec({ name: 'new_group/thing' })), 'new group');
assert.equal(taxonomy.recordingCollectionName(rec({ name: 'loose' })),
  taxonomy.STANDALONE_COLLECTION);

// The key counts for modulation, not only the description: a synthetic vector
// names itself and carries no description at all.
assert.equal(taxonomy.recordingModulation(rec({ name: 'synthetic/BPSK_2SPS' })), 'BPSK');
assert.equal(taxonomy.recordingModulation(rec({ tags: ['bpsk'] })), 'BPSK');
assert.equal(taxonomy.recordingModulation(rec({ name: 'estevez/amgu_1' })), null,
  'a word merely containing a modulation name is not one');

// Three populations hide in "no frequency", and only one of them is audio.
assert.equal(taxonomy.recordingBandOf(rec({ datatype: 'ri16_le', frequency: 0 })),
  taxonomy.BASEBAND_AUDIO_BAND);
assert.equal(taxonomy.recordingBandOf(rec({ datatype: 'cf32_le', frequency: 0 })), null,
  'an RF capture missing its centre frequency is a gap, not a band');
assert.equal(taxonomy.recordingBandOf(rec({ datatype: 'cf32_le', frequency: 145e6 })), 'VHF');
// One band vocabulary, owned here: labelled with its numeric range and ordered
// by frequency rather than alphabet.
assert.equal(taxonomy.recordingBandLabel('VHF'), '30–300 MHz (VHF)');
assert.equal(taxonomy.recordingBandLabel(taxonomy.BASEBAND_AUDIO_BAND),
  'no RF centre frequency (Baseband / audio)');
assert.deepEqual(['UHF', 'HF', taxonomy.BASEBAND_AUDIO_BAND, 'VHF', 'Made up']
  .sort(taxonomy.compareBands),
  [taxonomy.BASEBAND_AUDIO_BAND, 'HF', 'VHF', 'UHF', 'Made up'],
  'an unrecognized band sorts last rather than throwing the order off');

// The facet chooser, and the guards that keep it honest.
const many = (count, fields) => Array.from({ length: count }, (_, i) =>
  rec({ ...fields, name: `${fields.name}/${i}` }));
const ctf = [...many(16, { name: 'GRCon23_CTF' }), ...many(11, { name: 'GRCon24_CTF' }),
  ...many(7, { name: 'GRCon25_CTF' })];
const ctfSplit = taxonomy.splitRecordings(ctf);
assert.equal(ctfSplit.facet.id, 'collection');
// Newest event first, not largest: nobody opens CTF / Puzzle wanting 2023.
assert.deepEqual(ctfSplit.groups.map(group => [group.value, group.recordings.length]),
  [['GRCon 2025 CTF', 7], ['GRCon 2024 CTF', 11], ['GRCon 2023 CTF', 16]]);
// A real capture time outranks the year in the name.
const dated = taxonomy.splitRecordings([
  ...many(4, { name: 'GRCon23_CTF', captureDatetime: '2026-01-01T00:00:00Z' }),
  ...many(4, { name: 'GRCon25_CTF' })]);
assert.equal(dated.groups[0].value, 'GRCon 2023 CTF');
// And a collection with neither falls back to size, never to reverse alphabet.
const plain = taxonomy.splitRecordings([...many(4, { name: 'alpha' }),
  ...many(9, { name: 'zulu' })]);
assert.deepEqual(plain.groups.map(group => group.value), ['zulu', 'alpha']);

// Four recordings split into three headings of one card each reads as structure
// while carrying none, so a small category stays flat.
assert.equal(taxonomy.splitRecordings(many(4, { name: 'a' })).facet, null);
// And one value holding everything has not split anything.
assert.equal(taxonomy.splitRecordings(many(20, { name: 'one' })).facet, null);
// A facet most of the set cannot answer does not get to be the heading, however
// cleanly it divides the minority that can.
const sparse = [...many(3, { name: 'p', description: 'BPSK' }),
  ...many(3, { name: 'p', description: 'FSK' }), ...many(9, { name: 'p' })];
assert.ok(taxonomy.splitRecordings(sparse, [taxonomy.SECTION_FACETS[2]]).facet === null,
  'a facet under the coverage floor is rejected');

// ---- the backfill's merge, which decides what production metadata keeps ------
// Importing the script does not run it: main() is guarded on being the entry
// point. This is the highest-consequence function in the recordings work -- it
// rewrites .sigmf-meta objects in a bucket with no undo -- so the rules it
// enforces are pinned here rather than described in a comment.
const { mergeProposal } = await import('../../scripts/backfill-recording-metadata.mjs');

const proposal = {
  global: { 'grworld:category': 'Satellite', 'grworld:collection': 'A set' },
  datetime: '2025-09-08T00:00:00Z',
};

const bare = {
  global: { 'core:datatype': 'cf32_le' },
  captures: [{ 'core:sample_start': 0, 'core:frequency': 145e6 }],
  annotations: [],
};
const filled = mergeProposal(bare, proposal);
assert.equal(filled.changed, true);
assert.equal(filled.metadata.global['grworld:category'], 'Satellite');
assert.equal(filled.metadata.global['core:datatype'], 'cf32_le', 'core fields survive');
assert.equal(filled.metadata.captures[0]['core:datetime'], '2025-09-08T00:00:00Z');
assert.equal(filled.metadata.captures[0]['core:frequency'], 145e6,
  'the rest of the capture survives');
// A declared extension list is what tells a reader the grworld keys are real.
assert.deepEqual(filled.metadata.global['core:extensions'],
  [{ name: 'grworld', version: '1.0.0', optional: true }]);
// The input is never mutated: the caller writes it out as the backup.
assert.equal(bare.global['grworld:category'], undefined);
assert.equal(bare.captures[0]['core:datetime'], undefined);

// A field a human already declared is never overwritten -- the whole reason
// hand-curated recordings can be left in the run.
const curated = mergeProposal({
  global: { 'grworld:category': 'HF Utility' },
  captures: [{ 'core:sample_start': 0, 'core:datetime': '2020-01-01T00:00:00Z' }],
}, proposal);
assert.equal(curated.metadata.global['grworld:category'], 'HF Utility');
assert.equal(curated.metadata.global['grworld:collection'], 'A set',
  'the fields it did not declare are still filled in');
assert.equal(curated.metadata.captures[0]['core:datetime'], '2020-01-01T00:00:00Z',
  'a real capture time outranks the collection date');

// Re-running is a no-op, which is what makes this a publishing step rather than
// a migration: run it after an upload and only the new recordings are touched.
const again = mergeProposal(filled.metadata, proposal);
assert.equal(again.changed, false);
assert.equal(again.metadata.global['core:extensions'].length, 1,
  'the extension entry is not appended twice');

// An empty proposal changes nothing, so a recording that declares everything
// never reaches wrangler at all.
assert.equal(mergeProposal(bare, { global: {}, datetime: null }).changed, false);

// Metadata with no captures array still gets its datetime somewhere valid.
const captureless = mergeProposal({ global: {} }, proposal);
assert.equal(captureless.metadata.captures[0]['core:sample_start'], 0);
assert.equal(captureless.metadata.captures[0]['core:datetime'], '2025-09-08T00:00:00Z');

const grouped = taxonomy.categorize([rec({ name: 'estevez/ao73', description: 'NORAD 1' }),
  rec({ name: 'mystery' })]);
assert.deepEqual(grouped.map(entry => entry.category), ['Satellite', taxonomy.UNSORTED_CATEGORY],
  'the unsorted bucket is always ordered last, and never dropped');

assert.deepEqual(catalog.sigmfFileSourceFormat('cf32_le'), { type: 'complex', vlen: 1 });
assert.deepEqual(catalog.sigmfFileSourceFormat('ci16'), { type: 'short', vlen: 1 });
assert.deepEqual(catalog.sigmfFileSourceFormat('ru8'), { type: 'byte', vlen: 1 });
assert.equal(catalog.sigmfFileSourceFormat('ci16_be'), null);
assert.equal(catalog.isCi16Datatype(' CI16_LE '), true);
assert.equal(catalog.isCi16Datatype('cf32_le'), false);
assert.match(catalog.recordingViewUrl(recording.metadataUrl, recording.downloadUrl, recording.name),
  /^\/recording\/#\/view\/url\/[A-Za-z0-9_-]+\/[A-Za-z0-9_-]+\/collection%2Fcapture%20one$/);

// A recording is linkable by its base key, either SigMF suffix accepted, with
// the separators kept readable — the fragment is parsed by URLSearchParams,
// which splits only on '&' and '='.
assert.equal(catalog.normalizeRecordingKey('collection\\capture.sigmf-meta'), 'collection/capture');
assert.equal(catalog.recordingUrl('collection/capture one.sigmf-data',
  'https://example.test/editor#example=digital%2Fpsk_constellation'),
  'https://example.test/editor#recording=collection/capture%20one');
assert.throws(() => catalog.normalizeRecordingKey('../escape'), /invalid recording key/);
assert.throws(() => catalog.normalizeRecordingKey(''), /invalid recording key/);

assert.equal(catalog.displaySi(1_500_000, 'S/s'), '1.5 MS/s');
assert.equal(catalog.displayBytes(2048), '2.0 KiB');

// Browser integration contracts not represented by the pure catalog module.
const runnerHtml = await readFile(new URL('../../runner/src/runner.html', import.meta.url), 'utf8');
const readerWorker = await readFile(
  new URL('../../runner/src/browser_file_reader.js', import.meta.url), 'utf8');
// View and the copy-link button are built before the unsupported-datatype early
// return, so a recording GR World Recording cannot represent is still viewable.
const card = recordingPaletteSource.slice(recordingPaletteSource.indexOf('function makeRecordingItem'),
  recordingPaletteSource.indexOf('async function buildRecordings'));
const viewControl = card.indexOf("view.onclick");
const unsupported = card.indexOf('add.disabled = true');
assert.ok(viewControl !== -1 && unsupported !== -1 && viewControl < unsupported,
  'the View control is offered even for a datatype GR World Recording cannot represent');
assert.match(card, /view\.onclick = \(\) => openRecordingPreview\(recording\)/,
  'View opens the recording view without dropping a block on the canvas');
assert.match(card, /link\.onclick = \(\) => \{ void copyRecordingUrl\(recording\.name\); \}/,
  'the copy-link button hands out a #recording= link rather than adding the recording');
assert.match(card, /add\.onclick = \(\) =>[\s\S]*?addRecordingBlock\(recording, sourceFormat\)/,
  'adding a recording is an explicit compact-row action');
assert.match(card, /details\.hidden = !details\.hidden/,
  'full metadata and downloads expand without making every catalog row tall');
assert.match(card, /const facts = \[\s*recording\.author,\s*displaySi\(recording\.frequency, 'Hz'\)/,
  'the compact facts put the author first');

// Browsing is categories first, then whatever facet splits the one that was
// opened; search is global from wherever the reader is standing, so it is not
// narrowed by the category they happen to have open.
assert.match(recordingPaletteSource, /const categories = categorize\(recordings\)/);
assert.match(recordingPaletteSource, /const splits = new Map\(categories\.map\(entry =>\s*\n\s*\[entry\.category, splitRecordings\(entry\.recordings\)\] as const\)\)/,
  'the split is computed per category, so a refine chip cannot make its own chips vanish');
assert.match(recordingPaletteSource, /if \(terms\.length\) \{\s*\n\s*renderResults\(query, terms\);\s*\n\s*\} else if \(entry\) \{\s*\n\s*renderCategory\(entry\);\s*\n\s*\} else \{\s*\n\s*renderLanding\(\);/,
  'a query bypasses the hierarchy entirely rather than filtering within it');
assert.match(recordingPaletteSource, /const elsewhere = activeCategory\s*\n\s*\? matched\.filter\(recording => recordingCategory\(recording\) !== activeCategory\) : matched/,
  'what an open category did not match is offered below, never hidden');
// Rebuilt once per recording rather than once per recording per search term.
assert.match(recordingPaletteSource, /const searchText = new WeakMap<ExampleRecording, string>\(\);\s*\n\s*for \(const recording of recordings\) searchText\.set\(recording, recordingSearchText\(recording\)\);/,
  'the search haystack is precomputed');
assert.doesNotMatch(recordingPaletteSource, /terms\.every\(term => recordingSearchText\(recording\)/,
  'and never rebuilt inside the filter');

assert.match(main, /converterId = 'blocks_interleaved_short_to_complex'/);
assert.match(main, /scale_factor: 32767\.0/);
assert.match(main, /bindFlowgraphRecordings\(fg,/);
assert.match(main, /type RunnerInputFile[\s\S]*?kind: 'local'[\s\S]*?kind: 'http'/);
// The three source blocks and the binding each needs on the Run path: GR World
// Recording resolves a key against the bucket index (and the runner derives the
// path from the key itself, so nothing is rewritten), Public HTTP Recording is
// probed for a size and rewritten to a path, File Source is a local File.
assert.equal(catalog.RECORDING_ID, 'wasm_gr_world_recording');
assert.equal(catalog.RECORDING_PARAM, 'recording');
assert.match(main, /const HTTP_RECORDING_ID = 'wasm_public_http_recording'/);
assert.match(main, /await resolveRemoteRecording\(recordingDataPath\(key\)\)/);
assert.match(main, /const path = recordingDataPath\(key\);[\s\S]*?url: recording\.downloadUrl, size: recording\.byteLength/);
assert.match(main, /async function publicHttpFileSize[\s\S]*?method: 'HEAD'[\s\S]*?Range: 'bytes=0-0'/);
const publicSize = main.slice(main.indexOf('async function publicHttpFileSize'),
  main.indexOf('function graphNeedsGracefulStop'));
assert.doesNotMatch(publicSize, /response\.ok[\s\S]{0,120}return size;/,
  'a successful HEAD alone cannot claim that the public recording supports ranges');
assert.match(publicSize, /response\.status !== 206[\s\S]*return null/,
  'the preflight requires an actual one-byte partial response');
// Content-Range is not CORS-safelisted: raw.githubusercontent.com serves ranges
// and hides that header from script, so demanding it refused every recording
// hosted there. The 206 is the proof of range support; HEAD's Content-Length,
// which is safelisted, is allowed to supply the size on its own.
assert.match(publicSize, /return headSize;/,
  'an unreadable Content-Range falls back to the size HEAD reported');
assert.match(main, /const size = url \? await publicHttpFileSize\(url\) : null/);
assert.match(main, /const path = HTTP_RECORDING_PREFIX \+ encodeURIComponent\(url\)/);
assert.match(main, /const HTTP_RECORDING_PREFIX = '\/recordings\/external\/'/);
// File Source is a local file and nothing else, as native GNU Radio's is: no
// path into the bucket, and no URL of its own.
const runBinding = main.slice(main.indexOf('const recordingFiles: RunnerInputFile[] = []'),
  main.indexOf('for (const file of recordingFiles)'));
assert.doesNotMatch(runBinding, /savedPath\.startsWith\('\/recordings\//,
  'File Source no longer resolves a hosted recording');
assert.match(runBinding, /log\(`cannot run: choose a file for "\$\{block\.name\}" with Browse`\)/,
  'a File Source with nothing bound says how to bind it');
assert.doesNotMatch(main, /new Blob\(chunks/);
assert.match(main, /fetch\(recordingsBucketUrl\('index\.json'\), \{ cache: 'no-store' \}\)/);
assert.match(main, /listRecordings: loadExampleRecordings/,
  'Graham discovers recordings from the same live index as the palette');
assert.match(main,
  /readRecordingMetadata:[\s\S]*?find\(item => item\.name === key\)[\s\S]*?fetch\(recording\.metadataUrl, \{ cache: 'no-store' \}\)/,
  'Graham metadata reads resolve an indexed key before fetching its SigMF sidecar');
assert.match(main, /const LOCAL_FILE_PARAMS[\s\S]*?paint_image_source: 'image_file'/);
assert.match(main, /const RUN_BOUND_PARAMS[\s\S]*?\[HTTP_RECORDING_ID\]: HTTP_RECORDING_PARAM/,
  'a public URL is rewritten to its bound path the same way a local file is');
assert.doesNotMatch(runnerHtml, /\.arrayBuffer\(\)/);
assert.match(readerWorker, /MAX_CHUNK_BYTES = 2 \* 1024 \* 1024/);
assert.match(readerWorker, /Range: `bytes=\$\{start\}-\$\{end - 1\}`/);
assert.match(readerWorker, /if \(contentRange &&[\s\S]*?data\.byteLength !== end - start/);
assert.match(runnerHtml,
  /const RUN_RECORDING_TOKEN[\s\S]*message\.recordingToken = RUN_RECORDING_TOKEN;[\s\S]*postMessage\(message, location\.origin\)/,
  'every runner-to-editor message carries the run token and uses an exact target origin');

const library = JSON.parse(await readFile(
  new URL('../public/blocks.json', import.meta.url), 'utf8'));
const blockById = id => (library.blocks || []).find(block => block.id === id);
const imageFile = blockById('paint_image_source')?.params.find(param => param.id === 'image_file');
assert.equal(imageFile?.dtype, 'file_open');

// The recording parameter's dtype is what gives it the chooser in the Properties
// dialog, and the palette has to agree with main.ts about its spelling.
const recordingParam = blockById('wasm_gr_world_recording')
  ?.params.find(param => param.id === 'recording');
assert.equal(recordingParam?.dtype, 'gr_world_recording');
assert.match(main, /const RECORDING_DTYPE = 'gr_world_recording'/);
assert.match(main, /p\.dtype === RECORDING_DTYPE/,
  'the dialog renders that dtype as a chooser over the live recordings index');
// Output Type is the recording's datatype, not a choice: the chooser writes it,
// the dialog shows it disabled, and a datatype with no stream type of its own is
// never offered, since it could not be corrected by hand.
assert.match(main,
  /s\.disabled = \(inst\.id === RECORDING_ID \|\| inst\.id === SIGMF_SOURCE_ID\) &&\s*\n\s*p\.id === 'type'/,
  "the Output Type of a block that reads a recording is shown but not editable");
assert.match(main, /tmp\.params\.type = format\.type;[\s\S]*?node instanceof HTMLSelectElement\) node\.value = format\.type/,
  'choosing a recording writes Output Type and updates the field showing it');
assert.match(main, /recordings\.filter\(recording => sigmfFileSourceFormat\(recording\.datatype\)\)/,
  'only recordings this block can read are offered');
assert.ok(!blockById('wasm_gr_world_recording').params.some(param => param.id === 'vlen'),
  'a recording is a stream of scalar samples: no vector length to set');
assert.match(main, /void loadExampleRecordings\(\)[\s\S]*?\.catch\(error => \{[\s\S]*?typed\.hidden = false;/,
  'an unreachable index degrades the chooser to a text field rather than blocking the dialog');
assert.equal(blockById('wasm_public_http_recording')
  ?.params.find(param => param.id === 'url')?.dtype, 'string');

// Both new blocks reach the runner: the palette marks them runnable, and the
// registry's own manifest lists them.
const supported = new Set(JSON.parse(await readFile(
  new URL('../../runner/generated_blocks.json', import.meta.url), 'utf8')).supported);
for (const id of ['wasm_gr_world_recording', 'wasm_public_http_recording']) {
  assert.equal(blockById(id)?.runnable, true, `${id} is runnable in the palette`);
  assert.ok(supported.has(id), `${id} has a runner factory`);
}

console.log('checked recording catalog, formats, and streaming integration');

// ---- SigMF Source and SigMF Sink: local recordings, metadata and all --------
// Deliberately separate blocks from GR World Recording rather than a mode of it:
// the block title on the canvas is what tells a reader whether a flowgraph's
// samples come from this computer or from the internet.
const sigmf = await bundleModule('../src/sigmf-blocks.ts', {
  define: { 'import.meta.env': JSON.stringify({}) },
});

const file = (name, bytes = 8) => new File([new Uint8Array(bytes)], name);

// A recording is two files, and a browser cannot derive one from the other -- so
// both come out of one picker, and picking half of it says which half is missing
// rather than failing vaguely.
const pair = sigmf.pairSigmfFiles([file('capture.sigmf-meta'), file('capture.sigmf-data')]);
assert.equal(pair.base, 'capture');
assert.equal(pair.data.name, 'capture.sigmf-data');
assert.equal(pair.meta.name, 'capture.sigmf-meta');
assert.match(sigmf.pairSigmfFiles([file('capture.sigmf-data')]).error,
  /Also select capture\.sigmf-meta/,
  'picking one half names the other, which is the mistake everyone makes first');
assert.match(sigmf.pairSigmfFiles([file('a.sigmf-data'), file('a.sigmf-meta'),
                                   file('b.sigmf-data'), file('b.sigmf-meta')]).error,
  /Choose one recording/, 'two complete recordings is ambiguous, not a silent pick');
assert.match(sigmf.pairSigmfFiles([file('notes.txt')]).error, /not part of a SigMF recording/);
assert.match(sigmf.pairSigmfFiles([]).error, /No files selected/);

// The metadata decides Output Type and feeds the samp_rate toggle, so a document
// that cannot supply either is refused here rather than half-configuring a block.
const meta = sigmf.parseSigmfMeta(JSON.stringify({
  global: { 'core:datatype': 'ci16_le', 'core:sample_rate': 2e6 },
  captures: [{ 'core:sample_start': 0, 'core:frequency': 100e6 }],
  annotations: [{ 'core:sample_start': 10 }, { 'core:sample_start': 20 }],
}));
assert.equal(meta.datatype, 'ci16_le');
assert.equal(meta.sampleRate, 2e6);
assert.equal(meta.captures, 1);
assert.equal(meta.annotations, 2);
assert.match(sigmf.parseSigmfMeta('{oops').error, /not valid JSON/);
assert.match(sigmf.parseSigmfMeta('{}').error, /no "global" object/);
assert.match(sigmf.parseSigmfMeta('{"global":{}}').error, /does not say its core:datatype/);
// A rate that is absent, zero or nonsense is "unknown", never published as one.
assert.equal(sigmf.parseSigmfMeta(
  '{"global":{"core:datatype":"cf32_le","core:sample_rate":0}}').sampleRate, null);

// Output Type is derived and disabled, so a datatype with no stream type here
// could not be corrected by hand -- the same rule GR World Recording applies.
assert.equal(sigmf.sigmfStreamFormat('cf32_le').type, 'complex');
assert.equal(sigmf.sigmfStreamFormat('ci16_le').type, 'short');
assert.equal(sigmf.sigmfStreamFormat('cf32_be'), null, 'big-endian has no stream type here');

// The sink's name becomes the stem of two real files in a folder the reader
// chose, so a path separator has to go before getFileHandle() ever sees it.
assert.equal(sigmf.sanitizeSigmfBase('  capture  '), 'capture');
assert.equal(sigmf.sanitizeSigmfBase('take.sigmf-data'), 'take',
  'a suffix typed by hand is not doubled up');
assert.equal(sigmf.sanitizeSigmfBase('../etc/passwd'), '_etc_passwd');
assert.equal(sigmf.sanitizeSigmfBase(''), '');
assert.deepEqual(sigmf.sigmfSinkFileNames('take'), ['take.sigmf-data', 'take.sigmf-meta']);

// Both blocks reach the runner, and their browser-only dtypes match what the
// Properties dialog renders -- the palette and main.ts have to agree on spelling.
for (const id of ['wasm_sigmf_source', 'wasm_sigmf_sink']) {
  assert.equal(blockById(id)?.runnable, true, `${id} is runnable in the palette`);
  assert.ok(supported.has(id), `${id} has a runner factory`);
}
assert.equal(blockById('wasm_sigmf_source')?.params.find(p => p.id === 'file')?.dtype,
  'sigmf_file_open');
assert.equal(blockById('wasm_sigmf_sink')?.params.find(p => p.id === 'file')?.dtype,
  'sigmf_file_save');
assert.match(main, /p\.dtype === SIGMF_OPEN_DTYPE/,
  'the dialog renders the source dtype as a picker that takes both files at once');
assert.match(main, /p\.dtype === SIGMF_SAVE_DTYPE/,
  'the dialog renders the sink dtype as a name plus a folder picker');
assert.match(main, /native\.multiple = true;/,
  'one dialog takes both halves of a recording');
assert.ok(!blockById('wasm_sigmf_source').params.some(p => p.id === 'vlen'),
  'a recording is a stream of scalar samples: no vector length to set');

// Upstream's own SigMF blocks are Python and deprecated there. They stay visible
// and greyed out, with a reason that names the block to use instead.
for (const id of ['blocks_sigmf_source_minimal', 'blocks_sigmf_sink_minimal']) {
  assert.equal(blockById(id)?.runnable, false);
  assert.match(blockById(id)?.unavailable_reason ?? '', /use SigMF (Source|Sink) instead/,
    `${id} points at its replacement rather than looking merely broken`);
}

// "Use as samp_rate" publishes on the way out of the dialog, not as the reader
// clicks: Cancel has to cancel it, and switching the toggle on with a recording
// already bound has to publish too -- not only re-picking the files.
assert.match(main, /function sigmfSampRateToPublish\([\s\S]*?String\(params\.use_samp_rate\) !== 'True'\) return null;/,
  'the toggle is read from committed state');
assert.match(main, /const publish = sigmfSampRateToPublish\(inst\.id, inst\.params, inst\.localFileToken\);\s*\n\s*if \(publish\) applySampRateFromSigmf/,
  'the dialog applies it where it commits, so it is one undo step with the pick');
assert.match(main, /const variable = state\.insts\.find\(i => i\.id === 'variable' && i\.name === 'samp_rate'\);[\s\S]*?if \(!variable\) \{/,
  'a flowgraph whose samp_rate variable was renamed or deleted is told, not given one back');

// An interleaved 16-bit recording is a short stream -- GNU Radio's own
// convention -- and nobody wants one for its own sake. The Recordings palette
// already drops an IShort To Complex beside a ci16 GR World Recording; picking a
// ci16 recording for a SigMF Source does the same, rather than leaving the
// reader to read the hint and wire it up.
assert.match(main, /function attachIShortToComplex\(block: Inst\): boolean \{\s*\n\s*if \(state\.conns\.some\(c => c\.from === block\.uid\)\) return false;/,
  'an output that already goes somewhere is left alone: this only ever adds');
assert.match(main, /state\.conns\.push\(\{ from: block\.uid, fp: 0, to: converter\.uid, tp: 0 \}\);/,
  'the converter arrives already connected');
assert.match(main, /function sigmfNeedsIShortToComplex[\s\S]*?isCi16Datatype\(bound\.datatype\)/,
  'only an interleaved-integer recording gets one');
assert.match(main, /if \(sigmfNeedsIShortToComplex\(inst\.id, inst\.localFileToken\) &&\s*\n\s*attachIShortToComplex\(inst\)\)/,
  'it happens where the dialog commits, so Cancel cancels it and it is one undo step');
assert.match(blockById('wasm_sigmf_source')?.documentation ?? '',
  /adds an IShort To Complex after this block/,
  "the block's own documentation says so");

// Chrome's File System Access blocklist refuses the Downloads folder *itself*
// (kDontBlockChildren: the folder cannot be a directory handle, everything inside
// it can), and says it "contains system files" -- which reads like a bug in this
// app. One place opens the picker, and it carries the options that make that a
// non-event.
assert.match(main, /const dir = await pickOutputDirectory\(\);/g,
  'both call sites go through the one picker helper');
assert.equal((main.match(/\)\.showDirectoryPicker\(/g) || []).length, 0,
  'and nothing calls showDirectoryPicker directly, so the options cannot drift');
assert.match(sigmf.pickOutputDirectory.toString(), /startIn/,
  'the picker opens in Downloads, one "New folder" click from a usable choice');
assert.match(sigmf.pickOutputDirectory.toString(), /id:/,
  'and a stable id makes Chrome reopen the last folder, so this is once per browser');
assert.match(sigmf.SIGMF_OUTPUT_PICKER_HELP, /Downloads folder itself/,
  'a dismissed picker names the restriction rather than looking like nothing happened');
assert.match(blockById('wasm_sigmf_sink')?.documentation ?? '',
  /contains system files/,
  "the block's own documentation explains the message Chrome shows");

// Stopping a flowgraph that writes a recording has to let it finish: unloading
// the frame kills the writer worker with the tail of the capture still in shared
// memory, and with the whole of it where the browser buffers rather than streams.
assert.match(main, /function graphNeedsGracefulStop\(deps: RunSessionDeps\)[\s\S]*?i\.id === SIGMF_SINK_ID/);
assert.match(main, /session\.runningNeedsGracefulStop = graphNeedsGracefulStop\(deps\)/,
  'the running graph records whether it owns a writer before later canvas edits');
assert.match(main, /const finishing = session\.runningNeedsGracefulStop\s*\? requestRunnerShutdown\(deps, frame, session\.activeToken\) : null;/,
  'stop() stays synchronous -- loadFlowgraphAnimated needs the tab switch immediately');
assert.match(main, /if \(session\.active \|\| session\.starting \|\| session\.finishing\)[\s\S]*?return null;/,
  'Execute cannot replace an active runner or one whose recording is still flushing');
assert.match(main, /session\.starting = true;[\s\S]*?try \{[\s\S]*?await prepareFlowgraph[\s\S]*?finally \{[\s\S]*?session\.starting = false;/,
  'overlapping Execute clicks are also refused while permissions and file bindings are prepared');
assert.match(main, /if \(generation !== session\.generation\) return;/,
  'a stale asynchronous unload remains unable to blank a different frame');

const annotationViewer = await readFile(new URL(
  '../src/recording/pages/recording-view/components/annotation/annotation-viewer.tsx', import.meta.url), 'utf8');
assert.match(annotationViewer, /annotation\['core:sample_count'\] \?\? 0/,
  'point annotations without sample_count are rendered instead of becoming undefined');
assert.match(annotationViewer, /capture\?\.\['core:frequency'\] \?\? meta\.getCenterFrequency\(\)/,
  'annotations remain renderable when the captures array is empty');
assert.match(annotationViewer, /const x1 = 0\.25;[\s\S]*const x2 = 0\.75;/,
  'new annotations use normalized horizontal coordinates');

const timeSelector = await readFile(new URL(
  '../src/recording/pages/recording-view/components/time-selector.tsx', import.meta.url), 'utf8');
assert.match(timeSelector, /const fftStride = fftStepSize \+ 1/);
assert.match(timeSelector, /e\.target\.y\(\) \* fftStride/,
  'time cursor drag math includes zoom-out decimation');
const timeMinimap = await readFile(new URL(
  '../src/recording/pages/recording-view/components/time-selector-minimap.tsx', import.meta.url), 'utf8');
assert.match(timeMinimap, /Math\.min\(\s*totalSamples,[\s\S]*Math\.max\(0, y\)/,
  'both minimap handles clamp in sample units from zero through EOF');
const scrollBar = await readFile(new URL(
  '../src/recording/pages/recording-view/components/scroll-bar.tsx', import.meta.url), 'utf8');
assert.match(scrollBar, /Math\.min\(\s*spectrogramHeight,[\s\S]*MINIMUM_SCROLL_HANDLE_HEIGHT_PIXELS/,
  'a short recording cannot make its scroll handle taller than the minimap');

console.log('checked SigMF Source/Sink pairing, metadata, samp_rate and shutdown');
