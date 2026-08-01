// Deep links to an example flowgraph: every entry in the Example Flowgraphs tab
// hands out a #example=<name> URL, and opening one loads that example on startup.
// Unlike the #fg= share URL (a frozen gzipped copy of the flowgraph), this
// carries only the relative path, so it always opens the current version.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { exampleFiles as files } from './example-files.mjs';

const source = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

// ---- the link ----
assert.match(source, /function exampleUrl\(file: string\): string \{[\s\S]*?#example=\$\{encodeURIComponent\(file\.replace\(\/\\\.grc\$\/, ''\)\)\}/,
  'exampleUrl must build a #example=<name> fragment off the current page');
assert.match(source, /const base = location\.href\.split\('#'\)\[0\]\.split\('\?'\)\[0\];/,
  'the link must drop any existing fragment/query from the current URL');

// A path that arrives from a URL is untrusted: nested segments are retained,
// but empty, current-directory and parent-directory segments are rejected.
assert.match(source, /function normalizeExamplePath\(name: string\): string \{[\s\S]*?replace\(\/\\\\\/g, '\/'\)[\s\S]*?parts\.some\(part => !part \|\| part === '\.' \|\| part === '\.\.'\)/,
  'normalizeExamplePath must normalize separators and reject traversal paths');
assert.match(source, /if \(!path\.endsWith\('\.grc'\)\) path \+= '\.grc';/,
  'the .grc suffix must be optional in the link');
assert.match(source, /function encodeExamplePath\(path: string\): string \{\s*return path\.split\('\/'\)\.map\(encodeURIComponent\)\.join\('\/'\);/,
  'nested paths must encode each segment without encoding their separators');

// ---- handing it out ----
assert.match(source, /const link = document\.createElement\('button'\); link\.className = 'ex-link';/,
  'each example row needs its own copy-link button');
assert.match(source, /link\.onclick = e => \{ e\.stopPropagation\(\); void copyExampleUrl\(file\); \};/,
  'copying the link must not also load the example (the row underneath is a button)');
assert.match(source, /row\.append\(item, link\);\s*container\.append\(row\);/,
  'the link button must be a sibling of the example button, not nested inside it');
assert.match(source, /const entry: ExampleEntry = \{ file, item: row, blockIds: null,/,
  'the block filter must hide the whole row, not just the example button');
assert.match(html, /\.ex-row \{ position:relative; \}/, 'the row positions the link button');
assert.match(html, /\.ex-link \{[^}]*\}/, 'the copy-link button needs styling');
assert.match(html, /\.ex-row:hover \.ex-link, \.ex-link:focus-visible \{ opacity:[^}]*\}/,
  'the link button must be reachable by hover and by keyboard focus');

// ---- the address bar follows the canvas ----
// Clicking an example puts its link in the URL bar, so it can be copied from
// there and survives a reload.
assert.match(source, /function setExampleHash\(file: string \| null\) \{\s*const url = file \? exampleUrl\(file\) : location\.href\.split\('#'\)\[0\];\s*if \(url !== location\.href\) history\.replaceState\(null, '', url\);/,
  'setExampleHash must rewrite the fragment in place, without adding a history entry');
assert.match(source, /loadFlowgraphAnimated\(fg\);\s*setExampleHash\(file\);\s*setCurrentFileName\(file\);\s*log\(`loaded example "\$\{fgTitle \|\| file\}"`\)/,
  'clicking an example in the palette must update the URL to its link');
// ...and stops claiming an example once the canvas holds something else.
assert.match(source, /ensureOptionsBlock\(\); render\(\);\s*setExampleHash\(null\);/,
  'New/Close must drop a stale #example= from the URL');
assert.match(source, /loadFlowgraph\(parseGrc\(await file\.text\(\)\)\); setExampleHash\(null\);/,
  'opening a .grc file must drop a stale #example= from the URL');

// ---- Save writes back under the same name ----
// Editing an example and saving it must download <example>.grc, not the generic
// flowgraph.grc. Same file name the link carries, through the same helper, so a
// name from a URL cannot become a path. loadFlowgraph() clears it and only the
// callers that know a file name set it again, so no load path inherits a stale one.
assert.match(source, /let currentFileName: string \| null = null;/,
  'the file a Save writes to must be tracked');
assert.match(source, /function setCurrentFileName\(file: string \| null\) \{\s*currentFileName = file \? exampleFileName\(file\) : null;/,
  'Save must keep only the basename even when the example lives in a directory');
assert.match(source, /const file = currentFileName \|\| 'flowgraph\.grc';\s*downloadBlob\(grcText\(\), 'application\/x-yaml', file\);/,
  'saveFlowgraph must download under the current file name, falling back to flowgraph.grc');
assert.match(source, /insts = \[\]; conns = \[\]; counter = 0;\s*\/\/[\s\S]*?setCurrentFileName\(null\);/,
  'loadFlowgraph must clear the name, so a #fg=/#duplicate= load does not inherit one');
assert.match(source, /setExampleHash\(null\);\s*\/\/ the canvas is empty[^\n]*\n\s*setCurrentFileName\(null\);/,
  'New/Close must clear the name');
assert.match(source, /setExampleHash\(file\);\s*\/\/ normalizes[^\n]*\n\s*setCurrentFileName\(file\);/,
  'an example opened from a link must be saved back under its own name');
assert.match(source, /setExampleHash\(null\); setCurrentFileName\(file\.name\);/,
  'a .grc opened from disk must be saved back under its own name');

// ---- opening it ----
assert.match(source, /const example = hash\.get\('example'\);\s*if \(example\) \{[\s\S]*?await loadExampleByName\(example\);/,
  'startup must load the example named in the #example= fragment');
assert.match(source, /catch \(error\) \{ log\(`could not load example "\$\{example\}" from link: \$\{error\}`\); \}/,
  'a bad link must be reported, not thrown away silently');
// Unlike #fg= and #duplicate=, this fragment stays put: it is short, and keeping
// it makes the link bookmarkable and reloadable.
const startup = source.slice(source.indexOf("const example = hash.get('example')"));
assert.ok(!/cleanUrl\(\)/.test(startup.slice(0, startup.indexOf("hash.get('fg')"))),
  'the #example= fragment must survive in the address bar');
assert.match(source, /const res = await fetch\('\/example_flowgraphs\/' \+ encodeExamplePath\(file\)\);\s*if \(!res\.ok\) throw new Error/,
  'loadExampleByName must fetch the example and fail loudly on a 404');
assert.match(source, /loadFlowgraphAnimated\(fg\);\s*\/\/ resets history itself\s*setExampleHash\(file\);/,
  'a linked example must load the same way a clicked one does, and normalize the fragment');
assert.match(source, /void bindFlowgraphRecordings\(fg, title\);/,
  'a linked example must bind the SigMF recordings it references');

// ---- end to end on real data ----
// Every shipped example must be reachable through the round trip a link makes:
// relative path -> #example=<path> -> normalizeExamplePath() -> the same path.
assert.ok(files.length, 'no example flowgraphs to link to');
const normalizeExamplePath = name => {
  let path = String(name).replace(/\\/g, '/');
  if (!path.endsWith('.grc')) path += '.grc';
  const parts = path.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('invalid');
  return parts.join('/');
};
for (const file of [...files, 'collection/subcollection/example.grc']) {
  const url = `https://example.test/#example=${encodeURIComponent(file.replace(/\.grc$/, ''))}`;
  const name = new URLSearchParams(new URL(url).hash.slice(1)).get('example');
  assert.equal(normalizeExamplePath(name), file, `link round trip failed for ${file}`);
}
// And the traversal guard actually holds.
assert.throws(() => normalizeExamplePath('../../etc/passwd'));
assert.throws(() => normalizeExamplePath('/example_flowgraphs/rds_receiver.grc'));

console.log(`example-link: ok (${files.length} examples round-trip)`);
