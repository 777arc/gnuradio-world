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
  /const visible = visiblePortIndices\(inst, kind\);[\s\S]*?const slot = Math\.max\(0, visible\.indexOf\(i\)\);[\s\S]*?const vSlot = centeredPortSlot\(h, count, slot\)/,
  'each input/output port group must be centered vertically on the block');
assert.match(source,
  /const h = ceilToGrid\(TITLE_H \+ bodyH, PORT_PITCH\);[\s\S]*?w = ceilToGrid\(/,
  'block height and width must keep port attachment points on the grid');
assert.match(source,
  /function portWidth[\s\S]*?return ceilToGrid\(/,
  'port widths must keep their outer wire attachment edge on the grid');
assert.match(source, /textW\(r\.l, 11, true\) \+ textW\(r\.v, 11\)/,
  'block width must account for bold parameter labels');
assert.match(source, /l\.setAttribute\('class', 'plabel'\)/,
  'parameter labels and values must have distinct styles');
assert.match(html, /\.blk \.plabel\s*{\s*font-weight:700;\s*}/,
  'parameter labels must render bold');
for (const id of ['title', 'author', 'description']) {
  assert.match(source,
    new RegExp(`id: '${id}', label: '[^']+', type: 'string', def: '' }`),
    `Options ${id} must remain visible on the block face when empty`);
}
assert.match(source, /y: rows\.length \? '15' : String\(h \/ 2\)/,
  'a block without visible parameters must center its title vertically');
assert.match(source,
  /if \(rows\.length > MAX_FACE_ROWS\) {[\s\S]*?rows\.length = MAX_FACE_ROWS - 1;[\s\S]*?more parameters/,
  'a face with more parameters than the cap must be cut and say how many it dropped');
assert.match(source, /const y = rowsTop\(h, rows\.length\) \+ i \* ROW_H \+ 11/,
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
