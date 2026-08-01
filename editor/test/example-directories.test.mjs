import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findExampleFlowgraphs } from '../../scripts/example-flowgraphs.mjs';

// Discovery is recursive and returns portable URL paths, while ignoring files
// that are not flowgraphs.
const fixture = await mkdtemp(join(tmpdir(), 'example-flowgraphs-'));
try {
  await mkdir(join(fixture, 'radios', 'satellites'), { recursive: true });
  await writeFile(join(fixture, 'root.grc'), 'root');
  await writeFile(join(fixture, 'radios', 'fm.grc'), 'fm');
  await writeFile(join(fixture, 'radios', 'satellites', 'ax25.grc'), 'ax25');
  await writeFile(join(fixture, 'radios', 'notes.txt'), 'ignore');
  assert.deepEqual(await findExampleFlowgraphs(fixture), [
    'radios/fm.grc',
    'radios/satellites/ax25.grc',
    'root.grc',
  ]);
} finally {
  await rm(fixture, { recursive: true, force: true });
}

const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const server = await readFile(new URL('../../server.mjs', import.meta.url), 'utf8');
const assembler = await readFile(new URL('../../scripts/assemble-site.mjs', import.meta.url), 'utf8');
const harness = await readFile(new URL('../../scripts/run_example.mjs', import.meta.url), 'utf8');

assert.match(server, /await findExampleFlowgraphs\(dir\)/,
  'the development manifest must use recursive discovery');
assert.match(assembler, /const grcFiles = await findExampleFlowgraphs\(fgDir\)/,
  'the production manifest must use the same recursive discovery');
assert.match(assembler, /await mkdir\(dirname\(destination\), \{ recursive: true \}\);/,
  'site assembly must recreate nested directories before copying files');

assert.match(main, /function buildExampleTree\(files: string\[\]\): ExampleDirectory/,
  'the editor must convert manifest paths into a directory tree');
assert.match(main, /details\.className = 'rec-directory ex-directory'/,
  'example folders must use the same disclosure presentation as recording folders');
assert.match(main, /count\.textContent = `\$\{total\} example/,
  'each example folder must display its recursive item count');
assert.match(main, /if \(\(f \|\| q\) && hasVisibleChild\) details\.open = true;/,
  'search and block filters must expand folders containing matches');
assert.match(html, /\.ex-directory\[hidden\] \{ display:none; \}/,
  'folders without filtered matches must actually disappear');
assert.doesNotMatch(harness, /target\.replace\(\/\^\.\*\\\//,
  'the browser harness must not discard a supplied example directory');
assert.match(harness, /if \(parent instanceof HTMLDetailsElement\) parent\.open = true;/,
  'the browser harness must expand parent folders before clicking a nested example');

console.log('example directory discovery and rendering tests passed');
