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
assert.equal(catalog.recordingBand(recording.frequency), 'VHF');
assert.equal(catalog.recordingBandLabel('VHF'), '30–300 MHz (VHF)');
assert.equal(catalog.recordingBandLabel('UHF'), '300 MHz–3 GHz (UHF)');
assert.deepEqual(['Baseband / unknown', 'UHF', 'HF', 'VHF', 'MF', 'EHF and above',
  'LF and below', 'SHF'].sort(catalog.compareRecordingBands),
['LF and below', 'MF', 'HF', 'VHF', 'UHF', 'SHF', 'EHF and above',
  'Baseband / unknown']);
assert.equal(catalog.recordingCollection(recording), 'collection');
assert.equal(catalog.recordingDuration(recording), 2);
assert.equal(catalog.displayDuration(2), '2 s');
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
assert.match(main, /function runnerNeedsGracefulStop\(deps: RunSessionDeps\)[\s\S]*?i\.id === SIGMF_SINK_ID/);
assert.match(main, /const finishing = runnerNeedsGracefulStop\(deps\) \? requestRunnerShutdown\(deps, frame\) : null;/,
  'stop() stays synchronous -- loadFlowgraphAnimated needs the tab switch immediately');
assert.match(main, /if \(generation !== session\.generation\) return;/,
  'a Run pressed while a recording is still finishing keeps its own frame');

console.log('checked SigMF Source/Sink pairing, metadata, samp_rate and shutdown');
