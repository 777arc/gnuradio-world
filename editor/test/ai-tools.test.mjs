import assert from 'node:assert/strict';
import { bundleModule } from './bundle-module.mjs';

const { dispatchAiTool, canvasContext, SEED_DEFINITION_LIMIT, SEED_DEFINITION_BYTES, SEED_GRAPH_LIMIT } =
  await bundleModule('../src/ai/tools.ts');
const { runnableIndex, API_DOC_LIMIT } = await bundleModule('../src/ai/catalog.ts');

let uid = 0;
const blocks = [];
const connections = [];
const defs = {
  source: { label: 'Source', inputs: 0, outputs: 1, apiDocumentation: 'x'.repeat(9000), params: [
    { id: 'rate', label: 'Rate', type: 'number', def: 32000 },
  ] },
  sink: { label: 'Sink', inputs: 1, outputs: 0, params: [
    { id: 'label', label: 'Label', type: 'string', def: '' },
  ] },
};
const port = (kind) => ({
  dtype: 'complex', vlen: 1, domain: 'stream', id: '0', name: kind,
  streamIndex: 0, optional: false, hidden: false,
});
const named = name => {
  const found = blocks.find(block => block.name === name);
  if (!found) throw new Error(`no block named "${name}"`);
  return found;
};
const portIndex = (value) => Number(value) === 0 || value === 'out' || value === 'in' ? 0 : -1;

const deps = {
  blocks: () => blocks,
  connections: () => connections,
  entries: () => Object.entries(defs).map(([id, def]) => ({ id, label: def.label, category: 'Test' })),
  definition: value => defs[typeof value === 'string' ? value : value.id],
  ports: (value, kind) => {
    const id = typeof value === 'string' ? value : value.id;
    return kind === 'out' && id === 'source' ? [port('out')]
      : kind === 'in' && id === 'sink' ? [port('in')] : [];
  },
  validate: () => [],
  addBlock(id, requested) {
    const def = defs[id];
    if (!def) throw new Error('not runnable');
    const block = {
      uid: `b${++uid}`, id, name: requested || `${id}_0`, x: 0, y: 0,
      params: Object.fromEntries(def.params.map(param => [param.id, param.def])),
      enabled: true, bypassed: false, rotation: 0,
    };
    blocks.push(block); return block;
  },
  removeBlock(name) {
    const block = named(name); blocks.splice(blocks.indexOf(block), 1);
  },
  setParams(name, params) { Object.assign(named(name).params, params); },
  connect(from, output, to, input) {
    const source = named(from), sink = named(to);
    assert.equal(portIndex(output), 0); assert.equal(portIndex(input), 0);
    connections.push({ from: source.uid, fp: 0, to: sink.uid, tp: 0 });
  },
  disconnect() { connections.length = 0; },
  setEnabled(name, state) {
    const block = named(name); block.enabled = state !== 'disabled'; block.bypassed = state === 'bypassed';
  },
  autoArrange() {},
  replaceFlowgraph() {},
  listExamples: async () => ['digital/test.grc', 'radio/receiver.grc'],
  readExample: async path => path === 'digital/test.grc' ? `
options:
  parameters:
    id: test_graph
    title: Test Modulator
    author: Ada Lovelace
    copyright: Public domain
    description: Demonstrates digital modulation.
blocks:
- id: source
  name: source
- id: sink
  name: sink
connections:
- [source, '0', sink, '0']
metadata:
  file_format: 1
  grc_version: 3.10.12.0` : `
options:
  parameters:
    id: receiver
    title: Radio Receiver
    author: Grace Hopper
    description: Receives an analog radio signal.
blocks:
- id: source
  name: source
connections: []
metadata:
  file_format: 1
  grc_version: 3.10.12.0`,
  listRecordings: async () => [{
    name: 'satellite/ao-73', title: 'AO-73 telemetry', dataFile: 'satellite/ao-73.sigmf-data',
    metaFile: 'satellite/ao-73.sigmf-meta', datatype: 'ci16_le', sampleRate: 2_000_000,
    author: 'GNU Radio', description: 'BPSK satellite packets', frequency: 145_935_000,
    annotationCount: 13, annotationLabels: ['packet'], captureDatetime: '2026-08-25T12:00:00Z',
    category: 'Satellite', tags: ['BPSK', 'telemetry'], sampleCount: 4_000_000,
    byteLength: 16_000_000, downloadUrl: 'https://recordings.test/satellite/ao-73.sigmf-data',
    metadataUrl: 'https://recordings.test/satellite/ao-73.sigmf-meta',
  }, {
    name: 'fm/broadcast', title: 'FM broadcast', dataFile: 'fm/broadcast.sigmf-data',
    metaFile: 'fm/broadcast.sigmf-meta', datatype: 'cf32_le', sampleRate: 2_400_000,
    author: null, description: null, frequency: 99_500_000, annotationCount: 0,
    annotationLabels: [], captureDatetime: null, category: 'Broadcast', tags: ['FM'],
    sampleCount: 1_000_000, byteLength: 8_000_000,
    downloadUrl: 'https://recordings.test/fm/broadcast.sigmf-data',
    metadataUrl: 'https://recordings.test/fm/broadcast.sigmf-meta',
  }],
  readRecordingMetadata: async name => {
    if (!['satellite/ao-73', 'satellite/ao-73.sigmf-meta'].includes(name))
      throw new Error(`no hosted recording named "${name}"; call list_recordings first`);
    const recording = (await deps.listRecordings())[0];
    return { recording, metadata: {
      global: { 'core:datatype': 'ci16_le', 'core:sample_rate': 2_000_000 },
      captures: Array.from({ length: 12 }, (_, index) => ({ 'core:sample_start': index * 100 })),
      annotations: Array.from({ length: 13 }, (_, index) => ({
        'core:sample_start': index * 10, 'core:label': `packet ${index}`,
      })),
      collection: { note: 'top-level extension data is retained' },
    } };
  },
  runFlowgraph: async () => ({ started: true }),
};

