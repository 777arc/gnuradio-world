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
// return, so a recording File Source cannot represent is still viewable.
const card = main.slice(main.indexOf('function makeRecordingItem'),
  main.indexOf('interface RecordingEntry'));
const viewControl = card.indexOf("view.onclick");
const unsupported = card.indexOf("badge.textContent = 'Unsupported'");
assert.ok(viewControl !== -1 && unsupported !== -1 && viewControl < unsupported,
  'the View control is offered even for a datatype File Source cannot represent');
assert.match(card, /view\.onclick = event => \{ event\.stopPropagation\(\); openRecordingPreview\(recording\); \}/,
  'View opens the recording view without dropping a File Source on the canvas');
assert.match(card, /link\.onclick = event => \{ event\.stopPropagation\(\); void copyRecordingUrl\(recording\.name\); \}/,
  'the copy-link button hands out a #recording= link rather than adding the recording');
assert.match(card, /closest\('a,button'\)/,
  'keyboard activation of the card ignores its own links and buttons');

assert.match(main, /converterId = 'blocks_interleaved_short_to_complex'/);
assert.match(main, /scale_factor: 32767\.0/);
assert.match(main, /bindFlowgraphRecordings\(fg,/);
assert.match(main, /type RunnerInputFile[\s\S]*?kind: 'local'[\s\S]*?kind: 'http'/);
assert.match(main, /async function publicHttpFileSize[\s\S]*?method: 'HEAD'[\s\S]*?Range: 'bytes=0-0'/);
assert.match(main, /publicUrlSize = await publicHttpFileSize\(savedPath\)/);
assert.match(main, /`\/recordings\/external\/\$\{encodeURIComponent\(savedPath\)\}`/);
assert.doesNotMatch(main, /new Blob\(chunks/);
assert.match(main, /fetch\(recordingsBucketUrl\('index\.json'\), \{ cache: 'no-store' \}\)/);
assert.match(main, /const LOCAL_FILE_PARAMS[\s\S]*?paint_image_source: 'image_file'/);
assert.doesNotMatch(runnerHtml, /\.arrayBuffer\(\)/);
assert.match(readerWorker, /MAX_CHUNK_BYTES = 2 \* 1024 \* 1024/);
assert.match(readerWorker, /Range: `bytes=\$\{start\}-\$\{end - 1\}`/);
assert.match(readerWorker, /if \(contentRange &&[\s\S]*?data\.byteLength !== end - start/);

const library = JSON.parse(await readFile(
  new URL('../public/blocks.json', import.meta.url), 'utf8'));
const imageFile = (library.blocks || []).find(block => block.id === 'paint_image_source')
  ?.params.find(param => param.id === 'image_file');
assert.equal(imageFile?.dtype, 'file_open');

console.log('checked recording catalog, formats, and streaming integration');
