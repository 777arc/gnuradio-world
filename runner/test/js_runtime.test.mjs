// The JavaScript Block's runtime harness, on plain Node -- no browser, no
// Emscripten, no build.
//
// runner/src/js_runtime.js is deliberately free of Emscripten-only globals at
// load time: UTF8ToString and the GROWABLE_HEAP_* accessors are referenced inside
// functions only. So the whole harness -- descriptor validation, view shapes and
// lengths, decimation/interpolation arithmetic, error capture -- can be driven
// against a plain ArrayBuffer standing in for the WebAssembly heap, in about a
// second. The same bargain runner/test/grc_test.cpp makes for the .grc parser.
//
// What this cannot cover is the crossing itself (that the EM_ASM body runs on the
// block's own thread against GNU Radio's real buffers): test/test_js_block.mjs
// does that, end to end in the built runner.
//
//   node runner/test/js_runtime.test.mjs
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

// ---- a stand-in heap -------------------------------------------------------
// One buffer, the eight views the runtime asks for, and a bump allocator. Not a
// mock of the runtime: the runtime under test is the real file, unmodified.
const HEAP_BYTES = 4 << 20;
let buffer = new ArrayBuffer(HEAP_BYTES);
let views = rebuild();
let brk = 16;

function rebuild() {
  return {
    I8: new Int8Array(buffer), U8: new Uint8Array(buffer),
    I16: new Int16Array(buffer), U16: new Uint16Array(buffer),
    I32: new Int32Array(buffer), U32: new Uint32Array(buffer),
    F32: new Float32Array(buffer), F64: new Float64Array(buffer),
  };
}

function alloc(bytes) {
  const ptr = brk;
  brk = (brk + bytes + 15) & ~15;
  assert.ok(brk < HEAP_BYTES, 'the test heap ran out');
  return ptr;
}

for (const name of ['I8', 'U8', 'I16', 'U16', 'I32', 'U32', 'F32', 'F64'])
  globalThis[`GROWABLE_HEAP_${name}`] = () => views[name];

globalThis.UTF8ToString = ptr => {
  if (!ptr) return '';
  let end = ptr;
  while (views.U8[end]) end++;
  return new TextDecoder().decode(views.U8.subarray(ptr, end));
};
globalThis.stringToUTF8 = (text, ptr, cap) => {
  const bytes = new TextEncoder().encode(text);
  const n = Math.min(bytes.length, cap - 1);
  views.U8.set(bytes.subarray(0, n), ptr);
  views.U8[ptr + n] = 0;
  return n;
};
globalThis.stringToNewUTF8 = text => {
  const bytes = new TextEncoder().encode(text);
  const ptr = alloc(bytes.length + 1);
  views.U8.set(bytes, ptr);
  views.U8[ptr + bytes.length] = 0;
  return ptr;
};
const cstr = text => stringToNewUTF8(text);

// ---- stand-ins for the exported C++ PMT/tag/message shims -----------------
// The runtime owns the value mapping; this small arena only supplies canonical
// handle operations so that mapping is testable on plain Node.
globalThis._malloc = bytes => alloc(Math.max(1, bytes));
globalThis._free = () => {};
const arena = [];
const addPmt = value => (arena.push(value), arena.length - 1);
let bridgeError = '';
const errorTextPtr = alloc(1024);
globalThis._gr_js_last_error = () => {
  stringToUTF8(bridgeError, errorTextPtr, 1024);
  return errorTextPtr;
};
const failShim = error => { bridgeError = String(error?.message || error); return -1; };
const withShim = fn => { try { bridgeError = ''; return fn(); } catch (error) { return failShim(error); } };
const wordsToBig = (lo, hi) => BigInt(lo >>> 0) | (BigInt(hi >>> 0) << 32n);
const writeBig = (value, ptr) => {
  views.U32[ptr >> 2] = Number(value & 0xffffffffn);
  views.U32[(ptr >> 2) + 1] = Number((value >> 32n) & 0xffffffffn);
};
globalThis._gr_js_pmt_make = (kind, lo, hi, x, y, textPtr) => withShim(() => addPmt({
  kind,
  value: kind === 0 ? null : kind === 1 ? !!x : kind === 2 ? UTF8ToString(textPtr)
    : kind === 3 ? (lo | 0) : kind === 4 ? wordsToBig(lo, hi)
    : kind === 5 ? x : kind === 6 ? [x, y] : undefined,
}));
globalThis._gr_js_pmt_seq = (kind, ptr, count) => withShim(() => {
  const handles = Array.from(views.I32.subarray(ptr >> 2, (ptr >> 2) + count));
  return addPmt({ kind, value: handles.map(handle => arena[handle]) });
});
globalThis._gr_js_pmt_dict = (ptr, count) => withShim(() => {
  const handles = Array.from(views.I32.subarray(ptr >> 2, (ptr >> 2) + count));
  const entries = [];
  for (let i = 0; i < handles.length; i += 2) entries.push([arena[handles[i]], arena[handles[i + 1]]]);
  return addPmt({ kind: 7, value: entries });
});
const itemSize = kind => ({ 20: 1, 21: 1, 22: 2, 23: 2, 24: 4, 25: 4,
  26: 8, 27: 8, 28: 4, 29: 8, 30: 8, 31: 16, 32: 1 })[kind];
