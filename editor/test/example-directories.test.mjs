import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findExampleFlowgraphs } from '../../scripts/example-flowgraphs.mjs';
import { bundleModule } from './bundle-module.mjs';
import { examplePaletteSource as examples, cssSource as css } from './editor-contract-source.mjs';
import { decodeUrlPath, pathIsWithin } from '../../scripts/http-support.mjs';

const fixture = await mkdtemp(join(tmpdir(), 'example-flowgraphs-'));
try {
  await mkdir(join(fixture, 'radios', 'satellites'), { recursive: true });
  await writeFile(join(fixture, 'root.grc'), 'root');
  await writeFile(join(fixture, 'radios', 'fm.grc'), 'fm');
  await writeFile(join(fixture, 'radios', 'satellites', 'ax25.grc'), 'ax25');
  await writeFile(join(fixture, 'radios', 'notes.txt'), 'ignore');
  assert.deepEqual(await findExampleFlowgraphs(fixture), [
    'radios/fm.grc', 'radios/satellites/ax25.grc', 'root.grc',
  ]);
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const { buildExampleTree, exampleTreeCount } = await bundleModule('../src/example-catalog.ts');
const tree = buildExampleTree(['radios/fm.grc', 'radios/satellites/ax25.grc', 'root.grc']);
assert.equal(exampleTreeCount(tree), 3);
assert.deepEqual(tree.files, ['root.grc']);
assert.deepEqual(tree.directories.get('radios').files, ['radios/fm.grc']);
assert.deepEqual(tree.directories.get('radios').directories.get('satellites').files,
  ['radios/satellites/ax25.grc']);

const server = await readFile(new URL('../../server.mjs', import.meta.url), 'utf8');
const assembler = await readFile(new URL('../../scripts/assemble-site.mjs', import.meta.url), 'utf8');
const harness = await readFile(new URL('../../scripts/run_example.mjs', import.meta.url), 'utf8');
assert.match(server, /await findExampleFlowgraphs\(dir\)/);
assert.equal(decodeUrlPath('/%E0%A4%A'), null,
  'a malformed URL is rejected instead of throwing out of the request handler');
assert.equal(decodeUrlPath('/examples/radio'), '/examples/radio');
assert.equal(pathIsWithin('/tmp/site', '/tmp/site/assets/app.js'), true);
assert.equal(pathIsWithin('/tmp/site', '/tmp/site-secret/token'), false,
  'a sibling whose name shares the root prefix is not inside the served directory');
assert.match(server, /pathIsWithin\(base, resolved\)/);
const pagesServer = await readFile(new URL('../../scripts/serve_site.mjs', import.meta.url), 'utf8');
assert.match(pagesServer, /pathIsWithin\(SITE, direct\)/);
assert.match(assembler, /const grcFiles = await findExampleFlowgraphs\(fgDir\)/);
assert.match(assembler, /await mkdir\(dirname\(destination\), \{ recursive: true \}\)/);
// The folder rows own their styling; they used to borrow the recordings tab's
// classes, which vanished when that tab became a flat catalog and left the
// folder head an unstyled inline run of name and count.
assert.match(examples, /details\.className = 'ex-directory'/);
assert.doesNotMatch(examples, /rec-directory/);
for (const rule of ['.ex-directory-head', '.ex-directory-name', '.ex-directory-count',
  '.ex-directory-contents'])
  assert.ok(css.includes(rule), `no ${rule} rule for the example folder rows`);
assert.match(examples, /if \(\(f \|\| q\) && hasVisibleChild\) details\.open = true/);
assert.ok(css.includes('.ex-directory[hidden]'));
assert.doesNotMatch(harness, /target\.replace\(\/\^\.\*\\\//);
assert.match(harness, /if \(parent instanceof HTMLDetailsElement\) parent\.open = true/);

console.log('example directory discovery, tree, and rendering tests passed');
