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
  assert.equal(typeof block.wiki_url, 'string',
    `${block.id} must carry native-style wiki metadata`);
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
assert.equal(byId.get('analog_sig_source_x')?.wiki_url,
  'https://wiki.gnuradio.org/index.php/Signal_Source',
  'in-tree blocks must derive their wiki page from the block label');
assert.equal(byId.get('uhd_fpga_window')?.wiki_url,
  'https://wiki.gnuradio.org/index.php/UHD_FPGA_WINDOW',
  'an explicit block doc_url must override the GNU Radio wiki default');
assert.equal(byId.get('rds_decoder')?.wiki_url, '',
  'OOT blocks without an explicit doc_url must not receive a guessed wiki page');

const source = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
assert.match(source, /'Documentation',\s*\]/,
  'the Properties notebook must include a Documentation tab');
assert.match(source, /addDocs\('Block description', d\.documentation\)/,
  'the Documentation tab must render block-description prose');
assert.match(source, /addDocs\('API documentation', d\.apiDocumentation\)/,
  'the Documentation tab must render extracted source docstrings');
assert.match(source, /wikiLink\.textContent = 'Open Wiki Page for this Block'/,
  'the Documentation tab must offer the requested wiki link');
assert.match(source, /wikiLink\.target = '_blank'/,
  'the wiki link must open outside the properties dialog');
assert.ok(
  source.indexOf("wikiLink.textContent = 'Open Wiki Page for this Block'") <
    source.indexOf("addDocs('Block description', d.documentation)"),
  'the wiki link must appear before generated documentation');
assert.match(source, /content\.textContent = text/,
  'documentation must be inserted as text, not executable HTML');
assert.match(html, /\.props-doc-text\s*{[^}]*white-space:pre-wrap/s,
  'documentation whitespace and paragraphs must be preserved');
assert.match(html, /\.props-wiki-link\s*{[^}]*color:#58a6ff;[^}]*text-decoration:underline/s,
  'the wiki link must be blue and underlined');

console.log('checked generated block documentation and the Properties documentation tab');