globalThis._gr_js_pmt_blob_new = (kind, count, metaPtr) => withShim(() => {
  const size = itemSize(kind);
  if (!size) throw new Error('bad vector kind');
  const ptr = alloc(Math.max(1, count * size));
  views.U32.set([ptr, count * size, size, kind], metaPtr >> 2);
  return addPmt({ kind: kind === 32 ? 20 : kind, ptr, count, size });
});
globalThis._gr_js_pmt_type = handle => arena[handle]?.kind ?? failShim('bad handle');
globalThis._gr_js_pmt_real = (handle, component) => {
  const value = arena[handle]?.value;
  return Array.isArray(value) ? value[component] : Number(value);
};
globalThis._gr_js_pmt_u64 = (handle, ptr) => withShim(() => (writeBig(BigInt(arena[handle].value), ptr), 0));
globalThis._gr_js_pmt_length = handle => withShim(() => arena[handle].value?.length ?? arena[handle].count ?? 0);
globalThis._gr_js_pmt_ref = (handle, op, index) => withShim(() => {
  const value = arena[handle];
  if (op === 0 || op === 1) return addPmt(value.value[op]);
  if (op === 2 || op === 3) return addPmt(value.value[index]);
  return addPmt(value.value[index][op === 4 ? 0 : 1]);
});
globalThis._gr_js_pmt_text = (handle, ptr, cap) => withShim(() =>
  stringToUTF8(arena[handle].value, ptr, cap));
globalThis._gr_js_pmt_blob = (handle, metaPtr) => withShim(() => {
  const value = arena[handle];
  views.U32.set([value.ptr, value.count, value.size, value.kind], metaPtr >> 2);
  return 0;
});
const published = [], addedTags = [];
let deliveredTags = [], currentTags = [];
const counters = { read: 100, written: 200 };
globalThis._gr_js_publish = (_handle, port, message) =>
  withShim(() => (published.push({ port, value: arena[message] }), 0));
globalThis._gr_js_nitems = (_handle, written, _port, ptr) =>
  withShim(() => (writeBig(BigInt(written ? counters.written : counters.read), ptr), 0));
globalThis._gr_js_tags = (_handle, port, lo, hi, elo, ehi, keyHandle) => withShim(() => {
  const start = wordsToBig(lo, hi), end = wordsToBig(elo, ehi);
  const key = keyHandle < 0 ? null : arena[keyHandle];
  currentTags = deliveredTags.filter(tag => tag.port === port && tag.offset >= start && tag.offset < end &&
    (!key || JSON.stringify(tag.key) === JSON.stringify(key)));
  return currentTags.length;
});
globalThis._gr_js_tag_offset = (_handle, index, ptr) =>
  withShim(() => (writeBig(currentTags[index].offset, ptr), 0));
globalThis._gr_js_tag_field = (_handle, index, field) =>
  withShim(() => addPmt(currentTags[index][['key', 'value', 'srcid'][field]]));
globalThis._gr_js_add_tag = (_handle, port, lo, hi, key, value, srcid) => withShim(() => {
  addedTags.push({ port, offset: wordsToBig(lo, hi), key: arena[key], value: arena[value],
    srcid: srcid < 0 ? { kind: 1, value: false } : arena[srcid] });
  return 0;
});

// The runtime, evaluated exactly as --pre-js would evaluate it.
const runtimeSource = await readFile(
  new URL('../src/js_runtime.js', import.meta.url), 'utf8');
new Function(runtimeSource)();
const gr = globalThis.__grJs;
assert.ok(gr, 'js_runtime.js must install globalThis.__grJs');

const ERR_CAP = 4096;
const errPtr = alloc(ERR_CAP);
const readError = () => UTF8ToString(errPtr);

// ---- the control words, mirrored from blocks/src/js_block.hpp --------------
// Spelled out here rather than imported: this test is what catches the two sides
// drifting apart, and reading the layout from one of them would defeat that.
const MAX_PORTS = 32;
const W = {
  NOUT: 0, NIN_PORTS: 1, NOUT_PORTS: 2, RESULT: 3, CONSUME_EACH: 4, LOG_PENDING: 5,
  IN_PTR: 8, IN_AVAIL: 8 + MAX_PORTS, OUT_PTR: 8 + 2 * MAX_PORTS,
  CONSUME: 8 + 3 * MAX_PORTS, FORECAST: 8 + 4 * MAX_PORTS,
};
const WORDS = 8 + 5 * MAX_PORTS;
assert.equal(gr.WORDS, WORDS, 'the runtime and js_block.hpp must agree on the word count');
assert.equal(gr.MAX_PORTS, MAX_PORTS);

const wordsPtr = alloc(WORDS * 4);
const w = index => views.I32[(wordsPtr >> 2) + index];
const setWord = (index, value) => { views.I32[(wordsPtr >> 2) + index] = value; };

// ---- descriptor validation -------------------------------------------------

const GAIN = `
gr.export({
  label: 'JS Gain',
  inputs: ['complex'],
  outputs: ['complex'],
  params: { gain: 2.0, name: 'x', on: true },
  start() { this.calls = 0; },
  work(nout, input, output) {
    const x = input[0], y = output[0], g = this.gain;
    for (let i = 0; i < nout * 2; i++) y[i] = x[i] * g;
    this.calls++;
    return nout;
  },
});
`;

const described = gr.describeSource(GAIN);
assert.ok(described.ok, described.error);
assert.deepEqual(described.info.inputs, [{ dtype: 'complex', vlen: 1 }]);
assert.deepEqual(described.info.params, [['gain', 2], ['name', 'x'], ['on', true]],
  'parameters keep their declaration order and their JSON-safe defaults');
