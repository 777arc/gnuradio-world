// The editor's half of the JavaScript Block. See docs/js-blocks.md.
//
// Three jobs:
//
//   * turn a block's derived interface (its `_js_io`) into a RunnableDef, so the
//     rest of the editor -- ports, the Properties dialog, validation, .grc
//     serialization -- treats a JS block like any other block. Everything
//     downstream of defFor() in main.ts is unchanged; only the definition it
//     reads is per instance instead of per block id.
//
//   * re-derive that interface from the source, by running the *same* descriptor
//     validation the runner runs -- literally the same file, runner/src/
//     js_runtime.js, fetched and evaluated inside a sandboxed iframe. Editor and
//     runner therefore cannot disagree about what a descriptor means.
//
//   * keep the browser-local library of saved JS blocks (IndexedDB), so a block
//     someone writes is usable before any pull request merges.
//
// Unlike the Python Block, none of this is opt-in and none of it is slow: there
// is no runtime to download, introspection costs a few milliseconds, and ports
// follow the code as you type.
import type { ParamDef, PortTemplate, RunnableDef } from './block-defs';

export const JS_BLOCK_ID = 'wasm_js_block';
export const JS_SOURCE_PARAM = '_source_code';
export const JS_IO_PARAM = '_js_io';
// A JS block installed from the local library inlines its source here, so a
// flowgraph shared as a link works for someone who does not have that library.
// Empty on the inline block, whose source is JS_SOURCE_PARAM.
export const JS_LOCAL_SOURCE_PARAM = '_js_source';
// The dtype that selects the code field in the Properties dialog, spelled after
// native GRC's `_multiline_python_external` so the two blocks stay siblings.
export const JS_CODE_DTYPE = '_multiline_javascript_external';

/** One stream port, as gr.export() declared it. */
export interface JsPort { dtype: string; vlen: number }

/** What runner/src/js_runtime.js reports about one source. */
export interface JsBlockIo {
  label: string;
  doc: string;
  inputs: JsPort[];
  outputs: JsPort[];
  params: [string, unknown][];
  numericParams: string[];
  decim: number;
  interp: number;
  history: number;
  outputMultiple: number;
  relativeRate: number;
  general: boolean;
  overridesForecast: boolean;
  hasStart: boolean;
  hasStop: boolean;
  msgPortsIn?: string[];
  msgPortsOut?: string[];
  msgHandlerPorts?: string[];
  tagPropagation?: number;
  minOutputBuffers?: number[];
  maxNoutputItems?: number;
}

export function parseJsIo(text: unknown): JsBlockIo | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    const io = JSON.parse(text);
    return io && Array.isArray(io.params) && Array.isArray(io.inputs)
      ? io as JsBlockIo : null;
  } catch {
    return null;   // a hand-edited cache is not worth an error
  }
}

/**
 * The cache as it is written into a .grc: JSON with sorted keys, so re-deriving
 * identical source leaves the file byte for byte unchanged. The default in
 * blocks/grc/wasm_js_block.block.yml is this function's output for the default
 * source, which editor/test/js-block.test.mjs checks.
 */
export function serializeJsIo(io: JsBlockIo): string {
  return JSON.stringify(Object.fromEntries(
    Object.keys(io).sort().map(key => [key, (io as any)[key]])));
}

const portTemplate = (port: JsPort, label: string): PortTemplate => ({
  dtype: port.dtype, vlen: String(port.vlen ?? 1), domain: 'stream',
  id: '', label, multiplicity: '1', optional: false, hide: false,
});

const messagePortTemplate = (id: string): PortTemplate => ({
  dtype: 'message', vlen: '1', domain: 'message', id, label: id,
  multiplicity: '1', optional: true, hide: false,
});

// Each port is its own template with multiplicity 1, so nothing numbers them the
// way a repeated port is numbered -- two inputs would both read "in". Name them
// here instead, and only when there is more than one to tell apart.
const templatesFor = (ports: JsPort[], kind: 'in' | 'out'): PortTemplate[] =>
  ports.map((port, index) =>
    portTemplate(port, ports.length > 1 ? `${kind}${index}` : ''));

// upstream GRC's _update_params: `example_param` shows as "Example Param".
const titleCase = (id: string) =>
  id.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());

/**
 * The definition for one JS Block instance: the static schema from blocks.json
 * (the Code parameter and the two hidden ones) plus everything its own source
 * says about it.
 */
