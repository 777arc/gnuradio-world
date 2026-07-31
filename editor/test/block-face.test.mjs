import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
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
  /if \(inst\.id === 'variable'\)\s*rows\.unshift\({ id: 'id', l: 'ID: ', v: truncateValue\('ID', inst\.name\) }\)/,
  'Variable blocks must show their instance ID on the block face');
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
assert.doesNotMatch(source, /title \+ underline|GRC draws a rule under/,
  'the web renderer must not claim native GRC has a title separator');
assert.doesNotMatch(source, /svgEl\('line',\s*{\s*x1: '0',\s*y1: String\(TITLE_H\)/,
  'the block title separator must not be drawn');

console.log('checked native block-face parameter visibility and typography');
