#!/usr/bin/env node
// Opt-in, networked quality evaluation for Graham's JS Block workflow.
//
//   OPENAI_API_KEY=... node scripts/eval_graham_js_blocks.mjs
//   GRAHAM_EVAL_MODEL=gpt-5.4-mini OPENAI_API_KEY=... node ...
//
// This is deliberately not a CI test: it calls a real model and costs tokens.
// Deterministic tool/runtime behavior remains in the normal test suites; this
// measures whether a model uses those capabilities to create and repair code.
import { readFile } from 'node:fs/promises';
import { bundleModule } from '../editor/test/bundle-module.mjs';

const key = process.env.OPENAI_API_KEY || '';
if (!key) {
  console.error('Set OPENAI_API_KEY to run the opt-in Graham JS Block evaluation.');
  process.exit(2);
}
const model = process.env.GRAHAM_EVAL_MODEL || 'gpt-5.6-luna';
const { FlowgraphAgent } = await bundleModule('../editor/src/ai/agent.ts');
const systemPrompt = await readFile(new URL('../editor/src/ai/system-prompt.md', import.meta.url), 'utf8');
const runtime = await readFile(new URL('../runner/src/js_runtime.js', import.meta.url), 'utf8');
new Function(runtime)();

const describe = source => {
  const result = globalThis.__grJs.describeSource(source);
  if (!result.ok) throw new Error(result.error);
  return result.info;
};

// The quality evaluation is plain Node rather than the browser exercise Worker,
// so give model-written handlers the small PMT vocabulary these cases use. The
// browser-path test covers the complete production bridge.
globalThis.pmt = {
  intern: value => String(value),
  from_long: value => Number(value),
  to_long: value => Number(value),
  cons: (car, cdr) => [car, cdr], car: pair => pair[0], cdr: pair => pair[1],
  make_dict: () => ({}), is_dict: value => !!value && !Array.isArray(value) &&
    typeof value === 'object',
  dict_add: (dict, key, value) => ({ ...dict, [key]: value }),
};

const descriptor = source => {
  let exported = null;
  new Function('gr', '"use strict";\n' + source)({
    export(value) { exported = value; },
    TPP_DONT: 0, TPP_ALL_TO_ALL: 1, TPP_ONE_TO_ONE: 2, TPP_CUSTOM: 3,
  });
  if (!exported) throw new Error('source did not export a descriptor');
  return exported;
};

const Ctors = { complex: Float32Array, float: Float32Array, int: Int32Array,
  short: Int16Array, byte: Int8Array };
const elems = dtype => dtype === 'complex' ? 2 : 1;

function exercise(source, request = {}) {
  const info = describe(source), d = descriptor(source);
  const self = Object.assign(Object.create(d), Object.fromEntries(info.params));
  Object.assign(self, request.params || {});
  const logs = [], handlers = new Map(), published = [], tagsAdded = [];
  const messageInputs = [], messageOutputs = [];
  self.log = (...values) => logs.push(values.join(' '));
  let consumed = [];
  self.consume = (port, count) => { consumed[port] = (consumed[port] || 0) + count; };
  self.message_port_register_in = port => messageInputs.push(String(port));
  self.message_port_register_out = port => messageOutputs.push(String(port));
  self.set_msg_handler = (port, handler) => handlers.set(String(port), handler);
  self.message_port_pub = (port, value) => published.push({ port: String(port), value });
  self.set_tag_propagation_policy = policy => { self.tagPropagation = Number(policy); };
  let inputTags = [], itemsRead = info.inputs.map(() => 0), itemsWritten = info.outputs.map(() => 0);
  self.nitems_read = port => itemsRead[port];
  self.nitems_written = port => itemsWritten[port];
  self.get_tags_in_range = (port, start, end, key) => inputTags.filter(tag =>
    tag.port === port && tag.offset >= start && tag.offset < end &&
    (key === undefined || tag.key === key));
  self.get_tags_in_window = (port, start, end, key) =>
    self.get_tags_in_range(port, itemsRead[port] + start, itemsRead[port] + end, key);
  self.add_item_tag = (port, offset, key, value, srcid = false) =>
    tagsAdded.push({ port, offset, key, value, srcid });
  d.init?.call(self);
  d.start?.call(self);
  for (const message of request.messages || []) {
    const handler = handlers.get(message.port);
    if (!handler) throw new Error(`no handler for message port ${message.port}`);
    handler.call(self, message.value);
  }
  const results = [];
  for (const call of request.calls || [{ nout: 8 }]) {
    Object.assign(self, call.set_params || {});
    consumed = [];
    inputTags = call.tags || [];
    const nout = call.nout || 8;
    const input = info.inputs.map((port, index) => {
      const raw = call.inputs?.[index] || [];
      const count = raw.length || Math.floor(nout * info.decim / info.interp) *
        elems(port.dtype) * port.vlen;
      const view = new Ctors[port.dtype](count);
      view.set(raw.slice(0, count));
      return view;
    });
    const output = info.outputs.map(port =>
      new Ctors[port.dtype](nout * elems(port.dtype) * port.vlen));
    const nin = input.map((view, index) =>
      view.length / (elems(info.inputs[index].dtype) * info.inputs[index].vlen));
    const produced = info.general
      ? d.generalWork.call(self, nout, nin, input, output)
      : d.work.call(self, nout, input, output);
    const result = produced === undefined ? nout : produced;
    results.push({ produced: result,
      consumed: info.general ? info.inputs.map((_, index) => consumed[index] || 0)
        : info.inputs.map(() => Math.floor(result * info.decim / info.interp)),
      outputs: output.map(view => ({ values: Array.from(view).slice(0, 128),
        total_values: view.length })), log: logs.splice(0) });
    const used = results.at(-1).consumed;
    itemsRead = itemsRead.map((value, index) => value + used[index]);
    itemsWritten = itemsWritten.map(value => value + result);
  }
  d.stop?.call(self);
  return { info, calls: results, messages_published: published, tags_added: tagsAdded };
}