assert.deepEqual(described.info.numericParams, ['gain'],
  'only numeric parameters get a live setter, so only they are listed');
assert.equal(described.info.label, 'JS Gain');
assert.equal(described.info.general, false);
assert.equal(described.info.hasStart, true);

// Every rejection names the field, because this message is the only feedback a
// block author gets while typing.
const rejects = (source, pattern, what) => {
  const result = gr.describeSource(source);
  assert.equal(result.ok, false, `should have been rejected: ${what}`);
  assert.match(result.error, pattern, what);
};
rejects('const x = 1;', /never called gr\.export/, 'a source that registers nothing');
rejects('gr.export({ inputs: [], outputs: [] });', /no work\(\)/, 'a descriptor with no work');
// The class form is what an author writes when work() is a method somewhere
// else entirely; the message has to name the shape, not just the absence.
rejects("class B { work(){} }\ngr.export({ block: B, inputs: ['complex'], outputs: [] });",
        /no class or constructor form.*carries: block, inputs, outputs/s,
        'a descriptor pointing at a class');
rejects("const pmt = gr.pmt;\ngr.export({ inputs: ['complex'], outputs: [], work(){} });",
        /gr and pmt are injected/, 'a source redeclaring an injected global');
rejects("gr.export({ inputs: ['complex'], outputs: [], work(){}, generalWork(){} });",
        /work\(\) or generalWork\(\), not both/, 'both work and generalWork');
rejects("gr.export({ inputs: ['cplx'], outputs: [], work(){} });",
        /unknown port type "cplx"/, 'an unknown port dtype');
// The shape a first-time author (and a model) reaches for. It has to be told
// that a port is a dtype rather than a description of one, because the generic
// message reports the type it *did* supply as undefined.
rejects("gr.export({ inputs: [{ name: 'in', type: 'complex' }], outputs: [], work(){} });",
        /a port is a dtype string.*no dtype \(its keys are name, type\)/s,
        'a {name,type} port object');
rejects('gr.export({ inputs: [], outputs: [], work(){} });',
        /at least one stream or message port/, 'a block with no ports at all');
rejects("gr.export({ inputs: ['float'], outputs: [], params: { 'a-b': 1 }, work(){} });",
        /not a usable identifier/, 'a parameter name that is not an identifier');
rejects("gr.export({ inputs: ['float'], outputs: [], params: { a: [1, 2] }, work(){} });",
        /only numbers, strings and booleans/, 'a non-scalar parameter default');
rejects("gr.export({ inputs: ['float'], outputs: [], decimation: 0, work(){} });",
        /decimation must be a positive integer/, 'a zero decimation');
rejects("gr.export({ inputs: ['float'], outputs: [], work(){} }); gr.export({});",
        /called more than once/, 'a second gr.export');
rejects('this is not javascript(', /did not parse/, 'a syntax error');
assert.equal('msgPortsIn' in described.info, false,
  'new declaration keys stay absent from old descriptors, preserving _js_io bytes');

// ---- init(), message-only blocks, PMTs, tags and counters ------------------

const MESSAGE_ONLY = `
globalThis.__jsInitCalls = globalThis.__jsInitCalls || 0;
gr.export({
  label: 'PMT Echo', params: { bias: 1 },
  init() {
    globalThis.__jsInitCalls++;
    this.message_port_register_in(pmt.intern('in'));
    this.set_msg_handler(pmt.intern('in'), this.handle);
    this.message_port_register_out(pmt.intern('out'));
  },
  handle(msg) {
    const values = [
      null, true, 'symbol', -2147483648, pmt.from_uint64(18446744073709551615n),
      pmt.from_double(1), pmt.from_complex(2, -3), pmt.cons('meta', msg),
      pmt.dict_add(pmt.make_dict(), pmt.from_complex(1, 2), 'arbitrary-key'),
      [1, 'two'], pmt.make_tuple(1, 'two'),
      pmt.init_u8vector(2, [1, 255]), pmt.init_s8vector(2, [-1, 2]),
      pmt.init_u16vector(2, [1, 65535]), pmt.init_s16vector(2, [-2, 3]),
      pmt.init_u32vector(2, [1, 4294967295]), pmt.init_s32vector(2, [-3, 4]),
      pmt.init_u64vector(2, [1n, 18446744073709551615n]),
      pmt.init_s64vector(2, [-4n, 5n]), pmt.init_f32vector(2, [1.5, 2.5]),
      pmt.init_f64vector(2, [3.5, 4.5]), pmt.init_c32vector(1, [5, -6]),
      pmt.init_c64vector(1, [7, -8]), pmt.make_blob(new Uint8Array([9, 10])), this.bias,
    ];
    if (!pmt.is_pair(values[7]) || !pmt.is_dict(values[8]) || !pmt.is_blob(values[23]))
      throw new Error('PMT predicates failed');
    if (pmt.to_long(pmt.dict_ref({ answer: 42 }, 'answer', 0)) !== 42)
      throw new Error('plain-object dictionary shorthand failed');
    for (const value of values) this.message_port_pub('out', value);
  },
});`;
const messageInfo = gr.describeSource(MESSAGE_ONLY);
assert.ok(messageInfo.ok, messageInfo.error);
assert.deepEqual(messageInfo.info.msgPortsIn, ['in']);
assert.deepEqual(messageInfo.info.msgPortsOut, ['out']);
assert.deepEqual(messageInfo.info.msgHandlerPorts, ['in']);
assert.equal(messageInfo.info.inputs.length + messageInfo.info.outputs.length, 0,
  'a message-only block needs no stream ports');