let result = await dispatchAiTool(deps, 'add_block', { id: 'source', name: 'src' });
assert.equal(result.mutated, true);
await dispatchAiTool(deps, 'add_block', { id: 'sink', name: 'snk' });
await dispatchAiTool(deps, 'connect', { from: 'src', output: 'out', to: 'snk', input: 'in' });
await dispatchAiTool(deps, 'set_params', { name: 'src', params: { rate: 48000 } });
assert.equal(named('src').params.rate, 48000);
assert.equal(connections.length, 1);

// A batch is one round-trip and one validation pass for a whole change, which
// is what keeps a built-from-scratch graph from costing thirty requests. It
// runs in order, so a block added under an explicit name is connectable in the
// same call.
const batch = await dispatchAiTool(deps, 'apply_edits', { edits: [
  { op: 'add_block', id: 'source', name: 'src2' },
  { op: 'add_block', id: 'sink' },
  { op: 'set_params', name: 'src2', params: { rate: 96000 } },
  { op: 'connect', from: 'src2', output: 'out', to: 'sink_0', input: 'in' },
] });
assert.equal(batch.mutated, true);
assert.equal(batch.value.result.applied, 4);
// Only the names the editor assigned come back: an edit that did exactly what
// it was told tells the model nothing it does not already know.
assert.deepEqual(batch.value.result.added, { src2: 'source', sink_0: 'sink' });
assert.equal(batch.value.result.failed, undefined);
assert.equal(named('src2').params.rate, 96000);
assert.equal(connections.length, 2);
assert.ok(batch.value.validation, 'a batch reports validation once, at the end');

// A later edit usually depends on an earlier one, so the batch stops at the
// first failure instead of finishing around a hole — and says exactly where it
// stopped, because what came before it stays applied.
const partial = await dispatchAiTool(deps, 'apply_edits', { edits: [
  { op: 'add_block', id: 'sink', name: 'keeper' },
  { op: 'set_params', name: 'keeper', params: { nope: 1 } },
  { op: 'remove_block', name: 'keeper' },
] });
assert.equal(partial.value.result.applied, 1);
assert.equal(partial.value.result.failed.index, 1);
assert.equal(partial.value.result.failed.op, 'set_params');
assert.match(partial.value.result.failed.error, /valid ids are label/);
assert.equal(partial.value.result.failed.not_applied, 1);
assert.equal(partial.mutated, true, 'the block that was added is still on the canvas');
assert.ok(named('keeper'), 'and stays there rather than being rolled back');
await dispatchAiTool(deps, 'remove_block', { name: 'keeper' });

// A batch whose very first edit fails changed nothing, so the turn has no
// history entry to commit.
const nothing = await dispatchAiTool(deps, 'apply_edits', { edits: [
  { op: 'wiggle', name: 'src' },
] });
assert.equal(nothing.mutated, false);
assert.equal(nothing.value.result.applied, 0);
assert.match(nothing.value.result.failed.error, /valid ops are add_block/);
await assert.rejects(dispatchAiTool(deps, 'apply_edits', { edits: [] }), /non-empty/);

