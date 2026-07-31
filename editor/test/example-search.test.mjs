// Search box on the Example Flowgraphs tab: matches title, author, description
// and .grc file name, and composes with the "Show Examples" block filter.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const source = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

// The box itself, at the top of the panel — before the filter banner and list.
assert.match(source, /search\.className = 'palsearch ex-search';\s*search\.placeholder = 'Search examples…';/,
  'the examples tab needs a search input styled like the block palette search');
assert.match(source, /panel\.append\(search, bar, list, noMatch\);/,
  'the search box goes at the top of the examples panel');
assert.match(html, /\.ex-search \{[^}]*flex:none[^}]*\}/,
  'the search box must not shrink when the list scrolls');

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
// Escape is a cheap way out of a query that hides everything.
assert.match(source, /if \(e\.key === 'Escape' && search\.value\) \{[^}]*search\.value = ''; onQuery\(\);/,
  'Escape must clear the search box');

// End-to-end sanity on real data: the fields the search reads are actually
// present in the shipped examples, so a search over them can match something.
const dir = new URL('../../example_flowgraphs/', import.meta.url);
const files = (await readdir(dir)).filter(f => f.endsWith('.grc'));
assert.ok(files.length, 'no example flowgraphs to check against');
let withTitle = 0, withAuthor = 0, withDesc = 0;
for (const file of files) {
  const text = await readFile(new URL(file, dir), 'utf8');
  if (/^\s*title: \S/m.test(text)) withTitle++;
  if (/^\s*author: \S/m.test(text)) withAuthor++;
  if (/^\s*(description|comment): \S/m.test(text)) withDesc++;
}
assert.ok(withTitle, 'no example has a title to search');
assert.ok(withAuthor, 'no example has an author to search');
assert.ok(withDesc, 'no example has a description to search');

console.log('example-search tests passed');