export function jsDef(base: RunnableDef, io: JsBlockIo | null): RunnableDef {
  const staticIds = new Set([JS_SOURCE_PARAM, JS_IO_PARAM, JS_LOCAL_SOURCE_PARAM]);
  const staticParams = base.params.filter(p => staticIds.has(p.id));
  if (!io) return { ...base, params: staticParams, inputs: 0, outputs: 0,
                    inputTemplates: [], outputTemplates: [] };

  // A numeric parameter is `type: 'number'`, which is what lets a QT GUI Range's
  // ID be typed into it and resolved on the Run path -- the whole point of the
  // numeric_setters entry the factory makes for it. Everything else is a string;
  // deliberately not `raw`, whose evaluation would rewrite a list into the
  // runner's own vector spelling, which JavaScript could not read.
  const numeric = new Set(io.numericParams || []);
  const derived: ParamDef[] = (io.params || []).map(([id, def]) => ({
    id,
    label: titleCase(id),
    type: numeric.has(id) ? 'number' : 'string',
    def: def === null || def === undefined ? '' : def,
  }));

  const inputTemplates = [
    ...templatesFor(io.inputs || [], 'in'),
    ...(io.msgPortsIn || []).map(messagePortTemplate),
  ];
  const outputTemplates = [
    ...templatesFor(io.outputs || [], 'out'),
    ...(io.msgPortsOut || []).map(messagePortTemplate),
  ];
  return {
    ...base,
    label: io.label || base.label,
    documentation: io.doc || base.documentation,
    params: [...staticParams, ...derived],
    inputs: inputTemplates.length,
    outputs: outputTemplates.length,
    inputTemplates,
    outputTemplates,
  };
}

// One synthesized definition per distinct cache string, so dragging a block
// around does not rebuild its schema on every frame.
const defCache = new Map<string, RunnableDef>();

export function jsDefForCache(base: RunnableDef, cache: unknown): RunnableDef {
  const key = typeof cache === 'string' ? cache : '';
  let def = defCache.get(key);
  if (!def) {
    def = jsDef(base, parseJsIo(key));
    defCache.set(key, def);
  }
  return def;
}

// The last introspection failure per block instance, so a JS block with a broken
// source reddens on the canvas rather than only in its dialog -- the same role
// `_epy_reload_error` plays for a Python Block. Keyed by uid and kept out of
// `inst.params`, which is serialized wholesale into the .grc.
const sourceErrors = new Map<string, string>();

export function setJsSourceError(uid: string, message: string) {
  if (message) sourceErrors.set(uid, message);
  else sourceErrors.delete(uid);
}

export function jsSourceError(uid: string): string {
  return sourceErrors.get(uid) || '';
}

/**
 * Which parameter holds an instance's source. `_js_source` for an instance placed
 * from the browser-local library (whose source travels with the flowgraph so a
 * shared link works for someone who does not have that library), `_source_code`
 * for the inline block. The same one rule the runner's factory applies, seen from
 * the editor's side.
 */
export function jsSourceParamOf(params: Record<string, any>): string {
  return String(params?.[JS_LOCAL_SOURCE_PARAM] ?? '').trim()
    ? JS_LOCAL_SOURCE_PARAM : JS_SOURCE_PARAM;
}

/** The source an instance runs. */
export function jsSourceOf(params: Record<string, any>): string {
  return String(params?.[jsSourceParamOf(params)] ?? '');
}

// ---- introspection, in a sandbox -------------------------------------------
// A .grc arriving from a link can carry arbitrary JavaScript, and deriving its
// ports means running it. So it runs inside an <iframe sandbox="allow-scripts"
// srcdoc=…>: an opaque origin, with no reach into the editor's localStorage
// (which holds the API keys Graham uses) and no credentialed
// same-origin fetch. The descriptor comes back as JSON over postMessage.
//
// The iframe cannot fetch js_runtime.js for itself -- an opaque origin has no
// same-origin fetch -- so the parent fetches the text once and embeds it. That
// is what makes this the same validation the runner performs rather than a
// second implementation of it.

const RUNTIME_URL = '/runner/build/js_runtime.js';
// An infinite loop at the top level of a source would wedge the sandbox. It
// cannot wedge the editor -- the frame is disposable and this is what disposes
// of it. (There is no such rescue for a work() that never returns; see "The
// hang" in docs/js-blocks.md.)
const INTROSPECT_TIMEOUT_MS = 2000;

let runtimeText: Promise<string> | null = null;

function loadRuntime(): Promise<string> {
  if (!runtimeText)
    runtimeText = fetch(RUNTIME_URL).then(response => {
      if (!response.ok)
        throw new Error(`the JS Block runtime is not available (HTTP ${response.status})`);
      return response.text();
    }).catch(error => { runtimeText = null; throw error; });
  return runtimeText;
}

export interface JsExerciseCall {
  nout?: number;
  inputs?: number[][];
  setParams?: Record<string, number>;
  tags?: { port: number; offset: number; key: unknown; value: unknown; srcid?: unknown }[];
}

export interface JsExerciseRequest {
  params?: Record<string, unknown>;
  calls?: JsExerciseCall[];
  forecastNout?: number;
  messages?: { port: string; value: unknown }[];
}

const EXERCISE_TIMEOUT_MS = 2000;

/**
 * Execute a few bounded work() calls in a disposable Worker. Unlike a live GNU
 * Radio scheduler thread, the Worker can be terminated if user code never
 * returns. It runs the same js_runtime.js entry points and heap-view machinery
 * as the runner, with outbound browser APIs removed before the source is read.
 */
