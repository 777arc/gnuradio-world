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
assert.match(byId.get('wasm_adsb_map_sink')?.documentation || '',
  /ADS-B Decoder.*decoded message port/s,
  'the browser-native map must document its message contract');
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

assert.match(source, /'Documentation',\s*\.\.\.\(wikiDocs \? \['Wiki Docs'\] : \[\]\),\s*\]/,
  'the Properties notebook must include a Documentation tab, then Wiki Docs when the block has a page');
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

// ---- the Wiki Docs tab -------------------------------------------------------
// The GNU Radio wiki's page per block, from the snapshot under blocks/wiki/,
// shown in a tab of its own -- only for a block that has one.
import { bundleModule } from './bundle-module.mjs';
import { propertiesDialogSource as dialog, mainSource as main } from './editor-contract-source.mjs';
import { existsSync } from 'node:fs';
const wiki = await bundleModule('../src/wiki-docs.ts');

assert.equal(wiki.hasWikiDoc('analog_agc_xx'), false, 'no page is known before the manifest loads');
await wiki.loadWikiIndex(async () => ({ ok: true, json: async () => ['analog_agc_xx'] }));
assert.equal(wiki.hasWikiDoc('analog_agc_xx'), true);
assert.equal(wiki.hasWikiDoc('blocks_throttle'), false);
assert.equal(wiki.wikiPageUrl('analog_agc_xx'), '/wiki/analog_agc_xx.md');

{
  let fetched = 0;
  const raw = '<!-- block: analog_agc_xx -->\n<!-- title: AGC -->\n\nAutomatic gain control.\n';
  const fetchImpl = async () => { fetched++; return { ok: true, text: async () => raw }; };
  assert.equal(await wiki.loadWikiDoc('analog_agc_xx', fetchImpl), 'Automatic gain control.',
    'header comments are stripped');
  await wiki.loadWikiDoc('analog_agc_xx', fetchImpl);
  assert.equal(fetched, 1, 'a page is fetched once');
  assert.deepEqual(wiki.wikiHeader(raw), { block: 'analog_agc_xx', title: 'AGC' });
  await assert.rejects(wiki.loadWikiDoc('nope', async () => ({ ok: false, status: 404 })), /no wiki page/);
}

// The renderer builds DOM from text alone: a minimal document is enough to
// prove the structure, and that markup in the page stays text.
{
  const made = [];
  const node = tag => ({
    tag, children: [], text: '', tagName: tag.toUpperCase(),
    set textContent(value) { this.text = value; }, get textContent() { return this.text; },
    appendChild(child) { this.children.push(child); return child; },
    append(...items) { this.children.push(...items); },
    get lastElementChild() { return this.children.at(-1) || null; },
  });
  const doc = {
    createDocumentFragment: () => node('#fragment'),
    createElement: tag => { const n = node(tag); made.push(n); return n; },
    createTextNode: text => ({ tag: '#text', text }),
  };
  const out = wiki.renderWikiText([
    '## Usage', 'Set the <b>rate</b> low.', 'for a slow loop.', '',
    '- Rate', '  loop rate', '1. first', '```', 'x = 1', '```', '### Notes', 'done',
  ].join('\n'), doc);
  assert.deepEqual(out.children.map(c => c.tag), ['h3', 'p', 'ul', 'ol', 'pre', 'h4', 'p']);
  assert.equal(out.children[1].text, 'Set the <b>rate</b> low. for a slow loop.', 'markup stays text; lines join');
  assert.equal(out.children[2].children[0].text, 'Rate');
  assert.equal(out.children[2].children[0].children[0].text, ' — loop rate', 'a definition body follows its term');
  assert.equal(out.children[4].text, 'x = 1');
  assert.ok(!made.some(n => n.innerHTML !== undefined), 'nothing is set through innerHTML');
}

assert.match(dialog, /const wikiDocs = hasWikiDoc\(inst\.id\);/, 'the tab depends on the manifest');
assert.match(dialog, /\.\.\.\(wikiDocs \? \['Wiki Docs'\] : \[\]\)/, 'and is absent for a block without a page');
assert.match(dialog, /renderWikiText\(text\)/, 'the page is rendered through the textContent renderer');
assert.doesNotMatch(dialog.slice(dialog.indexOf('if (wikiDocs)')), /innerHTML/, 'never innerHTML');
assert.match(main, /void loadWikiIndex\(\)/, 'the manifest is read at startup');
if (existsSync(new URL('../public/wiki/index.json', import.meta.url))) {
  const { readFile: read } = await import('node:fs/promises');
  const ids = JSON.parse(await read(new URL('../public/wiki/index.json', import.meta.url), 'utf8'));
  assert.ok(ids.every(id => byId.has(id)), 'every published wiki page belongs to a block in the library');
  assert.ok(ids.every(id => existsSync(new URL(`../public/wiki/${id}.md`, import.meta.url))),
    'every manifest entry has its page published beside it');
}

console.log('checked generated block documentation, runtime-changeable parameter ' +
  'marking, the Properties documentation tab, and the Wiki Docs tab');