globalThis.__jsInitCalls = 0;
const MESSAGE_HANDLE = 40;
assert.equal(gr.compile(MESSAGE_HANDLE, cstr(MESSAGE_ONLY), 0, 0, errPtr, ERR_CAP), 0,
  readError());
assert.equal(globalThis.__jsInitCalls, 2,
  'compile fallback performs one recording init and one live init');
assert.equal(gr.setParam(MESSAGE_HANDLE, cstr('bias'), 9), 0);
published.length = 0;
assert.equal(gr.message(MESSAGE_HANDLE, 0, addPmt({ kind: 3, value: 9 }), errPtr, ERR_CAP), 0,
  readError());
assert.deepEqual(published.map(entry => entry.value.kind),
  [0, 1, 2, 3, 4, 5, 6, 8, 7, 9, 10,
   20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 20, 3],
  'every supported scalar/container/uniform PMT crossed to canonical C++ kinds');
assert.equal(published[4].value.value, 18446744073709551615n,
  'a uint64 remains exact across the low/high-word boundary');
assert.equal(published[5].value.kind, 5,
  'an integral-valued real remains a PMT real rather than becoming a long');
assert.equal(published.at(-1).value.value, 9,
  'a live numeric parameter change reaches a message-only block before its next handler');

const DONT_TAGS = `gr.export({ inputs: ['byte'], outputs: ['byte'],
  init() { this.set_tag_propagation_policy(gr.TPP_DONT); },
  work(nout) { return nout; } });`;
assert.equal(gr.describeSource(DONT_TAGS).info.tagPropagation, 0,
  'TPP_DONT is retained as an explicit non-default declaration');

const MISMATCH = `gr.export({ inputs: ['float'], outputs: ['float'], params: { n: 1 },
  init() { this.set_history(this.n); }, work(n) { return n; } });`;
assert.equal(gr.compile(41, cstr(MISMATCH), cstr('{"n":2}'), 0, errPtr, ERR_CAP), -1);
assert.match(readError(), /\[init\].*different history.*cannot depend on parameter values/s,
  'a parameter-dependent declaration fails instead of drifting');

const UNHANDLED = `gr.export({ init() { this.message_port_register_in('in'); } });`;
const unhandledInfo = gr.describeSource(UNHANDLED);
assert.ok(unhandledInfo.ok, unhandledInfo.error);
assert.deepEqual(unhandledInfo.info.msgPortsIn, ['in']);
assert.equal('msgHandlerPorts' in unhandledInfo.info, false,
  'a registered input may deliberately have no handler');

const COUNTERS = `gr.export({ inputs: ['byte'], outputs: ['byte'],
  work(nout, input, output) { this.log(this.nitems_read(0), this.nitems_written(0)); return nout; } });`;
assert.equal(gr.compile(42, cstr(COUNTERS), 0, 0, errPtr, ERR_CAP), 0, readError());
counters.read = Number.MAX_SAFE_INTEGER; counters.written = Number.MAX_SAFE_INTEGER;
views.I32.fill(0, wordsPtr >> 2, (wordsPtr >> 2) + WORDS);
setWord(W.NOUT, 1); setWord(W.NIN_PORTS, 1); setWord(W.NOUT_PORTS, 1);
setWord(W.IN_PTR, alloc(1)); setWord(W.IN_AVAIL, 1); setWord(W.OUT_PTR, alloc(1));
assert.equal(gr.work(42, wordsPtr, errPtr, ERR_CAP), 0, readError());
counters.read = 1n << 53n;
assert.equal(gr.work(42, wordsPtr, errPtr, ERR_CAP), -2);
assert.match(readError(), /nitems_read\(0\).*exact integer range/,
  'counters above 2^53 throw rather than truncate');
counters.read = 100; counters.written = 200;

const RETAINED_TAG = `gr.export({ inputs: ['byte'], outputs: ['byte'],
  init() { this.set_tag_propagation_policy(gr.TPP_CUSTOM); },
  work(nout) {
    const tags = this.get_tags_in_window(0, 0, nout, 'bytes');
    if (!this.saved && tags.length) this.saved = tags[0];
    if (this.saved && pmt.u8vector_elements(this.saved.value)[0] !== 7)
      throw new Error('retained tag value changed');
    return nout;
  } });`;
assert.equal(gr.compile(43, cstr(RETAINED_TAG), 0, 0, errPtr, ERR_CAP), 0, readError());
const tagBytesPtr = alloc(2);
views.U8.set([7, 8], tagBytesPtr);
deliveredTags = [{ port: 0, offset: 100n,
  key: { kind: 2, value: 'bytes' }, value: { kind: 20, ptr: tagBytesPtr, count: 2, size: 1 },
  srcid: { kind: 2, value: 'source' } }];
assert.equal(gr.work(43, wordsPtr, errPtr, ERR_CAP), 0, readError());
views.U8[tagBytesPtr] = 99;
assert.equal(gr.work(43, wordsPtr, errPtr, ERR_CAP), 0, readError());

