import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { exampleFiles as files } from './example-files.mjs';
import { bundleModule } from './bundle-module.mjs';
import { editorSource as main, cssSource as css } from './editor-contract-source.mjs';

const examples = await bundleModule('../src/example-catalog.ts');
assert.equal(examples.normalizeExamplePath('digital\\psk_constellation'),
  'digital/psk_constellation.grc');
assert.equal(examples.normalizeExamplePath('PSK_constellation'),
  'digital/psk_constellation.grc', 'old shared links retain their target');
assert.equal(examples.normalizeExamplePath('recording_waterfall_test'),
  'recordings/recording_waterfall.grc', 'old recording links retain their target');
assert.equal(examples.exampleFileName('digital/psk_constellation.grc'),
  'psk_constellation.grc');
assert.equal(examples.encodeExamplePath('folder/a b.grc'), 'folder/a%20b.grc');
assert.deepEqual(examples.summarizeExampleFlowgraph('folder/test.grc', {
  options: { parameters: {
    id: 'test_id', title: 'Test title', author: 'Grace Hopper',
    copyright: 'Public domain', description: 'Tests the example summary.',
  } },
  metadata: { file_format: 1, grc_version: '3.10.12.0' },
  blocks: [{ id: 'source' }, { id: 'sink' }],
  connections: [['source', '0', 'sink', '0']],
}), {
  path: 'folder/test.grc', id: 'test_id', title: 'Test title', author: 'Grace Hopper',
  copyright: 'Public domain', description: 'Tests the example summary.',
  fileFormat: 1, grcVersion: '3.10.12.0',
  blockCount: 2, connectionCount: 1,
});
assert.equal(examples.summarizeExampleFlowgraph('folder/untitled.grc', {
  options: { parameters: { id: '', title: '', comment: 'Upstream comment' } },
}).title, 'untitled');
assert.equal(examples.exampleUrl('digital/psk_constellation.grc',
  'https://example.test/editor?old=1#fg=old'),
  'https://example.test/editor#example=digital%2Fpsk_constellation');
for (const invalid of ['../../etc/passwd', '/absolute', 'a//b', './example'])
  assert.throws(() => examples.normalizeExamplePath(invalid), `accepted ${invalid}`);

assert.ok(files.length, 'no example flowgraphs to link to');
for (const file of [...files, 'collection/subcollection/example.grc']) {
  const url = examples.exampleUrl(file, 'https://example.test/');
  const name = new URLSearchParams(new URL(url).hash.slice(1)).get('example');
  assert.equal(examples.normalizeExamplePath(name), file, `link round trip failed for ${file}`);
}

// ---- the static page generated for each example -----------------------------
// The slug is the only place the .grc's own name and its URL meet, so both
// spellings are pinned here: hyphens for the URL, underscores left alone in the
// file name the editor still fetches.
assert.equal(examples.exampleSlug('fm_loopback'), 'fm-loopback');
assert.equal(examples.exampleSlug('gr-lora_sdr'), 'gr-lora-sdr');
assert.equal(examples.examplePageSlug('analog/fm_loopback.grc'), 'analog/fm-loopback');
assert.equal(examples.examplePageSlug('digital/psk_constellation'), 'digital/psk-constellation');
assert.equal(examples.examplePageUrl('analog/fm_loopback.grc'), '/examples/analog/fm-loopback/');
assert.equal(examples.exampleCategoryUrl('analog/fm_loopback.grc'), '/examples/analog/');
assert.equal(examples.exampleCategoryUrl('loose.grc'), '/examples/',
  'a top-level example belongs to the hub, not to a category of its own');
// Old shared links still name the .grc, and must still resolve to its page.
assert.equal(examples.examplePageUrl('PSK_constellation'), '/examples/digital/psk-constellation/');

// Every example must get a page, and no two may claim the same one -- a
// collision would silently overwrite one flowgraph's page with another's.
const slugs = new Map();
for (const file of files) {
  const slug = examples.examplePageSlug(file);
  assert.ok(!slugs.has(slug), `${file} and ${slugs.get(slug)} both map to /examples/${slug}/`);
  slugs.set(slug, file);
}

