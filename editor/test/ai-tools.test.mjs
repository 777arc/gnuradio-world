import assert from 'node:assert/strict';
import { bundleModule } from './bundle-module.mjs';

const { dispatchAiTool } = await bundleModule('../src/ai/tools.ts');
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
  listExamples: async () => ['test.grc'],
  readExample: async () => 'options: {}',
  runFlowgraph: async () => ({ started: true }),
};

let result = await dispatchAiTool(deps, 'add_block', { id: 'source', name: 'src' });
assert.equal(result.mutated, true);
await dispatchAiTool(deps, 'add_block', { id: 'sink', name: 'snk' });
await dispatchAiTool(deps, 'connect', { from: 'src', output: 'out', to: 'snk', input: 'in' });
await dispatchAiTool(deps, 'set_params', { name: 'src', params: { rate: 48000 } });
assert.equal(named('src').params.rate, 48000);
assert.equal(connections.length, 1);

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
