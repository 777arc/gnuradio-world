import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const library = JSON.parse(await readFile(
  new URL('../public/blocks.json', import.meta.url), 'utf8'));
const byId = new Map((library.blocks || []).map(block => [block.id, block]));

for (const block of library.blocks || []) {
  assert.equal(typeof block.documentation, 'string',
    `${block.id} must carry YAML documentation metadata`);
  assert.equal(typeof block.api_documentation, 'string',
    `${block.id} must carry source docstring metadata`);
}

assert.match(byId.get('blocks_throttle')?.api_documentation || '',
  /average rate does\s+not exceed samples_per_sec/,
  'C++ Doxygen class prose must be shipped as API documentation');
assert.match(byId.get('blocks_throttle')?.api_documentation || '',
  /Parameters:\s+itemsize:/,
  'constructor parameter docs must be retained');
assert.match(byId.get('qtgui_time_sink_x')?.api_documentation || '',
  /graphical sink to display multiple signals in time/i,
  'templated include names must resolve to QT GUI API documentation');
assert.match(byId.get('digital_psk_mod')?.api_documentation || '',
  /Hierarchical block for RRC-filtered PSK modulation/,
  'Python hierarchy docstrings must be available for custom WASM implementations');
assert.match(byId.get('wasm_packet_rate_sink')?.documentation || '',
  /throughput of its input stream/,
  'YAML documentation must be retained for browser-only blocks');

const source = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
assert.match(source, /'Documentation',\s*\]/,
  'the Properties notebook must include a Documentation tab');
assert.match(source, /addDocs\('Block description', d\.documentation\)/,
  'the Documentation tab must render block-description prose');
assert.match(source, /addDocs\('API documentation', d\.apiDocumentation\)/,
  'the Documentation tab must render extracted source docstrings');
assert.match(source, /content\.textContent = text/,
  'documentation must be inserted as text, not executable HTML');
assert.match(html, /\.props-doc-text\s*{[^}]*white-space:pre-wrap/s,
  'documentation whitespace and paragraphs must be preserved');

console.log('checked generated block documentation and the Properties documentation tab');
