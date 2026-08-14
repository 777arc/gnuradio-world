import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { bundleModule } from './bundle-module.mjs';
import { mainSource as main } from './editor-contract-source.mjs';

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
  sample_rate: 2_000_000, number_of_samples: 100, author: 'GNU Radio',
});
assert.ok(recording);
assert.equal(recording.byteLength, 400, 'byte length is derived when the index omits it');
assert.equal(recording.downloadUrl,
  'https://recordings.example.test/collection/capture%20one.sigmf-data');
assert.equal(recording.metadataUrl,
  'https://recordings.example.test/collection/capture%20one.sigmf-meta');
assert.equal(catalog.recordingFromR2Index({ base_filename: '../escape', byte_length: 1 }), null);
assert.equal(catalog.recordingFromR2Index({ base_filename: 'missing-size' }), null);

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

const other = { ...recording, name: 'collection/nested/other' };
const tree = catalog.buildRecordingTree([recording, other]);
assert.equal(catalog.recordingTreeCount(tree), 2);
assert.equal(tree.directories.get('collection').recordings.length, 1);
assert.equal(tree.directories.get('collection').directories.get('nested').recordings.length, 1);
assert.equal(catalog.displaySi(1_500_000, 'S/s'), '1.5 MS/s');
assert.equal(catalog.displayBytes(2048), '2.0 KiB');

// Browser integration contracts not represented by the pure catalog module.
const runnerHtml = await readFile(new URL('../../runner/src/runner.html', import.meta.url), 'utf8');
const readerWorker = await readFile(
  new URL('../../runner/src/browser_file_reader.js', import.meta.url), 'utf8');
// View and the copy-link button are built before the unsupported-datatype early
// return, so a recording GR World Recording cannot represent is still viewable.
const card = main.slice(main.indexOf('function makeRecordingItem'),
  main.indexOf('interface RecordingEntry'));
const viewControl = card.indexOf("view.onclick");
const unsupported = card.indexOf("badge.textContent = 'Unsupported'");
assert.ok(viewControl !== -1 && unsupported !== -1 && viewControl < unsupported,
  'the View control is offered even for a datatype GR World Recording cannot represent');
assert.match(card, /view\.onclick = event => \{ event\.stopPropagation\(\); openRecordingPreview\(recording\); \}/,
  'View opens the recording view without dropping a block on the canvas');
assert.match(card, /link\.onclick = event => \{ event\.stopPropagation\(\); void copyRecordingUrl\(recording\.name\); \}/,
  'the copy-link button hands out a #recording= link rather than adding the recording');
assert.match(card, /closest\('a,button'\)/,
  'keyboard activation of the card ignores its own links and buttons');

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
assert.match(main, /const LOCAL_FILE_PARAMS[\s\S]*?paint_image_source: 'image_file'/);
assert.match(main, /const RUN_BOUND_PARAMS[\s\S]*?\[HTTP_RECORDING_ID\]: HTTP_RECORDING_PARAM/,
  'a public URL is rewritten to its bound path the same way a local file is');
assert.doesNotMatch(runnerHtml, /\.arrayBuffer\(\)/);
assert.match(readerWorker, /MAX_CHUNK_BYTES = 2 \* 1024 \* 1024/);
assert.match(readerWorker, /Range: `bytes=\$\{start\}-\$\{end - 1\}`/);
assert.match(readerWorker, /if \(contentRange &&[\s\S]*?data\.byteLength !== end - start/);

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
assert.match(main, /s\.disabled = inst\.id === RECORDING_ID && p\.id === 'type'/,
  "GR World Recording's Output Type is shown but not editable");
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
