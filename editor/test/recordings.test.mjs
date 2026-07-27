import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');

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
assert.match(source, /loadFlowgraphAnimated\(fg\)[\s\S]*?cacheFlowgraphRecordings\(fg,/,
  'opening an example flowgraph must cache its referenced recordings');
assert.match(source, /recordingDownloadsByFile\.get\(recording\.dataFile\)[\s\S]*?return active\.promise/,
  'concurrent requests for the same recording must share one download');
assert.match(source, /subscribeRecordingState\(recording\.dataFile,[\s\S]*?state\.kind === 'downloaded'[\s\S]*?✓ Downloaded/,
  'recording cards must reflect downloads initiated by example flowgraphs');

console.log('checked ci16 recording block-chain insertion');