deliveredTags = [{ ...deliveredTags[0], offset: 1n << 53n }];
const LARGE_TAG = `gr.export({ inputs: ['byte'], outputs: ['byte'], work(nout) {
  this.get_tags_in_range(0, 0n, (1n << 53n) + 1n, 'bytes'); return nout; } });`;
assert.equal(gr.compile(44, cstr(LARGE_TAG), 0, 0, errPtr, ERR_CAP), 0, readError());
assert.equal(gr.work(44, wordsPtr, errPtr, ERR_CAP), -2);
assert.match(readError(), /tag offset.*exact integer range/,
  'tag offsets above 2^53 throw rather than truncate');
deliveredTags = [];
gr.destroy(MESSAGE_HANDLE);
gr.destroy(42);
gr.destroy(43);
gr.destroy(44);

// ---- compile, work, and the views ------------------------------------------

const HANDLE = 1;
assert.equal(gr.compile(HANDLE, cstr(GAIN), cstr('{"gain":3}'), 0, errPtr, ERR_CAP), 0,
  readError());
assert.equal(gr.count(), 1);

const ITEMS = 64;
const inPtr = alloc(ITEMS * 8), outPtr = alloc(ITEMS * 8);
for (let i = 0; i < ITEMS * 2; i++) views.F32[(inPtr >> 2) + i] = i + 1;

const runWork = ({ nout = ITEMS, inPorts = 1, outPorts = 1, avail = [ITEMS] } = {}) => {
  views.I32.fill(0, wordsPtr >> 2, (wordsPtr >> 2) + WORDS);
  setWord(W.NOUT, nout);
  setWord(W.NIN_PORTS, inPorts);
  setWord(W.NOUT_PORTS, outPorts);
  for (let i = 0; i < inPorts; i++) {
    setWord(W.IN_PTR + i, inPtr);
    setWord(W.IN_AVAIL + i, avail[i]);
  }
  for (let i = 0; i < outPorts; i++) setWord(W.OUT_PTR + i, outPtr);
  return gr.work(HANDLE, wordsPtr, errPtr, ERR_CAP);
};

assert.equal(runWork(), 0, readError());
assert.equal(w(W.RESULT), ITEMS);
// The flowgraph's value, not the descriptor's default: params_json wins.
assert.equal(views.F32[outPtr >> 2], 3, 'the instance took the flowgraph parameter');
assert.equal(views.F32[(outPtr >> 2) + 2 * ITEMS - 1], ITEMS * 2 * 3,
  'a complex port is 2 * n floats, and the last one was written');
assert.equal(w(W.CONSUME_EACH), ITEMS,
  'a sync block consumes exactly what it produced');

// A live parameter change lands between calls.
assert.equal(gr.setParam(HANDLE, cstr('gain'), 10), 0);
assert.equal(runWork(), 0, readError());
assert.equal(views.F32[outPtr >> 2], 10);

// ---- decimation and interpolation ------------------------------------------
// The arithmetic GNU Radio's sync_decimator/sync_interpolator do: the input view
// is nout * decim / interp items long, and consume_each follows the same ratio.

const rateBlock = (extra) => `
gr.export({
  inputs: ['float'], outputs: ['float'], ${extra}
  work(nout, input, output) {
    this.log('in=' + input[0].length + ' out=' + output[0].length);
    return nout;
  },
});`;

assert.equal(gr.compile(2, cstr(rateBlock('decimation: 4,')), 0, 0, errPtr, ERR_CAP), 0,
  readError());
views.I32.fill(0, wordsPtr >> 2, (wordsPtr >> 2) + WORDS);
setWord(W.NOUT, 16); setWord(W.NIN_PORTS, 1); setWord(W.NOUT_PORTS, 1);
setWord(W.IN_PTR, inPtr); setWord(W.IN_AVAIL, 1000); setWord(W.OUT_PTR, outPtr);
assert.equal(gr.work(2, wordsPtr, errPtr, ERR_CAP), 0, readError());
assert.equal(w(W.CONSUME_EACH), 64, 'a decim-4 block consumes 4 items per output');
const ratePtr = alloc(128);
gr.takeLog(2, ratePtr, 128);
assert.equal(UTF8ToString(ratePtr), 'in=64 out=16',
  'a decim-4 block is handed 4 * nout input items, as GNU Radio guarantees');

assert.equal(gr.compile(3, cstr(rateBlock('interpolation: 4,')), 0, 0, errPtr, ERR_CAP), 0,
  readError());
views.I32.fill(0, wordsPtr >> 2, (wordsPtr >> 2) + WORDS);
setWord(W.NOUT, 16); setWord(W.NIN_PORTS, 1); setWord(W.NOUT_PORTS, 1);
setWord(W.IN_PTR, inPtr); setWord(W.IN_AVAIL, 1000); setWord(W.OUT_PTR, outPtr);
assert.equal(gr.work(3, wordsPtr, errPtr, ERR_CAP), 0, readError());
assert.equal(w(W.CONSUME_EACH), 4, 'an interp-4 block consumes one item per four outputs');
gr.takeLog(3, ratePtr, 128);
assert.equal(UTF8ToString(ratePtr), 'in=4 out=16');
assert.equal(gr.describeSource(rateBlock('interpolation: 4,')).info.relativeRate, 4,
  'relativeRate follows interpolation/decimation when it is not given');

// ---- a general block --------------------------------------------------------
// generalWork() consumes only what it asked for, which is the whole reason the
// two kinds are told apart at all.

