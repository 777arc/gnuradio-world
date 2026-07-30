// Deep links to an example flowgraph: every entry in the Example Flowgraphs tab
// hands out a #example=<name> URL, and opening one loads that example on startup.
// Unlike the #fg= share URL (a frozen gzipped copy of the flowgraph), this
// carries only the file name, so it always opens the current version.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const source = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

// ---- the link ----
assert.match(source, /function exampleUrl\(file: string\): string \{[\s\S]*?#example=\$\{encodeURIComponent\(file\.replace\(\/\\\.grc\$\/, ''\)\)\}/,
  'exampleUrl must build a #example=<name> fragment off the current page');
assert.match(source, /const base = location\.href\.split\('#'\)\[0\]\.split\('\?'\)\[0\];/,
  'the link must drop any existing fragment/query from the current URL');

// A name that arrives from a URL is untrusted: only the file name may survive.
assert.match(source, /function exampleFileName\(name: string\): string \{[\s\S]*?split\(\/\[\\\\\/\]\/\)\.pop\(\)/,
  'exampleFileName must strip any path so a link cannot fetch outside example_flowgraphs/');
assert.match(source, /return base\.endsWith\('\.grc'\) \? base : base \+ '\.grc';/,
  'the .grc suffix must be optional in the link');

// ---- handing it out ----
assert.match(source, /const link = document\.createElement\('button'\); link\.className = 'ex-link';/,
  'each example row needs its own copy-link button');
assert.match(source, /link\.onclick = e => \{ e\.stopPropagation\(\); void copyExampleUrl\(file\); \};/,
  'copying the link must not also load the example (the row underneath is a button)');
assert.match(source, /row\.append\(item, link\);\s*list\.append\(row\);/,
  'the link button must be a sibling of the example button, not nested inside it');
assert.match(source, /const entry: ExampleEntry = \{ file, item: row, blockIds: null \};/,
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
assert.match(source, /loadFlowgraphAnimated\(fg\);\s*setExampleHash\(file\);\s*log\(`loaded example "\$\{fgTitle \|\| file\}"`\)/,
  'clicking an example in the palette must update the URL to its link');
// ...and stops claiming an example once the canvas holds something else.
assert.match(source, /ensureOptionsBlock\(\); render\(\);\s*setExampleHash\(null\);/,
  'New/Close must drop a stale #example= from the URL');
assert.match(source, /loadFlowgraph\(parseGrc\(await file\.text\(\)\)\); setExampleHash\(null\);/,
  'opening a .grc file must drop a stale #example= from the URL');

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
assert.match(source, /const res = await fetch\('\/example_flowgraphs\/' \+ encodeURIComponent\(file\)\);\s*if \(!res\.ok\) throw new Error/,
  'loadExampleByName must fetch the example and fail loudly on a 404');
assert.match(source, /loadFlowgraphAnimated\(fg\);\s*\/\/ resets history itself\s*setExampleHash\(file\);/,
  'a linked example must load the same way a clicked one does, and normalize the fragment');
assert.match(source, /void bindFlowgraphRecordings\(fg, title\);/,
  'a linked example must bind the SigMF recordings it references');

// ---- end to end on real data ----
// Every shipped example must be reachable through the round trip a link makes:
// file name -> #example=<name> -> exampleFileName() -> the same file.
const files = (await readdir(new URL('../../example_flowgraphs/', import.meta.url)))
  .filter(f => f.endsWith('.grc'));
assert.ok(files.length, 'no example flowgraphs to link to');
const fileName = name => {
  const base = String(name).split(/[\\/]/).pop() || '';
  return base.endsWith('.grc') ? base : base + '.grc';
};
for (const file of files) {
  const url = `https://example.test/#example=${encodeURIComponent(file.replace(/\.grc$/, ''))}`;
  const name = new URLSearchParams(new URL(url).hash.slice(1)).get('example');
  assert.equal(fileName(name), file, `link round trip failed for ${file}`);
}
// And the traversal guard actually holds.
assert.equal(fileName('../../etc/passwd'), 'passwd.grc');
assert.equal(fileName('/example_flowgraphs/rds_receiver.grc'), 'rds_receiver.grc');

console.log(`example-link: ok (${files.length} examples round-trip)`);