function makeDeps(initialSource = '') {
  const blocks = [];
  let counter = 0;
  const install = (name, source) => {
    const io = describe(source);
    let block = blocks.find(item => item.name === name);
    if (!block) {
      block = { uid: `b${++counter}`, id: 'wasm_js_block', name,
        params: {}, enabled: true, bypassed: false, rotation: 0, x: 0, y: 0 };
      blocks.push(block);
    }
    block.source = source; block.io = io;
    block.params = { _source_code: source, _js_io: JSON.stringify(io),
      ...Object.fromEntries(io.params) };
    return block;
  };
  if (initialSource) install('dut', initialSource);
  const block = name => {
    const found = blocks.find(item => item.name === name);
    if (!found) throw new Error(`no block named "${name}"`);
    return found;
  };
  const def = item => ({ label: item.io?.label || 'JS Block',
    inputs: item.io?.inputs?.length || 0, outputs: item.io?.outputs?.length || 0,
    params: [
      { id: '_source_code', label: 'Code', type: 'string', def: '' },
      { id: '_js_io', label: 'JS Interface', type: 'string', def: '' },
      ...(item.io?.params || []).map(([id, value]) => ({ id, label: id,
        type: typeof value === 'number' ? 'number' : 'string', def: value })),
    ] });
  const ports = (item, kind) => (item.io?.[kind === 'in' ? 'inputs' : 'outputs'] || [])
    .map((port, index) => ({ dtype: port.dtype, vlen: port.vlen, domain: 'stream',
      id: String(index), name: `${kind}${index}`, streamIndex: index,
      optional: false, hidden: false }));
  const deps = {
    blocks: () => blocks, connections: () => [],
    entries: () => [{ id: 'wasm_js_block', label: 'JS Block',
      category: 'Core / Misc', javascript: true }],
    definition: value => {
      if (typeof value !== 'string') return def(value);
      return value === 'wasm_js_block' ? def({ io: { inputs: [], outputs: [], params: [] } }) : undefined;
    },
    ports: (value, kind) => ports(typeof value === 'string'
      ? { io: { inputs: [], outputs: [] } } : value, kind),
    validate: () => [],
    addBlock: (_id, name) => install(name || `wasm_js_block_${counter}`, `gr.export({outputs:['float'],work(n,out){out[0].fill(0);return n;}});`),
    removeBlock: name => { blocks.splice(blocks.indexOf(block(name)), 1); return { removed: true }; },
    setParams: (name, params) => Object.assign(block(name).params, params),
    connect() {}, disconnect() {}, setEnabled() {}, autoArrange() {}, replaceFlowgraph() {},
    clearFlowgraph() { blocks.length = 0; },
    listExamples: async () => [], readExample: async () => '',
    listRecordings: async () => [],
    readRecordingMetadata: async () => ({ recording: {}, metadata: {} }),
    inspectJsBlock: async name => {
      const item = block(name);
      return { name, source: item.source, descriptor: item.io, warnings: [] };
    },
    createJsBlock: async (name, source) => {
      const item = install(name || `wasm_js_block_${counter}`, source);
      return { name: item.name, descriptor: item.io, warnings: [] };
    },
    setJsBlockSource: async (name, source) => {
      const item = install(name, source);
      return { name, descriptor: item.io, warnings: [] };
    },
    forkJsBlock: async () => { throw new Error('no repository block in this evaluation'); },
    exerciseJsBlock: async args => {
      const source = args.source || block(args.name).source;
      return exercise(source, args);
    },
    saveJsBlock: async (name, id) => ({ installed: true, name, id }),
    runFlowgraph: async () => ({ started: true, note: 'Use exercise_js_block for this evaluation.' }),
    // No runner here, so nothing to look at or read; `capture_plots` is not even
    // offered, because this harness leaves `vision` off.
    capturePlots: async () => { throw new Error('there is no running flowgraph in this evaluation'); },
    readPlotData: async () => { throw new Error('there is no running flowgraph in this evaluation'); },
  };
  return { deps, blocks };
}