export async function exerciseJsSource(
  source: string, request: JsExerciseRequest = {},
): Promise<Record<string, unknown>> {
  const calls = request.calls !== undefined ? request.calls : [{ nout: 8 }];
  if (calls.length > 8) throw new Error('exercise_js_block accepts at most 8 calls');
  let scalars = 0, tags = 0;
  for (const call of calls) {
    const nout = Number(call.nout ?? 8);
    if (!Number.isInteger(nout) || nout < 1 || nout > 4096)
      throw new Error('each exercise call needs nout from 1 to 4096');
    for (const input of call.inputs || []) {
      if (!Array.isArray(input) || input.some(value => !Number.isFinite(Number(value))))
        throw new Error('exercise inputs must be arrays of finite numbers');
      scalars += input.length;
    }
    for (const tag of call.tags || []) {
      if (!Number.isInteger(tag.port) || tag.port < 0)
        throw new Error('exercise tag ports must be non-negative integers');
      if (!Number.isSafeInteger(tag.offset) || tag.offset < 0)
        throw new Error('exercise tag offsets must be non-negative safe integers');
      tags++;
    }
  }
  if (scalars > 65_536) throw new Error('exercise inputs are limited to 65,536 scalar values');
  if (tags > 64) throw new Error('exercise_js_block accepts at most 64 input tags');
  if (request.forecastNout !== undefined &&
      (!Number.isInteger(request.forecastNout) || request.forecastNout < 1 ||
       request.forecastNout > 4096))
    throw new Error('forecastNout must be an integer from 1 to 4096');
  if ((request.messages?.length || 0) > 16)
    throw new Error('exercise_js_block accepts at most 16 input messages');
  for (const message of request.messages || [])
    if (typeof message.port !== 'string' || !message.port.length)
      throw new Error('exercise input messages need a non-empty port name');

  const runtime = await loadRuntime();
  const workerSource = `'use strict';
// This worker is a computation sandbox, not a second browser runtime. Remove
// outbound and worker-spawning APIs before evaluating any block source.
self.fetch = undefined; self.XMLHttpRequest = undefined; self.WebSocket = undefined;
self.EventSource = undefined; self.importScripts = undefined; self.Worker = undefined;
var __buffer = new ArrayBuffer(16 * 1024 * 1024);
var __next = 4096;
var __enc = new TextEncoder(), __dec = new TextDecoder();
function __alloc(bytes, alignment) {
  alignment = alignment || 8;
  __next = (__next + alignment - 1) & ~(alignment - 1);
  var ptr = __next; __next += bytes;
  if (__next >= __buffer.byteLength) throw new Error('the exercise exceeded its bounded heap');
  return ptr;
}
function GROWABLE_HEAP_I8() { return new Int8Array(__buffer); }
function GROWABLE_HEAP_U8() { return new Uint8Array(__buffer); }
function GROWABLE_HEAP_I16() { return new Int16Array(__buffer); }
function GROWABLE_HEAP_U16() { return new Uint16Array(__buffer); }
function GROWABLE_HEAP_I32() { return new Int32Array(__buffer); }
function GROWABLE_HEAP_U32() { return new Uint32Array(__buffer); }
function GROWABLE_HEAP_F32() { return new Float32Array(__buffer); }
function GROWABLE_HEAP_F64() { return new Float64Array(__buffer); }
function UTF8ToString(ptr) {
  var heap = new Uint8Array(__buffer), end = ptr;
  while (end < heap.length && heap[end]) end++;
  return __dec.decode(heap.subarray(ptr, end));
}
function stringToUTF8(text, ptr, cap) {
  var bytes = __enc.encode(String(text));
  var n = Math.max(0, Math.min(bytes.length, cap - 1));
  new Uint8Array(__buffer, ptr, n).set(bytes.subarray(0, n));
  new Uint8Array(__buffer)[ptr + n] = 0;
}
function stringToNewUTF8(text) {
  var bytes = __enc.encode(String(text)), ptr = __alloc(bytes.length + 1, 1);
  stringToUTF8(text, ptr, bytes.length + 1); return ptr;
}
function _malloc(bytes) { return __alloc(Math.max(1, bytes), 8); }
function _free() {}
var __arena = [], __bridgeError = '', __published = [], __tagsOut = [];
var __inputTags = [], __currentTags = [], __nread = [], __nwritten = [];
function __pmtAdd(value) { __arena.push(value); return __arena.length - 1; }
function __shim(run) { try { __bridgeError = ''; return run(); }
  catch (error) { __bridgeError = String(error && error.message || error); return -1; } }
function __big(lo, hi) { return BigInt(lo >>> 0) | (BigInt(hi >>> 0) << 32n); }
function __writeBig(value, ptr) { var u = GROWABLE_HEAP_U32(), b = ptr >> 2;
  u[b] = Number(value & 0xffffffffn); u[b + 1] = Number((value >> 32n) & 0xffffffffn); }
var __errorPtr = __alloc(1024, 1);
function _gr_js_last_error() { stringToUTF8(__bridgeError, __errorPtr, 1024); return __errorPtr; }
function _gr_js_pmt_make(kind, lo, hi, x, y, textPtr) { return __shim(function () {
  return __pmtAdd({ kind: kind, value: kind === 0 ? null : kind === 1 ? !!x
    : kind === 2 ? UTF8ToString(textPtr) : kind === 3 ? (lo | 0)
    : kind === 4 ? __big(lo, hi) : kind === 5 ? x : kind === 6 ? [x, y] : undefined }); }); }
function _gr_js_pmt_seq(kind, ptr, count) { return __shim(function () {
  var h = Array.from(GROWABLE_HEAP_I32().subarray(ptr >> 2, (ptr >> 2) + count));
  return __pmtAdd({ kind: kind, value: h.map(function (i) { return __arena[i]; }) }); }); }
function _gr_js_pmt_dict(ptr, count) { return __shim(function () {
  var h = Array.from(GROWABLE_HEAP_I32().subarray(ptr >> 2, (ptr >> 2) + count)), e = [];
  for (var i = 0; i < h.length; i += 2) e.push([__arena[h[i]], __arena[h[i + 1]]]);
  return __pmtAdd({ kind: 7, value: e }); }); }
function __itemSize(kind) { return ({20:1,21:1,22:2,23:2,24:4,25:4,26:8,27:8,
  28:4,29:8,30:8,31:16,32:1})[kind]; }
function _gr_js_pmt_blob_new(kind, count, meta) { return __shim(function () {
  var size = __itemSize(kind), ptr = __alloc(Math.max(1, count * size), size);
  GROWABLE_HEAP_U32().set([ptr, count * size, size, kind], meta >> 2);
  return __pmtAdd({ kind: kind === 32 ? 20 : kind, ptr: ptr, count: count, size: size }); }); }
function _gr_js_pmt_type(handle) { return __arena[handle] ? __arena[handle].kind : -1; }
function _gr_js_pmt_real(handle, component) { var v = __arena[handle].value;
  return Array.isArray(v) ? v[component] : Number(v); }
function _gr_js_pmt_u64(handle, ptr) { return __shim(function () {
  __writeBig(BigInt(__arena[handle].value), ptr); return 0; }); }
function _gr_js_pmt_length(handle) { var v = __arena[handle];
  return v.value && v.value.length !== undefined ? v.value.length : (v.count || 0); }
function _gr_js_pmt_ref(handle, op, index) { return __shim(function () { var v = __arena[handle].value;
  if (op < 2) return __pmtAdd(v[op]); if (op < 4) return __pmtAdd(v[index]);
  return __pmtAdd(v[index][op === 4 ? 0 : 1]); }); }
function _gr_js_pmt_text(handle, ptr, cap) { return __shim(function () {
  return stringToUTF8(__arena[handle].value, ptr, cap); }); }
function _gr_js_pmt_blob(handle, meta) { return __shim(function () { var v = __arena[handle];
  GROWABLE_HEAP_U32().set([v.ptr, v.count, v.size, v.kind], meta >> 2); return 0; }); }
function _gr_js_publish(handle, port, message) { return __shim(function () {
  __published.push({ port: port, value: __arena[message] }); return 0; }); }
function _gr_js_nitems(handle, written, port, ptr) { return __shim(function () {
  __writeBig((written ? __nwritten : __nread)[port] || 0n, ptr); return 0; }); }
function __samePmt(first, second) {
  if (!first || !second || first.kind !== second.kind) return false;
  return first.value === second.value;
}
function _gr_js_tags(handle, port, startLo, startHi, endLo, endHi, keyHandle) {
  return __shim(function () {
    var start = __big(startLo, startHi), end = __big(endLo, endHi);
    var key = keyHandle < 0 ? null : __arena[keyHandle];
    __currentTags = __inputTags.filter(function (tag) {
      return tag.port === port && tag.offset >= start && tag.offset < end &&
        (!key || __samePmt(tag.key, key));
    });
    return __currentTags.length;
  });
}
function _gr_js_tag_offset(handle, index, ptr) { return __shim(function () {
  __writeBig(__currentTags[index].offset, ptr); return 0; }); }
function _gr_js_tag_field(handle, index, field) { return __shim(function () {
  return __pmtAdd(__currentTags[index][['key','value','srcid'][field]]); }); }
function _gr_js_add_tag(handle, port, lo, hi, key, value, srcid) { return __shim(function () {
  __tagsOut.push({ port: port, offset: __big(lo, hi), key: __arena[key], value: __arena[value],
    srcid: srcid < 0 ? { kind: 1, value: false } : __arena[srcid] }); return 0; }); }
function __plainPmt(value) {
  if (value === null || value === undefined) return { kind: 0, value: null };
  if (typeof value === 'boolean') return { kind: 1, value: value };
  if (typeof value === 'string') return { kind: 2, value: value };
  if (typeof value === 'bigint') return { kind: 4, value: value };
  if (typeof value === 'number') return { kind: Number.isInteger(value) ? 3 : 5, value: value };
  if (Array.isArray(value)) return { kind: 9, value: value.map(__plainPmt) };
  var entries = Object.keys(value).map(function (key) {
    return [{ kind: 2, value: key }, __plainPmt(value[key])]; });
  return { kind: 7, value: entries };
}
function __plain(value) {
  if (!value) return value;
  if (value.kind === 7) { var result = {}; value.value.forEach(function (entry) {
    result[entry[0].value] = __plain(entry[1]); }); return result; }
  if (value.kind === 8 || value.kind === 9 || value.kind === 10) return value.value.map(__plain);
  if (value.ptr !== undefined) return Array.from(new Uint8Array(__buffer, value.ptr, value.count * value.size));
  return typeof value.value === 'bigint' ? value.value.toString() + 'n' : value.value;
}
${runtime}
var __types = {
  complex: { C: Float32Array, elems: 2, bytes: 4 },
  float: { C: Float32Array, elems: 1, bytes: 4 },
  int: { C: Int32Array, elems: 1, bytes: 4 },
  short: { C: Int16Array, elems: 1, bytes: 2 },
  byte: { C: Int8Array, elems: 1, bytes: 1 }
};
function __writeText(text) {
  var bytes = __enc.encode(String(text)), ptr = __alloc(bytes.length + 1, 1);
  stringToUTF8(text, ptr, bytes.length + 1); return ptr;
}
function __error(ptr) { return UTF8ToString(ptr) || 'the JavaScript exercise failed'; }
function __summary(values) {
  var list = Array.from(values), head = list.slice(0, 128);
  var hasBig = list.some(function (value) { return typeof value === 'bigint'; });
  var min = list.length && !hasBig ? Math.min.apply(null, list) : null;
  var max = list.length && !hasBig ? Math.max.apply(null, list) : null;
  if (hasBig) head = head.map(function (value) { return value.toString() + 'n'; });
  return { values: head, total_values: list.length,
    truncated: list.length > head.length, min: min, max: max };
}
self.onmessage = function (event) {
  try {
    var payload = event.data || {}, described = __grJs.describeSource(payload.source);
    if (!described.ok) throw new Error(described.error);
    var info = described.info, err = __alloc(4096, 8), wordsPtr = __alloc(__grJs.WORDS * 4, 8);
    var words = GROWABLE_HEAP_I32(), base = wordsPtr >> 2, handle = 1;
    var srcPtr = __writeText(payload.source), paramsPtr = __writeText(JSON.stringify(payload.params || {}));
    var rc = __grJs.compile(handle, srcPtr, paramsPtr, 0, err, 4096);
    if (rc) throw new Error(__error(err));
    __nread = new Array(info.inputs.length).fill(0n);
    __nwritten = new Array(info.outputs.length).fill(0n);
    var received = [];
    for (var mi = 0; mi < (payload.messages || []).length; mi++) {
      var incoming = payload.messages[mi];
      var messageIndex = (info.msgHandlerPorts || []).indexOf(incoming.port);
      if (messageIndex < 0) throw new Error('no JS message handler for port ' + incoming.port);
      var messageHandle = __pmtAdd(__plainPmt(incoming.value));
      rc = __grJs.message(handle, messageIndex, messageHandle, err, 4096);
      if (rc) throw new Error(__error(err));
      received.push({ port: incoming.port, value: incoming.value });
    }
    var forecast = null;
    if (payload.forecastNout !== undefined) {
      words[base] = payload.forecastNout | 0; words[base + 1] = info.inputs.length;
      rc = __grJs.forecast(handle, wordsPtr, err, 4096);
      if (rc) throw new Error(__error(err));
      forecast = [];
      var forecastBase = 8 + __grJs.MAX_PORTS * 4;
      for (var fi = 0; fi < info.inputs.length; fi++) forecast.push(words[base + forecastBase + fi]);
    }
    var results = [];
    for (var ci = 0; ci < payload.calls.length; ci++) {
      var call = payload.calls[ci], nout = call.nout | 0, inputs = call.inputs || [];
      __inputTags = (call.tags || []).map(function (tag) {
        if (tag.port < 0 || tag.port >= info.inputs.length)
          throw new Error('call ' + ci + ' tag names no input port ' + tag.port);
        return { port: tag.port, offset: BigInt(tag.offset), key: __plainPmt(tag.key),
          value: __plainPmt(tag.value),
          srcid: tag.srcid === undefined ? { kind: 1, value: false } : __plainPmt(tag.srcid) };
      });
      Object.keys(call.setParams || {}).forEach(function (name) {
        if (info.numericParams.indexOf(name) < 0)
          throw new Error('no numeric live parameter named ' + name);
        var namePtr = __writeText(name);
        if (__grJs.setParam(handle, namePtr, Number(call.setParams[name])) < 0)
          throw new Error('could not update parameter ' + name);
      });
      words = GROWABLE_HEAP_I32();
      words[base] = nout; words[base + 1] = info.inputs.length;
      words[base + 2] = info.outputs.length; words[base + 3] = 0; words[base + 4] = 0;
      var inputPtrs = [], outputViews = [];
      for (var ii = 0; ii < info.inputs.length; ii++) {
        var ip = info.inputs[ii], its = __types[ip.dtype], raw = inputs[ii] || [];
        var stride = its.elems * ip.vlen;
        var neededItems = info.general ? Math.floor(raw.length / stride)
          : Math.floor(nout * info.decim / info.interp);
        var neededValues = neededItems * stride;
        if (raw.length && raw.length < neededValues)
          throw new Error('call ' + ci + ' input ' + ii + ' needs at least ' + neededValues + ' scalar values');
        var inPtr = __alloc(Math.max(1, neededValues) * its.bytes, its.bytes);
        var inView = new its.C(__buffer, inPtr, neededValues);
        if (raw.length) inView.set(raw.slice(0, neededValues));
        inputPtrs.push(inPtr);
        words[base + 8 + ii] = inPtr;
        words[base + 8 + __grJs.MAX_PORTS + ii] = neededItems;
      }
      for (var oi = 0; oi < info.outputs.length; oi++) {
        var op = info.outputs[oi], ots = __types[op.dtype], count = nout * ots.elems * op.vlen;
        var outPtr = __alloc(Math.max(1, count) * ots.bytes, ots.bytes);
        outputViews.push(new ots.C(__buffer, outPtr, count));
        words[base + 8 + __grJs.MAX_PORTS * 2 + oi] = outPtr;
      }
      rc = __grJs.work(handle, wordsPtr, err, 4096);
      if (rc) throw new Error(__error(err));
      words = GROWABLE_HEAP_I32();
      var produced = words[base + 3], consumeEach = words[base + 4], consumed = [];
      if (produced < 0 || produced > nout)
        throw new Error('call ' + ci + ' returned ' + produced + ' produced items for nout=' + nout);
      var consumeBase = 8 + __grJs.MAX_PORTS * 3;
      for (var co = 0; co < info.inputs.length; co++) {
        var amount = consumeEach >= 0 ? consumeEach : words[base + consumeBase + co];
        var available = words[base + 8 + __grJs.MAX_PORTS + co];
        if (amount < 0 || amount > available)
          throw new Error('call ' + ci + ' consumed ' + amount + ' items from input ' + co +
            ', which had ' + available);
        consumed.push(amount);
        __nread[co] += BigInt(amount);
      }
      for (var wo = 0; wo < info.outputs.length; wo++) __nwritten[wo] += BigInt(produced);
      var logPtr = __alloc(4096, 1), logged = __grJs.takeLog(handle, logPtr, 4096);
      results.push({ produced: produced, consumed: consumed,
        outputs: outputViews.map(__summary), log: logged ? UTF8ToString(logPtr).split('\\n') : [] });
    }
    rc = __grJs.stop(handle, err, 4096);
    if (rc) throw new Error(__error(err));
    __grJs.destroy(handle);
    self.postMessage({ ok: true, info: info, forecast: forecast, calls: results,
      messages_received: received,
      messages_published: __published.map(function (entry) {
        return { port: (info.msgPortsOut || [])[entry.port], value: __plain(entry.value) }; }),
      tags_added: __tagsOut.map(function (tag) {
        return { port: tag.port, offset: tag.offset.toString(), key: __plain(tag.key),
          value: __plain(tag.value), srcid: __plain(tag.srcid) }; }) });
  } catch (error) {
    self.postMessage({ ok: false, error: String(error && (error.stack || error.message) || error) });
  }
};`;

  const blob = new Blob([workerSource], { type: 'text/javascript' });
  const url = URL.createObjectURL(blob);
  const worker = new Worker(url);
  try {
    return await new Promise<Record<string, unknown>>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(() => finish(() => reject(new Error(
        'the JS Block exercise timed out — work() or another hook may not return'))),
      EXERCISE_TIMEOUT_MS);
      worker.onmessage = event => finish(() => event.data?.ok
        ? resolve(event.data) : reject(new Error(event.data?.error || 'the exercise failed')));
      worker.onerror = event => finish(() => reject(new Error(event.message || 'the exercise worker failed')));
      worker.postMessage({ source, params: request.params || {}, calls,
        forecastNout: request.forecastNout, messages: request.messages || [] });
    });
  } finally {
    worker.terminate();
    URL.revokeObjectURL(url);
  }
}

