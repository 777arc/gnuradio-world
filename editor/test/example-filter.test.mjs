// "Show Examples" on a palette block: filters the Example Flowgraphs tab to the
// examples that instantiate that block, with a visible, clearable banner.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { exampleFiles as files, exampleFilePath } from './example-files.mjs';
import { editorSource as source, markupSource as html } from './editor-contract-source.mjs';

// The entry point: right-clicking a palette block offers exactly this action.
assert.match(source, /item\.oncontextmenu = e => \{[\s\S]*?showPaletteMenu\(e\.clientX, e\.clientY, b\)/,
  'palette blocks must open a context menu on right-click');
assert.match(source, /function showPaletteMenu\([\s\S]*?d\.textContent = 'Show Examples';[\s\S]*?showExamplesFor\(b\.id, b\.label\)/,
  'the palette context menu must offer "Show Examples" for the block');
// The same action on a placed block, from the canvas context menu.
assert.match(source, /item\('Show Examples', \(\) => showExamplesFor\(inst\.id, RUNNABLE\[inst\.id\]\?\.label \|\| inst\.id\)\)/,
  'the canvas context menu must offer "Show Examples" for the block under the cursor');

// It has to switch tabs, and the examples tab is built lazily on first visit, so
// the filter must be set before activation and applied after it.
assert.match(source, /function showExamplesFor\(id: string, label: string\) \{[\s\S]*?exampleFilter = \{ id, label \};[\s\S]*?deps\.activateExamplesTab\(\);[\s\S]*?applyExampleFilter\?\.\(\);/,
  'showExamplesFor must set the filter, switch to the examples tab, then apply it');
assert.match(source, /activatePaletteTab = activate;/,
  'buildPalette must expose its tab activator');

// Matching is by block id against the ids in each example .grc.
assert.match(source, /entry\.blockIds = new Set\(blocks\.map\(\(b: any\) => String\(b\?\.id\)\)\);\s*refresh\(\);/,
  'each example must record its block ids as its .grc arrives, and re-filter');
assert.match(source, /const match = entry\.blockIds\.has\(f\.id\) && hit;\s*entry\.item\.hidden = !match;/,
  'the filter must hide examples that do not use the selected block (or miss the search)');
assert.match(source, /if \(!entry\.blockIds\) \{ entry\.item\.hidden = true; pending\+\+; continue; \}/,
  'examples whose .grc has not arrived yet count as pending, not as matches');
assert.match(source, /entry\.blockIds = new Set\(\); refresh\(\);/,
  'an example that fails to parse must stop counting as pending');

// The filtered state must be obvious, and reversible.
assert.match(source, /Filtered: \$\{shown\} of \$\{exampleEntries\.length\} examples use/,
  'the banner must say the list is filtered and how many examples matched');
assert.match(source, /clear\.textContent = 'Show all';[\s\S]*?clear\.onclick = \(\) => \{ exampleFilter = null; refresh\(\); /,
  '"Show all" must clear the filter and redraw the full list');
assert.match(source, /bar\.hidden = !f;/, 'the banner is only shown while a filter is active');
assert.match(source, /noMatch\.textContent = pending \? '' : `No example flowgraph uses/,
  'a filter that matches nothing must say so rather than showing an empty list');

// .ex-item sets display:block, which beats the UA [hidden] rule unless undone.
// The filter hides the row wrapper (button + copy-link button), so it needs the
// same treatment.
assert.match(html, /\.ex-item\[hidden\], \.ex-row\[hidden\] \{ display:none; \}/,
  'hidden example items must actually be hidden');
assert.match(html, /\.ex-filter \{[^}]*\}/, 'the filter banner needs styling');
assert.match(html, /\.ex-filter-clear \{[^}]*\}/, 'the "Show all" button needs styling');

// End-to-end sanity on real data: the block ids the filter matches on are the
// ones that appear in the shipped examples.
assert.ok(files.length, 'no example flowgraphs to check against');
const ids = new Set();
for (const file of files)
  for (const m of (await readFile(exampleFilePath(file), 'utf8')).matchAll(/^ {4}id: (\S+)\s*$/gm))
    ids.add(m[1]);
const library = JSON.parse(await readFile(new URL('../public/blocks.json', import.meta.url), 'utf8'));
const known = new Set((library.blocks || []).map(b => b.id));
// Every palette block a user can right-click uses the same id space as the
// examples; if these never intersected, "Show Examples" could never match.
assert.ok([...ids].some(id => known.has(id)),
  'example block ids and palette block ids must share an id space');

console.log('example-filter tests passed');