// Keep the DOM wiring as a compact integration contract; URL/path rules above
// are exercised through their public functions.
assert.match(main, /link\.onclick = e => \{ e\.stopPropagation\(\); void copyExampleUrl\(file\); \}/);
// The row is an anchor to that page, and only a plain click is taken over.
assert.match(main, /const item = document\.createElement\('a'\); item\.className = 'ex-item'/);
assert.match(main, /item\.href = examplePageUrl\(file\)/);
assert.match(main, /if \(e\.metaKey \|\| e\.ctrlKey \|\| e\.shiftKey \|\| e\.altKey \|\| e\.button !== 0\) return;/);
assert.ok(css.includes('.ex-item.disabled'), 'the anchor has no disabled property to fall back on');
assert.match(main, /history\.replaceState\(null, '', url\)/);
assert.match(main, /const file = currentFileName \|\| 'flowgraph\.grc'/);
assert.match(main, /const example = hash\.get\('example'\)/);
assert.match(main, /fetch\('\/example_flowgraphs\/' \+ encodeExamplePath\(file\)\)/);
assert.ok(css.includes('.ex-link'));
assert.ok(css.includes('.ex-row:hover .ex-link, .ex-link:focus-visible'));

// ---- the generator's own output ---------------------------------------------
// Run it and read what it wrote: the pages are the whole point of the slugs
// above, and the parts that can rot -- the canonical, the embed URL, the block
// table -- are only visible in the emitted HTML.
await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [new URL('../gen/gen_example_pages.mjs', import.meta.url).pathname],
    { stdio: 'ignore' });
  child.once('error', reject);
  child.once('exit', code => code === 0 ? resolve()
    : reject(new Error(`gen_example_pages.mjs exited ${code}`)));
});

const generated = relative => readFile(
  new URL('../public/' + relative, import.meta.url), 'utf8');

const leaf = await generated('examples/analog/fm-loopback/index.html');
assert.match(leaf, /<link rel="canonical" href="https:\/\/gnuradioworld\.com\/examples\/analog\/fm-loopback\/" \/>/);
assert.match(leaf, /<h1>FM Loopback<\/h1>/);
// The embed is the click-to-load one: without both flags the page would pull
// the whole editor bundle on every visit.
assert.ok(leaf.includes('src="/?embed=1&amp;click_to_load=1&amp;zoom=fit#example=analog%2Ffm_loopback"'),
  'the leaf page must frame the editor click-to-load and fitted to the frame');
assert.ok(leaf.includes('href="/#example=analog%2Ffm_loopback"'),
  'the leaf page must link into the editor with the fragment the editor reads');
assert.ok(leaf.includes('href="/example_flowgraphs/analog/fm_loopback.grc"'),
  'the .grc download must point at the file, whose name keeps its underscores');
assert.ok(leaf.includes('Quadrature Demod'), 'blocks are listed by their human labels');
assert.ok(leaf.includes('"@type": "BreadcrumbList"') && leaf.includes('"@type": "SoftwareSourceCode"'));
// Everything out of the .grc is escaped, the flowgraph source included: it is
// the one place a whole file of someone else's text is pasted into the page.
const source = leaf.slice(leaf.indexOf('<pre>') + 5, leaf.indexOf('</pre>'));
assert.ok(source.includes('quadrature_demod'), 'the .grc source is not on the page');
assert.ok(!source.includes('<'), 'unescaped markup reached the source block');

const hub = await generated('examples/index.html');
for (const file of files)
  assert.ok(hub.includes(`href="${examples.examplePageUrl(file)}"`),
    `the hub does not link to ${file}`);

const category = await generated('examples/analog/index.html');
assert.match(category, /<h1>Analog example flowgraphs<\/h1>/);

const sitemap = await generated('sitemap.xml');
assert.ok(sitemap.includes('<loc>https://gnuradioworld.com/</loc>'));
assert.ok(sitemap.includes('<loc>https://gnuradioworld.com/examples/</loc>'));
for (const file of files)
  assert.ok(sitemap.includes(`<loc>https://gnuradioworld.com${examples.examplePageUrl(file)}</loc>`),
    `the sitemap omits ${file}`);

console.log(`example-link: ok (${files.length} examples round-trip and have a page)`);