// The page the sandbox runs. It installs the stand-ins js_runtime.js needs at
// call time -- only describeSource() is used here, and it touches none of the
// heap accessors -- then answers one message with one descriptor.
function sandboxPage(runtime: string): string {
  return `<!doctype html><meta charset="utf-8"><script>
(function () {
  'use strict';
  var noop = function () { return 0; };
  self.stringToUTF8 = noop; self.stringToNewUTF8 = noop; self.UTF8ToString = function () { return ''; };
  try {
${runtime}
  } catch (e) {
    parent.postMessage({ ready: false, error: String(e && e.message || e) }, '*');
    return;
  }
  addEventListener('message', function (event) {
    var data = event.data || {};
    if (typeof data.source !== 'string') return;
    var result;
    try {
      result = self.__grJs.describeSource(data.source);
    } catch (e) {
      result = { ok: false, error: String(e && e.stack || e && e.message || e) };
    }
    // '*' is not a loosening here, it is the only option: this frame has an
    // opaque origin, so there is no origin string that would name the parent.
    // The parent checks event.source instead, which is the identity that matters.
    parent.postMessage({ id: data.id, result: result }, '*');
  });
  parent.postMessage({ ready: true }, '*');
})();
<\/script>`;
}

export class JsIntrospector {
  private frame: HTMLIFrameElement | null = null;
  private ready: Promise<HTMLIFrameElement> | null = null;
  private nextId = 1;

