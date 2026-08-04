// The palette's three search boxes — Blocks, Example Flowgraphs and SigMF
// Recordings — plus the sticky bar they share, which keeps the query reachable
// however far down the list the reader has scrolled.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { exampleFiles as files, exampleFilePath } from './example-files.mjs';
import { editorSource as source, markupSource as html } from './editor-contract-source.mjs';

// ---- the shared box ---------------------------------------------------------
assert.match(source, /function makePaletteSearch\([\s\S]*?bar\.className = 'palsearch-bar';[\s\S]*?input\.className = 'palsearch';/,
  'every palette search box comes from one helper, so all three behave alike');
// .paltab-panel is the scroll container; the bar sticks against it, and the
// opaque background is what stops rows showing through as they scroll under it.
assert.match(html, /\.paltab-panel \{[^}]*overflow:auto[^}]*\}/,
  'the tab panel has to be the scroll container the search box sticks to');
assert.match(html, /\.palsearch-bar \{[^}]*position:sticky[^}]*\}/,
  'the search box must stay at the top while the list scrolls');
assert.match(html, /\.palsearch-bar \{[^}]*top:0[^}]*\}/,
  'sticky needs an offset to stick at');
assert.match(html, /\.palsearch-bar \{[^}]*flex:none[^}]*\}/,
  'the search box must not shrink when the list scrolls');
assert.match(html, /\.palsearch-bar \{[^}]*background:#[0-9a-f]{6}[^}]*\}/,
  'the sticky bar needs an opaque background or rows scroll through it');

// Each tab builds its own box through the helper and puts it first in the panel.
for (const [placeholder, append] of [
  ['Search blocks…', /blocksPanel\.append\(searchBar, tree\)/],
  ['Search examples…', /panel\.append\(searchBar, bar, list, noMatch\)/],
  ['Search recordings…', /panel\.append\(searchBar, list, noMatch\)/],
]) {
  assert.ok(source.includes(placeholder), `no search box placeholder "${placeholder}"`);
  assert.match(source, append, `the search box goes at the top of the panel (${placeholder})`);
}

// ---- Blocks -----------------------------------------------------------------
assert.match(source, /search\.oninput = \(\) => draw\(search\.value\.trim\(\)\.toLowerCase\(\)\)/,
  'typing in the block search must redraw the tree');

// ---- Example Flowgraphs -----------------------------------------------------
// What it matches: every whitespace-separated term, against one lowercased blob.
assert.match(source, /terms = search\.value\.trim\(\)\.toLowerCase\(\)\.split\(\/\\s\+\/\)\.filter\(Boolean\);\s*refresh\(\);/,
  'typing must re-split the query into terms and redraw');
assert.match(source, /const hit = terms\.every\(t => entry\.text\.includes\(t\)\);/,
  'an example matches only when every search term is found');
assert.match(source, /text: file\.toLowerCase\(\)/,
  'an example is searchable by file name before its .grc has been fetched');
assert.match(source, /entry\.text = \[file, fgTitle, fgAuthor, fgDesc\]\.filter\(Boolean\)\.join\(' '\)\.toLowerCase\(\);/,
  'the searchable text must cover file name, title, author and description');

// Composition with the block filter, and the empty state.
assert.match(source, /if \(!f\) \{ entry\.item\.hidden = !hit; if \(hit\) shown\+\+; continue; \}/,
  'with no block filter the search alone decides what is shown');
assert.match(source, /noMatch\.textContent = `No example flowgraph matches/,
  'a search that matches nothing must say so rather than showing an empty list');
assert.match(source, /noMatch\.hidden = \(!f && !q\) \|\| shown > 0 \|\| pending > 0;/,
  'the empty-state message shows for a search too, not only for a block filter');

// ---- SigMF Recordings -------------------------------------------------------
// The index carries everything the box matches, so nothing waits on a fetch.
assert.match(source, /function recordingSearchText[\s\S]*?\[recording\.name, recording\.author, recording\.datatype\][\s\S]*?\.toLowerCase\(\)/,
  'a recording is searchable by its full key, author and datatype');
assert.match(source, /entries\.push\(\{ item, text: recordingSearchText\(recording\) \}\)/,
  'every rendered recording card must be registered with the search');
assert.match(source, /const hit = terms\.every\(t => entry\.text\.includes\(t\)\);\s*entry\.item\.hidden = !hit;/,
  'a recording matches only when every search term is found');
assert.match(source, /noMatch\.textContent = `No SigMF recording matches/,
  'a recording search that matches nothing must say so');
// Collections are collapsed <details>; a hit inside one has to be reachable.
assert.match(source, /querySelectorAll<HTMLDetailsElement>\('\.rec-directory'\)\]\.reverse\(\)/,
  'directory visibility is decided innermost-first, so a parent sees its children');
assert.match(source, /details\.hidden = !hasVisibleChild;\s*if \(q && hasVisibleChild\) details\.open = true;/,
  'a search must hide empty collections and open the ones holding a match');
assert.match(html, /\.rec-item\[hidden\], \.rec-directory\[hidden\] \{ display:none; \}/,
  'filtered-out recordings and collections must actually disappear');

// Escape is a cheap way out of a query that hides everything, on both list tabs.
const escapes = source.match(/if \(e\.key === 'Escape' && search\.value\) \{[^}]*search\.value = ''; onQuery\(\);/g);
assert.equal(escapes?.length, 2, 'Escape must clear both the example and recording search boxes');

// End-to-end sanity on real data: the fields the search reads are actually
// present in the shipped examples, so a search over them can match something.
assert.ok(files.length, 'no example flowgraphs to check against');
let withTitle = 0, withAuthor = 0, withDesc = 0;
for (const file of files) {
  const text = await readFile(exampleFilePath(file), 'utf8');
  if (/^\s*title: \S/m.test(text)) withTitle++;
  if (/^\s*author: \S/m.test(text)) withAuthor++;
  if (/^\s*(description|comment): \S/m.test(text)) withDesc++;
}
assert.ok(withTitle, 'no example has a title to search');
assert.ok(withAuthor, 'no example has an author to search');
assert.ok(withDesc, 'no example has a description to search');

console.log('palette-search tests passed');