const close = (actual, expected, tolerance = 1e-5) =>
  actual.length === expected.length && actual.every((value, index) =>
    Math.abs(value - expected[index]) <= tolerance);

const CASES = [
  {
    name: 'create complex gain',
    prompt: 'Create an inline JS Block named dut with complex input/output and numeric gain default 2. Exercise it on two complex samples before finishing.',
    check(source) {
      const run = exercise(source, { params: { gain: 3 },
        calls: [{ nout: 2, inputs: [[1, 2, -1, 0.5]] }] });
      return close(run.calls[0].outputs[0].values, [3, 6, -3, 1.5]);
    },
  },
  {
    name: 'modify while preserving parameter',
    initial: `gr.export({inputs:['float'],outputs:['float'],params:{gain:2},work(n,i,o){for(let k=0;k<n;k++)o[0][k]=i[0][k]*this.gain;return n;}});`,
    prompt: 'Modify dut to add numeric bias default 1 after the gain. Keep gain and the float interface, and exercise the result.',
    check(source) {
      const run = exercise(source, { params: { gain: 3, bias: -1 },
        calls: [{ nout: 3, inputs: [[1, 2, 3]] }] });
      return close(run.calls[0].outputs[0].values, [2, 5, 8]);
    },
  },
  {
    name: 'repair general consumption',
    initial: `gr.export({inputs:['float'],outputs:['float'],generalWork(n,nin,i,o){const k=Math.min(n,nin[0]);for(let x=0;x<k;x++)o[0][x]=i[0][x];return k;}});`,
    prompt: 'Debug dut: it produces samples but stalls because its general block does not consume. Fix it and exercise four float samples.',
    check(source) {
      const run = exercise(source, { calls: [{ nout: 4, inputs: [[1, 2, 3, 4]] }] });
      return run.calls[0].produced === 4 && run.calls[0].consumed[0] === 4;
    },
  },
  {
    name: 'state across calls',
    prompt: 'Create dut as a float accumulator: each output is the running sum across samples and across work calls. Put per-instance state in start(), exercise two calls, and finish with the tested source.',
    check(source) {
      const run = exercise(source, { calls: [
        { nout: 2, inputs: [[1, 2]] }, { nout: 2, inputs: [[3, 4]] },
      ] });
      return close(run.calls[0].outputs[0].values, [1, 3]) &&
        close(run.calls[1].outputs[0].values, [6, 10]);
    },
  },
  {
    name: 'message-only handler',
    prompt: 'Create message-only JS Block dut with input port ctrl and output port events. On each numeric ctrl message, synchronously publish twice its value to events. Exercise it with ctrl value 4 and calls:[] before finishing.',
    check(source) {
      const run = exercise(source, { messages: [{ port: 'ctrl', value: 4 }], calls: [] });
      return run.info.msgPortsIn?.includes('ctrl') && run.info.msgPortsOut?.includes('events') &&
        run.messages_published.some(message => message.port === 'events' && message.value === 8);
    },
  },
  {
    name: 'custom stream tag',
    prompt: 'Create byte input/output JS Block dut that copies samples and uses TPP_CUSTOM to rewrite input_tag stream tags as seen_tag with the numeric value increased by one. Exercise four bytes with an input_tag at absolute offset 2 and verify the added tag.',
    check(source) {
      const run = exercise(source, { calls: [{ nout: 4, inputs: [[1, 2, 3, 4]],
        tags: [{ port: 0, offset: 2, key: 'input_tag', value: 7 }] }] });
      return close(run.calls[0].outputs[0].values, [1, 2, 3, 4]) &&
        run.tags_added.some(tag => tag.port === 0 && tag.offset === 2 &&
          tag.key === 'seen_tag' && tag.value === 8);
    },
  },
];

let passed = 0;
for (const test of CASES) {
  const { deps, blocks } = makeDeps(test.initial || '');
  const agent = new FlowgraphAgent({ provider: 'openai', key, model,
    systemPrompt: `${systemPrompt}\n\nRunnable block index:\nCore / Misc:\n  wasm_js_block | JS Block | JavaScript`,
    deps });
  let result, error = '';
  try { result = await agent.turn(`[canvas] ${blocks.length ? 'contains JS Block dut' : 'empty'}\n\n[message]\n${test.prompt}`); }
  catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
  const source = blocks.find(block => block.name === 'dut')?.source || '';
  let ok = false;
  try { ok = !!source && test.check(source); } catch (caught) { error ||= String(caught); }
  if (ok) passed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${test.name}` +
    `${result ? ` (${result.rounds} rounds)` : ''}${error ? ` — ${error}` : ''}`);
}

console.log(`\n${passed}/${CASES.length} Graham JS Block evaluations passed with ${model}.`);
process.exit(passed === CASES.length ? 0 : 1);
