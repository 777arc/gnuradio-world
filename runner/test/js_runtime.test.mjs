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
rejects("gr.export({ inputs: ['complex'], outputs: [], work(){}, generalWork(){} });",
        /work\(\) or generalWork\(\), not both/, 'both work and generalWork');
rejects("gr.export({ inputs: ['cplx'], outputs: [], work(){} });",
        /unknown port type "cplx"/, 'an unknown port dtype');
rejects('gr.export({ inputs: [], outputs: [], work(){} });',
        /at least one input or output/, 'a block with no ports at all');
rejects("gr.export({ inputs: ['float'], outputs: [], params: { 'a-b': 1 }, work(){} });",
        /not a usable identifier/, 'a parameter name that is not an identifier');
rejects("gr.export({ inputs: ['float'], outputs: [], params: { a: [1, 2] }, work(){} });",
        /only numbers, strings and booleans/, 'a non-scalar parameter default');
rejects("gr.export({ inputs: ['float'], outputs: [], decimation: 0, work(){} });",
        /decimation must be a positive integer/, 'a zero decimation');
rejects("gr.export({ inputs: ['float'], outputs: [], work(){} }); gr.export({});",
        /called more than once/, 'a second gr.export');
rejects('this is not javascript(', /did not parse/, 'a syntax error');

// ---- compile, work, and the views ------------------------------------------

const HANDLE = 1;
assert.equal(gr.compile(HANDLE, cstr(GAIN), cstr('{"gain":3}'), errPtr, ERR_CAP), 0,
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

assert.equal(gr.compile(2, cstr(rateBlock('decimation: 4,')), 0, errPtr, ERR_CAP), 0,
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

assert.equal(gr.compile(3, cstr(rateBlock('interpolation: 4,')), 0, errPtr, ERR_CAP), 0,
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
assert.equal(gr.compile(4, cstr(GENERAL), 0, errPtr, ERR_CAP), 0, readError());
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
assert.equal(gr.compile(5, cstr(IDLE), 0, errPtr, ERR_CAP), 0, readError());
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
assert.equal(gr.compile(6, cstr(FORECAST), 0, errPtr, ERR_CAP), 0, readError());
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
assert.equal(gr.compile(7, cstr(VECTOR), 0, errPtr, ERR_CAP), 0, readError());
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
assert.equal(gr.compile(8, cstr(THROWS), 0, errPtr, ERR_CAP), 0, readError());
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
  0, errPtr, ERR_CAP), -1);
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
  work(nout) { this.log('hello', 7); return nout; } });`), 0, errPtr, ERR_CAP), 0);
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
  assert.equal(gr.compile(handle, cstr(text), cstr(JSON.stringify(params)), errPtr, ERR_CAP),
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