const GENERAL = `
gr.export({
  inputs: ['byte'], outputs: ['byte'],
  generalWork(nout, nin, input, output) {
    this.lastAvail = nin[0];
    const n = Math.min(nout, nin[0]);
    for (let i = 0; i < n; i++) output[0][i] = input[0][i] + 1;
    this.consume(0, n);
    return n;
  },
});`;
assert.equal(gr.compile(4, cstr(GENERAL), 0, 0, errPtr, ERR_CAP), 0, readError());
views.I8[inPtr] = 41;
views.I32.fill(0, wordsPtr >> 2, (wordsPtr >> 2) + WORDS);
setWord(W.NOUT, 10); setWord(W.NIN_PORTS, 1); setWord(W.NOUT_PORTS, 1);
setWord(W.IN_PTR, inPtr); setWord(W.IN_AVAIL, 7); setWord(W.OUT_PTR, outPtr);
assert.equal(gr.work(4, wordsPtr, errPtr, ERR_CAP), 0, readError());
assert.equal(w(W.RESULT), 7);
assert.equal(views.I8[outPtr], 42, 'a byte port is an Int8Array');
assert.equal(w(W.CONSUME_EACH), -1, 'a general block reports per-port consumption');
assert.equal(w(W.CONSUME), 7, 'this.consume(0, n) reached C++');

// A general block that consumes nothing must consume nothing -- not the
// sync-block default, which would drop input it never looked at.
const IDLE = `
gr.export({
  inputs: ['byte'], outputs: ['byte'],
  generalWork(nout, nin, input, output) { return 0; },
});`;
assert.equal(gr.compile(5, cstr(IDLE), 0, 0, errPtr, ERR_CAP), 0, readError());
views.I32.fill(0, wordsPtr >> 2, (wordsPtr >> 2) + WORDS);
setWord(W.NOUT, 10); setWord(W.NIN_PORTS, 1); setWord(W.NOUT_PORTS, 1);
setWord(W.IN_PTR, inPtr); setWord(W.IN_AVAIL, 7); setWord(W.OUT_PTR, outPtr);
assert.equal(gr.work(5, wordsPtr, errPtr, ERR_CAP), 0, readError());
assert.equal(w(W.CONSUME_EACH), -1);
assert.equal(w(W.CONSUME), 0);

// ---- forecast ---------------------------------------------------------------

const FORECAST = `
gr.export({
  inputs: ['float', 'float'], outputs: ['float'],
  history: 8,
  forecast(nout, required) { required[0] = nout + 7; required[1] = 2 * nout; },
  work(nout, input, output) { return nout; },
});`;
const forecastInfo = gr.describeSource(FORECAST).info;
assert.equal(forecastInfo.overridesForecast, true);
assert.equal(forecastInfo.history, 8);
assert.equal(gr.compile(6, cstr(FORECAST), 0, 0, errPtr, ERR_CAP), 0, readError());
views.I32.fill(0, wordsPtr >> 2, (wordsPtr >> 2) + WORDS);
setWord(W.NOUT, 100); setWord(W.NIN_PORTS, 2);
assert.equal(gr.forecast(6, wordsPtr, errPtr, ERR_CAP), 0, readError());
assert.equal(w(W.FORECAST), 107);
assert.equal(w(W.FORECAST + 1), 200);

// ---- vlen -------------------------------------------------------------------

const VECTOR = `
gr.export({
  inputs: [{ dtype: 'float', vlen: 4 }], outputs: [{ dtype: 'complex', vlen: 2 }],
  work(nout, input, output) {
    this.log(input[0].length + ' ' + output[0].length);
    return nout;
  },
});`;
assert.equal(gr.compile(7, cstr(VECTOR), 0, 0, errPtr, ERR_CAP), 0, readError());
views.I32.fill(0, wordsPtr >> 2, (wordsPtr >> 2) + WORDS);
setWord(W.NOUT, 5); setWord(W.NIN_PORTS, 1); setWord(W.NOUT_PORTS, 1);
setWord(W.IN_PTR, inPtr); setWord(W.IN_AVAIL, 5); setWord(W.OUT_PTR, outPtr);
assert.equal(gr.work(7, wordsPtr, errPtr, ERR_CAP), 0, readError());
const vectorLog = alloc(64);
assert.equal(gr.takeLog(7, vectorLog, 64), 1);
// 5 items x vlen 4 floats in; 5 items x vlen 2 x 2 floats out, because a complex
// element is two floats.
assert.equal(UTF8ToString(vectorLog), '20 20', 'vlen multiplies a port view');

// ---- error capture ----------------------------------------------------------
// A JS throw is never allowed to unwind through a wasm frame: it is caught, its
// stack is written into the buffer C++ owns, and a negative code comes back.

const THROWS = `
gr.export({
  inputs: ['float'], outputs: ['float'],
  work(nout, input, output) { throw new Error('boom in work'); },
});`;
assert.equal(gr.compile(8, cstr(THROWS), 0, 0, errPtr, ERR_CAP), 0, readError());
views.I32.fill(0, wordsPtr >> 2, (wordsPtr >> 2) + WORDS);
setWord(W.NOUT, 4); setWord(W.NIN_PORTS, 1); setWord(W.NOUT_PORTS, 1);
setWord(W.IN_PTR, inPtr); setWord(W.IN_AVAIL, 4); setWord(W.OUT_PTR, outPtr);
assert.equal(gr.work(8, wordsPtr, errPtr, ERR_CAP), -2);
assert.match(readError(), /\[work\]/, 'a runtime failure names its lifecycle phase');
assert.match(readError(), /boom in work/, 'the message survives the crossing');
assert.match(readError(), /at .*work/, 'and so does the stack');

