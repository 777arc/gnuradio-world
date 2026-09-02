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
  ['Search recordings…', /panel\.append\(searchBar, list, noMatch, moreResults\)/],
]) {
  assert.ok(source.includes(placeholder), `no search box placeholder "${placeholder}"`);
  assert.match(source, append, `the search box goes at the top of the panel (${placeholder})`);
}

// ---- Blocks -----------------------------------------------------------------
assert.match(source, /search\.oninput = \(\) => draw\(search\.value\.trim\(\)\.toLowerCase\(\)\)/,
  'typing in the block search must redraw the tree');
assert.match(source, /TOP_PALETTE_CATEGORY = 'Supported SDRs'/,
  'Supported SDRs must have explicit root-category priority');
assert.match(source, /if \(depth === 0\)[\s\S]*?a === TOP_PALETTE_CATEGORY[\s\S]*?return -1/,
  'Supported SDRs must sort above Core at the root of the block tree');
// Both categories a user reaches for first are open on the first paint; every
// other root stays collapsed until it is clicked or a search matches inside it.
assert.match(source,
  /openByDefault = depth === 0 &&\s*\n?\s*\(child\.name === TOP_PALETTE_CATEGORY \|\| child\.name === CORE_PALETTE_CATEGORY\)/,
  'Supported SDRs and Core must both start expanded');

assert.match(source, /CORE_PALETTE_CATEGORY = 'Core'/,
  'Core must have explicit root-category priority');
assert.match(source, /AFTER_CORE_PALETTE_CATEGORY = 'GNU Radio World'/,
  'GNU Radio World must have explicit after-Core priority');
assert.match(source,
  /a === CORE_PALETTE_CATEGORY[\s\S]*?return -1[\s\S]*?a === AFTER_CORE_PALETTE_CATEGORY[\s\S]*?return -1/,
  'GNU Radio World must sort immediately after Core at the root of the block tree');

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
assert.match(source, /function recordingSearchText[\s\S]*?recording\.title[\s\S]*?recording\.description[\s\S]*?\.\.\.recording\.tags[\s\S]*?\.\.\.recording\.annotationLabels[\s\S]*?recordingBand\(recording\.frequency\)[\s\S]*?\.toLowerCase\(\)/,
  'recording search covers human metadata, catalog tags, annotations and RF band');
assert.match(source, /terms\.every\(term => recordingSearchText\(recording\)\.includes\(term\)\)/,
  'a recording matches only when every search term is found');
assert.match(source, /noMatch\.textContent = query[\s\S]*?No SigMF recording matches/,
  'a recording search that matches nothing must say so');
assert.match(source, /facetOptions\([\s\S]*?'All categories'[\s\S]*?'All bands'[\s\S]*?'All collections'[\s\S]*?'All formats'/,
  'the catalog has category, band, collection and format facets');
assert.match(source, /'All bands',[\s\S]*?compareRecordingBands, recordingBandLabel/,
  'band choices include their numeric frequency ranges in frequency order');
assert.match(source, /checkControl\('Annotated'\)/,
  'annotation filtering is available without a search expression');
assert.doesNotMatch(source, /checkControl\('Runnable'\)/,
  'recordings are expected to be runnable, so runner support is not a discovery facet');
assert.match(source, /function recordingCollection[\s\S]*?Uncollected[\s\S]*?const byCollection[\s\S]*?a === 'Uncollected'[\s\S]*?return -1/,
  'uncollected recordings sort before named collections');
assert.match(source, /const PAGE_SIZE = 50;[\s\S]*?filtered\.slice\(0, visibleLimit\)/,
  'only a bounded batch of matching recording rows is rendered');
assert.match(source, /groupName\(recording, groupValue\)[\s\S]*?className = 'rec-group-title'/,
  'matching recordings can be grouped by their catalog category or stable collection');
assert.match(html, /\.rec-details\[hidden\] \{ display:none; \}/,
  'full recording metadata is collapsed until requested');

// Escape is a cheap way out of a query that hides everything, on both list tabs.
assert.match(source, /if \(event\.key === 'Escape' && search\.value\)[\s\S]*?search\.value = ''; filterChanged\(\);/,
  'Escape clears the recording query and redraws the catalog');

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