  private start(): Promise<HTMLIFrameElement> {
    if (this.ready) return this.ready;
    this.ready = loadRuntime().then(runtime => new Promise<HTMLIFrameElement>(
      (resolve, reject) => {
        const frame = document.createElement('iframe');
        // 'allow-scripts' and nothing else: the frame gets an opaque origin,
        // which is the whole point. Relaxing that would hand the block's source
        // the editor's own storage and its credentialed fetch.
        frame.setAttribute('sandbox', 'allow-scripts');
        frame.style.display = 'none';
        frame.srcdoc = sandboxPage(runtime);
        const onMessage = (event: MessageEvent) => {
          if (event.source !== frame.contentWindow) return;
          const data = event.data || {};
          if (data.ready === undefined) return;
          removeEventListener('message', onMessage);
          if (data.ready) resolve(frame);
          else reject(new Error(data.error || 'the JS Block runtime failed to load'));
        };
        addEventListener('message', onMessage);
        document.body.appendChild(frame);
        this.frame = frame;
        setTimeout(() => reject(new Error('the JS Block sandbox did not start')),
                   INTROSPECT_TIMEOUT_MS * 2);
      }));
    this.ready = this.ready.catch(error => { this.dispose(); throw error; });
    return this.ready;
  }

  /** Throw the sandbox away, which is also how a wedged one is disposed of. */
  dispose() {
    this.frame?.remove();
    this.frame = null;
    this.ready = null;
  }