// A throw from start() fails the compile rather than the first call.
assert.equal(gr.compile(9, cstr(`
gr.export({ inputs: ['float'], outputs: ['float'],
  start() { throw new Error('boom in start'); }, work() { return 0; } });`),
  0, 0, errPtr, ERR_CAP), -1);
assert.match(readError(), /\[start\]/, 'a start failure is distinct from compile/work');
assert.match(readError(), /boom in start/);

// Calling work() on a handle that was never compiled is an error, not a crash.
assert.equal(gr.work(999, wordsPtr, errPtr, ERR_CAP), -1);
assert.match(readError(), /never compiled/);

// ---- this.log ---------------------------------------------------------------
// console.log from a scheduler worker reaches only devtools. Lines are queued and
// drained by C++ into printf, which is what puts them in the editor's console
// pane -- flagged by a word so a block that never logs never crosses for it.

assert.equal(gr.compile(10, cstr(`
gr.export({ inputs: ['float'], outputs: ['float'],
  work(nout) { this.log('hello', 7); return nout; } });`), 0, 0, errPtr, ERR_CAP), 0);
views.I32.fill(0, wordsPtr >> 2, (wordsPtr >> 2) + WORDS);
setWord(W.NOUT, 4); setWord(W.NIN_PORTS, 1); setWord(W.NOUT_PORTS, 1);
setWord(W.IN_PTR, inPtr); setWord(W.IN_AVAIL, 4); setWord(W.OUT_PTR, outPtr);
assert.equal(gr.work(10, wordsPtr, errPtr, ERR_CAP), 0, readError());
assert.equal(w(W.LOG_PENDING), 1, 'the word flag is what makes a silent block free');
const logPtr = alloc(256);
assert.equal(gr.takeLog(10, logPtr, 256), 1);
assert.equal(UTF8ToString(logPtr), 'hello 7');
assert.equal(gr.takeLog(10, logPtr, 256), 0, 'a drained queue is empty');

// ---- realm isolation, and forgetting ---------------------------------------

const before = gr.count();
assert.equal(gr.destroy(10), 0);
assert.equal(gr.count(), before - 1, 'destroy() forgets the instance');

// ---- growth does not detach a view -----------------------------------------
// The rule the design turns on. On a -pthread shared heap the old buffer is not
// detached, so a stale view keeps reading the same real memory -- which is why
// the failure a cached subarray causes is a silent out-of-range against memory
// allocated *after* the growth, not a crash or a zero read. Simulated here by
// replacing the buffer, which is the same observation the spike made in a
// browser: views must be re-derived through GROWABLE_HEAP_* on every call.

const stale = views.F32.subarray(inPtr >> 2, (inPtr >> 2) + 4);
const grown = new ArrayBuffer(HEAP_BYTES * 2);
new Uint8Array(grown).set(views.U8);
buffer = grown;
views = rebuild();
assert.equal(stale.length, 4, 'the old view is not detached');
assert.notEqual(stale.buffer, buffer, 'but it no longer addresses the current heap');
// The runtime never keeps one, which is what makes that harmless here.
assert.doesNotMatch(runtimeSource, /this\.(input|output)\s*=/,
  'the runtime must not stash a view on an instance');
