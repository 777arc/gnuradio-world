import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { editorSource as source, markupSource as html } from './editor-contract-source.mjs';

const library = JSON.parse(await readFile(
  new URL('../public/blocks.json', import.meta.url), 'utf8'));
const generatedRegistry = await readFile(
  new URL('../../runner/src/generated_registry.cpp', import.meta.url), 'utf8');
const byId = new Map((library.blocks || []).map(block => [block.id, block]));

for (const block of library.blocks || []) {
  assert.equal(typeof block.documentation, 'string',
    `${block.id} must carry YAML documentation metadata`);
  assert.equal(typeof block.api_documentation, 'string',
    `${block.id} must carry source docstring metadata`);
  assert.equal(typeof block.wiki_url, 'string',
    `${block.id} must carry native-style wiki metadata`);
}

assert.match(byId.get('blocks_throttle2')?.api_documentation || '',
  /average rate does\s+not exceed samples_per_sec/,
  'C++ Doxygen class prose must be shipped as API documentation');
assert.match(byId.get('blocks_throttle2')?.api_documentation || '',
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
assert.match(byId.get('wasm_spectrum_analyzer_sink')?.documentation || '',
  /occupied-bandwidth measurement/,
  'the browser-native analyzer must describe its measurements');
const analyzerLevelUnit = byId.get('wasm_spectrum_analyzer_sink')?.params
  .find(param => param.id === 'level_unit');
assert.equal(analyzerLevelUnit?.dtype, 'enum',
  'the Spectrum Analyzer level unit must be a bounded choice');
assert.deepEqual(analyzerLevelUnit?.options, ['dBFS', 'dBm', 'dBµV'],
  'the Spectrum Analyzer must offer relative and calibrated level units');
assert.equal(byId.get('analog_sig_source_x')?.wiki_url,
  'https://wiki.gnuradio.org/index.php/Signal_Source',
  'in-tree blocks must derive their wiki page from the block label');
assert.equal(byId.get('uhd_fpga_window')?.wiki_url,
  'https://wiki.gnuradio.org/index.php/UHD_FPGA_WINDOW',
  'an explicit block doc_url must override the GNU Radio wiki default');
assert.equal(byId.get('rds_decoder')?.wiki_url, '',
  'OOT blocks without an explicit doc_url must not receive a guessed wiki page');

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

// Parameters a QT GUI control can still drive with the flowgraph running.
// gen_registry.py reads them back out of the factories it generates and out of
// registry.cpp's hand-written table, so the palette agrees with the one map the
// runner actually looks a control's parameter up in.
const liveIds = id => (byId.get(id)?.params || [])
  .filter(param => param.live).map(param => param.id).sort();
assert.deepEqual(liveIds('analog_sig_source_x'),
  ['amp', 'freq', 'offset', 'phase', 'samp_rate'],
  'a generated factory\'s numeric setters must reach the palette');
assert.deepEqual(liveIds('wasm_rtlsdr_source'),
  ['bias_tee', 'center_freq', 'freq_correction', 'gain', 'gain_mode'],
  'a hand-written factory\'s setters must too, and its YAML names none of them');
assert.ok(liveIds('qtgui_freq_sink_x').includes('fc'),
  'a QT GUI sink can be retuned while it runs');
assert.ok(!liveIds('analog_sig_source_x').includes('waveform'),
  'a parameter with no setter must not be marked live: the control would ' +
  'move and the block would keep its construction-time value');
const multiplyFactory = generatedRegistry.match(
  /registry\.emplace\("blocks_multiply_const_vxx"[\s\S]*?(?=\n    registry\.emplace\()/)?.[0] || '';
assert.match(multiplyFactory,
  /const bool vector = vlen > 1 &&[\s\S]*?type == "complex"[\s\S]*?numeric_setters\["const"\][\s\S]*?set_k\(gr_complex/,
  'Multiply Const at vlen 1 must use its complex scalar setter even though its hidden mode defaults to vector');
const allBlocks = library.blocks || [];
assert.ok(allBlocks.some(block => (block.params || []).some(param => param.live)) &&
  allBlocks.some(block => (block.params || []).every(param => !param.live)),
  'the flag must distinguish blocks, not be set or cleared everywhere');

assert.match(source, /const liveParams = new Set\(d\.params\.filter\(p => p\.live\)/,
  'the Properties dialog must know which parameters are runtime-changeable');
assert.match(source, /l\.className = 'live-param'/,
  'a runtime-changeable parameter must have its label marked');
assert.match(html, /\.dlgrow label\.live-param\s*{[^}]*text-decoration:underline/s,
  'and underlined, as native GRC underlines a parameter with a callback');

console.log('checked generated block documentation, runtime-changeable parameter ' +
  'marking, and the Properties documentation tab');
