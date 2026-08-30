// Throttle policy: the editor offers upstream's blocks_throttle2 ("Throttle")
// and nothing else, while the deprecated blocks_throttle ("Throttle (old)")
// stays loadable so a native .grc that still uses it opens. Both wrap the same
// gr::blocks::throttle; only throttle2 exposes the limit/maximum cap that keeps
// a low-rate throttle from stalling on a wide buffer.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { exampleFiles, exampleFilePath } from './example-files.mjs';
import { editorSource as source } from './editor-contract-source.mjs';

const library = JSON.parse(await readFile(
  new URL('../public/blocks.json', import.meta.url), 'utf8'));
const byId = new Map((library.blocks || []).map(block => [block.id, block]));

// ---- the replacement is the one that is offered ----
assert.equal(byId.get('blocks_throttle2')?.runnable, true,
  'Throttle (blocks_throttle2) must be runnable in WASM');
const throttle2Params = new Map(byId.get('blocks_throttle2').params.map(p => [p.id, p]));
for (const id of ['type', 'samples_per_second', 'vlen', 'ignoretag', 'limit', 'maximum'])
  assert.ok(throttle2Params.has(id), `Throttle must expose the ${id} parameter`);
assert.deepEqual(throttle2Params.get('limit').options, ['auto', 'time', 'items'],
  'the sleep cap is what makes throttle2 worth standardizing on');

// ---- the deprecated one is hidden but not removed ----
assert.match(source, /const PALETTE_HIDDEN = new Set\(\[[^\]]*'blocks_throttle'/,
  'blocks_throttle must be kept out of the palette');
assert.equal(byId.get('blocks_throttle')?.runnable, true,
  'blocks_throttle must stay runnable so an existing .grc still opens');
// It has no hand-written schema, so it loads with the generated one -- upstream's
// own parameter ids, `samples_per_second` included. There is no table of
// alternate spellings behind that any more: every schema in block-defs.ts uses
// the ids the block's own yaml uses, which is what makes a .grc written here one
// native GRC reads and vice versa.
const throttleParams = new Map(byId.get('blocks_throttle').params.map(p => [p.id, p]));
assert.ok(throttleParams.has('samples_per_second'),
  'the deprecated Throttle keeps upstream\'s rate parameter id');
assert.doesNotMatch(source, /LEGACY_PARAM_IDS/,
  'parameter ids follow upstream, so nothing should need an alias table');

// ---- the default example waits for the palette ----
// Loading a flowgraph needs the generated block schemas installed first.
assert.match(source,
  /paletteReady\.then\(async \(\) => \{[\s\S]{0,1400}loadExampleByName\('digital\/welcome_example\.grc'/,
  'digital/welcome_example.grc must be loaded as the default only after the block library is ready');

// ---- nothing shipped in the repo uses the deprecated block ----
for (const name of exampleFiles) {
  const text = await readFile(exampleFilePath(name), 'utf8');
  assert.doesNotMatch(text, /id: blocks_throttle$/m,
    `${name} must use blocks_throttle2, not the deprecated Throttle (old)`);
}

console.log('checked Throttle standardization and the deprecated block\'s fallback');