// Tearing the batch back down leaves the graph the single-edit cases built.
await dispatchAiTool(deps, 'apply_edits', { edits: [
  { op: 'remove_block', name: 'src2' },
  { op: 'remove_block', name: 'sink_0' },
] });
connections.length = 0;
await dispatchAiTool(deps, 'connect', { from: 'src', output: 'out', to: 'snk', input: 'in' });

const graph = await dispatchAiTool(deps, 'get_flowgraph', {});
assert.deepEqual(graph.value.connections, [{ from: 'src', output: 'out', to: 'snk', input: 'in' }]);
assert.deepEqual(graph.value.blocks.find(block => block.name === 'src').params, { rate: 48000 });

await assert.rejects(
  dispatchAiTool(deps, 'set_params', { name: 'src', params: { samp_rate: 1 } }),
  /valid ids are rate/,
  'unknown parameter ids fail loudly instead of being dropped',
);

result = await dispatchAiTool(deps, 'describe_block', { id: 'source' });
assert.equal(result.value.parameters[0].id, 'rate');
assert.equal((await dispatchAiTool(deps, 'validate', {})).value.length, 0);

// The example discovery tool exposes the Options metadata already shown in the
// palette, plus structural counts, without making the model read every .grc.
const exampleList = await dispatchAiTool(deps, 'list_examples', { query: 'ada modulation' });
assert.equal(exampleList.mutated, false);
assert.equal(exampleList.value.total, 2);
assert.equal(exampleList.value.matched, 1);
assert.deepEqual(exampleList.value.examples[0], {
  path: 'digital/test.grc', id: 'test_graph', title: 'Test Modulator',
  author: 'Ada Lovelace', copyright: 'Public domain',
  description: 'Demonstrates digital modulation.', file_format: 1,
  grc_version: '3.10.12.0', number_of_blocks: 2,
  number_of_connections: 1,
});
await assert.rejects(dispatchAiTool(deps, 'list_examples', { limit: 101 }), /limit must be/);
const fullExample = await dispatchAiTool(deps, 'read_example', { path: 'digital/test' });
assert.equal(fullExample.value.number_of_blocks, 2);
assert.equal(fullExample.value.author, 'Ada Lovelace');
assert.match(fullExample.value.grc, /title: Test Modulator/);

// Hosted SigMF examples are discovered from the live index, with a compact
// searchable page rather than an unbounded payload in the system prompt.
const recordingList = await dispatchAiTool(deps, 'list_recordings', { query: 'satellite BPSK' });
assert.equal(recordingList.mutated, false);
assert.equal(recordingList.value.total, 2);
assert.equal(recordingList.value.matched, 1);
assert.equal(recordingList.value.recordings[0].recording, 'satellite/ao-73');
assert.equal(recordingList.value.recordings[0].sample_rate, 2_000_000);
assert.equal(recordingList.value.recordings[0].metadataUrl, undefined,
  'catalog results stay compact; metadata has a dedicated tool');
await assert.rejects(dispatchAiTool(deps, 'list_recordings', { limit: 101 }), /limit must be/);

// SigMF permits unlimited captures and annotations. Ten of each are enough for
// the normal answer; totals and next offsets make the rest explicitly pageable.
const recordingMeta = await dispatchAiTool(
  deps, 'get_recording_metadata', { recording: 'satellite/ao-73' });
assert.equal(recordingMeta.value.metadata.captures.length, 10);
assert.equal(recordingMeta.value.metadata.annotations.length, 10);
assert.equal(recordingMeta.value.metadata.collection.note, 'top-level extension data is retained');
assert.deepEqual(recordingMeta.value.pages.captures,
  { total: 12, offset: 0, returned: 10, next_offset: 10 });
assert.deepEqual(recordingMeta.value.pages.annotations,
  { total: 13, offset: 0, returned: 10, next_offset: 10 });
const laterMeta = await dispatchAiTool(deps, 'get_recording_metadata', {
  recording: 'satellite/ao-73.sigmf-meta', capture_offset: 10, capture_limit: 2,
  annotation_offset: 11, annotation_limit: 2,
});
assert.equal(laterMeta.value.metadata.captures[0]['core:sample_start'], 1000);
assert.equal(laterMeta.value.metadata.annotations[0]['core:label'], 'packet 11');

// Long doxygen prose stays in the transcript for the rest of the turn, so it is
// truncated to a head that names how to read the rest.
assert.ok(result.value.api_documentation.length < 9000, 'api docs are truncated by default');
assert.match(result.value.api_documentation, /full_docs: true/);
const full = await dispatchAiTool(deps, 'describe_block', { id: 'source', full_docs: true });
assert.equal(full.value.api_documentation.length, 9000, 'full_docs returns every character');
assert.ok(API_DOC_LIMIT > 0);