assert.match(runtimeSource, /function view\([\s\S]{0,200}?heapFor\(spec\.heap\)/,
  'every view goes through the growable accessors');

// The runtime keeps working across the swap, because it re-derives.
assert.equal(gr.work(HANDLE, wordsPtr, errPtr, ERR_CAP), 0, readError());

// ---- the shipped repo blocks ------------------------------------------------
// blocks/js/*.js are real DSP, and this is the cheapest place to check that they
// compute the right thing: they are plain JavaScript against a plain buffer, so
// the arithmetic can be driven exactly, with inputs a flowgraph could not easily
// produce. test/test_js_block.mjs then only has to prove they load and run.

const shippedDir = new URL('../../blocks/js/', import.meta.url);
const shipped = (await readdir(shippedDir)).filter(name => name.endsWith('.js')).sort();
assert.ok(shipped.length, 'blocks/js/ must hold the repo JavaScript blocks');

let nextHandle = 100;
async function loadShipped(file, params = {}) {
  const text = await readFile(new URL(file, shippedDir), 'utf8');
  const described = gr.describeSource(text);
  assert.ok(described.ok, `${file}: ${described.error}`);
  const handle = nextHandle++;
  assert.equal(gr.compile(handle, cstr(text), cstr(JSON.stringify(params)), 0, errPtr, ERR_CAP),
               0, readError());
  return { handle, info: described.info };
}

// Every shipped block must read cleanly, which is also what gen_registry.py's
// port check assumes when it parses the same declaration textually.
for (const file of shipped) await loadShipped(file);

// --- Complex Soft Clipper: the magnitude is limited, the phase is not.
{
  const { handle, info } = await loadShipped('js_clip_cc.js', { threshold: 0.5, knee: 0 });
  assert.equal(info.decim, 1);
  // Four samples at increasing magnitude, all at 45 degrees, two under the
  // threshold and two over it.
  const magnitudes = [0.1, 0.4, 1.0, 8.0];
  const inPtrC = alloc(magnitudes.length * 8), outPtrC = alloc(magnitudes.length * 8);
  magnitudes.forEach((m, i) => {
    views.F32[(inPtrC >> 2) + 2 * i] = m * Math.SQRT1_2;
    views.F32[(inPtrC >> 2) + 2 * i + 1] = m * Math.SQRT1_2;
  });
  views.I32.fill(0, wordsPtr >> 2, (wordsPtr >> 2) + WORDS);
  setWord(W.NOUT, magnitudes.length); setWord(W.NIN_PORTS, 1); setWord(W.NOUT_PORTS, 1);
  setWord(W.IN_PTR, inPtrC); setWord(W.IN_AVAIL, magnitudes.length); setWord(W.OUT_PTR, outPtrC);
  assert.equal(gr.work(handle, wordsPtr, errPtr, ERR_CAP), 0, readError());
  magnitudes.forEach((m, i) => {
    const re = views.F32[(outPtrC >> 2) + 2 * i];
    const im = views.F32[(outPtrC >> 2) + 2 * i + 1];
    const magnitude = Math.hypot(re, im);
    assert.ok(magnitude <= 0.5 + 1e-5,
      `clip: |${m}| came out as ${magnitude}, above the 0.5 threshold`);
    if (m <= 0.5)
      assert.ok(Math.abs(magnitude - m) < 1e-5,
        `clip: |${m}| is under the threshold and must pass through untouched`);
    else
      assert.ok(Math.abs(magnitude - 0.5) < 1e-5,
        `clip: |${m}| must be limited to exactly the threshold with knee 0`);
    // The whole reason not to clip I and Q separately: the phase survives.
    assert.ok(Math.abs(Math.atan2(im, re) - Math.PI / 4) < 1e-5,
      `clip: |${m}| had its phase rotated`);
  });
}

// --- Phase Unwrap: 2*pi discontinuities removed, and the offset carries across
// work() calls, which is the property a block that reset every call would lose.
{
  const { handle } = await loadShipped('js_phase_unwrap_ff.js');
  // A phase advancing by 0.75*pi per sample: every wrap is a real one, and the
  // unwrapped output must be an exact arithmetic ramp.
  const step = 0.75 * Math.PI;
  const wrap = (angle) => Math.atan2(Math.sin(angle), Math.cos(angle));
  const COUNT = 12;
  const inPtrU = alloc(COUNT * 4), outPtrU = alloc(COUNT * 4);
  for (let i = 0; i < COUNT; i++) views.F32[(inPtrU >> 2) + i] = wrap(i * step);
  const runUnwrap = (from, n) => {
    views.I32.fill(0, wordsPtr >> 2, (wordsPtr >> 2) + WORDS);
    setWord(W.NOUT, n); setWord(W.NIN_PORTS, 1); setWord(W.NOUT_PORTS, 1);
    setWord(W.IN_PTR, inPtrU + from * 4); setWord(W.IN_AVAIL, n);
    setWord(W.OUT_PTR, outPtrU + from * 4);
    assert.equal(gr.work(handle, wordsPtr, errPtr, ERR_CAP), 0, readError());
  };
  // Deliberately two calls, so the second one has to continue the first.
  runUnwrap(0, 5);
  runUnwrap(5, COUNT - 5);
  for (let i = 0; i < COUNT; i++)
    assert.ok(Math.abs(views.F32[(outPtrU >> 2) + i] - i * step) < 1e-4,
      `unwrap: sample ${i} came out as ${views.F32[(outPtrU >> 2) + i]}, ` +
      `expected the continuous ${i * step}` +
      (i >= 5 ? ' — the accumulated offset did not survive the call boundary' : ''));
}

// --- Peak Hold: one output per group, and the input view really is decim * nout
// items long, which is what makes reading x[i * n + k] legal at all.
{
  const { handle, info } = await loadShipped('js_peak_hold_ff.js', { absolute: 1 });
  const n = info.decim;
  assert.ok(n > 1, 'Peak Hold is a decimating block');
  const GROUPS = 3;
  const inPtrP = alloc(GROUPS * n * 4), outPtrP = alloc(GROUPS * 4);
  // The largest value of each group is negative and not at its edge, so a block
  // that took the first sample, the last one, or the signed maximum all fail.
  for (let g = 0; g < GROUPS; g++)
    for (let k = 0; k < n; k++)
      views.F32[(inPtrP >> 2) + g * n + k] = k === 2 ? -(g + 5) : 0.5;
  views.I32.fill(0, wordsPtr >> 2, (wordsPtr >> 2) + WORDS);
  setWord(W.NOUT, GROUPS); setWord(W.NIN_PORTS, 1); setWord(W.NOUT_PORTS, 1);
  setWord(W.IN_PTR, inPtrP); setWord(W.IN_AVAIL, GROUPS * n); setWord(W.OUT_PTR, outPtrP);
  assert.equal(gr.work(handle, wordsPtr, errPtr, ERR_CAP), 0, readError());
  for (let g = 0; g < GROUPS; g++)
    assert.equal(views.F32[(outPtrP >> 2) + g], g + 5,
      `peak hold: group ${g} must hold the largest magnitude in it`);
  assert.equal(w(W.CONSUME_EACH), GROUPS * n,
    'a decimating block consumes decim items per output');
}

console.log(`checked the JS Block runtime: descriptor validation, views, ` +
            `decim/interp, generalWork, forecast, logging, error capture, and ` +
            `the arithmetic of ${shipped.length} shipped blocks`);
