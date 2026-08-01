import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
const runnerHtml = await readFile(new URL('../../runner/src/runner.html', import.meta.url), 'utf8');
const readerWorker = await readFile(
  new URL('../../runner/src/browser_file_reader.js', import.meta.url), 'utf8');

assert.match(source, /function isCi16Datatype\([^)]*\)[\s\S]*?\^ci16\(\?:_le\)\?\$/,
  'ci16 and ci16_le recordings must be recognized');
assert.match(source, /converterId = 'blocks_interleaved_short_to_complex'/,
  'ci16 recording insertion must use IShort To Complex');
assert.match(source, /vector_input: 'False'/,
  'IShort To Complex must accept the File Source scalar stream');
assert.match(source, /scale_factor: 32767\.0/,
  'automatically inserted IShort To Complex must normalize ci16 samples');
assert.match(source, /conns\.push\(\{ from: block\.uid, fp: 0, to: converter\.uid, tp: 0 \}\)/,
  'the File Source must be connected to IShort To Complex');
assert.match(source, /function flowgraphRecordingPaths\([^)]*\)[\s\S]*?blocks_file_source[\s\S]*?\/recordings\//,
  'example flowgraphs must discover recording-backed File Sources');
assert.match(source, /loadFlowgraphAnimated\(fg\)[\s\S]*?bindFlowgraphRecordings\(fg,/,
  'opening an example flowgraph must bind its referenced recordings');
assert.match(source, /type RunnerInputFile[\s\S]*?kind: 'local'[\s\S]*?kind: 'http'/,
  'the runner handoff must support local files and remote range sources');
assert.match(source, /remoteRecordingsByPath[\s\S]*?bindRemoteRecording/,
  'recordings must be bound as remote descriptors rather than complete Blobs');
assert.doesNotMatch(source, /new Blob\(chunks/,
  'the editor must never accumulate a complete recording Blob');
assert.match(source, /native\.type = 'file'[\s\S]*?localFilesByToken\.set/,
  'File Source properties must bind a browser-selected local File');
assert.match(source, /fileOverrides\.set\(block\.name, path\)/,
  'local browser paths must only override the temporary run document');
assert.match(source, /badge\.textContent = 'Stream'/,
  'recording cards must describe bounded streaming rather than whole downloads');
assert.doesNotMatch(runnerHtml, /\.arrayBuffer\(\)/,
  'runner startup must not materialize a complete browser File');
assert.match(readerWorker, /MAX_CHUNK_BYTES = 2 \* 1024 \* 1024/,
  'browser reader chunks must have a fixed memory bound');
assert.match(readerWorker, /Range: `bytes=\$\{start\}-\$\{end - 1\}`/,
  'remote recordings must use HTTP byte ranges');
assert.match(readerWorker, /response\.status !== 206[\s\S]*?response\.body\?\.cancel/,
  'a server that ignores Range must be rejected before its body is consumed');

// Discovery and both recording objects come from the live R2 bucket. Nothing
// under example_recordings in the repository or assembled Pages site is used.
assert.match(source, /fetch\(recordingsBucketUrl\('index\.json'\), \{ cache: 'no-store' \}\)/,
  'recording discovery must fetch the live R2 index');
assert.match(source, /metaUrl = recording\.metadataUrl;\s*dataUrl = new URL\(recording\.downloadUrl,/,
  'the recording-view route must use R2 URLs for both objects');
assert.match(source, /addDownloadLink\('meta file', recording\.metadataUrl, recording\.metaFile\)/,
  'the metadata download must point to R2');
assert.doesNotMatch(source, /['"]\/example_recordings/,
  'the editor must not read repository or Pages recording files');
assert.match(source, /base_filename[\s\S]*?number_of_samples[\s\S]*?recordingFromR2Index/,
  'the editor must normalize the Worker index schema');
// Collections use nested R2 keys, so URLs must be encoded a segment at a time.
assert.match(source, /const encodeRecordingPath = \(path: string\): string =>\s*\n?\s*path\.split\('\/'\)\.map\(encodeURIComponent\)\.join\('\/'\)/,
  'recording URLs must be encoded per path segment, not with encodeURIComponent');
assert.match(source, /\$\{RECORDING_VIEW_BASE\}\/view\/url\/\$\{base64Url\(metaUrl\)\}\/\$\{base64Url\(dataUrl\)\}\//,
  "the recording-view route must use its 'url' data source, base64url-encoded");
// Hash routing: Cloudflare Pages serves /recording/ as static files and cannot
// answer arbitrary paths under it with index.html, so the route goes after '#'.
assert.match(source, /const RECORDING_VIEW_BASE = '\/recording\/#'/,
  'the recording-view route must ride in the URL fragment, not the path');
// The recording view is reached through its workspace tab now; the palette
// entry offers only the two download links.
assert.doesNotMatch(source, /open in IQEngine/,
  'the recordings palette must not link out to a separate viewer in a new tab');

console.log('checked ci16 recording block-chain insertion');