// A mutation reports blocking issues in full and the rest as a count; only
// `validate` pays for the whole list.
const issues = [
  { uid: named('src').uid, field: 'rate', message: 'must be positive', blocking: true },
  { uid: named('src').uid, field: 'rate', message: 'unusually large', blocking: false },
];
const quiet = deps.validate;
deps.validate = () => issues;
const edited = await dispatchAiTool(deps, 'set_params', { name: 'src', params: { rate: 48000 } });
assert.deepEqual(edited.value.validation, {
  blocking: [{ block: 'src', field: 'rate', message: 'must be positive' }],
  non_blocking: 1,
});
assert.equal((await dispatchAiTool(deps, 'validate', {})).value.length, 2);
deps.validate = quiet;

// Every user message carries the canvas and the parameter contract of what is
// on it, because a turn that has to ask for both spends two round-trips before
// it thinks about anything — on payloads the editor already had in hand.
const seed = canvasContext(deps);
assert.match(seed, /\[canvas at the time of this message/);
assert.ok(seed.includes('"name":"src"'), 'the canvas itself is seeded');
assert.ok(seed.includes('"id":"rate"'), 'and the parameters of the types on it');
assert.equal(seed.includes('xxxxxxxxxx'), false, 'but never the doxygen prose');
// The same shape the tool returns, so a model reading one has read the other.
const seededGraph = JSON.parse(seed.slice(seed.indexOf('{'), seed.indexOf('\n\n')));
assert.deepEqual(seededGraph, (await dispatchAiTool(deps, 'get_flowgraph', {})).value);

// It degrades instead of growing without bound, naming the tool that reads what
// it left out — a canvas resent on every message must have a ceiling.
const anyType = {
  ...deps,
  connections: () => [],
  definition: value => defs[typeof value === 'string' ? value : value.id] || defs.sink,
  blocks: () => Array.from({ length: SEED_DEFINITION_LIMIT + 1 }, (_, index) => ({
    ...blocks[0], uid: `many${index}`, name: `many${index}`, id: `type${index}`,
  })),
};
assert.match(canvasContext(anyType), /distinct types on this canvas/);
// One QT GUI sink describes ten traces in six styling parameters each, so a
// seeded definition is a head of its parameters with the rest named — the same
// discipline as the API-doc truncation, for the same reason: this rides along
// on every message of the conversation.
const fat = {
  ...deps,
  connections: () => [],
  blocks: () => [{ ...blocks[0], uid: 'fat', name: 'fat_0', id: 'fat' }],
  definition: () => ({ label: 'Fat', inputs: 0, outputs: 1, params:
    Array.from({ length: 200 }, (_, index) => ({
      id: `p${index}`, label: `Parameter ${index}`, type: 'string', def: 'x'.repeat(20),
    })) }),
};
const fatSeed = canvasContext(fat);
assert.ok(fatSeed.length < SEED_DEFINITION_BYTES, 'a huge type does not swamp the message');
assert.match(fatSeed, /further parameters; call describe_block/);
assert.ok(fatSeed.includes('"p0"'), 'what a block does comes first in GRC order, so the head is kept');
assert.equal(fatSeed.includes('"p199"'), false);

// A canvas the seed cannot read is not a broken message: the tools still can.
assert.match(canvasContext({ ...deps, connections: () => { throw new Error('mid-edit'); } }),
  /call get_flowgraph/);
const wide = { ...deps, connections: () => [], blocks: () => Array.from({ length: 400 }, (_, index) => ({
  ...blocks[0], uid: `wide${index}`, name: `wide${index}`, id: 'source',
})) };
const wideSeed = canvasContext(wide);
assert.ok(wideSeed.length < SEED_GRAPH_LIMIT, 'an oversized canvas is summarized, not resent');
assert.match(wideSeed, /call get_flowgraph to read it/);
assert.match(canvasContext({ ...deps, blocks: () => [] }), /empty/);

// The runnable index names each category once instead of on every one of its
// blocks, which is a quarter of the system prompt it is resent inside.
const index = runnableIndex([
  { id: 'a_one', label: 'One', category: 'Core / Math' },
  { id: 'b_two', label: 'Two', category: 'Core / Math' },
  { id: 'c_three', label: 'Three', category: 'Core / Audio' },
]);
assert.equal(index, [
  'Core / Audio:',
  '  c_three | Three',
  'Core / Math:',
  '  a_one | One',
  '  b_two | Two',
].join('\n'));
assert.equal(index.match(/Core \/ Math/g).length, 1, 'a category is named once');

console.log('ai-tools.test.mjs: ok');
