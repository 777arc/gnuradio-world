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

// "open in IQEngine": the link has to carry absolute URLs for BOTH files, since
// the data file can be on R2 while the .sigmf-meta is served from this site.
assert.match(source, /function iqengineViewUrl\([\s\S]*?new URL\(\s*'\/example_recordings\/' \+ encodeURIComponent\(recording\.metaFile\),[\s\S]*?new URL\(recording\.downloadUrl,/,
  'the IQEngine link must resolve both the meta and the data file to absolute URLs');
assert.match(source, /\$\{IQENGINE_BASE\}\/view\/url\/\$\{base64Url\(metaUrl\)\}\/\$\{base64Url\(dataUrl\)\}\//,
  "the IQEngine link must use its 'url' data source route, base64url-encoded");
// Hash routing: Cloudflare Pages serves /iqengine/ as static files and cannot
// answer arbitrary paths under it with index.html, so the route goes after '#'.
assert.match(source, /const IQENGINE_BASE = '\/iqengine\/#'/,
  'the IQEngine route must ride in the URL fragment, not the path');
assert.match(source, /viewLink\.textContent = 'open in IQEngine'[\s\S]*?viewLink\.onclick = event => event\.stopPropagation\(\)/,
  'clicking the IQEngine link must not also drop a File Source on the canvas');

console.log('checked ci16 recording block-chain insertion');
