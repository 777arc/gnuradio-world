import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { bundleModule } from './bundle-module.mjs';
import { editorSource as source, markupSource as html } from './editor-contract-source.mjs';

const library = JSON.parse(await readFile(
  new URL('../public/blocks.json', import.meta.url), 'utf8'));
const { installGeneratedBlocks, RUNNABLE } =
  await bundleModule('./_library-entry.ts');
installGeneratedBlocks(library.blocks || []);
const multiply = (library.blocks || []).find(block => block.id === 'blocks_multiply_xx');

assert.equal(multiply?.params?.find(param => param.id === 'type')?.hide, 'part',
  'Multiply IO Type must retain native hide metadata');
assert.match(source, /hide: p\.hide \? String\(p\.hide\) : 'none'/,
  'generated parameters must carry native hide metadata into the editor');
assert.match(source, /const hide = parameterHideValue\(p\.hide, inst\.params\);[\s\S]*?hide !== 'part' && hide !== 'all'/,
  'literal and dynamically evaluated part/all parameters must stay off the block face');
assert.match(source,
  /if \(blockIdVisible\(inst\)\)\s*rows\.unshift\({ id: 'id', l: 'ID: ', v: truncateValue\('ID', inst\.name\) }\)/,
  'blocks that expose their ID must show it on the block face');
