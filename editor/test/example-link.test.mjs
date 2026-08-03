import assert from 'node:assert/strict';
import { exampleFiles as files } from './example-files.mjs';
import { bundleModule } from './bundle-module.mjs';
import { mainSource as main, cssSource as css } from './editor-contract-source.mjs';

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

// Keep the DOM wiring as a compact integration contract; URL/path rules above
// are exercised through their public functions.
assert.match(main, /link\.onclick = e => \{ e\.stopPropagation\(\); void copyExampleUrl\(file\); \}/);
assert.match(main, /history\.replaceState\(null, '', url\)/);
assert.match(main, /const file = currentFileName \|\| 'flowgraph\.grc'/);
assert.match(main, /const example = hash\.get\('example'\)/);
assert.match(main, /fetch\('\/example_flowgraphs\/' \+ encodeExamplePath\(file\)\)/);
assert.ok(css.includes('.ex-link'));
assert.ok(css.includes('.ex-row:hover .ex-link, .ex-link:focus-visible'));

console.log(`example-link: ok (${files.length} examples round-trip)`);