  /** Derive a block's interface from its source. A few milliseconds. */
  async describe(source: string): Promise<JsBlockIo> {
    const frame = await this.start();
    const id = this.nextId++;
    return new Promise<JsBlockIo>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        removeEventListener('message', onMessage);
        clearTimeout(timer);
        fn();
      };
      const onMessage = (event: MessageEvent) => {
        if (event.source !== frame.contentWindow) return;
        const data = event.data || {};
        if (data.id !== id) return;
        finish(() => {
          if (data.result?.ok) resolve(data.result.info as JsBlockIo);
          else reject(new Error(data.result?.error || 'the block source could not be read'));
        });
      };
      const timer = setTimeout(() => finish(() => {
        // A source that never answers has wedged its frame. Bin it; the next
        // introspection starts a fresh one.
        this.dispose();
        reject(new Error('the block source did not finish evaluating — an ' +
                         'infinite loop at the top level of the file?'));
      }), INTROSPECT_TIMEOUT_MS);
      addEventListener('message', onMessage);
      // Same as in the page above: an opaque origin has no nameable origin, and
      // the only reader of this message is the frame we just created.
      frame.contentWindow?.postMessage({ id, source }, '*');
    });
  }
}

export const jsIntrospector = new JsIntrospector();

// ---- Run consent ------------------------------------------------------------
// A .grc arriving from a link can carry arbitrary JavaScript, and the runner
// iframe is same-origin with the editor. So pressing Run on a flowgraph whose JS
// has not been accepted shows the code and asks -- the same shape as the RTL-SDR
// device prompt on the Run click, remembered per source hash in localStorage.
//
// Source typed in this session is trusted from the moment it was typed, and a
// repo block is trusted because it went through review.

