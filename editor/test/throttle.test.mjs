// Throttle policy: the editor offers upstream's blocks_throttle2 ("Throttle")
// and nothing else, while the deprecated blocks_throttle ("Throttle (old)")
// stays loadable so an existing .grc keeps working. Both wrap the same
// gr::blocks::throttle; only throttle2 exposes the limit/maximum cap that keeps
// a low-rate throttle from stalling on a wide buffer.
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';

const source = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
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

// ---- the seeded demo waits for the palette ----
// Throttle has no hand-written RUNNABLE entry, so RUNNABLE learns about it only
// when installGeneratedBlocks() runs. Seeding the demo before that would place
// nothing and leave the startup path throwing on the missing block.
assert.match(source, /paletteReady\.then\(async \(\) => \{[\s\S]{0,200}seedDemoFlowgraph\(\)/,
  'the demo flowgraph must be seeded only after the block library has loaded');
assert.match(source, /const thr = addBlock\('blocks_throttle2'/,
  'the demo must connect the instance addBlock returned, not a position in insts');

// ---- nothing shipped in the repo uses the deprecated block ----
const exampleDir = new URL('../../example_flowgraphs/', import.meta.url);
for (const name of (await readdir(exampleDir)).filter(n => n.endsWith('.grc'))) {
  const text = await readFile(new URL(name, exampleDir), 'utf8');
  assert.doesNotMatch(text, /id: blocks_throttle$/m,
    `${name} must use blocks_throttle2, not the deprecated Throttle (old)`);
}

console.log('checked Throttle standardization and the deprecated block\'s fallback');