assert.match(source,
  /function blockIdVisible\(inst: Inst\): boolean {\s*if \(inst\.id === OPTIONS_ID\) return false;\s*return showAllBlockIds \|\| !!RUNNABLE\[inst\.id\]\?\.showId;/,
  "ID visibility must follow native GRC's show_id flag, with the View toggle as the override, " +
  'and the Options block — whose flowgraph id is derived from its Title — must expose none');
// Native GRC builds the id param `hide: none` for show_id blocks and `hide: all`
// for every other one (grc/core/blocks/_build.py). Variable is the block the
// editor hand-writes, so it carries the flag itself; the rest come from the yaml.
assert.match(source, /label: 'Variable', inputs: 0, outputs: 0, showId: true/,
  "the hand-written Variable schema must keep native GRC's show_id flag");
assert.match(source, /const flags = blockFlags\(block\.flags\);\s*const showId = flags\.includes\('show_id'\)/,
  'generated blocks must take ID visibility from their native flags');
{
  const flagged = (library.blocks || [])
    .filter(block => block.runnable && (block.flags || []).includes('show_id'))
    .map(block => block.id);
  assert.ok(flagged.includes('variable_qtgui_range') && flagged.includes('blocks_probe_signal_x'),
    'the show_id flag must survive into blocks.json for the blocks whose ID is referenced elsewhere');
}
assert.match(source,
  /const visible = visiblePortIndices\(inst, kind\);[\s\S]*?const slot = Math\.max\(0, visible\.indexOf\(i\)\);[\s\S]*?const vSlot = centeredPortSlot\(h, count, slot, PORT_PITCH\)/,
  'each input/output port group must be centered vertically on the block');
assert.match(source,
  /const h = ceilToGrid\(headH \+ bodyH, BLOCK_H_STEP\);[\s\S]*?w = ceilToGrid\(/,
  'block height and width must keep the port group centered on a grid coordinate');
assert.match(source, /const PORT_PITCH = SNAP_GRID_SIZE \* 3;/,
  'ports sit three grid cells apart');
assert.match(source, /centeredPortSlot\(h, count, slot, PORT_PITCH\)/,
  'the drawn port spacing must be the one the block height was sized against');
assert.match(source,
  /function portWidth[\s\S]*?return ceilToGrid\(/,
  'port widths must keep their outer wire attachment edge on the grid');
assert.match(source,
  /textW\(r\.l, PARAM_FONT_SIZE, true\) \+[\s\S]*?textW\(faceRowText\(r\), PARAM_FONT_SIZE\)/,
  'block width must account for bold parameter labels');
// The measured sizes and the drawn ones are two declarations of the same thing;
// a block face is only laid out correctly while they agree.
assert.match(source, /const TITLE_FONT_SIZE = 18, PARAM_FONT_SIZE = 16;/,
  'block text must be measured at the sizes editor.css draws it at');
assert.match(html, /\.blk text\.title {[^}]*font-size:18px/,
  'block titles are the one thing drawn larger than the app-wide 16px');
assert.match(html, /\.blk text\.param {[^}]*font-size:16px/,
  'block parameter rows must use the app-wide text size');
assert.match(source, /l\.setAttribute\('class', 'plabel'\)/,
  'parameter labels and values must have distinct styles');
assert.match(html, /\.blk \.plabel\s*{\s*font-weight:700;\s*}/,
  'parameter labels must render bold');
for (const id of ['title', 'author', 'description']) {
  assert.match(source,
    new RegExp(`id: '${id}', label: '[^']+', type: 'string', def: '' }`),
    `Options ${id} must remain visible on the block face when empty`);
}
// A block with a body -- parameter rows, or the GUI Layout block's grid
// miniature -- keeps its title in the title bar; one with neither centers it.
assert.match(source,
  /const titleY = \(rows\.length \|\| thumb\) \? TITLE_BASELINE\s*\n?\s*: h \/ 2 - \(subtitle \? SUBTITLE_H \/ 2 : 0\)/,
  'a block without visible parameters must center its title vertically');
assert.match(source,
  /if \(!rows\.length && !thumb\) titleAttrs\['dominant-baseline'\] = 'central'/,
  'the GUI Layout thumbnail must use the same title baseline as parameter rows');
// OOT blocks say which gr-* package supplied them. The Embedded Python and
// JavaScript Blocks keep the language subtitles that already explained where
// their instance-specific definitions came from.
assert.equal(RUNNABLE.ham_varicode_rx?.ootModule, 'gr-ham',
  'generated source provenance must reach the canvas definition');
assert.equal(RUNNABLE.blocks_multiply_xx?.ootModule, undefined,
  'an in-tree block must not acquire an OOT subtitle');
assert.match(source, /existing\.ootModule = ootModule/,
  'generated provenance must also merge into a hand-written definition');
assert.match(source,
  /const subtitleFor = \(inst: Inst, d: RunnableDef\) => d\.ootModule \|\|[\s\S]*?EPY_BLOCK_ID \? 'Python'[\s\S]*?JS_BLOCK_ID \? 'JavaScript'/,
  'an OOT subtitle must take precedence while Python and JS retain theirs');
assert.match(source, /const headH = TITLE_H \+ \(subtitle \? SUBTITLE_H : 0\)/,
  'a subtitle must lengthen the title bar, or it collides with the first parameter row');
assert.match(source, /rowsTop\(h, rows\.length, headH\)/,
  'parameter rows must be centered under the title bar the subtitle grew');
assert.match(source, /textW\(subtitle, SUBTITLE_FONT_SIZE\)/,
  'block width must account for the subtitle');
assert.match(html, /\.blk text\.subtitle \{[^}]*font-size:12px/,
  'the subtitle must be drawn at the size main.ts measures it at');
assert.doesNotMatch(html, /\.blk text\.subtitle \{[^}]*font-style:italic/,
  'the subtitle is set apart by size and colour, not by italics');
assert.match(source, /const SUBTITLE_FONT_SIZE = 12, SUBTITLE_H = 14, SUBTITLE_GAP = 14;/,
  'the subtitle must be measured at the size editor.css draws it at');
assert.match(source,
  /if \(rows\.length > MAX_FACE_ROWS\) {[\s\S]*?rows\.length = MAX_FACE_ROWS - 1;[\s\S]*?more parameters/,
  'a face with more parameters than the cap must be cut and say how many it dropped');
assert.match(source, /const y = rowsTop\(h, rows\.length, headH\) \+ i \* ROW_H \+ ROW_BASELINE/,
  'parameter rows must be centered in the body so top and bottom padding match');
// dvbs2_bbheader_bb has 29 face parameters; without the cap it draws ~480px tall.
{
  const visible = param => {
    const hide = String(param.hide || 'none').trim();
    return hide !== 'part' && hide !== 'all' &&
      !/^\$\{\s*['"](none|part|all)['"]\s+if\s+\w+\s*==/.test(hide);
  };
  const tallest = Math.max(...(library.blocks || []).map(block =>
    (block.params || []).filter(p =>
      (!p.category || p.category === 'General') && visible(p)).length));
  assert.ok(tallest > 14,
    'the row cap is only meaningful while some block still has more face parameters than it');
}
assert.doesNotMatch(source, /title \+ underline|GRC draws a rule under/,
  'the web renderer must not claim native GRC has a title separator');
assert.doesNotMatch(source, /svgEl\('line',\s*{\s*x1: '0',\s*y1: String\(TITLE_H\)/,
  'the block title separator must not be drawn');

// Output buffer limits and Comment are native base parameters, not metadata
// repeated in every block YAML. Buffer controls belong at the top of Advanced
// only for DSP blocks with a declared output; Comment is last for every block.
{
  const advanced = id => RUNNABLE[id].params.filter(p => p.category === 'Advanced');
  const sourceAdvanced = advanced('analog_sig_source_x');
  assert.deepEqual(sourceAdvanced.slice(0, 2).map(p => p.id), ['minoutbuf', 'maxoutbuf'],
    'a stream source must expose native Min/Max Output Buffer first on Advanced');
  for (const [index, id, label] of [
    [0, 'minoutbuf', 'Min Output Buffer'],
    [1, 'maxoutbuf', 'Max Output Buffer'],
  ]) {
    const param = sourceAdvanced[index];
    assert.equal(param.id, id);
    assert.equal(param.label, label);
    assert.equal(param.type, 'number');
    assert.equal(param.dtype, 'int');
    assert.equal(param.def, 0);
    assert.equal(param.hide, 'part');
  }
  assert.equal(sourceAdvanced.at(-1).id, 'comment',
    'Comment remains the last field on Advanced, matching native GRC');
  assert.deepEqual(advanced('qtgui_freq_sink_x').slice(0, 2).map(p => p.id),
    ['minoutbuf', 'maxoutbuf'],
    'a declared message output earns the native controls even when hidden');
  assert.deepEqual(advanced('wasm_musical_keyboard_source').slice(0, 2).map(p => p.id),
    ['minoutbuf', 'maxoutbuf'],
    'the SamSonic source must offer the same per-block controls');
  assert.deepEqual(advanced('blocks_null_sink').map(p => p.id), ['comment'],
    'an input-only sink has no output buffer to size');
  assert.deepEqual(advanced('variable').map(p => p.id), ['comment'],
    'native not-DSP variables have no output-buffer controls');
}
assert.match(source,
  /const MIN_OUTPUT_BUFFER_PARAM: ParamDef = \{[\s\S]*?label: 'Min Output Buffer'[\s\S]*?category: 'Advanced'[\s\S]*?hide: 'part'/,
  'Min Output Buffer must use native GRC\'s name and Advanced placement');
assert.match(source,
  /const MAX_OUTPUT_BUFFER_PARAM: ParamDef = \{[\s\S]*?label: 'Max Output Buffer'[\s\S]*?category: 'Advanced'[\s\S]*?hide: 'part'/,
  'Max Output Buffer must use native GRC\'s name and Advanced placement');
assert.match(source,
  /const BLOCK_COMMENT_PARAM: ParamDef = \{[\s\S]*?id: BLOCK_COMMENT_ID,[\s\S]*?label: 'Comment',[\s\S]*?category: 'Advanced',[\s\S]*?hide: 'part',[\s\S]*?multiline: true/,
  'every block must receive native GRC\'s multiline Advanced Comment parameter');
assert.match(source,
  /function installNativeBlockParams\(\)[\s\S]*?def\.params = \[\.\.\.outputBuffers, \.\.\.own, \{ \.\.\.BLOCK_COMMENT_PARAM }\]/,
  'native base parameters must be installed on hand-written and generated block schemas');
assert.ok(source.indexOf('installNativeBlockParams();') < source.indexOf('function addBlock('),
  'base parameters must be installed before the first block instance is created');
assert.match(source,
  /const value = String\(inst\.params\[BLOCK_COMMENT_ID\] \?\? ''\);[\s\S]*?value\.split\(\/\\r\\n\?\|\\n\/\)/,
  'canvas comments must read the native parameter and preserve explicit line breaks');
assert.match(source,
  /comment\.lines\.forEach[\s\S]*?class: 'comment'[\s\S]*?text\.textContent = line/,
  'comments must render below blocks as inert text rather than executable markup');
assert.match(source,
  /label: 'Show Block Comments', run: toggleShowBlockComments, check: \(\) => showBlockComments/,
  'View must expose the native Show Block Comments toggle');
assert.match(source, /let showBlockComments = true;/,
  'block comments must be visible by default like native GRC');
assert.match(source,
  /right = Math\.max\(right, inst\.x \+ Math\.max\(w, comment\.width\)\);[\s\S]*?bottom = Math\.max\(bottom, inst\.y \+ h \+ comment\.height\)/,
  'scroll and zoom extents must include visible comment text');
assert.match(html, /\.blk text\.comment \{[^}]*fill:#444;[^}]*font:14px[^}]*pointer-events:none/,
  'enabled comments must use native-style gray, ordinary text that is not part of block hit testing');
assert.match(html, /\.blk\.disabled text\.comment \{\s*fill:#888;\s*}/,
  'disabled block comments must use native\'s lighter gray');

// The remaining native View display preferences are live toggles rather than
// disabled menu placeholders.
for (const [label, toggle, state] of [
  ['Show parameter expressions in block', 'toggleShowParameterExpressions', 'showParameterExpressions'],
  ['Show parameter value in block', 'toggleShowParameterValues', 'showParameterValues'],
  ['Hide Variables', 'toggleHideVariables', 'hideVariables'],
  ['Auto-Hide Port Labels', 'toggleAutoHidePortLabels', 'autoHidePortLabels'],
  ['Show Properties Field Colors', 'toggleShowPropertiesFieldColors', 'showPropertiesFieldColors'],
]) {
  assert.match(source,
    new RegExp(`label: '${label}', run: ${toggle},[\\s\\S]*?check: \\(\\) => ${state}`),
    `${label} must be implemented and expose its current state`);
}
assert.doesNotMatch(source, /const R_TODO|reason: R_TODO/,
  'no View display preference may remain on the unimplemented path');
assert.match(source,
  /evaluated && showParameterExpressions[\s\S]*?expression:[\s\S]*?showParameterValues \? value : ''/,
  'an evaluated expression must support expression-only and expression=value display modes');
assert.match(source, /expression\.setAttribute\('class', 'pexpr'\)/,
  'a displayed raw expression must have its own block-face style');
assert.match(html, /\.blk text\.pexpr \{[^}]*font-style:italic/,
  'raw expressions must be italic like native GRC');
assert.match(source,
  /function canvasBlockHidden\(inst: Inst\)[\s\S]*?hideVariables && VARIABLE_IDS\.has\(inst\.id\)/,
  'Hide Variables must remove native variable/control blocks from the canvas');
assert.match(html,
  /#canvasWrap\.auto-hide-port-labels \.port-label \{ opacity:0; \}[\s\S]*?#canvasWrap\.auto-hide-port-labels \.port:hover \+ \.port-label \{ opacity:1; \}/,
  'auto-hidden port labels must return while their port is hovered');
assert.match(source, /const PORT_HIDDEN_W = 10;/,
  'auto-hidden ports must contract to native GRC\'s compact width');
assert.match(source,
  /function portWidth[\s\S]*?connectionController\.portLabelHidden\(`\$\{inst\.uid\}:\$\{kind\}:\$\{i\}`\)[\s\S]*?return PORT_HIDDEN_W/,
  'port geometry and therefore its wire endpoint must use the compact width');
assert.match(source,
  /rect\.addEventListener\('pointerenter'[\s\S]*?this\.hoveredPortKey = hoverKey;[\s\S]*?rect\.addEventListener\('pointerleave'[\s\S]*?this\.hoveredPortKey = null;/,
  'hovering a compact port must expand it and leaving must contract it');
assert.match(source,
  /const PROPERTY_FIELD_COLORS:[\s\S]*?complex: '#3399FF'[\s\S]*?string: '#CC66CC'[\s\S]*?raw: '#DDDDDD'/,
  'property fields must use native GRC\'s dtype color palette');
assert.match(html, /\.dlgrow\.dtype-field input,[\s\S]*?background:var\(--dtype-field-color\)/,
  'the dtype color must reach editable property controls');

console.log('checked native block-face parameter visibility and typography');