const CONSENT_KEY = 'gnuradio-world.js-blocks-accepted';

/** FNV-1a. Not a security boundary — a stable key for "this exact source". */
export function sourceHash(source: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < source.length; i++) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0') + ':' + source.length;
}

function acceptedHashes(): Set<string> {
  try {
    const raw = localStorage.getItem(CONSENT_KEY);
    return new Set(raw ? JSON.parse(raw) as string[] : []);
  } catch {
    return new Set();
  }
}

export function isJsSourceAccepted(source: string): boolean {
  return acceptedHashes().has(sourceHash(source));
}

export function acceptJsSource(source: string) {
  const hashes = acceptedHashes();
  hashes.add(sourceHash(source));
  try {
    // Bounded: this is a convenience record, not an archive.
    localStorage.setItem(CONSENT_KEY, JSON.stringify([...hashes].slice(-200)));
  } catch { /* private mode */ }
}

// ---- the browser-local block library ---------------------------------------
// The repo pair (blocks/js/<id>.js + blocks/grc/<id>.block.yml) is the real
// destination -- a JS block that ships is a block everyone gets. But a static
// site with no backend cannot commit for you, so without this every block is
// unusable until a pull request merges.

export interface LocalJsBlock {
  id: string;
  label: string;
  category: string;      // e.g. '[Custom JS Blocks]/Filters'
  source: string;
  io: JsBlockIo;
  saved: number;         // epoch ms
}

