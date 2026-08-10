import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { editorSource as source, markupSource as html } from './editor-contract-source.mjs';

const library = JSON.parse(await readFile(
  new URL('../public/blocks.json', import.meta.url), 'utf8'));
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
assert.match(source, /const showId = blockFlags\(block\.flags\)\.includes\('show_id'\)/,
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
  /textW\(r\.l, PARAM_FONT_SIZE, true\) \+ textW\(r\.v, PARAM_FONT_SIZE\)/,
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
assert.match(source,
  /const titleY = rows\.length \? TITLE_BASELINE : h \/ 2 - \(subtitle \? SUBTITLE_H \/ 2 : 0\)/,
  'a block without visible parameters must center its title vertically');
// The Embedded Python Block is the only block whose name, parameters and ports
// come from source the user wrote, so its face says which language that is. The
// measured size and the drawn one are two declarations of one thing, as with the
// title and parameter rows above.
assert.match(source, /const subtitleFor = \(inst: Inst\) => inst\.id === EPY_BLOCK_ID \? 'Python' : ''/,
  'the Python Block is the block that carries a subtitle');
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
assert.match(source, /const SUBTITLE_FONT_SIZE = 12, SUBTITLE_H = 12, SUBTITLE_GAP = 12;/,
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

console.log('checked native block-face parameter visibility and typography');
