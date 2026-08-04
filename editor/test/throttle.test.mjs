// Throttle policy: the editor offers upstream's blocks_throttle2 ("Throttle")
// and nothing else, while the deprecated blocks_throttle ("Throttle (old)")
// stays loadable so an existing .grc keeps working. Both wrap the same
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
assert.match(source, /LEGACY_PARAM_IDS[\s\S]{0,400}blocks_throttle: \{ samples_per_second: 'samp_rate' \}/,
  'a .grc written with this editor\'s old `samp_rate` id must keep its rate on load');
assert.match(source, /function importParams\([^)]*blockId\?: string\)/,
  'importParams must receive the block id so it can consult LEGACY_PARAM_IDS');

// ---- the default example waits for the palette ----
// Loading a flowgraph needs the generated block schemas installed first.
assert.match(source,
  /paletteReady\.then\(async \(\) => \{[\s\S]{0,600}loadExampleByName\('digital\/psk_constellation\.grc'\)/,
  'digital/psk_constellation.grc must be loaded as the default only after the block library is ready');

// ---- nothing shipped in the repo uses the deprecated block ----
for (const name of exampleFiles) {
  const text = await readFile(exampleFilePath(name), 'utf8');
  assert.doesNotMatch(text, /id: blocks_throttle$/m,
    `${name} must use blocks_throttle2, not the deprecated Throttle (old)`);
}

console.log('checked Throttle standardization and the deprecated block\'s fallback');