const DB_NAME = 'gnuradio-world';
const STORE = 'js-blocks';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB is unavailable'));
  });
}

function transact<T>(mode: IDBTransactionMode,
                     run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return openDb().then(db => new Promise<T>((resolve, reject) => {
    const request = run(db.transaction(STORE, mode).objectStore(STORE));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('the local block library failed'));
  }));
}

export async function listLocalJsBlocks(): Promise<LocalJsBlock[]> {
  try {
    const all = await transact<LocalJsBlock[]>('readonly', store => store.getAll());
    return (all || []).sort((a, b) => a.label.localeCompare(b.label));
  } catch {
    return [];    // private mode, or a browser with no IndexedDB
  }
}

export async function saveLocalJsBlock(block: LocalJsBlock): Promise<void> {
  await transact('readwrite', store => store.put(block));
}

export async function deleteLocalJsBlock(id: string): Promise<void> {
  await transact('readwrite', store => store.delete(id));
}

// A saved block's id has to be a legal GRC block id, and must not collide with
// one that already exists.
export function sanitizeBlockId(raw: string): string {
  let id = String(raw ?? '').trim().toLowerCase().replace(/[^a-z0-9_]+/g, '_');
  id = id.replace(/^_+/, '').replace(/_+$/, '').replace(/_+/g, '_');
  if (!id) id = 'js_block';
  if (/^[0-9]/.test(id)) id = 'js_' + id;
  return id.slice(0, 48).replace(/_+$/, '');
}

// ---- the repo pair a saved block offers to become ---------------------------
// The yml is authoritative for a repo block, not the descriptor: it unlocks the
// whole GRC parameter and port vocabulary -- enums, templated dtypes, hide
// expressions, categories, documentation -- that a JS object would re-invent
// badly. No human writes it by hand; this generates it from the descriptor.

function ymlScalar(value: unknown): string {
  const text = String(value ?? '');
  return /^[A-Za-z_][\w .\-/]*$/.test(text) && !/^(y|n|yes|no|true|false|on|off)$/i.test(text)
    ? text : `'${text.replace(/'/g, "''")}'`;
}

const GRC_DTYPE: Record<string, string> = {
  complex: 'complex', float: 'float', int: 'int', short: 'short', byte: 'byte',
};

export function generateBlockYml(block: LocalJsBlock): string {
  const lines: string[] = [
    `# Generated from a JS Block's own descriptor by the editor's Save as Block.`,
    `# The yml is authoritative for a repo block: edit it, not the descriptor's`,
    `# port declaration, and gen_registry.py will hold the two to each other.`,
    `id: ${block.id}`,
    `label: ${ymlScalar(block.label)}`,
    `category: ${ymlScalar(block.category)}`,
    `flags: [js]`,
    ``,
  ];
  const doc = (block.io.doc || '').trim();
  lines.push('documentation: |-');
  for (const line of (doc || `${block.label}, implemented in JavaScript.`).split('\n'))
    lines.push('    ' + line);
  lines.push('');
  lines.push('    Implemented in JavaScript: see blocks/js/' + block.id + '.js.');
  lines.push('    This block exists only in the WebAssembly runner — it has no Python');
  lines.push('    implementation, so a flowgraph using it will not run in desktop GNU Radio.');
  lines.push('');

  const numeric = new Set(block.io.numericParams || []);
  if (block.io.params?.length) {
    lines.push('parameters:');
    for (const [id, def] of block.io.params) {
      lines.push(`-   id: ${id}`);
      lines.push(`    label: ${ymlScalar(titleCase(id))}`);
      lines.push(`    dtype: ${numeric.has(id) ? 'real' : 'string'}`);
      lines.push(`    default: ${ymlScalar(def)}`);
    }
    lines.push('');
  }
  for (const [key, ports, messages] of [
    ['inputs', block.io.inputs, block.io.msgPortsIn],
    ['outputs', block.io.outputs, block.io.msgPortsOut],
  ] as [string, JsPort[], string[] | undefined][]) {
    if (!ports?.length && !messages?.length) continue;
    lines.push(`${key}:`);
    for (const port of ports) {
      lines.push('-   domain: stream');
      lines.push(`    dtype: ${GRC_DTYPE[port.dtype] || port.dtype}`);
      if ((port.vlen ?? 1) !== 1) lines.push(`    vlen: '${port.vlen}'`);
    }
    for (const id of messages || []) {
      lines.push('-   domain: message');
      lines.push(`    id: ${ymlScalar(id)}`);
      lines.push('    optional: true');
    }
    lines.push('');
  }
  lines.push('file_format: 1');
  return lines.join('\n') + '\n';
}
