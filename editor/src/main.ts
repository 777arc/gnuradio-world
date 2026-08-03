// GNU Radio WebAssembly Flowgraph Editor (TypeScript).
// Loads the block library, lets you place/connect/configure blocks on an SVG
// canvas, and Runs the flowgraph by handing JSON to the C++/WASM runner via a
// URL hash (runner.html#<encoded json>).

import { dumpGrc, parseGrc, type GrcDoc, type GrcScalar } from './grc';
import { boundsBetween, boundsIntersect, type Point } from './selection';
import { ceilToGrid, centeredPortSlot, constrainBlockPosition, SNAP_GRID_SIZE } from './grid';
import { arrangeFlowgraph, type LayoutNode } from './layout';
import { evaluate as evalExpr, buildScope, formatValue as fmtExprVal, serializeForRunner, type Scope } from './expr';
import { wrapNoteText, NOTE_FONT_SIZE } from './note';
import { EXAMPLES_REPO, examplePath, newExampleFileUrl, sanitizeExampleName } from './contribute';
import aboutHtml from './about.html?raw';

import {
  BLOCKS_URL,
  DTYPE_COLOR,
  RUNNABLE,
  type ParamDef,
  type ResolvedPort,
  type RunnableDef,
} from './block-defs';
import type { Conn, GraphSnapshot, Inst, ValidationIssue } from './graph-model';
import {
  NAME_FIELD,
  VARIABLE_IDS,
  validateFlowgraph,
} from './validation';
import {
  buildRecordingTree,
  displayBytes,
  displayRecordingValue,
  displaySi,
  isCi16Datatype,
  recordingFromR2Index,
  recordingTreeCount,
  recordingViewUrl,
  recordingsBucketUrl,
  sigmfFileSourceFormat,
  type ExampleRecording,
  type FileSourceFormat,
  type R2RecordingIndexEntry,
  type RecordingDirectory,
} from './recording-catalog';
import {
  buildExampleTree,
  encodeExamplePath,
  exampleFileName,
  exampleTreeCount,
  exampleUrl,
  normalizeExamplePath,
  type ExampleDirectory,
} from './example-catalog';
import { installGeneratedBlocks, numericOrExpression } from './block-library';
import { showDebugInfo } from './debug-panel';

const SVGNS = 'http://www.w3.org/2000/svg';
const el = (id: string) => document.getElementById(id)!;
const nodesG = el('nodes'), wiresG = el('wires'), selectionG = el('selectionOverlay');
const svg = el('svg') as unknown as SVGSVGElement;

let insts: Inst[] = [];
let conns: Conn[] = [];
let selected: string | null = null;
let selectedBlocks = new Set<string>();
let selectedConnection: Conn | null = null;
let counter = 0;
// In-progress connection: a rubber-band wire from a port (either an output or an
// input, GRC-style). Two ways to complete it: drag from one port and release on
// another, or click one port then click the other. `connectPreview` is the live
// SVG path. `connectDownPt` is the screen point where the source port was
// pressed; a press-release on the same port that barely moved reads as a click
// (which arms click-to-connect) rather than an aborted drag.
let connecting: { uid: string; port: number; kind: 'in' | 'out' } | null = null;
let connectPreview: SVGPathElement | null = null;
let connectDownPt: { x: number; y: number } | null = null;
const CONNECT_CLICK_SLOP = 4;   // px of movement still treated as a click, not a drag
let autoScrollLog = true;
let zoom = 1;
let hideDisabled = false;
// Unlike desktop GRC's historical preference default, the WASM editor starts
// with snapping enabled so newly opened sessions get aligned movement.
let snapToGrid = true;
let paletteSearch: HTMLInputElement | null = null;

// Blocks that name a file the browser has to open for itself, and the parameter
// holding that name. Each gets a Browse control in its Properties dialog, and
// the File it picks is bound for this session under the block's
// `localFileToken` (a .grc keeps the human-readable name, never a File handle).
// The Run path rewrites the parameter of exactly these blocks to the
// /local-files/... path the runner resolves that binding through.
const LOCAL_FILE_PARAMS: Record<string, string> = {
  blocks_file_source: 'file',
  paint_image_source: 'image_file',   // gr-paint's Image File Source
};
// What the native file input offers, per block: an Image File Source only ever
// wants a picture, where a File Source takes any recording.
const LOCAL_FILE_ACCEPT: Record<string, string> = {
  paint_image_source: 'image/*',
};

const localFilesByToken = new Map<string, File>();
function newLocalFileToken(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const graphHistory: GraphSnapshot[] = [];
let historyIndex = -1;
let historyReady = false;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function snapshot(): GraphSnapshot { return clone({ insts, conns, counter }); }
function resetHistory() {
  graphHistory.length = 0; graphHistory.push(snapshot()); historyIndex = 0;
}
function recordHistory() {
  if (!historyReady) return;
  graphHistory.splice(historyIndex + 1);
  graphHistory.push(snapshot());
  if (graphHistory.length > 100) graphHistory.shift();
  historyIndex = graphHistory.length - 1;
}
function restoreHistory(index: number) {
  if (index < 0 || index >= graphHistory.length) return;
  historyIndex = index;
  const state = clone(graphHistory[index]);
  insts = state.insts; conns = state.conns; counter = state.counter;
  selected = null; selectedBlocks.clear(); selectedConnection = null; cancelConnect();
  render();
}
function undo() { restoreHistory(historyIndex - 1); }
function redo() { restoreHistory(historyIndex + 1); }

// The console pane holds at most this many lines. A running flowgraph can print
// continuously (a Message Debug on a fast frame source emits hundreds of lines a
// second), and an unbounded textContent grows without limit and gets slower with
// every append, so drop the oldest lines once the pane is full.
const LOG_MAX_LINES = 4000;

// Append a burst in one pass. A running flowgraph delivers stdout in batches of
// up to a couple of hundred lines; rewriting the pane once per batch instead of
// once per line keeps the cost proportional to the batch, not to batch x buffer.
function logLines(lines: string[]) {
  if (!lines.length) return;
  const l = el('log');
  const existing = l.textContent ? l.textContent.split('\n') : [];
  if (existing.length && existing[existing.length - 1] === '') existing.pop();
  const all = existing.concat(lines);
  const kept = all.length > LOG_MAX_LINES ? all.slice(all.length - LOG_MAX_LINES) : all;
  l.textContent = kept.join('\n') + '\n';
  if (autoScrollLog) l.scrollTop = l.scrollHeight;
}

function log(s: string) { logLines([s]); }

// GRC-style geometry: title bar + "Label: value" parameter rows, typed ports.
const TITLE_H = 22, ROW_H = 15, PAD = 6, PORT_H = 15;
// Keeping ports two grid cells apart lets centered odd and even port groups
// share the same grid-aligned geometry.
const PORT_PITCH = SNAP_GRID_SIZE * 2;
// Horizontal breathing room around the title/parameter text inside a block.
const TEXT_PAD_L = 6, TEXT_PAD_R = 6;
const PORT_FONT_SIZE = 10, PORT_LABEL_PAD = 4, PORT_MIN_W = 20;
// A face with dozens of parameters (dvbs2_bbheader_source has 37) grows into a
// wall that dwarfs everything else on the canvas, so it is cut to this many
// lines with the last one saying how many are missing. Properties still shows
// the whole set; only the drawn face is capped.
const MAX_FACE_ROWS = 14, MORE_ROW_ID = '__more';
// Rows sit centered in the body: the height is rounded up to the port pitch, and
// giving that slack to the bottom alone left the text visibly high in the block.
const rowsTop = (h: number, rows: number) => (h + TITLE_H - rows * ROW_H) / 2;

function templateScope(params: Record<string, any>): Scope {
  const scope: Scope = { ...varScope };
  for (const [id, raw] of Object.entries(params)) {
    const text = String(raw ?? '').trim();
    if (typeof raw === 'number' || typeof raw === 'boolean') scope[id] = raw;
    else if (text === 'True' || text === 'False') scope[id] = text === 'True';
    else if (text && Number.isFinite(Number(text))) scope[id] = Number(text);
    else scope[id] = text;
  }
  return scope;
}

function templateValue(raw: any, params: Record<string, any>): any {
  const text = String(raw ?? '').trim();
  const match = text.match(/^\$\{\s*([\s\S]*?)\s*\}$/);
  if (!match) return raw;
  const result = evalExpr(match[1], templateScope(params));
  return result.ok ? result.value : raw;
}

function pythonBool(raw: any): boolean {
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'number') return raw !== 0;
  const text = String(raw ?? '').trim();
  return text !== '' && text !== 'False' && text !== 'false' && text !== '0';
}

function portHidden(raw: string | boolean, params: Record<string, any>): boolean {
  const text = String(raw ?? '').trim();
  const not = text.match(/^\$\{\s*not\s+([A-Za-z_]\w*)\s*\}$/);
  if (not) return !pythonBool(params[not[1]]);
  const direct = text.match(/^\$\{\s*([A-Za-z_]\w*)\s*\}$/);
  if (direct) return pythonBool(params[direct[1]]);
  const value = templateValue(raw, params);
  // Unsupported native expressions (for example `${ type.hide }`) should
  // remain visible, matching the editor's historical fallback, rather than
  // treating the unevaluated non-empty template text as truthy.
  return value === raw && /^\$\{.*\}$/.test(text) ? false : pythonBool(value);
}

function templateMultiplicity(raw: any, params: Record<string, any>): number {
  const value = templateValue(raw, params);
  const number = Number(value);
  // GRC's EvaluatedPInt falls back to one for zero, negative or invalid values.
  return Number.isFinite(number) && number >= 1 ? Math.trunc(number) : 1;
}

function resolvedPorts(inst: Inst, kind: 'in' | 'out'): ResolvedPort[] | null {
  const d = RUNNABLE[inst.id];
  const templates = kind === 'in' ? d.inputTemplates : d.outputTemplates;
  if (!templates) return null;
  const result: ResolvedPort[] = [];
  let streamIndex = 0;
  for (const port of templates) {
    const count = templateMultiplicity(port.multiplicity, inst.params);
    const domain = port.domain || 'stream';
    const baseName = String(port.label ||
      (domain === 'stream' ? kind : port.id) || kind);
    const hidden = portHidden(port.hide, inst.params);
    for (let i = 0; i < count; ++i) {
      const currentStreamIndex = domain === 'stream' ? streamIndex : -1;
      result.push({
        dtype: port.dtype.replace(
          /^\$\{\s*([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?)\s*\}$/, '$$$1'),
        vlen: templateValue(port.vlen, inst.params),
        domain,
        id: domain === 'stream' ? String(currentStreamIndex) : String(port.id || baseName),
        name: count > 1 ? `${baseName}${i}` : baseName,
        streamIndex: currentStreamIndex,
        optional: port.optional,
        hidden,
      });
      if (domain === 'stream') ++streamIndex;
    }
  }
  return result;
}

function legacyPortCount(inst: Inst, kind: 'in' | 'out'): number {
  const d = RUNNABLE[inst.id];
  const key = kind === 'in'
    ? (d.params.some(p => p.id === 'num_inputs') ? 'num_inputs' :
       d.params.some(p => p.id === 'nconnections') && d.inputs ? 'nconnections' : '')
    : (d.params.some(p => p.id === 'num_outputs') ? 'num_outputs' :
       d.params.some(p => p.id === 'nconnections') && !d.inputs ? 'nconnections' : '');
  if (!key) return kind === 'in' ? d.inputs : d.outputs;
  const value = Number(inst.params[key]);
  return Number.isFinite(value) ? Math.max(1, Math.trunc(value)) : (kind === 'in' ? d.inputs : d.outputs);
}

function portMeta(inst: Inst, kind: 'in' | 'out', i: number): ResolvedPort {
  const dynamic = resolvedPorts(inst, kind);
  if (dynamic?.[i]) return dynamic[i];
  const d = RUNNABLE[inst.id];
  const domains = kind === 'in' ? d.inDomains : d.outDomains;
  const types = kind === 'in' ? d.inTypes : d.outTypes;
  const ids = kind === 'in' ? d.inIds : d.outIds;
  const labels = kind === 'in' ? d.inLabels : d.outLabels;
  const indices = kind === 'in' ? d.inStreamIndices : d.outStreamIndices;
  const domain = domains?.[i] || 'stream';
  return {
    dtype: types?.[i] || '',
    vlen: 1,
    domain,
    id: ids?.[i] ?? (domain === 'stream' ? String(indices?.[i] ?? i) : String(i)),
    name: labels?.[i] || `${kind}${legacyPortCount(inst, kind) > 1 ? i : ''}`,
    streamIndex: domain === 'stream' ? (indices?.[i] ?? i) : -1,
    optional: false,
    hidden: false,
  };
}

function visiblePortIndices(inst: Inst, kind: 'in' | 'out'): number[] {
  const count = portCount(inst, kind);
  return Array.from({ length: count }, (_, i) => i)
    .filter(i => !portMeta(inst, kind, i).hidden);
}

function remapConnectionsForPortChange(inst: Inst, nextParams: Record<string, any>) {
  if (!RUNNABLE[inst.id].inputTemplates && !RUNNABLE[inst.id].outputTemplates) return;
  const next = { ...inst, params: nextParams };
  const portKey = (port: ResolvedPort) =>
    port.domain === 'stream' ? `stream:${port.streamIndex}` : `message:${port.id}`;
  const mappings = (kind: 'in' | 'out') => {
    const oldPorts = resolvedPorts(inst, kind) || [];
    const newPorts = resolvedPorts(next, kind) || [];
    const newByKey = new Map(newPorts.map((port, index) => [portKey(port), index]));
    return oldPorts.map(port => newByKey.get(portKey(port)) ?? -1);
  };
  const inputs = mappings('in'), outputs = mappings('out');
  conns = conns.flatMap(connection => {
    if (connection.to === inst.uid) {
      const nextPort = inputs[connection.tp] ?? -1;
      if (nextPort < 0) return [];
      connection.tp = nextPort;
    }
    if (connection.from === inst.uid) {
      const nextPort = outputs[connection.fp] ?? -1;
      if (nextPort < 0) return [];
      connection.fp = nextPort;
    }
    return [connection];
  });
}

// A port's dtype: explicit per-port (converters), else the block's `type` param
// (complex/float), else its fixed `dtype`, else complex.
function portType(inst: Inst, kind: 'in' | 'out', i: number): string {
  const d = RUNNABLE[inst.id];
  const meta = portMeta(inst, kind, i);
  if (meta.domain === 'message') return 'message';
  if (meta.dtype) {
    // GRC's optional-IQ idiom: `${ 'complex' if iq else 'float' }`. expandPorts
    // only normalizes a bare `${ name }`, so this arrives as the raw template.
    const conditional = meta.dtype.match(
      /^\$\{\s*'(\w+)'\s+if\s+([A-Za-z_]\w*)\s+else\s+'(\w+)'\s*\}$/);
    if (conditional) {
      const flag = String(inst.params[conditional[2]] ?? '').trim().toLowerCase();
      return flag === 'true' || flag === '1' ? conditional[1] : conditional[3];
    }
    // Any other unresolved template: report the type as unknown rather than as
    // the template text, so the connection validator skips the check instead of
    // rejecting every connection to the port.
    if (/^\$\{.*\}$/.test(meta.dtype)) return '';
    const match = meta.dtype.match(/^\$([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?$/);
    if (!match) return meta.dtype;
    const value = String(inst.params[match[1]] || '');
    if (!match[2]) return value;
    const param = d.params.find(p => p.id === match[1]);
    const optionIndex = param?.options?.indexOf(value) ?? -1;
    return optionIndex >= 0
      ? String(param?.optionAttributes?.[match[2]]?.[optionIndex] || '')
      : '';
  }
  return inst.params.type || d.dtype || 'complex';
}
const portColor = (inst: Inst, kind: 'in' | 'out', i: number) =>
  DTYPE_COLOR[portType(inst, kind, i)] || '#2196F3';

function portLabel(inst: Inst, kind: 'in' | 'out', i: number): string {
  const d = RUNNABLE[inst.id];
  if (kind === 'in' ? d.inputTemplates : d.outputTemplates)
    return portMeta(inst, kind, i).name;
  const labels = kind === 'in' ? d.inLabels : d.outLabels;
  const base = kind === 'in' ? d.inLabelBase : d.outLabelBase;
  const count = portCount(inst, kind);
  // Native GRC appends an index when a single port definition has
  // multiplicity, and removes it again when the multiplicity returns to one.
  if (base !== undefined) return count > 1 ? `${base}${i}` : base;
  return labels?.[i] || `${kind}${count > 1 ? i : ''}`;
}

function portWidth(inst: Inst, kind: 'in' | 'out', i: number): number {
  return ceilToGrid(Math.max(PORT_MIN_W,
    Math.ceil(textW(portLabel(inst, kind, i), PORT_FONT_SIZE)) + 2 * PORT_LABEL_PAD));
}

function fmtVal(v: any): string {
  if (typeof v === 'number' && Number.isInteger(v) && Math.abs(v) >= 1000) {
    if (v % 1000000 === 0) return v / 1000000 + 'M';
    if (v % 1000 === 0) return v / 1000 + 'k';
  }
  return String(v);
}

// Variable scope for expression evaluation, rebuilt each render() from the
// flowgraph's variable blocks. The block face shows the *evaluated* result of a
// parameter expression (like native GRC), while the stored value keeps the raw
// expression (visible/editable in the Properties dialog).
let varScope: Scope = {};
function rebuildScope() { varScope = buildScope(insts); }

// What bounds a block's width in native GRC: every parameter value drawn on the
// block face is truncated to `max(27 - len(label), 3)` characters, so no single
// row can push the box past ~29 characters wide (grc/gui/canvas/param.py).
// Style picks which end is dropped: <0 front, 0 centre (the default), >0 rear.
function truncateValue(label: string, s: string, style = 0): string {
  const maxLen = Math.max(27 - label.length, 3);
  if (s.length <= maxLen) return s;
  if (style < 0) return '...' + s.slice(3 - maxLen);
  if (style > 0) return s.slice(0, maxLen - 3) + '...';
  // Centre truncate, matching Python's floor division on the trailing slice.
  return s.slice(0, Math.floor(maxLen / 2) - 3) + '...' + s.slice(-Math.ceil(maxLen / 2));
}

// The value string drawn on a block for parameter `p`. Numeric/expression params
// are evaluated against the variable scope; anything that can't be resolved
// (a filename, an unshimmed call, a bad expression) falls back to the raw text.
// Native GRC keeps the tail of a path visible and the head of a long vector.
function paramDisplay(p: ParamDef, raw: any): string {
  const cut = (s: string, style = 0) => truncateValue(p.label, s, style);
  const fileStyle = p.dtype === 'file_open' || p.dtype === 'file_save' ? -1 : 0;
  if (p.type !== 'number') {
    const optionIndex = p.options?.indexOf(String(raw)) ?? -1;
    const display = optionIndex >= 0 ? p.optionLabels?.[optionIndex] ?? raw : raw;
    return cut(fmtVal(display), fileStyle);
  }
  if (typeof raw === 'number') return cut(fmtVal(raw));
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const r = evalExpr(s, varScope);
  if (!r.ok) return cut(fmtVal(raw), fileStyle);
  if (typeof r.value === 'number') return cut(fmtVal(r.value));
  return cut(fmtExprVal(r.value), Array.isArray(r.value) ? 1 : 0);
}

function wrapValidationMessage(message: string, maxCharacters: number): string[] {
  const lines: string[] = [];
  for (const word of message.split(/\s+/)) {
    const last = lines.length - 1;
    if (last >= 0 && lines[last].length + word.length + 1 <= maxCharacters)
      lines[last] += ' ' + word;
    else lines.push(word);
  }
  return lines;
}

function validateGraph(blocks: Inst[] = insts, connections: Conn[] = conns): ValidationIssue[] {
  return validateFlowgraph(blocks, connections, { portCount, portMeta, portType, resolvedPorts });
}

function fieldIssue(issues: ValidationIssue[], uid: string, field: string): string {
  return issues.find(issue => issue.uid === uid && issue.field === field)?.message || '';
}

function setFieldError(node: HTMLElement, errorNode: HTMLElement, message: string) {
  node.classList.toggle('field-invalid', !!message);
  node.setAttribute('aria-invalid', String(!!message));
  if (message) node.setAttribute('title', message); else node.removeAttribute('title');
  errorNode.textContent = message;
  errorNode.hidden = !message;
}

// Real glyph metrics: the old per-character estimate under-measured wide text
// (caps, digits, bold titles) and let it spill past the block's right edge.
const BLOCK_FONT = `'DejaVu Sans',Verdana,sans-serif`;
const measureCtx = document.createElement('canvas').getContext('2d');
const textWCache = new Map<string, number>();
const textW = (s: string, px: number, bold = false) => {
  const key = `${px}|${bold ? 'b' : 'n'}|${s}`;
  const hit = textWCache.get(key);
  if (hit !== undefined) return hit;
  let w: number;
  if (measureCtx) {
    measureCtx.font = `${bold ? '700 ' : ''}${px}px ${BLOCK_FONT}`;
    w = measureCtx.measureText(s).width;
  } else {
    w = s.length * px * 0.56;
  }
  textWCache.set(key, w);
  return w;
};
function portCount(inst: Inst, kind: 'in' | 'out'): number {
  return resolvedPorts(inst, kind)?.length ?? legacyPortCount(inst, kind);
}

function parameterHideValue(hide: string | undefined, params: Record<string, any>): string {
  const text = String(hide || 'none').trim();
  if (text === 'none' || text === 'part' || text === 'all') return text;
  // The common native GRC vector-length rule, used by Selector and over a
  // hundred other blocks: hide vlen on the face while it remains one.
  const conditional = text.match(
    /^\$\{\s*['"](none|part|all)['"]\s+if\s+([A-Za-z_]\w*)\s*==\s*(-?(?:\d+(?:\.\d*)?|\.\d+))\s+else\s+['"](none|part|all)['"]\s*\}$/);
  if (conditional)
    return Number(params[conditional[2]]) === Number(conditional[3]) ? conditional[1] : conditional[4];
  return text;
}

// The Note block's body is its text, wrapped to a fixed column: one row per
// wrapped line, drawn as plain label text (no "Note: " prefix, no truncation).
const NOTE_ID = 'note';
function noteGeom(inst: Inst, d: RunnableDef) {
  const text = String(inst.params.note ?? '');
  const lines = text.trim() ? wrapNoteText(text, s => textW(s, NOTE_FONT_SIZE)) : [];
  // The text goes in the value tspan, not the label one: `.plabel` is bold, and a
  // note's prose is body text, not a parameter name.
  const rows = lines.map(line => ({ id: 'note', l: '', v: line }));
  let w = textW(d.label, 13, true);
  for (const line of lines) w = Math.max(w, textW(line, NOTE_FONT_SIZE));
  return {
    d, rows,
    h: TITLE_H + Math.max(rows.length * ROW_H + 2 * PAD, ROW_H),
    w: Math.max(104, Math.ceil(w) + TEXT_PAD_L + TEXT_PAD_R),
  };
}

function geom(inst: Inst) {
  const d = RUNNABLE[inst.id];
  if (inst.id === NOTE_ID) return noteGeom(inst, d);
  // Categorized parameters belong in the modal notebook. Native GRC also keeps
  // parameters marked `hide: part` or `hide: all` off the block face.
  const rows = d.params
    .filter(p => {
      const hide = parameterHideValue(p.hide, inst.params);
      return !p.category && hide !== 'part' && hide !== 'all' &&
        !(p.hideIfEmpty && !String(inst.params[p.id] ?? '').trim());
    })
    .map(p => ({ id: p.id, l: p.label + ': ', v: paramDisplay(p, inst.params[p.id]) }));
  // A Variable's identifier is its block instance name rather than a regular
  // parameter, but it is part of the block's meaning and must stay visible.
  if (inst.id === 'variable')
    rows.unshift({ id: 'id', l: 'ID: ', v: truncateValue('ID', inst.name) });
  if (rows.length > MAX_FACE_ROWS) {
    const hidden = rows.length - (MAX_FACE_ROWS - 1);
    rows.length = MAX_FACE_ROWS - 1;
    rows.push({ id: MORE_ROW_ID, l: '', v: `… ${hidden} more parameters` });
  }
  const nports = Math.max(visiblePortIndices(inst, 'in').length,
    visiblePortIndices(inst, 'out').length, 1);
  const bodyH = Math.max(rows.length * ROW_H + PAD, nports * PORT_PITCH + PAD, ROW_H);
  // Two grid cells keep a centered port group on-grid for both odd and even
  // port counts. Width is one-cell aligned so right-edge ports align as well.
  const h = ceilToGrid(TITLE_H + bodyH, PORT_PITCH);
  let w = textW(d.label, 13, true);
  for (const r of rows) w = Math.max(w, textW(r.l, 11, true) + textW(r.v, 11));
  w = ceilToGrid(Math.max(104, Math.ceil(w) + TEXT_PAD_L + TEXT_PAD_R));
  return { d, rows, h, w };
}
type Edge = 'L' | 'R' | 'T' | 'B';
// Port position (relative to the block) + which edge it sits on, honouring rotation.
function portPos(inst: Inst, kind: 'in' | 'out', i: number): { x: number; y: number; edge: Edge } {
  const { w, h } = geom(inst);
  const pw = portWidth(inst, kind, i);
  // Center each side's port group independently, as native GRC does. Using the
  // block midpoint also keeps a lone port centered when parameter rows change
  // the block height or the opposite side has a different number of ports.
  const visible = visiblePortIndices(inst, kind);
  const count = visible.length;
  const slot = Math.max(0, visible.indexOf(i));
  const vSlot = centeredPortSlot(h, count, slot);
  const hSlot = PORT_PITCH + slot * PORT_PITCH;
  const map: Record<number, { in: Edge; out: Edge }> = {
    0: { in: 'L', out: 'R' }, 90: { in: 'T', out: 'B' },
    180: { in: 'R', out: 'L' }, 270: { in: 'B', out: 'T' },
  };
  const e = map[inst.rotation || 0][kind];
  if (e === 'L') return { x: -pw, y: vSlot, edge: e };
  if (e === 'R') return { x: w + pw, y: vSlot, edge: e };
  if (e === 'T') return { x: hSlot, y: -pw, edge: e };
  return { x: hSlot, y: h + pw, edge: e };
}
// Bezier control point for a wire leaving `edge`: `k` outward along the port's
// own axis, `bow` perpendicular to it (down for side ports, right for top/bottom
// ones) — see wireShape() for where the two numbers come from.
function ctrl(edge: Edge, x: number, y: number, k: number, bow = 0): [number, number] {
  if (edge === 'L') return [x - k, y + bow];
  if (edge === 'R') return [x + k, y + bow];
  if (edge === 'T') return [x + bow, y - k];
  return [x + bow, y + k];
}
const horizontalEdge = (e: Edge) => e === 'L' || e === 'R';
const outwardSign = (e: Edge) => (e === 'R' || e === 'B' ? 1 : -1);
// Native GRC puts both bezier control points a flat 50px straight out of their
// ports, and for an ordinary forward wire that is the right answer at any
// length — a long one just draws as a lazy diagonal, which reads fine.
//
// A *backwards* wire is the case it handles badly: the sink sits behind the
// source, so the wire leaves the port away from its destination and has to
// double back, and 50px is not enough room to turn around in. Those get more
// control length (scaled with the span, capped) plus a perpendicular bow:
//   * BOW_MAX is what the curve is pulled by at each end. The control points
//     carry the curve about three quarters of the way, so it buys ~0.75 of that
//     in real clearance — enough to pass a tall block rather than graze it.
//   * The bow ramps in with the span (nothing below BOW_START, full by
//     BOW_FULL) and with the drift, the wire bowing *along* the direction it is
//     already travelling. A level wire has no direction to bow in and stays
//     straight; the drift ramp spans one port pitch so that is not a step
//     change.
//   * The two ends bow *opposite* ways. Bowing them alike swings the tail below
//     a lower sink and hooks up into its port from underneath; opposing them
//     keeps the loop in the corridor between the two blocks and brings it down
//     into the port from above.
// All of it needs both ports on the same axis — with one rotated block the
// "perpendicular" of each end points a different way and the two would fight.
const CTRL_FLAT = 50, CTRL_MAX = 220, CTRL_FRAC = 0.4;
const BOW_MAX = 190, BOW_START = 180, BOW_FULL = 600, BOW_DRIFT_FULL = PORT_PITCH;
function wireShape(ea: Edge, eb: Edge, x1: number, y1: number, x2: number, y2: number):
    { k: number; bowA: number; bowB: number } {
  const flat = { k: CTRL_FLAT, bowA: 0, bowB: 0 };
  if (horizontalEdge(ea) !== horizontalEdge(eb)) return flat;
  const [span, drift] = horizontalEdge(ea) ? [x2 - x1, y2 - y1] : [y2 - y1, x2 - x1];
  if (span * outwardSign(ea) >= 0) return flat;             // forward: plain GRC curve
  const ramp = Math.min(1, Math.max(0, (Math.abs(span) - BOW_START) / (BOW_FULL - BOW_START)));
  const lean = Math.max(-1, Math.min(1, drift / BOW_DRIFT_FULL));
  const bow = BOW_MAX * ramp * lean;
  return { k: Math.max(CTRL_FLAT, Math.min(CTRL_MAX, Math.abs(span) * CTRL_FRAC)), bowA: bow, bowB: -bow };
}

function addBlock(id: string, x = 60 + (counter % 5) * 30, y = 60 + (counter % 7) * 24,
                  paramOverrides: Record<string, any> = {}, record = true): Inst | null {
  const d = RUNNABLE[id]; if (!d) { log('block "' + id + '" is not runnable yet'); return null; }
  if (id === OPTIONS_ID) {
    const existing = insts.find(i => i.id === OPTIONS_ID);
    if (existing) { log('only one Options block is allowed per flowgraph'); select(existing.uid); return existing; }
  }
  const uid = 'b' + (++counter);
  const params: Record<string, any> = {};
  d.params.forEach(p => params[p.id] = p.def);
  Object.assign(params, paramOverrides);
  const position = constrainBlockPosition(x, y, snapToGrid);
  const inst: Inst = {
    uid, id, name: id.replace(/^.*_/, '') + counter,
    x: position.x, y: position.y, params,
    enabled: true, rotation: 0, bypassed: false,
  };
  insts.push(inst);
  select(uid);
  if (record) recordHistory();
  return inst;
}

// ---- block operations (used by the context menu and shortcuts) ----
function deleteBlocks(uids = selectedBlocks) {
  if (!uids.size) return;
  // The Options block is a required singleton and cannot be deleted.
  insts = insts.filter(i => !uids.has(i.uid) || i.id === OPTIONS_ID);
  conns = conns.filter(c => !uids.has(c.from) && !uids.has(c.to));
  selectedBlocks.clear(); selected = null; selectedConnection = null;
  render(); recordHistory();
}
function deleteConnection(conn: Conn) {
  conns = conns.filter(c => c !== conn);
  if (selectedConnection === conn) selectedConnection = null;
  render(); recordHistory();
}
function duplicateBlock(uid: string) {
  const s = insts.find(i => i.uid === uid); if (!s) return;
  if (s.id === OPTIONS_ID) { log('only one Options block is allowed per flowgraph'); return; }
  const nu = 'b' + (++counter);
  const position = constrainBlockPosition(s.x + 24, s.y + 24, snapToGrid);
  insts.push({ uid: nu, id: s.id, name: s.id.replace(/^.*_/, '') + counter,
    x: position.x, y: position.y, params: { ...s.params }, enabled: s.enabled,
    rotation: s.rotation, bypassed: s.bypassed });
  select(nu); recordHistory();
}
// ---- clipboard (Cut/Copy/Paste) ----
interface GraphClipboard { blocks: Inst[]; connections: Conn[] }
let clipboard: GraphClipboard | null = null;
function copyBlock(uid: string) {
  copyBlocks(selectedBlocks.has(uid) ? selectedBlocks : new Set([uid]));
}
function copyBlocks(uids = selectedBlocks) {
  // The Options block is a singleton; never copy it (so paste can't duplicate it).
  const blocks = insts.filter(i => uids.has(i.uid) && i.id !== OPTIONS_ID);
  if (!blocks.length) return;
  clipboard = clone({ blocks, connections: conns.filter(c => uids.has(c.from) && uids.has(c.to)) });
  log(`copied ${blocks.length} block${blocks.length === 1 ? '' : 's'}`);
}
function pasteBlock(x = 80, y = 80) {
  if (!clipboard) return;
  const minX = Math.min(...clipboard.blocks.map(b => b.x));
  const minY = Math.min(...clipboard.blocks.map(b => b.y));
  const remap = new Map<string, string>();
  const added: Inst[] = clipboard.blocks.map(source => {
    const uid = 'b' + (++counter); remap.set(source.uid, uid);
    const position = constrainBlockPosition(
      x + source.x - minX, y + source.y - minY, snapToGrid);
    return { ...clone(source), uid, name: source.id.replace(/^.*_/, '') + counter,
      x: position.x, y: position.y };
  });
  insts.push(...added);
  conns.push(...clipboard.connections.map(c => ({ ...c, from: remap.get(c.from)!, to: remap.get(c.to)! })));
  selectedBlocks = new Set(added.map(i => i.uid)); selected = added.length ? added[added.length - 1].uid : null;
  selectedConnection = null; render(); recordHistory();
}

function selectedInsts(): Inst[] { return insts.filter(i => selectedBlocks.has(i.uid)); }
function setSelectedEnabled(enabled: boolean) {
  const blocks = selectedInsts(); if (!blocks.length) return;
  blocks.forEach(i => i.enabled = enabled); render(); recordHistory();
}
function rotateSelected(degrees: number) {
  const blocks = selectedInsts(); if (!blocks.length) return;
  blocks.forEach(i => i.rotation = (((i.rotation + degrees) % 360) + 360) % 360);
  render(); recordHistory();
}
function bypassSelected() {
  const blocks = selectedInsts(); if (!blocks.length) return;
  let changed = false;
  for (const block of blocks) {
    if (portCount(block, 'in') === 1 && portCount(block, 'out') === 1) { block.bypassed = !block.bypassed; changed = true; }
  }
  if (!changed) { log('bypass only works on 1-in/1-out blocks'); return; }
  render(); recordHistory();
}
type Alignment = 'top' | 'middle' | 'bottom' | 'left' | 'center' | 'right';
function alignSelected(alignment: Alignment) {
  const blocks = selectedInsts(); if (blocks.length < 2) return;
  const boxes = blocks.map(block => ({ block, ...geom(block) }));
  const left = Math.min(...boxes.map(b => b.block.x));
  const right = Math.max(...boxes.map(b => b.block.x + b.w));
  const top = Math.min(...boxes.map(b => b.block.y));
  const bottom = Math.max(...boxes.map(b => b.block.y + b.h));
  for (const b of boxes) {
    if (alignment === 'top') b.block.y = top;
    else if (alignment === 'middle') b.block.y = Math.round((top + bottom - b.h) / 2);
    else if (alignment === 'bottom') b.block.y = bottom - b.h;
    else if (alignment === 'left') b.block.x = left;
    else if (alignment === 'center') b.block.x = Math.round((left + right - b.w) / 2);
    else b.block.x = right - b.w;
    const position = constrainBlockPosition(b.block.x, b.block.y, snapToGrid);
    b.block.x = position.x; b.block.y = position.y;
  }
  render(); recordHistory();
}
// Auto-arrange: hand the whole flowgraph to the layout engine and drop every
// block on the coordinate it comes back with. Everything the engine needs is
// measured here — box size, how far the port tabs stick out on each side, and
// the y offset of every port — so `layout.ts` stays DOM-free and unit testable.
function autoArrangeBlocks() {
  if (!insts.length) return;
  // Ports have to face the way the layout flows, so a hand-rotated block is
  // straightened first: a 90° block's ports sit on its top and bottom edges, and
  // no left-to-right wire into one of those can ever come out straight.
  for (const inst of insts) inst.rotation = 0;
  const nodes: LayoutNode[] = insts.map(inst => {
    const { w, h } = geom(inst);
    const offsets = (kind: 'in' | 'out') =>
      Array.from({ length: portCount(inst, kind) }, (_, i) => portPos(inst, kind, i).y);
    const pad = (kind: 'in' | 'out') =>
      Math.max(0, ...visiblePortIndices(inst, kind).map(i => portWidth(inst, kind, i)));
    return {
      uid: inst.uid, w, h, leftPad: pad('in'), rightPad: pad('out'),
      in: offsets('in'), out: offsets('out'), pinned: inst.id === OPTIONS_ID,
    };
  });
  const byUid = new Map(insts.map(inst => [inst.uid, inst]));
  for (const at of arrangeFlowgraph(nodes, conns)) {
    const inst = byUid.get(at.uid)!;
    const position = constrainBlockPosition(at.x, at.y, snapToGrid);
    inst.x = position.x; inst.y = position.y;
  }
  render(); recordHistory();
  log(`arranged ${insts.length} block${insts.length === 1 ? '' : 's'}`);
}
function cycleBlockType(direction: number) {
  const blocks = selectedInsts(); let changed = false;
  for (const block of blocks) {
    const param = RUNNABLE[block.id].params.find(p => p.id === 'type' && p.options?.length);
    if (!param?.options?.length) continue;
    const current = param.options.indexOf(String(block.params.type));
    block.params.type = param.options[(current + direction + param.options.length) % param.options.length];
    changed = true;
  }
  if (changed) { render(); recordHistory(); }
}
function changePortCount(delta: number) {
  const candidates = ['nconnections', 'num_inputs', 'num_outputs', 'nports'];
  const blocks = selectedInsts(); let changed = false;
  for (const block of blocks) {
    const key = candidates.find(id => RUNNABLE[block.id].params.some(p => p.id === id));
    if (!key) continue;
    const nextParams = { ...block.params,
      [key]: Math.max(1, Math.trunc(Number(block.params[key]) || 1) + delta) };
    remapConnectionsForPortChange(block, nextParams);
    block.params = nextParams;
    changed = true;
  }
  if (changed) { render(); recordHistory(); }
}
function setZoom(next: number) {
  zoom = Math.max(0.4, Math.min(2.5, next));
  // Draw the grid at the snap spacing so every line is a legal block position.
  el('canvasWrap').style.setProperty('--grid-size', `${SNAP_GRID_SIZE * zoom}px`); render();
  log(`zoom ${Math.round(zoom * 100)}%`);
}
// ---- Options block: the singleton flowgraph-metadata block (GRC-style) ----
// Every flowgraph has exactly one, holding title/author/copyright/description.
const OPTIONS_ID = 'options';
function makeOptionsInst(): Inst {
  const params: Record<string, any> = {};
  RUNNABLE[OPTIONS_ID].params.forEach(p => params[p.id] = p.def);
  return { uid: 'b' + (++counter), id: OPTIONS_ID, name: 'options',
    x: 10, y: 10, params, enabled: true, rotation: 0, bypassed: false };
}
// Guarantee the current flowgraph has an Options block (loaded/legacy files may lack one).
function ensureOptionsBlock() {
  if (!insts.some(i => i.id === OPTIONS_ID)) insts.unshift(makeOptionsInst());
}

// ---- the default (new) flowgraph ----
// A new flowgraph is not empty in native GRC: it is loaded from the template in
// `grc/core/default_flow_graph.grc`, which holds the Options block plus a
// `samp_rate` variable of 32000 — which is why upstream flowgraphs refer to
// `samp_rate` as if it were always there. Same two blocks, same value, same
// positions here. It is an ordinary Variable once placed: renameable, editable,
// and deletable like any other block.
const DEFAULT_SAMP_RATE = '32000';
function makeSampRateInst(): Inst {
  const params: Record<string, any> = {};
  RUNNABLE['variable'].params.forEach(p => params[p.id] = p.def);
  params.value = DEFAULT_SAMP_RATE;
  return { uid: 'b' + (++counter), id: 'variable', name: 'samp_rate',
    x: 200, y: 10, params, enabled: true, rotation: 0, bypassed: false };
}

// The file name Save writes back to: whatever file the canvas was loaded from
// (an example, or a .grc opened from disk), so editing an example and saving it
// keeps its own name instead of everything landing as flowgraph.grc. Anything
// that replaces the canvas with something that came from no file clears it, and
// Save falls back to flowgraph.grc.
let currentFileName: string | null = null;
function setCurrentFileName(file: string | null) {
  currentFileName = file ? exampleFileName(file) : null;   // name only, always .grc
}

function clearFlowgraph(record = true) {
  insts = []; conns = []; counter = 0; selected = null; selectedBlocks.clear();
  insts.push(makeSampRateInst());   // the default flowgraph's one variable
  selectedConnection = null; cancelConnect(); ensureOptionsBlock(); render();
  setExampleHash(null);   // the canvas is empty; any #example= in the URL is stale
  setCurrentFileName(null);
  if (record) recordHistory();
}

// ---- native .grc (GNU Radio Companion YAML) serialization ----
const GRC_VERSION = '3.11.0.0';

// GRC's tri-state block enable flag, from the editor's two booleans.
function grcState(inst: Inst): string {
  if (!inst.enabled) return 'disabled';
  if (inst.bypassed) return 'bypassed';
  return 'enabled';
}
// GRC stores every parameter value as a string, sorted by key.
function grcParams(params: Record<string, any>): Record<string, GrcScalar> {
  const out: Record<string, GrcScalar> = {};
  for (const key of Object.keys(params).sort()) {
    const v = params[key];
    out[key] = typeof v === 'boolean' ? (v ? 'True' : 'False') : String(v);
  }
  return out;
}
function grcStates(inst: Inst): Record<string, any> {
  return { coordinate: [Math.round(inst.x), Math.round(inst.y)], rotation: inst.rotation, state: grcState(inst) };
}
// Derive a valid Python-identifier flowgraph id from the Options title.
function flowgraphId(): string {
  const opt = insts.find(i => i.id === OPTIONS_ID);
  const raw = String(opt?.params.title || '').trim();
  const id = raw.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(?=[0-9])/, '_');
  return id || 'default';
}
function grcConnectionKey(c: GrcScalar[] | Record<string, GrcScalar>): string {
  const parts = Array.isArray(c)
    ? c : [c.src_blk_id, c.src_port_id, c.snk_blk_id, c.snk_port_id];
  return parts.map(String).join('\x1f');
}
// For the Run path we hand the runner a *resolved* .grc: numeric/expression
// parameters are evaluated to concrete values so the C++ runner (which only
// inlines plain variables + coerces numeric strings) can execute expressions
// like `samp_rate/2` or `firdes.low_pass(...)`. The *saved* .grc keeps raw
// expressions for desktop byte-compatibility.
//
// The run scope excludes the live variable-control blocks (qtgui_range/chooser/
// push_button): a parameter that references a control (`freq`, or `freq/2`) then
// fails static evaluation and is left as raw text, so the runner still wires it
// to the live block instead of freezing it at the control's initial value.
function buildRunScope(): Scope {
  return buildScope(insts.filter(i => i.id === 'variable'));
}
// GRC lets a parameter's dtype depend on another parameter: `fir_filter_xxx`
// declares `taps` as `${ type.taps }`, which resolves through the `type` param's
// option_attributes to `real_vector` or `complex_vector`. Resolve that here so
// the caller sees the concrete dtype rather than the template.
function effectiveDtype(inst: Inst, def: RunnableDef, p: ParamDef): string {
  const dtype = String(p.dtype ?? '');
  const match = dtype.match(/^\$\{\s*([A-Za-z_]\w*)(?:\.([A-Za-z_]\w*))?\s*\}$/);
  if (!match) return dtype;
  const value = String(inst.params[match[1]] ?? '');
  if (!match[2]) return value;
  const source = def.params.find((q: ParamDef) => q.id === match[1]);
  const index = source?.options?.indexOf(value) ?? -1;
  return index >= 0 ? String(source?.optionAttributes?.[match[2]]?.[index] ?? '') : '';
}

// Parameters whose value is a Python expression rather than a literal, and so
// have to be evaluated before the runner (which parses JSON-ish scalars and
// vectors, not Python) sees them.
const EVALUATED_DTYPES = new Set([
  'int', 'real', 'float', 'hex', 'raw',
  'int_vector', 'real_vector', 'float_vector', 'complex_vector',
]);

function resolveParamsForRun(inst: Inst, scope: Scope): Record<string, any> {
  const def = RUNNABLE[inst.id];
  const out: Record<string, any> = { ...inst.params };
  if (!def) return out;
  for (const p of def.params) {
    // Numeric, vector and `raw` params are evaluated; enum/string params pass
    // through. `raw` covers things like an OFDM carrier allocation written as
    // `list(range(-26, -21)) + ...`; the vector dtypes cover the commonest GRC
    // idiom of all, filter taps written as `firdes.low_pass(...)` or
    // `[1/sps] * sps`. Neither is something the runner can evaluate itself.
    if (p.type !== 'number' && !p.raw &&
        !EVALUATED_DTYPES.has(effectiveDtype(inst, def, p))) continue;
    const raw = out[p.id];
    if (typeof raw !== 'string') continue;          // already a numeric/bool literal
    const s = raw.trim();
    if (!s || Number.isFinite(Number(s))) continue; // empty or a plain number already
    const r = evalExpr(s, scope);
    // Only substitute a concrete (non-string) result; symbolic values (enum
    // constants) and anything referencing a live control are left as raw text.
    if (r.ok && typeof r.value !== 'string') out[p.id] = serializeForRunner(r.value);
  }
  return out;
}

function buildGrcDoc(resolve = false): GrcDoc {
  const runScope = resolve ? buildRunScope() : {};
  const paramsOf = (i: Inst) => grcParams(resolve ? resolveParamsForRun(i, runScope) : i.params);
  const byUid = (u: string) => insts.find(i => i.uid === u);
  // options: a top-level block (not in `blocks`), carrying flowgraph metadata.
  const opt = insts.find(i => i.id === OPTIONS_ID);
  const optionParams: Record<string, GrcScalar> = { generate_options: 'qt_gui', id: flowgraphId() };
  if (opt) for (const [k, v] of Object.entries(opt.params)) optionParams[k] = String(v);
  const options = { parameters: grcParams(optionParams),
    states: opt ? grcStates(opt) : { coordinate: [10, 10], rotation: 0, state: 'enabled' } };

  // blocks: everything except options, GRC order (variables first, then by name).
  const isVar = (i: Inst) => VARIABLE_IDS.has(i.id);
  const blocks = insts.filter(i => i.id !== OPTIONS_ID)
    .sort((a, b) => (Number(!isVar(a)) - Number(!isVar(b))) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(i => ({ name: i.name, id: i.id, parameters: paramsOf(i), states: grcStates(i) }));

  // connections: 4-tuples for streams, dicts (file_format 2) for message ports.
  const connections: Array<GrcScalar[] | Record<string, GrcScalar>> = [];
  for (const c of conns) {
    const src = byUid(c.from), snk = byUid(c.to);
    if (!src || !snk) continue;
    const sourcePort = portMeta(src, 'out', c.fp);
    const sinkPort = portMeta(snk, 'in', c.tp);
    const message = sourcePort.domain === 'message' || sinkPort.domain === 'message';
    if (message) {
      connections.push({ src_blk_id: src.name, src_port_id: sourcePort.id,
        snk_blk_id: snk.name, snk_port_id: sinkPort.id });
    } else {
      connections.push([src.name, String(sourcePort.streamIndex),
        snk.name, String(sinkPort.streamIndex)]);
    }
  }
  connections.sort((a, b) => grcConnectionKey(a) < grcConnectionKey(b) ? -1 : 1);
  const fileFormat = connections.some(c => !Array.isArray(c)) ? 2 : 1;

  return { options, blocks, connections, metadata: { file_format: fileFormat, grc_version: GRC_VERSION } };
}
function grcText(): string { return dumpGrc(buildGrcDoc()); }
// The Run path's .grc, with parameter expressions evaluated to concrete values.
function grcTextForRun(fileOverrides: Map<string, string> = new Map()): string {
  const doc = buildGrcDoc(true);
  for (const block of doc.blocks) {
    const path = fileOverrides.get(block.name);
    const param = LOCAL_FILE_PARAMS[block.id];
    if (path !== undefined && param) block.parameters[param] = path;
  }
  return dumpGrc(doc);
}
function downloadBlob(contents: BlobPart, type: string, filename: string) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
function saveFlowgraph() {
  const file = currentFileName || 'flowgraph.grc';
  downloadBlob(grcText(), 'application/x-yaml', file);
  log(`saved ${insts.length} blocks to ${file}`);
}

// ---- .grc import (parsed GrcDoc tree -> editor model) ----
function stateToFlags(state: any): { enabled: boolean; bypassed: boolean } {
  const s = String(state ?? 'enabled');
  return { enabled: s !== 'disabled', bypassed: s === 'bypassed' };
}
// Parameter ids this editor wrote before its schema matched upstream GRC's, per
// block id: `current id -> id found in old files`. Consulted only when the
// current id is absent, so an existing .grc keeps its value instead of silently
// falling back to the schema default.
const LEGACY_PARAM_IDS: Record<string, Record<string, string>> = {
  // Deprecated "Throttle (old)", superseded by blocks_throttle2. Its rate was
  // written as `samp_rate`; upstream has always called it samples_per_second.
  blocks_throttle: { samples_per_second: 'samp_rate' },
};
// GRC stores param values as strings; numeric fields become numbers (or keep a
// variable-reference expression), everything else stays a string.
function importParams(def: RunnableDef, raw: Record<string, any> = {},
                      blockId?: string): Record<string, any> {
  const params: Record<string, any> = {};
  const legacy = (blockId && LEGACY_PARAM_IDS[blockId]) || {};
  for (const p of def.params) {
    const key = raw[p.id] !== undefined && raw[p.id] !== null ? p.id : legacy[p.id] ?? p.id;
    const present = raw[key] !== undefined && raw[key] !== null;
    const value = present ? raw[key] : p.def;
    params[p.id] = p.type === 'number' ? numericOrExpression(String(value)) : String(value);
  }
  return params;
}
// Map a GRC connection port token (stream index or message port id) to the
// block's editor port index.
function portIndex(inst: Inst, kind: 'in' | 'out', token: string): number {
  const ports = resolvedPorts(inst, kind);
  if (ports) {
    const num = Number(token);
    if (Number.isInteger(num) && String(num) === token.trim()) {
      const idx = ports.findIndex(port => port.domain === 'stream' && port.streamIndex === num);
      return idx >= 0 ? idx : num;
    }
    const idx = ports.findIndex(port => port.id === token);
    return idx >= 0 ? idx : 0;
  }
  const def = RUNNABLE[inst.id];
  const num = Number(token);
  if (Number.isInteger(num) && String(num) === token.trim()) {
    const arr = kind === 'in' ? def?.inStreamIndices : def?.outStreamIndices;
    const idx = arr ? arr.indexOf(num) : -1;
    return idx >= 0 ? idx : num;
  }
  const ids = kind === 'in' ? def?.inIds : def?.outIds;
  const idx = ids ? ids.indexOf(token) : -1;
  return idx >= 0 ? idx : 0;
}
function loadFlowgraph(doc: any) {
  if (!doc || !Array.isArray(doc.blocks))
    throw new Error('not a GNU Radio .grc flowgraph');
  insts = []; conns = []; counter = 0;
  // Whatever was on the canvas is gone, and with it the file Save writes to; the
  // callers that do know a name (an example, an opened .grc) set it back after.
  setCurrentFileName(null);
  // options: a top-level block in .grc; becomes the editor's singleton Options.
  const optRaw = doc.options || {};
  const optFlags = stateToFlags(optRaw.states?.state);
  const optCoord = Array.isArray(optRaw.states?.coordinate) ? optRaw.states.coordinate : [10, 10];
  insts.push({ uid: 'b' + (++counter), id: OPTIONS_ID, name: 'options',
    x: Number(optCoord[0]) || 10, y: Number(optCoord[1]) || 10,
    params: importParams(RUNNABLE[OPTIONS_ID], optRaw.parameters || {}),
    enabled: optFlags.enabled, rotation: Number(optRaw.states?.rotation) || 0, bypassed: optFlags.bypassed });

  const nameToUid = new Map<string, string>();
  doc.blocks.forEach((b: any, index: number) => {
    const def = RUNNABLE[b.id];
    if (!def) { log(`skipped unsupported block "${b.id}"`); return; }
    const coord = Array.isArray(b.states?.coordinate) ? b.states.coordinate
      : [60 + (index % 4) * 190, 60 + Math.floor(index / 4) * 130];
    const flags = stateToFlags(b.states?.state);
    const uid = 'b' + (++counter), name = String(b.name || b.id);
    nameToUid.set(name, uid);
    insts.push({ uid, id: b.id, name, x: Number(coord[0]) || 0, y: Number(coord[1]) || 0,
      params: importParams(def, b.parameters || {}, b.id), enabled: flags.enabled,
      rotation: Number(b.states?.rotation) || 0, bypassed: flags.bypassed });
  });
  for (const c of doc.connections || []) {
    let from: string | undefined, to: string | undefined, sp: string, tp: string;
    if (Array.isArray(c)) {
      from = nameToUid.get(String(c[0])); to = nameToUid.get(String(c[2]));
      sp = String(c[1]); tp = String(c[3]);
    } else if (c && typeof c === 'object') {
      from = nameToUid.get(String(c.src_blk_id)); to = nameToUid.get(String(c.snk_blk_id));
      sp = String(c.src_port_id); tp = String(c.snk_port_id);
    } else continue;
    if (!from || !to) continue;
    conns.push({ from, fp: portIndex(G0(from), 'out', sp), to, tp: portIndex(G0(to), 'in', tp) });
  }
  ensureOptionsBlock();
  selected = null; selectedBlocks.clear(); selectedConnection = null; cancelConnect();
  render(); recordHistory(); log(`opened ${insts.length} blocks`);
}
// Fly-in / fly-out transition used when opening an example flowgraph: the blocks
// already on the canvas scatter off-screen in random directions while the
// example's blocks sweep in from off-screen to their loaded positions.
function loadFlowgraphAnimated(doc: any) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) {
    loadFlowgraph(doc); resetHistory(); return;
  }
  const parseXY = (g: Element): [number, number] => {
    const m = /translate\(\s*([-\d.]+)[ ,]+([-\d.]+)/.exec(g.getAttribute('transform') || '');
    return m ? [parseFloat(m[1]), parseFloat(m[2])] : [0, 0];
  };
  const rect = svg.getBoundingClientRect();
  // Far enough that a block starting/ending here is off-screen from anywhere on
  // the canvas, in local (pre-scale) units. Each block gets its own direction.
  const reach = Math.hypot(rect.width, rect.height) / (zoom || 1) + 500;
  const randOffset = (): [number, number] => {
    const a = Math.random() * Math.PI * 2;
    return [Math.cos(a) * reach, Math.sin(a) * reach];
  };

  // Preserve the outgoing scene in an overlay so render() can rebuild the canvas
  // underneath it. flyG mirrors nodesG's scale so coordinates line up.
  const flyG = svgEl('g', { transform: `scale(${zoom})` });
  const oldWires = [...wiresG.children];
  const oldBlocks = [...nodesG.children];
  for (const w of oldWires) flyG.appendChild(w);
  for (const b of oldBlocks) flyG.appendChild(b);
  svg.appendChild(flyG);

  loadFlowgraph(doc); resetHistory();

  const OUT = 520, IN = 620;
  // Old wires just fade; their paths can't track the scattering blocks.
  for (const w of oldWires)
    (w as SVGElement).animate([{ opacity: 1 }, { opacity: 0 }], { duration: 260, fill: 'forwards' });
  for (const b of oldBlocks) {
    const [x, y] = parseXY(b), [dx, dy] = randOffset();
    (b as SVGElement).animate([
      { transform: `translate(${x}px,${y}px)`, opacity: 1 },
      { transform: `translate(${x + dx}px,${y + dy}px)`, opacity: 0 },
    ], { duration: OUT, delay: Math.random() * 80, easing: 'cubic-bezier(0.4,0,1,1)', fill: 'both' });
  }
  for (const b of [...nodesG.children]) {
    const [x, y] = parseXY(b), [dx, dy] = randOffset();
    (b as SVGElement).animate([
      { transform: `translate(${x + dx}px,${y + dy}px)`, opacity: 0 },
      { transform: `translate(${x}px,${y}px)`, opacity: 1 },
    ], { duration: IN, delay: Math.random() * 120, easing: 'cubic-bezier(0.16,1,0.3,1)', fill: 'backwards' });
  }
  // New wires would dangle off the incoming blocks, so hold them until the
  // blocks have mostly arrived, then fade them in.
  wiresG.style.opacity = '0';
  const wa = wiresG.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 320, delay: IN * 0.55, easing: 'ease-out' });
  wa.onfinish = () => { wiresG.style.opacity = ''; };

  // Tear down the overlay once the slowest fly-out has finished.
  setTimeout(() => flyG.remove(), OUT + 120);
}
function duplicateFlowgraph() {
  if (!insts.length) return;
  const token = `grc-duplicate-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    localStorage.setItem(token, grcText());
    const duplicate = window.open(`${location.href.split('#')[0]}#duplicate=${encodeURIComponent(token)}`, '_blank');
    if (duplicate) { log('duplicated flowgraph in a new tab'); return; }
    localStorage.removeItem(token);
  } catch { /* fall through to an in-canvas copy if storage or popups are unavailable */ }
  const ids = new Set(insts.map(i => i.uid)); copyBlocks(ids);
  const minX = Math.min(...insts.map(i => i.x)), minY = Math.min(...insts.map(i => i.y));
  pasteBlock(minX + 30, minY + 30); log('popup blocked; duplicated flowgraph on the canvas');
}
function saveScreenshot() {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  copy.setAttribute('xmlns', SVGNS);
  copy.setAttribute('viewBox', `0 0 ${svg.clientWidth} ${svg.clientHeight}`);
  const style = document.createElementNS(SVGNS, 'style');
  style.textContent = [...document.styleSheets].flatMap(sheet => {
    try { return [...sheet.cssRules].map(rule => rule.cssText); } catch { return []; }
  }).join('\n');
  copy.insertBefore(style, copy.firstChild);
  downloadBlob(new XMLSerializer().serializeToString(copy), 'image/svg+xml', 'flowgraph.svg');
  log('saved flowgraph screenshot');
}
function saveConsole() { downloadBlob(el('log').textContent || '', 'text/plain', 'grc-console.txt'); }

// ---- shareable URL (flowgraph gzip-compressed into a ?fg= query param) ----
async function gzip(str: string): Promise<Uint8Array> {
  const stream = new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
async function gunzip(bytes: Uint8Array): Promise<string> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return await new Response(stream).text();
}
function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64UrlToBytes(s: string): Uint8Array {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(s); const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
// Payload rides in the URL fragment (#fg=), not the query string, so it is never
// sent to the server — that avoids "414 URI Too Long" on load and keeps flowgraphs
// out of server logs. URL_MAX is a soft ceiling: chat apps / email clients truncate
// very long links even though the browser address bar itself allows far more.
const URL_MAX = 16000;
async function flowgraphToUrl(): Promise<string> {
  const param = bytesToBase64Url(await gzip(grcText()));
  const base = location.href.split('#')[0].split('?')[0];
  return `${base}#fg=${param}`;
}
// Clipboard API needs a secure context / permission; fall back to a hidden
// textarea + execCommand so http:// dev servers keep working.
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy'); ta.remove();
    return ok;
  }
}
async function copyFlowgraphUrl() {
  let url: string;
  try { url = await flowgraphToUrl(); }
  catch (error) { log('could not build URL: ' + error); return; }
  if (url.length > URL_MAX) {
    log(`flowgraph is too large for a shareable URL (${url.length} chars, limit ${URL_MAX}). ` +
        'Use File ▸ Save to share it as a .json file instead.');
    return;
  }
  log(await copyText(url) ? `copied shareable URL to clipboard (${url.length} chars)`
        : 'could not copy automatically — URL logged below:\n' + url);
}
function showVariableEditor() {
  closeMenu(); document.querySelector('.modal')?.remove();
  const variables = insts.filter(i => i.id === 'variable' || i.id.startsWith('variable_'));
  const overlay = document.createElement('div'); overlay.className = 'modal variables';
  const dlg = document.createElement('div'); dlg.className = 'dlg';
  const head = document.createElement('div'); head.className = 'dlghead'; head.textContent = 'Variable Editor';
  const body = document.createElement('div'); body.className = 'dlgbody';
  const controls: { uid: string; field: string; node: HTMLElement; error: HTMLElement }[] = [];
  const refreshValidation = () => {
    const issues = validateGraph();
    controls.forEach(control => setFieldError(control.node, control.error,
      fieldIssue(issues, control.uid, control.field)));
  };
  if (!variables.length) {
    body.textContent = 'No variable blocks are present in this flowgraph.';
  } else for (const variable of variables) {
    const d = RUNNABLE[variable.id];
    const title = document.createElement('div'); title.className = 'dlghead'; title.textContent = d.label;
    body.appendChild(title);
    const add = (label: string, node: HTMLElement, field: string) => {
      const row = document.createElement('div'); row.className = 'dlgrow';
      const l = document.createElement('label'); l.textContent = label;
      const control = document.createElement('div'); control.className = 'field-control';
      const error = document.createElement('small'); error.className = 'field-error'; error.hidden = true;
      control.append(node, error); row.append(l, control); body.appendChild(row);
      controls.push({ uid: variable.uid, field, node, error });
    };
    const name = document.createElement('input'); name.value = variable.name;
    name.oninput = () => { variable.name = name.value.replace(/\s+/g, '_'); render(); refreshValidation(); };
    name.onchange = recordHistory;
    add('ID', name, NAME_FIELD);
    for (const param of d.params) {
      let input: HTMLInputElement | HTMLSelectElement;
      if (param.type === 'enum') {
        input = document.createElement('select');
        (param.options || []).forEach(option => input.appendChild(new Option(option, option)));
        input.value = String(variable.params[param.id]);
      } else {
        input = document.createElement('input'); input.value = String(variable.params[param.id]);
      }
      input.oninput = () => {
        variable.params[param.id] = param.type === 'number' ? numericOrExpression(input.value) : input.value;
        render(); refreshValidation();
      };
      input.onchange = recordHistory;
      add(param.label, input, param.id);
    }
  }
  const foot = document.createElement('div'); foot.className = 'dlgfoot';
  const close = document.createElement('button'); close.textContent = 'Close'; close.onclick = () => overlay.remove(); foot.appendChild(close);
  dlg.append(head, body, foot); overlay.appendChild(dlg); document.body.appendChild(overlay);
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) overlay.remove(); });
  refreshValidation(); close.focus();
}

// ---- right-click context menu (GRC-style) ----
let menuEl: HTMLDivElement | null = null;
function closeMenu() { if (menuEl) { menuEl.remove(); menuEl = null; } }
function showMenu(x: number, y: number, inst: Inst) {
  closeMenu();
  const m = document.createElement('div'); m.className = 'ctxmenu';
  const item = (label: string, fn: () => void, danger = false) => {
    const d = document.createElement('div');
    d.className = 'ctxitem' + (danger ? ' danger' : '');
    d.textContent = label;
    d.onclick = () => { closeMenu(); fn(); };
    m.appendChild(d);
  };
  const sep = () => m.appendChild(Object.assign(document.createElement('div'), { className: 'ctxsep' }));
  item('Properties', () => showPropsDialog(inst));
  // Same destination as the palette's "Show Examples": the Example Flowgraphs
  // tab, filtered to the examples that use this block type.
  item('Show Examples', () => showExamplesFor(inst.id, RUNNABLE[inst.id]?.label || inst.id));
  sep();
  item('Cut', () => { copyBlock(inst.uid); deleteBlocks(selectedBlocks.has(inst.uid) ? selectedBlocks : new Set([inst.uid])); });
  item('Copy', () => copyBlock(inst.uid));
  item('Paste', () => pasteBlock(inst.x + 30, inst.y + 30));
  item('Duplicate', () => duplicateBlock(inst.uid));
  sep();
  item('Rotate Clockwise', () => rotateSelected(90));
  item('Rotate Counterclockwise', () => rotateSelected(-90));
  item(inst.enabled ? 'Disable' : 'Enable', () => setSelectedEnabled(!inst.enabled));
  item(inst.bypassed ? 'Un-Bypass' : 'Bypass', () => bypassSelected());
  sep();
  item('Delete', () => deleteBlocks(selectedBlocks.has(inst.uid) ? selectedBlocks : new Set([inst.uid])), true);
  document.body.appendChild(m);
  m.style.left = Math.min(x, window.innerWidth - m.offsetWidth - 6) + 'px';
  m.style.top = Math.min(y, window.innerHeight - m.offsetHeight - 6) + 'px';
  menuEl = m;
}
document.addEventListener('mousedown', e => { if (menuEl && !menuEl.contains(e.target as Node)) closeMenu(); });
const SHORTCUTS: [string, string][] = [
  ['Ctrl+N / O', 'New / open flowgraph'], ['Ctrl+S', 'Save flowgraph'],
  ['Ctrl+Shift+D', 'Duplicate flowgraph'], ['Ctrl+W / Ctrl+Q', 'Close flowgraph / app'],
  ['Ctrl+P', 'Save flowgraph screenshot'], ['Ctrl+Shift+P', 'Save console'], ['Ctrl+L', 'Clear console'],
  ['Ctrl+Z / Ctrl+Y', 'Undo / redo'], ['Ctrl+A', 'Select all'], ['Delete', 'Delete selection'],
  ['Ctrl+X / C / V', 'Cut / copy / paste'], ['Left / Right', 'Rotate counterclockwise / clockwise'],
  ['Return', 'Block properties'], ['E / D / B', 'Enable / disable / bypass'],
  ['C', 'Create hierarchy (not available in WASM)'],
  ['Shift+T / M / B', 'Align top / middle / bottom'], ['Shift+L / C / R', 'Align left / center / right'],
  ['Up / Down', 'Previous / next block type'], ['+ / −', 'Increase / decrease dynamic ports'],
  ['Ctrl++ / Ctrl+− / Ctrl+0', 'Zoom in / out / reset'], ['Ctrl+D', 'Hide disabled blocks'],
  ['Ctrl+E / R / B', 'Variable editor / console / block tree'], ['Scroll Lock', 'Toggle console autoscroll'],
  ['G', 'Toggle grid'], ['Ctrl+K or F1', 'Show these shortcuts'],
  ['F6 / F7', 'Execute / stop'], ['Escape', 'Close dialog or menu'],
];
function showShortcutHelp() {
  closeMenu(); document.querySelector('.modal')?.remove();
  const overlay = document.createElement('div'); overlay.className = 'modal shortcuts';
  const dlg = document.createElement('div'); dlg.className = 'dlg shortcut-dlg';
  const head = document.createElement('div'); head.className = 'dlghead'; head.textContent = 'Keyboard shortcuts';
  const body = document.createElement('div'); body.className = 'dlgbody';
  const note = document.createElement('p'); note.className = 'shortcut-note';
  note.textContent = 'These mirror GNU Radio Companion. Browser-reserved close/quit keys may still be handled by the browser.';
  const grid = document.createElement('div'); grid.className = 'shortcut-grid';
  for (const [keys, action] of SHORTCUTS) {
    const row = document.createElement('div'); row.className = 'shortcut-row';
    const key = document.createElement('kbd'); key.textContent = keys;
    const label = document.createElement('span'); label.textContent = action; row.append(key, label); grid.appendChild(row);
  }
  body.append(note, grid);
  const foot = document.createElement('div'); foot.className = 'dlgfoot';
  const close = document.createElement('button'); close.textContent = 'Close'; close.onclick = () => overlay.remove(); foot.appendChild(close);
  dlg.append(head, body, foot); overlay.appendChild(dlg); document.body.appendChild(overlay); close.focus();
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) overlay.remove(); });
}
function consume(e: KeyboardEvent) { e.preventDefault(); e.stopPropagation(); }
document.addEventListener('keydown', e => {
  const ctrl = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
  if (e.key === 'Escape') {
    closeMenu(); closeMenus(); cancelConnect(); document.querySelector('.modal')?.remove();
    if (document.activeElement === paletteSearch && paletteSearch) {
      paletteSearch.value = ''; paletteSearch.dispatchEvent(new Event('input')); paletteSearch.blur();
    }
    return;
  }
  if (e.key === 'F1' || (ctrl && key === 'k')) { consume(e); showShortcutHelp(); return; }
  if (ctrl && key === 'n') { consume(e); clearFlowgraph(); return; }
  if (ctrl && key === 'o') { consume(e); (el('fileOpen') as HTMLInputElement).click(); return; }
  if (ctrl && key === 's') { consume(e); saveFlowgraph(); return; }
  if (ctrl && e.shiftKey && key === 'd') { consume(e); duplicateFlowgraph(); return; }
  if (ctrl && e.shiftKey && key === 'p') { consume(e); saveConsole(); return; }
  if (ctrl && key === 'p') { consume(e); saveScreenshot(); return; }
  if (ctrl && key === 'l') { consume(e); el('log').textContent = ''; return; }
  if (ctrl && key === 'w') { consume(e); clearFlowgraph(); return; }
  if (ctrl && key === 'q') { consume(e); stop(); window.close(); return; }
  if (e.key === 'F6') { consume(e); run(); return; }
  if (e.key === 'F7') { consume(e); stop(); return; }
  if (e.key === 'ScrollLock') { consume(e); autoScrollLog = !autoScrollLog; log(`console autoscroll ${autoScrollLog ? 'on' : 'off'}`); return; }
  if (ctrl && (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd')) { consume(e); setZoom(zoom * 1.15); return; }
  if (ctrl && (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract')) { consume(e); setZoom(zoom / 1.15); return; }
  if (ctrl && key === '0') { consume(e); setZoom(1); return; }
  if (ctrl && key === 'd') { consume(e); hideDisabled = !hideDisabled; render(); return; }
  if (ctrl && key === 'e') { consume(e); showVariableEditor(); return; }
  if (ctrl && key === 'r') { consume(e); el('workspace').classList.toggle('console-hidden'); return; }
  if (ctrl && key === 'b') { consume(e); el('app').classList.toggle('hide-palette'); return; }
  const active = document.activeElement;
  if (active && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName)) return;

  if (ctrl && key === 'z') { consume(e); e.shiftKey ? redo() : undo(); }
  else if (ctrl && key === 'y') { consume(e); redo(); }
  else if (ctrl && key === 'a') {
    consume(e); selectedBlocks = new Set(insts.map(i => i.uid)); selected = insts.length ? insts[insts.length - 1].uid : null;
    selectedConnection = null; render();
  }
  else if (e.key === 'Delete' && (selectedConnection || selectedBlocks.size)) {
    consume(e); if (selectedConnection) deleteConnection(selectedConnection); else deleteBlocks();
  }
  else if (ctrl && key === 'c' && selectedBlocks.size) { consume(e); copyBlocks(); }
  else if (ctrl && key === 'x' && selectedBlocks.size) { consume(e); copyBlocks(); deleteBlocks(); }
  else if (ctrl && key === 'v') { consume(e); pasteBlock(); }
  else if (e.key === 'ArrowRight' && !ctrl && selectedBlocks.size) { consume(e); rotateSelected(90); }
  else if (e.key === 'ArrowLeft' && !ctrl && selectedBlocks.size) { consume(e); rotateSelected(-90); }
  else if (e.key === 'ArrowUp' && !ctrl && selectedBlocks.size) { consume(e); cycleBlockType(-1); }
  else if (e.key === 'ArrowDown' && !ctrl && selectedBlocks.size) { consume(e); cycleBlockType(1); }
  else if (e.key === 'Enter' && selected) { consume(e); showPropsDialog(G0(selected)); }
  else if (!ctrl && !e.shiftKey && key === 'e') { consume(e); setSelectedEnabled(true); }
  else if (!ctrl && !e.shiftKey && key === 'd') { consume(e); setSelectedEnabled(false); }
  else if (!ctrl && !e.shiftKey && key === 'b') { consume(e); bypassSelected(); }
  else if (!ctrl && !e.shiftKey && key === 'c') { consume(e); log('hierarchical blocks are not supported in WebAssembly'); }
  else if (e.shiftKey && !ctrl && key === 't') { consume(e); alignSelected('top'); }
  else if (e.shiftKey && !ctrl && key === 'm') { consume(e); alignSelected('middle'); }
  else if (e.shiftKey && !ctrl && key === 'b') { consume(e); alignSelected('bottom'); }
  else if (e.shiftKey && !ctrl && key === 'l') { consume(e); alignSelected('left'); }
  else if (e.shiftKey && !ctrl && key === 'c') { consume(e); alignSelected('center'); }
  else if (e.shiftKey && !ctrl && key === 'r') { consume(e); alignSelected('right'); }
  else if (!ctrl && (e.key === '+' || e.key === '=')) { consume(e); changePortCount(1); }
  else if (!ctrl && (e.key === '-' || e.key === '_')) { consume(e); changePortCount(-1); }
  else if (!ctrl && !e.shiftKey && key === 'g') { consume(e); el('canvasWrap').classList.toggle('grid-hidden'); }
});

// ---- block Properties dialog (GRC-style modal) ----
function showPropsDialog(inst: Inst) {
  closeMenu();
  const d = RUNNABLE[inst.id]; if (!d) return;
  const tmp: { name: string; params: Record<string, any>; localFileToken?: string } = {
    name: inst.name,
    params: { ...inst.params },
    localFileToken: inst.localFileToken,
  };

  const overlay = document.createElement('div'); overlay.className = 'modal props';
  const dlg = document.createElement('div'); dlg.className = 'dlg';
  const head = document.createElement('div'); head.className = 'dlghead withclose';
  const headTitle = document.createElement('span'); headTitle.textContent = 'Properties: ' + d.label;
  const headClose = document.createElement('button'); headClose.className = 'dlgclose';
  headClose.type = 'button'; headClose.title = 'Close'; headClose.setAttribute('aria-label', 'Close');
  headClose.textContent = '×';
  headClose.onclick = () => overlay.remove();
  head.append(headTitle, headClose);
  const tabBar = document.createElement('div'); tabBar.className = 'dlgtabs'; tabBar.setAttribute('role', 'tablist');
  const body = document.createElement('div'); body.className = 'dlgbody';

  const categories = [
    'General',
    ...d.params.map(p => p.category || 'General')
      .filter((cat, i, all) => cat !== 'General' && all.indexOf(cat) === i),
    'Documentation',
  ];
  const panels = new Map<string, HTMLDivElement>();
  const tabs: HTMLButtonElement[] = [];
  const controls = new Map<string, { node: HTMLElement; error: HTMLElement }>();
  const conditionalRows: { param: ParamDef; row: HTMLElement }[] = [];
  let refreshValidation = () => {};
  let refreshVisibility = () => {};
  const activateTab = (category: string) => {
    panels.forEach((panel, name) => panel.hidden = name !== category);
    tabs.forEach(tab => {
      const active = tab.dataset.category === category;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
      tab.tabIndex = active ? 0 : -1;
    });
  };
  for (const category of categories) {
    const panel = document.createElement('div'); panel.className = 'dlgpanel'; panel.setAttribute('role', 'tabpanel');
    panels.set(category, panel); body.appendChild(panel);
    const tab = document.createElement('button'); tab.type = 'button'; tab.className = 'dlgtab';
    tab.textContent = category; tab.dataset.category = category; tab.setAttribute('role', 'tab');
    tab.onclick = () => activateTab(category);
    tab.onkeydown = e => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const offset = e.key === 'ArrowRight' ? 1 : -1;
      const next = tabs[(tabs.indexOf(tab) + offset + tabs.length) % tabs.length];
      activateTab(next.dataset.category!); next.focus();
    };
    tabs.push(tab); tabBar.appendChild(tab);
  }

  const docsPanel = panels.get('Documentation')!;
  if (d.wikiUrl) {
    const wikiLink = document.createElement('a'); wikiLink.className = 'props-wiki-link';
    wikiLink.href = d.wikiUrl;
    wikiLink.target = '_blank';
    wikiLink.rel = 'noopener noreferrer';
    wikiLink.textContent = 'Open Wiki Page for this Block';
    docsPanel.appendChild(wikiLink);
  }
  const addDocs = (title: string, text: string | undefined) => {
    if (!text) return;
    const section = document.createElement('section'); section.className = 'props-doc-section';
    const heading = document.createElement('h3'); heading.textContent = title;
    const content = document.createElement('div'); content.className = 'props-doc-text';
    content.textContent = text;
    section.append(heading, content); docsPanel.appendChild(section);
  };
  addDocs('Block description', d.documentation);
  addDocs('API documentation', d.apiDocumentation);
  if (!d.documentation && !d.apiDocumentation) {
    const empty = document.createElement('p'); empty.className = 'props-doc-empty';
    empty.textContent = 'No documentation is available for this block.';
    docsPanel.appendChild(empty);
  }

  const addField = (
    category: string,
    label: string,
    node: HTMLElement,
    field: string,
    validationNode: HTMLElement = node,
  ) => {
    const row = document.createElement('div'); row.className = 'dlgrow';
    const l = document.createElement('label'); l.textContent = label;
    const control = document.createElement('div'); control.className = 'field-control';
    const error = document.createElement('small'); error.className = 'field-error'; error.hidden = true;
    control.append(node, error); row.append(l, control); panels.get(category)!.appendChild(row);
    controls.set(field, { node: validationNode, error });
    return node;
  };
  const nameI = addField('General', 'ID', document.createElement('input'), NAME_FIELD) as HTMLInputElement;
  nameI.value = tmp.name;
  nameI.oninput = () => { tmp.name = nameI.value.replace(/\s+/g, '_'); refreshValidation(); };
  for (const p of d.params) {
    if (p.type === 'enum') {
      const s = document.createElement('select');
      (p.options || []).forEach((o, index) => {
        const opt = document.createElement('option');
        opt.value = o;
        opt.textContent = p.optionLabels?.[index] ?? o;
        s.appendChild(opt);
      });
      s.value = String(tmp.params[p.id]);
      s.onchange = () => { tmp.params[p.id] = s.value; refreshVisibility(); refreshValidation(); };
      addField(p.category || 'General', `${p.label}  (${p.id})`, s, p.id);
      if (p.showWhen) conditionalRows.push({ param: p, row: s.closest('.dlgrow') as HTMLElement });
    } else if (LOCAL_FILE_PARAMS[inst.id] === p.id && p.dtype === 'file_open') {
      const picker = document.createElement('div'); picker.className = 'file-picker';
      const inp = document.createElement('input'); inp.value = String(tmp.params[p.id]);
      const choose = document.createElement('button'); choose.type = 'button';
      choose.textContent = 'Browse…';
      const native = document.createElement('input'); native.type = 'file';
      native.className = 'file-picker-native'; native.tabIndex = -1;
      const accept = LOCAL_FILE_ACCEPT[inst.id];
      if (accept) native.accept = accept;
      const detail = document.createElement('small'); detail.className = 'file-picker-detail';
      const refreshDetail = () => {
        const file = tmp.localFileToken
          ? localFilesByToken.get(tmp.localFileToken) : undefined;
        detail.textContent = file
          ? `Local file · ${file.name} · ${displayBytes(file.size)}`
          : 'No local file selected for this browser session.';
      };
      inp.oninput = () => {
        tmp.params[p.id] = inp.value;
        tmp.localFileToken = undefined;
        refreshDetail(); refreshVisibility(); refreshValidation();
      };
      choose.onclick = () => native.click();
      native.onchange = () => {
        const file = native.files?.[0];
        if (!file) return;
        const token = newLocalFileToken();
        localFilesByToken.set(token, file);
        tmp.localFileToken = token;
        tmp.params[p.id] = file.name;
        inp.value = file.name;
        refreshDetail(); refreshVisibility(); refreshValidation();
      };
      picker.append(inp, choose, native, detail);
      addField(p.category || 'General', `${p.label}  (${p.id})`, picker, p.id, inp);
      refreshDetail();
      if (p.showWhen) conditionalRows.push({ param: p, row: picker.closest('.dlgrow') as HTMLElement });
    } else {
      // Prose params (the Note block) get a textarea so the text can contain the
      // line breaks the block face honours; everything else stays a one-liner.
      const inp = document.createElement(p.multiline ? 'textarea' : 'input') as
        HTMLInputElement | HTMLTextAreaElement;
      if (p.multiline) (inp as HTMLTextAreaElement).rows = 5;
      inp.value = String(tmp.params[p.id]);
      inp.oninput = () => {
        tmp.params[p.id] = p.type === 'number' ? numericOrExpression(inp.value) : inp.value;
        refreshVisibility(); refreshValidation();
      };
      addField(p.category || 'General', `${p.label}  (${p.id})`, inp, p.id);
      if (p.showWhen) conditionalRows.push({ param: p, row: inp.closest('.dlgrow') as HTMLElement });
    }
  }

  refreshVisibility = () => {
    conditionalRows.forEach(({ param, row }) => row.hidden = !param.showWhen!(tmp.params));
  };
  refreshVisibility();

  refreshValidation = () => {
    const candidate = { ...inst, name: tmp.name, params: tmp.params };
    const issues = validateGraph(insts.map(block => block.uid === inst.uid ? candidate : block));
    controls.forEach((control, field) =>
      setFieldError(control.node, control.error, fieldIssue(issues, inst.uid, field)));
  };

  const foot = document.createElement('div'); foot.className = 'dlgfoot';
  const apply = () => {
    inst.name = tmp.name;
    remapConnectionsForPortChange(inst, tmp.params);
    inst.params = { ...tmp.params };
    inst.localFileToken = tmp.localFileToken;
    select(inst.uid);
    recordHistory();
  };
  const btn = (label: string, fn: () => void, cls = '') => {
    const b = document.createElement('button'); b.textContent = label; if (cls) b.className = cls; b.onclick = fn; return b;
  };
  foot.appendChild(btn('Cancel', () => overlay.remove()));
  foot.appendChild(btn('Apply', apply));
  foot.appendChild(btn('OK', () => { apply(); overlay.remove(); }, 'run'));

  activateTab('General');
  dlg.append(head, tabBar, body, foot); overlay.appendChild(dlg); document.body.appendChild(overlay);
  // Unlike the informational dialogs, this one holds unsaved edits: a stray click
  // on the backdrop must not discard them. Only OK/Cancel/× close it.
  refreshValidation();
  nameI.focus(); nameI.select();
}

function select(uid: string | null, additive = false) {
  if (uid === null) selectedBlocks.clear();
  else if (additive) {
    if (selectedBlocks.has(uid)) selectedBlocks.delete(uid); else selectedBlocks.add(uid);
  } else if (!selectedBlocks.has(uid) || selectedBlocks.size === 1) {
    selectedBlocks.clear(); selectedBlocks.add(uid);
  }
  selected = uid !== null && selectedBlocks.has(uid) ? uid : ([...selectedBlocks].pop() || null);
  selectedConnection = null;
  render();
}

function selectConnection(conn: Conn) {
  // Give keyboard shortcuts back to the canvas if the palette/property editor
  // previously held focus. The SVG path itself is not a focusable element.
  (document.activeElement as HTMLElement | null)?.blur();
  selected = null; selectedBlocks.clear();
  selectedConnection = conn;
  render();
}

function svgPoint(evt: MouseEvent): { x: number; y: number } {
  const r = svg.getBoundingClientRect();
  return { x: (evt.clientX - r.left) / zoom, y: (evt.clientY - r.top) / zoom };
}

const svgEl = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>): SVGElementTagNameMap[K] => {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
};

function render() {
  rebuildScope();
  nodesG.textContent = ''; wiresG.textContent = '';
  nodesG.setAttribute('transform', `scale(${zoom})`);
  wiresG.setAttribute('transform', `scale(${zoom})`);
  selectionG.setAttribute('transform', `scale(${zoom})`);
  const validation = validateGraph();
  const invalidConnections = new Set(validation.flatMap(issue => issue.connection ? [issue.connection] : []));
  const G = (uid: string) => insts.find(i => i.uid === uid)!;
  // wires (from output right-edge to input left-edge, GRC-style curves)
  for (const c of conns) {
    const a = G(c.from), b = G(c.to); if (!a || !b || (hideDisabled && (!a.enabled || !b.enabled))) continue;
    if (portMeta(a, 'out', c.fp).hidden || portMeta(b, 'in', c.tp).hidden) continue;
    const pa = portPos(a, 'out', c.fp), pb = portPos(b, 'in', c.tp);
    const x1 = a.x + pa.x, y1 = a.y + pa.y, x2 = b.x + pb.x, y2 = b.y + pb.y;
    // As in native GRC: a straight 15px run out of each port, a cubic bezier,
    // then a straight approach in. Control points 50px out, except on a wire
    // that has to double back on itself — see wireShape().
    const { k, bowA, bowB } = wireShape(pa.edge, pb.edge, x1, y1, x2, y2);
    const [sx, sy] = ctrl(pa.edge, x1, y1, 15);
    const [c1x, c1y] = ctrl(pa.edge, x1, y1, k, bowA);
    const [c2x, c2y] = ctrl(pb.edge, x2, y2, k, bowB);
    const [ex, ey] = ctrl(pb.edge, x2, y2, 15);
    const d = `M${x1},${y1} L${sx},${sy} C${c1x},${c1y} ${c2x},${c2y} ${ex},${ey} L${x2},${y2}`;
    const isSelected = c === selectedConnection || (insts.length > 0 && selectedBlocks.size === insts.length);
    const wire = svgEl('g', { class: 'wire-group' });
    wire.appendChild(svgEl('path', { class: 'wire' + (isSelected ? ' sel' : '') +
      (invalidConnections.has(c) ? ' invalid' : ''), d,
      'marker-end': isSelected ? 'url(#arrow-selected)' : 'url(#arrow)' }));
    // Match the desktop GUI's forgiving line hit test without drawing a thick wire.
    wire.appendChild(svgEl('path', { class: 'wire-hit', d }));
    wire.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      e.preventDefault(); e.stopPropagation();
      cancelConnect();
      selectConnection(c);
    });
    wiresG.appendChild(wire);
  }
  // blocks
  for (const inst of insts) {
    if (hideDisabled && !inst.enabled) continue;
    const { d, rows, h, w } = geom(inst);
    const blockIssues = validation.filter(issue => issue.uid === inst.uid);
    const g = svgEl('g', { class: 'blk' + (selectedBlocks.has(inst.uid) ? ' sel' : '') +
      (inst.enabled ? '' : ' disabled') + (inst.bypassed ? ' bypassed' : '') +
      (blockIssues.length ? ' invalid' : ''),
      transform: `translate(${inst.x},${inst.y})` });
    const rect = svgEl('rect', { class: 'body', width: String(w), height: String(h), rx: '2' });
    g.appendChild(rect);
    // Native GRC has no title separator. With no face parameters, center the
    // title in the whole block instead of leaving it in an empty title row.
    const titleAttrs: Record<string, string> = {
      class: 'title', x: String(w / 2), y: rows.length ? '15' : String(h / 2),
      'text-anchor': 'middle',
    };
    if (!rows.length) titleAttrs['dominant-baseline'] = 'central';
    const t = svgEl('text', titleAttrs);
    t.textContent = d.label; g.appendChild(t);
    // parameter rows: "label: value"
    rows.forEach((r, i) => {
      const y = rowsTop(h, rows.length) + i * ROW_H + 11;
      const tx = svgEl('text', { class: 'param' + (fieldIssue(blockIssues, inst.uid, r.id) ? ' invalid' : '') +
        (r.id === MORE_ROW_ID ? ' pmore' : ''), x: String(TEXT_PAD_L), y: String(y) });
      const l = document.createElementNS(SVGNS, 'tspan'); l.setAttribute('class', 'plabel'); l.textContent = r.l;
      const v = document.createElementNS(SVGNS, 'tspan'); v.setAttribute('class', 'pval'); v.textContent = r.v;
      tx.appendChild(l); tx.appendChild(v); g.appendChild(tx);
    });
    const messages = [...new Set(blockIssues.map(issue => issue.message))];
    const wrapped = messages.flatMap(message => wrapValidationMessage(message, Math.max(22, Math.floor(w / 5.7))));
    wrapped.slice(0, 5).forEach((message, i) => {
      const error = svgEl('text', { class: 'validation-error', x: '0', y: String(h + 12 + i * 12) });
      error.textContent = message; g.appendChild(error);
    });
    if (wrapped.length > 5) {
      const more = svgEl('text', { class: 'validation-error', x: '0', y: String(h + 72) });
      more.textContent = `+${wrapped.length - 5} more lines`; g.appendChild(more);
    }
    // Drag from anywhere on the block; ports stopPropagation so they still connect.
    g.addEventListener('mousedown', e => startDrag(e, inst));
    g.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); if (!selectedBlocks.has(inst.uid)) select(inst.uid); showMenu(e.clientX, e.clientY, inst); });
    for (const i of visiblePortIndices(inst, 'in'))
      addPort(g, inst, 'in', i, portColor(inst, 'in', i));
    for (const i of visiblePortIndices(inst, 'out'))
      addPort(g, inst, 'out', i, portColor(inst, 'out', i));
    nodesG.appendChild(g);
  }
  updateCanvasExtent();
  syncRecordingTabs();   // one workspace tab per File Source with a recording
}

// Grow the drawing surface past the viewport when blocks sit outside it, so the
// canvas gets scrollbars like the native editor's QGraphicsView. Only the right
// and bottom extents matter: constrainBlockPosition() keeps blocks out of
// negative coordinates. The surface stays exactly viewport-sized otherwise
// (svg is width/height 100%, see index.html) so one scrollbar appearing can
// never squeeze the canvas enough to conjure up the other one.
const CANVAS_MARGIN = 60;   // room for port tabs, validation labels and drop space
function updateCanvasExtent() {
  let right = 0, bottom = 0;
  for (const inst of insts) {
    if (hideDisabled && !inst.enabled) continue;
    const { w, h } = geom(inst);
    right = Math.max(right, inst.x + w);
    bottom = Math.max(bottom, inst.y + h);
  }
  svg.style.minWidth = `${Math.ceil((right + CANVAS_MARGIN) * zoom)}px`;
  svg.style.minHeight = `${Math.ceil((bottom + CANVAS_MARGIN) * zoom)}px`;
}

function addPort(g: SVGGElement, inst: Inst, kind: 'in' | 'out', idx: number, color: string) {
  // Native GRC ports are typed, colored tabs whose width follows their centered
  // label. The connection attaches to the tab's outer edge.
  const p = portPos(inst, kind, idx);
  const label = portLabel(inst, kind, idx);
  const pw = portWidth(inst, kind, idx);
  let x: number, y: number, w: number, h: number;
  if (p.edge === 'L') { w = pw; h = PORT_H; x = p.x; y = p.y - PORT_H / 2; }
  else if (p.edge === 'R') { w = pw; h = PORT_H; x = p.x - pw; y = p.y - PORT_H / 2; }
  else if (p.edge === 'T') { w = PORT_H; h = pw; x = p.x - PORT_H / 2; y = p.y; }
  else { w = PORT_H; h = pw; x = p.x - PORT_H / 2; y = p.y - pw; }
  const r = svgEl('rect', { class: 'port', x: String(x), y: String(y),
    width: String(w), height: String(h), fill: color });
  const cx = x + w / 2, cy = y + h / 2;
  const text = svgEl('text', { class: 'port-label', x: String(cx), y: String(cy),
    'text-anchor': 'middle', 'dominant-baseline': 'central' });
  if (p.edge === 'T' || p.edge === 'B')
    text.setAttribute('transform', `rotate(-90 ${cx} ${cy})`);
  text.textContent = label;
  // Two ways to wire ports (GRC-style): left-drag from a port and release on a
  // compatible one, or click a port then click the other. Works from either an
  // output or an input.
  r.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    e.stopPropagation(); e.preventDefault();
    // A source is already armed from a prior click and this is a different
    // port: treat the press as the second click and complete the connection.
    if (connecting && !(connecting.uid === inst.uid && connecting.port === idx && connecting.kind === kind)) {
      completeConnect(inst, kind, idx);
      return;
    }
    connecting = { uid: inst.uid, port: idx, kind };
    connectDownPt = { x: e.clientX, y: e.clientY };
    log('connect from ' + inst.name + ':' + idx + ' …');
    updateConnectPreview(svgPoint(e));
  });
  r.addEventListener('mouseup', e => {
    if (!connecting) return;
    e.stopPropagation();   // keep the window handler from cancelling the wire
    // Released on the source port itself: if the pointer barely moved this was a
    // click, so leave the wire armed for click-to-connect; otherwise it was a
    // drag that went nowhere, so abandon it.
    if (connecting.uid === inst.uid && connecting.port === idx && connecting.kind === kind) {
      const dp = connectDownPt;
      if (dp && Math.hypot(e.clientX - dp.x, e.clientY - dp.y) > CONNECT_CLICK_SLOP) cancelConnect();
      return;
    }
    completeConnect(inst, kind, idx);
  });
  g.appendChild(r);
  g.appendChild(text);
}
const G0 = (uid: string) => insts.find(i => i.uid === uid)!;

// Live rubber-band wire from the source port to the cursor while connecting.
function updateConnectPreview(pt: { x: number; y: number }) {
  if (!connecting) return;
  const inst = G0(connecting.uid);
  if (!inst) { cancelConnect(); return; }
  const pp = portPos(inst, connecting.kind, connecting.port);
  const x1 = inst.x + pp.x, y1 = inst.y + pp.y;
  const [c1x, c1y] = ctrl(pp.edge, x1, y1, 42);
  const d = `M${x1},${y1} C${c1x},${c1y} ${pt.x},${pt.y} ${pt.x},${pt.y}`;
  if (!connectPreview) {
    connectPreview = svgEl('path', { class: 'wire connecting', d });
    wiresG.appendChild(connectPreview);
  } else connectPreview.setAttribute('d', d);
}
function cancelConnect() {
  connecting = null; connectDownPt = null;
  if (connectPreview) { connectPreview.remove(); connectPreview = null; }
}
// Finish a drag on the given port, orienting the connection output→input.
function completeConnect(inst: Inst, kind: 'in' | 'out', idx: number) {
  if (!connecting) return;
  let out: { uid: string; port: number }, sink: { uid: string; port: number };
  if (connecting.kind === 'out' && kind === 'in') {
    out = { uid: connecting.uid, port: connecting.port }; sink = { uid: inst.uid, port: idx };
  } else if (connecting.kind === 'in' && kind === 'out') {
    out = { uid: inst.uid, port: idx }; sink = { uid: connecting.uid, port: connecting.port };
  } else { cancelConnect(); return; }   // same direction (out→out / in→in): no connection
  if (out.uid === sink.uid) { cancelConnect(); return; }  // don't connect a block to itself
  if (selectedConnection && selectedConnection.to === sink.uid && selectedConnection.tp === sink.port)
    selectedConnection = null;
  conns = conns.filter(cn => !(cn.to === sink.uid && cn.tp === sink.port));  // one wire per input
  conns.push({ from: out.uid, fp: out.port, to: sink.uid, tp: sink.port });
  log('  → ' + G0(out.uid).name + ':' + out.port + '  to  ' + G0(sink.uid).name + ':' + sink.port);
  cancelConnect(); render(); recordHistory();
}

let drag: { inst: Inst; ox: number; oy: number; starts: Map<string, { x: number; y: number }>; moved: boolean } | null = null;
interface Marquee {
  start: Point;
  initial: Set<string>;
  initialPrimary: string | null;
  rect: SVGRectElement;
  moved: boolean;
}
let marquee: Marquee | null = null;
const MARQUEE_SLOP = 3;

function sameSelection(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every(uid => b.has(uid));
}

function updateMarquee(point: Point) {
  if (!marquee) return;
  const box = boundsBetween(marquee.start, point);
  const { x, y, width, height } = box;
  if (!marquee.moved && Math.hypot(width, height) * zoom < MARQUEE_SLOP) return;
  marquee.moved = true;
  marquee.rect.setAttribute('x', String(x));
  marquee.rect.setAttribute('y', String(y));
  marquee.rect.setAttribute('width', String(width));
  marquee.rect.setAttribute('height', String(height));
  marquee.rect.removeAttribute('visibility');

  // QGraphicsView's native rubber-band mode selects every item whose shape
  // intersects the box. Use the block body here; ports and validation labels
  // should not make a distant block feel selected.
  const next = new Set(marquee.initial);
  const hits: string[] = [];
  for (const inst of insts) {
    if (hideDisabled && !inst.enabled) continue;
    const { w, h } = geom(inst);
    if (boundsIntersect(box, { x: inst.x, y: inst.y, width: w, height: h })) {
      next.add(inst.uid);
      hits.push(inst.uid);
    }
  }
  if (sameSelection(next, selectedBlocks)) return;
  selectedBlocks = next;
  selected = hits[hits.length - 1] || (marquee.initialPrimary && next.has(marquee.initialPrimary)
    ? marquee.initialPrimary : ([...next].pop() || null));
  selectedConnection = null;
  render();
}

// Manual double-click detection: select()/drag rebuild the block's DOM node on
// every mousedown, so the browser never sees two clicks on the same element and
// its native 'dblclick' never fires. Track the last mousedown ourselves instead.
let lastMouseDown: { uid: string; t: number } | null = null;
function startDrag(e: MouseEvent, inst: Inst) {
  e.stopPropagation();
  if (e.button !== 0) return;   // right/middle click: let the context menu handle it
  e.preventDefault();           // stop the browser from starting a text selection
  const now = Date.now();
  if (lastMouseDown && lastMouseDown.uid === inst.uid && now - lastMouseDown.t < 350) {
    lastMouseDown = null; drag = null;
    select(inst.uid); showPropsDialog(inst);   // same dialog as right-click → Properties
    return;
  }
  lastMouseDown = { uid: inst.uid, t: now };
  select(inst.uid, e.shiftKey);
  if (!selectedBlocks.has(inst.uid)) return;
  const p = svgPoint(e);
  drag = { inst, ox: p.x - inst.x, oy: p.y - inst.y,
    starts: new Map(insts.filter(i => selectedBlocks.has(i.uid)).map(i => [i.uid, { x: i.x, y: i.y }])), moved: false };
}
window.addEventListener('mousemove', e => {
  if (connecting) { updateConnectPreview(svgPoint(e)); return; }
  if (marquee) { updateMarquee(svgPoint(e)); return; }
  if (!drag) return; const p = svgPoint(e);
  const primary = drag.starts.get(drag.inst.uid)!;
  const target = constrainBlockPosition(p.x - drag.ox, p.y - drag.oy, snapToGrid);
  const dx = target.x - primary.x, dy = target.y - primary.y;
  let moved = false;
  for (const inst of insts) {
    const start = drag.starts.get(inst.uid); if (!start) continue;
    const position = constrainBlockPosition(start.x + dx, start.y + dy, snapToGrid);
    moved ||= position.x !== inst.x || position.y !== inst.y;
    inst.x = position.x; inst.y = position.y;
  }
  drag.moved ||= moved; render();
});
window.addEventListener('mouseup', () => {
  if (connecting) cancelConnect();   // released away from a port: abandon the wire
  if (drag?.moved) recordHistory(); drag = null;
  if (marquee) { marquee.rect.remove(); marquee = null; }
});
svg.addEventListener('mousedown', e => {
  if (e.button !== 0) return;
  e.preventDefault();
  cancelConnect();
  const additive = e.shiftKey || e.ctrlKey || e.metaKey;
  const initial = additive ? new Set(selectedBlocks) : new Set<string>();
  const initialPrimary = additive ? selected : null;
  if (!additive) {
    selectedBlocks.clear();
    selected = null;
  }
  selectedConnection = null;
  render();
  const rect = svgEl('rect', { class: 'selection-box', visibility: 'hidden' });
  selectionG.appendChild(rect);
  marquee = { start: svgPoint(e), initial, initialPrimary, rect, moved: false };
});
svg.addEventListener('contextmenu', e => {
  e.preventDefault(); closeMenu();
  const m = document.createElement('div'); m.className = 'ctxmenu';
  const d = document.createElement('div'); d.className = 'ctxitem';
  d.textContent = 'Paste'; d.style.opacity = clipboard ? '1' : '.4';
  d.onclick = () => { closeMenu(); if (clipboard) { const p = svgPoint(e); pasteBlock(p.x, p.y); } };
  m.appendChild(d); document.body.appendChild(m);
  m.style.left = Math.min(e.clientX, window.innerWidth - m.offsetWidth - 6) + 'px';
  m.style.top = Math.min(e.clientY, window.innerHeight - m.offsetHeight - 6) + 'px';
  menuEl = m;
});

// ---- Workspace tabs and embedded WASM runner ----
type RunnerInputFile =
  | { kind: 'local'; path: string; file: File }
  | { kind: 'http'; path: string; url: string; size: number };
const pendingRunnerRecordings = new Map<string, RunnerInputFile[]>();
let pendingRunnerToken: string | null = null;

// Editor and QT GUI are the two fixed tabs; recording tabs ('rec:<key>') are
// added and removed by syncRecordingTabs() as File Sources come and go, so the
// bar is a registry rather than the pair of buttons it used to be.
type WorkspaceTab = 'editor' | 'qtgui' | string;
interface WorkspaceTabEntry { id: WorkspaceTab; button: HTMLButtonElement; panel: HTMLElement }
const workspaceTabs: WorkspaceTabEntry[] = [
  { id: 'editor', button: el('tabEditor') as HTMLButtonElement, panel: el('editorPane') },
  { id: 'qtgui', button: el('tabQtGui') as HTMLButtonElement, panel: el('runPane') },
];
let activeWorkspaceTab: WorkspaceTab = 'editor';

function activateWorkspaceTab(tab: WorkspaceTab) {
  if (!workspaceTabs.some(entry => entry.id === tab)) tab = 'editor';
  activeWorkspaceTab = tab;
  const editorActive = tab === 'editor';
  el('editorPane').hidden = !editorActive;
  el('runPane').hidden = tab !== 'qtgui';
  for (const entry of workspaceTabs) {
    const active = entry.id === tab;
    entry.button.classList.toggle('active', active);
    entry.button.setAttribute('aria-selected', String(active));
    entry.button.tabIndex = active ? 0 : -1;
    if (isRecordingTabId(entry.id)) entry.panel.classList.toggle('active', active);
  }
  // Nothing of the recording view — neither its bundle nor the recording's
  // samples — is fetched until the tab showing it is opened for the first time.
  if (isRecordingTabId(tab)) void openRecordingPane(recordingTabKey(tab));
}

function wireWorkspaceTab(entry: WorkspaceTabEntry) {
  entry.button.addEventListener('click', () => activateWorkspaceTab(entry.id));
  entry.button.addEventListener('keydown', event => {
    const index = workspaceTabs.indexOf(entry);
    if (index < 0) return;
    let next = index;
    if (event.key === 'ArrowLeft') next = (index + workspaceTabs.length - 1) % workspaceTabs.length;
    else if (event.key === 'ArrowRight') next = (index + 1) % workspaceTabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = workspaceTabs.length - 1;
    else return;
    const target = workspaceTabs[next];
    activateWorkspaceTab(target.id);
    target.button.focus();
    event.preventDefault();
  });
}
workspaceTabs.forEach(wireWorkspaceTab);

function setRunnerRunning(running: boolean, status?: string) {
  el('workspace').classList.toggle('running', running);
  el('runStatus').textContent = status || (running ? 'Running flowgraph…' : 'No flowgraph running');
  (el('btnStop') as HTMLButtonElement).disabled = !running;
  const qtTab = el('tabQtGui');
  const qtLabel = running ? 'QT GUI — flowgraph running' : 'QT GUI';
  qtTab.title = qtLabel;
  qtTab.setAttribute('aria-label', qtLabel);
}

// runner.html is same-origin and takes this one-time payload before Qt/WASM
// starts. Descriptors retain either a browser File reference or a remote URL;
// the runner reads bounded slices/ranges instead of materializing whole files.
(window as any).__grTakeRecordingFiles = (token: string): RunnerInputFile[] => {
  const files = pendingRunnerRecordings.get(token) || [];
  pendingRunnerRecordings.delete(token);
  if (pendingRunnerToken === token) pendingRunnerToken = null;
  return files;
};

// ---- Recording tabs (an embedded recording view per File Source) ------------
// Every File Source with something to show gets its own workspace tab holding
// the recording viewer this same build emits at /recording/ (adapted from
// IQEngine; see editor/src/recording/), driven through its 'url' data source.
// One <iframe> per tab, created the first time that tab is activated and kept
// alive afterwards, which is what makes both halves of the laziness hold: the
// viewer bundle is requested once (later tabs hit the HTTP cache) and a
// recording's samples are requested only for tabs actually opened.
//
// The tab set is derived state — it never reaches the .grc — so it is rebuilt
// from `insts` on every render() rather than tracked through each mutation.
interface RecordingSource {
  key: string;            // '/recordings/<path>' or 'local:<token>'
  label: string;          // tab text
  title: string;          // tooltip: the full path or file name
  name: string;           // display name handed to the recording view
  kind: 'remote' | 'local';
  path: string;           // remote: the /recordings/... path this resolves through
  token?: string;         // local: key into localFilesByToken
  datatype?: string;      // local: SigMF datatype inferred from the block
  sampleRate?: number;    // local: samp_rate from the flowgraph, when numeric
  offset: number;         // File Source selection, in samples
  length: number;
}

interface RecordingTab {
  source: RecordingSource;
  entry: WorkspaceTabEntry;
  label: HTMLElement;
  status: HTMLElement;
  frame: HTMLIFrameElement | null;
  opening: boolean;
  ready: boolean;
  viewerOffset: number | null;
  viewerLength: number | null;
  blobUrls: string[];
}

const recordingTabs = new Map<string, RecordingTab>();
let recordingTabCounter = 0;

const isRecordingTabId = (id: WorkspaceTab): boolean => id.startsWith('rec:');
const recordingTabKey = (id: WorkspaceTab): string => id.slice(4);

// A local file has no SigMF metadata, so the datatype is inferred from the File
// Source itself. GNU Radio reads interleaved I/Q integers as a scalar stream fed
// into a converter, so a short/byte source whose only sink is that converter is
// a complex recording — the same shape addRecordingFileSource() builds for ci16.
const FILE_SOURCE_DATATYPES: Record<string, string> = {
  complex: 'cf32_le', float: 'rf32_le', int: 'ri32_le', short: 'ri16_le', byte: 'ri8',
};
const INTERLEAVED_CONVERTERS: Record<string, { from: string; datatype: string }> = {
  blocks_interleaved_short_to_complex: { from: 'short', datatype: 'ci16_le' },
  blocks_interleaved_char_to_complex: { from: 'byte', datatype: 'ci8' },
};
const SIGMF_SAMPLE_BYTES: Record<string, number> = {
  cf32_le: 8, rf32_le: 4, ri32_le: 4, ci16_le: 4, ri16_le: 2, ci8: 2, ri8: 1,
};

function localRecordingDatatype(block: Inst): string {
  const type = String(block.params.type || 'complex');
  const scalar = FILE_SOURCE_DATATYPES[type] || 'cf32_le';
  if (Number(block.params.vlen ?? 1) > 1) return scalar;
  const sinks = conns.filter(c => c.from === block.uid)
    .map(c => insts.find(i => i.uid === c.to)?.id || '');
  if (sinks.length !== 1) return scalar;
  const converter = INTERLEAVED_CONVERTERS[sinks[0]];
  return converter && converter.from === type ? converter.datatype : scalar;
}

function fileSourceSelection(block: Inst): { offset: number; length: number } {
  const resolved = resolveParamsForRun(block, varScope);
  const samples = (value: any): number => {
    const number = Number(value);
    return Number.isSafeInteger(number) && number > 0 ? number : 0;
  };
  return { offset: samples(resolved.offset), length: samples(resolved.length) };
}

function recordingSourceFor(block: Inst): RecordingSource | null {
  const savedPath = String(block.params.file || '');
  const selection = fileSourceSelection(block);
  if (block.localFileToken) {
    const file = localFilesByToken.get(block.localFileToken);
    if (!file) return null;   // picked in a previous session; the File is gone
    const rate = Number(varScope['samp_rate']);
    return {
      key: 'local:' + block.localFileToken,
      label: file.name, title: file.name, name: file.name,
      kind: 'local', path: savedPath, token: block.localFileToken,
      datatype: localRecordingDatatype(block),
      sampleRate: Number.isFinite(rate) && rate > 0 ? rate : undefined,
      ...selection,
    };
  }
  if (!savedPath.startsWith('/recordings/')) return null;
  // The label comes from the path, not from the recordings manifest, so drawing
  // the tab never has to wait on (or trigger) a fetch.
  const relative = savedPath.slice('/recordings/'.length);
  const name = relative.replace(/\.sigmf-data$/, '');
  return {
    key: savedPath, label: name.split('/').pop() || name, title: relative, name,
    kind: 'remote', path: savedPath,
    ...selection,
  };
}

function recordingSources(): RecordingSource[] {
  const sources: RecordingSource[] = [];
  const seen = new Set<string>();
  for (const block of insts) {
    if (block.id !== 'blocks_file_source') continue;
    const source = recordingSourceFor(block);
    if (!source || seen.has(source.key)) continue;   // two File Sources, one tab
    seen.add(source.key);
    sources.push(source);
  }
  return sources;
}

function createRecordingTab(source: RecordingSource): RecordingTab {
  const id = ++recordingTabCounter;
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'workspace-tab'; button.id = `tabRecording${id}`;
  button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', 'false');
  button.tabIndex = -1;
  const label = document.createElement('span'); label.className = 'workspace-tab-label';
  button.appendChild(label);

  const panel = document.createElement('section');
  panel.className = 'workspace-panel recording-pane'; panel.id = `recordingPane${id}`;
  panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', button.id);
  button.setAttribute('aria-controls', panel.id);
  const status = document.createElement('div'); status.className = 'rec-pane-status';
  status.textContent = 'Open this tab to load the recording view.';
  panel.appendChild(status);
  el('workspaceContent').appendChild(panel);

  const entry: WorkspaceTabEntry = { id: 'rec:' + source.key, button, panel };
  wireWorkspaceTab(entry);
  workspaceTabs.push(entry);
  el('workspaceTabs').appendChild(button);
  return {
    source, entry, label, status, frame: null, opening: false, ready: false,
    viewerOffset: null, viewerLength: null, blobUrls: [],
  };
}

function destroyRecordingTab(tab: RecordingTab) {
  for (const url of tab.blobUrls) URL.revokeObjectURL(url);
  tab.entry.button.remove();
  tab.entry.panel.remove();   // drops the iframe, and with it the viewer's fetches
  const index = workspaceTabs.indexOf(tab.entry);
  if (index >= 0) workspaceTabs.splice(index, 1);
  recordingTabs.delete(tab.source.key);
}

// Called from render(), so it must stay synchronous and free of network calls.
function syncRecordingTabs() {
  const sources = recordingSources();
  const wanted = new Set(sources.map(source => source.key));
  for (const tab of [...recordingTabs.values()])
    if (!wanted.has(tab.source.key)) destroyRecordingTab(tab);

  for (const source of sources) {
    let tab = recordingTabs.get(source.key);
    if (!tab) { tab = createRecordingTab(source); recordingTabs.set(source.key, tab); }
    tab.source = source;
    tab.label.textContent = source.label;
    tab.entry.button.title = source.title;
    tab.entry.button.setAttribute('aria-label', `Recording ${source.title}`);
    if (tab.ready &&
        (tab.viewerOffset !== source.offset || tab.viewerLength !== source.length))
      postFileSourceSelection(tab);
  }

  // Keep the bar in canvas order. Only the buttons are reordered: re-inserting a
  // panel would re-insert its iframe, which reloads the document inside it.
  const order = [workspaceTabs[0], workspaceTabs[1],
    ...sources.map(source => recordingTabs.get(source.key)!.entry)];
  workspaceTabs.length = 0; workspaceTabs.push(...order);
  const bar = el('workspaceTabs');
  if (order.some((entry, index) => bar.children[index] !== entry.button))
    for (const entry of order) bar.appendChild(entry.button);

  if (!workspaceTabs.some(entry => entry.id === activeWorkspaceTab))
    activateWorkspaceTab('editor');
}

// A local file is a bare stream of samples: no sample rate, no datatype, nothing
// the recording view can read. Synthesize the smallest SigMF that describes it
// from what the flowgraph already says, and label the result as inferred.
function synthesizedSigmfMeta(source: RecordingSource, file: File): string {
  const datatype = source.datatype || 'cf32_le';
  const global: Record<string, any> = {
    'core:datatype': datatype,
    'core:version': '1.0.0',
    'core:description':
      'Synthesized by GNU Radio World from the File Source parameters; this file carries no SigMF metadata.',
    // Supplying the sample count spares the viewer a HEAD request, which a
    // blob: URL does not reliably answer.
    'traceability:sample_length': Math.floor(file.size / (SIGMF_SAMPLE_BYTES[datatype] || 8)),
  };
  if (source.sampleRate) global['core:sample_rate'] = source.sampleRate;
  return JSON.stringify({ global, captures: [{ 'core:sample_start': 0 }], annotations: [] });
}

function recordingPaneMessage(tab: RecordingTab, message: string) {
  tab.status.textContent = message;
  tab.status.hidden = false;
}

function recordingTabForMessage(event: MessageEvent): RecordingTab | null {
  if (event.origin !== location.origin) return null;
  return [...recordingTabs.values()].find(candidate =>
    candidate.frame?.contentWindow === event.source) || null;
}

function postFileSourceSelection(tab: RecordingTab) {
  if (!tab.ready || !tab.frame?.contentWindow) return;
  const { offset, length } = tab.source;
  tab.frame.contentWindow.postMessage(
    { type: 'gr-file-source-selection', offset, length }, location.origin);
  tab.viewerOffset = offset;
  tab.viewerLength = length;
}

function applyRecordingSelection(event: MessageEvent, data: any): boolean {
  const tab = recordingTabForMessage(event);
  if (!tab) return false;

  const offset = Number(data.offset);
  const length = Number(data.length);
  if (!Number.isSafeInteger(offset) || offset < 0 ||
      !Number.isSafeInteger(length) || length < 0) return false;

  // Remember what the viewer already shows before render() synchronizes the
  // tabs, so the resulting block edit is not immediately echoed back.
  tab.viewerOffset = offset;
  tab.viewerLength = length;

  let changed = false;
  for (const block of insts) {
    if (block.id !== 'blocks_file_source' ||
        recordingSourceFor(block)?.key !== tab.source.key) continue;
    const current = fileSourceSelection(block);
    if (current.offset === offset && current.length === length) continue;
    block.params.offset = offset;
    block.params.length = length;
    changed = true;
  }
  if (changed) {
    render();
    recordHistory();
  }
  return changed;
}

async function openRecordingPane(key: string) {
  const tab = recordingTabs.get(key);
  if (!tab || tab.frame || tab.opening) return;
  tab.opening = true;
  try {
    recordingPaneMessage(tab, 'Loading the recording view…');

    // The File Source can be deleted while the bucket index fetch below is in
    // flight; anything created past this point would never be cleaned up.
    if (recordingTabs.get(key) !== tab) return;

    let metaUrl: string, dataUrl: string;
    if (tab.source.kind === 'remote') {
      const recording = await resolveRemoteRecording(tab.source.path);
      if (recordingTabs.get(key) !== tab) return;
      if (!recording) {
        recordingPaneMessage(tab, `The recording "${tab.source.title}" is not available.`);
        return;
      }
      metaUrl = recording.metadataUrl;
      dataUrl = new URL(recording.downloadUrl, location.href).href;
    } else {
      const file = localFilesByToken.get(tab.source.token!);
      if (!file) {
        recordingPaneMessage(tab, 'Choose the local file for this File Source again.');
        return;
      }
      // Blob URLs, not a copy of the file: the viewer reads them with the same
      // ranged requests it uses for an HTTP recording.
      dataUrl = URL.createObjectURL(file);
      metaUrl = URL.createObjectURL(
        new Blob([synthesizedSigmfMeta(tab.source, file)], { type: 'application/json' }));
      tab.blobUrls.push(dataUrl, metaUrl);
      const note = document.createElement('div'); note.className = 'rec-pane-note';
      note.textContent = `Metadata inferred from the File Source: ${tab.source.datatype}` +
        (tab.source.sampleRate ? ` at ${displaySi(tab.source.sampleRate, 'Hz')}` : ', sample rate unknown') +
        '. A local file carries no SigMF metadata.';
      tab.entry.panel.insertBefore(note, tab.status);
    }

    const frame = document.createElement('iframe');
    frame.className = 'rec-pane-frame';
    frame.title = `Recording view — ${tab.source.name}`;
    frame.addEventListener('load', () => { tab.status.hidden = true; });
    tab.entry.panel.appendChild(frame);
    tab.frame = frame;
    frame.src = recordingViewUrl(metaUrl, dataUrl, tab.source.name);
  } catch (error) {
    recordingPaneMessage(tab, `The recording view could not be opened: ${error}`);
  } finally {
    tab.opening = false;
  }
}

// ---- Vertical splitter between the block palette and the workspace ----
const PALETTE_SPLITTER_WIDTH = 7;
const MIN_PALETTE_WIDTH = 180;
const MIN_WORKSPACE_WIDTH = 320;
const DEFAULT_PALETTE_WIDTH = 460;
let paletteWidth = DEFAULT_PALETTE_WIDTH;

function applyPaletteWidth(width = paletteWidth) {
  const app = el('app');
  const maximum = Math.max(MIN_PALETTE_WIDTH,
    app.clientWidth - PALETTE_SPLITTER_WIDTH - MIN_WORKSPACE_WIDTH);
  paletteWidth = Math.round(Math.max(MIN_PALETTE_WIDTH, Math.min(maximum, width)));
  app.style.setProperty('--palette-width', `${paletteWidth}px`);
  paletteSplitter.setAttribute('aria-valuenow', String(paletteWidth));
}

const paletteSplitter = el('paletteSplitter');
let resizingPalette = false;
const paletteFromPointer = (clientX: number) =>
  applyPaletteWidth(clientX - el('app').getBoundingClientRect().left - PALETTE_SPLITTER_WIDTH / 2);
paletteSplitter.addEventListener('pointerdown', event => {
  if (el('app').classList.contains('hide-palette')) return;
  resizingPalette = true;
  el('app').classList.add('resizing-palette');
  paletteSplitter.setPointerCapture(event.pointerId);
  paletteFromPointer(event.clientX);
  event.preventDefault();
});
paletteSplitter.addEventListener('pointermove', event => {
  if (resizingPalette) paletteFromPointer(event.clientX);
});
const finishPaletteResize = (event: PointerEvent) => {
  if (!resizingPalette) return;
  resizingPalette = false;
  el('app').classList.remove('resizing-palette');
  if (paletteSplitter.hasPointerCapture(event.pointerId))
    paletteSplitter.releasePointerCapture(event.pointerId);
};
paletteSplitter.addEventListener('pointerup', finishPaletteResize);
paletteSplitter.addEventListener('pointercancel', finishPaletteResize);
paletteSplitter.addEventListener('dblclick', () => applyPaletteWidth(DEFAULT_PALETTE_WIDTH));
paletteSplitter.addEventListener('keydown', event => {
  if (el('app').classList.contains('hide-palette')) return;
  if (event.key === 'ArrowLeft') applyPaletteWidth(paletteWidth - 20);
  else if (event.key === 'ArrowRight') applyPaletteWidth(paletteWidth + 20);
  else if (event.key === 'Home') applyPaletteWidth(MIN_PALETTE_WIDTH);
  else if (event.key === 'End') applyPaletteWidth(Infinity);
  else return;
  event.preventDefault();
});
window.addEventListener('resize', () => {
  if (!el('app').classList.contains('hide-palette')) applyPaletteWidth();
});

// ---- Horizontal splitter between the workspace panels and the console pane ----
// Until it is dragged the console keeps its CSS auto-sizing (grows with output up
// to 26vh); a drag pins an explicit height, and a double-click gives that back.
const CONSOLE_SPLITTER_HEIGHT = 7;
const MIN_CONSOLE_HEIGHT = 29;
const MIN_WORKSPACE_CONTENT_HEIGHT = 120;
let consoleHeight = 0;   // 0 while auto-sized

function applyConsoleHeight(height: number | null = consoleHeight) {
  const workspace = el('workspace');
  if (height === null) {
    consoleHeight = 0;
    workspace.classList.remove('console-resized');
    workspace.style.removeProperty('--console-height');
    consoleSplitter.removeAttribute('aria-valuenow');
    return;
  }
  const maximum = Math.max(MIN_CONSOLE_HEIGHT,
    workspace.clientHeight - el('workspaceTabs').offsetHeight
      - CONSOLE_SPLITTER_HEIGHT - MIN_WORKSPACE_CONTENT_HEIGHT);
  consoleHeight = Math.round(Math.max(MIN_CONSOLE_HEIGHT, Math.min(maximum, height)));
  workspace.classList.add('console-resized');
  workspace.style.setProperty('--console-height', `${consoleHeight}px`);
  consoleSplitter.setAttribute('aria-valuenow', String(consoleHeight));
}

const consoleSplitter = el('consoleSplitter');
let resizingConsole = false;
const consoleFromPointer = (clientY: number) => applyConsoleHeight(
  el('workspace').getBoundingClientRect().bottom - clientY - CONSOLE_SPLITTER_HEIGHT / 2);
consoleSplitter.addEventListener('pointerdown', event => {
  resizingConsole = true;
  el('app').classList.add('resizing-console');
  consoleSplitter.setPointerCapture(event.pointerId);
  consoleFromPointer(event.clientY);
  event.preventDefault();
});
consoleSplitter.addEventListener('pointermove', event => {
  if (resizingConsole) consoleFromPointer(event.clientY);
});
const finishConsoleResize = (event: PointerEvent) => {
  if (!resizingConsole) return;
  resizingConsole = false;
  el('app').classList.remove('resizing-console');
  if (consoleSplitter.hasPointerCapture(event.pointerId))
    consoleSplitter.releasePointerCapture(event.pointerId);
};
consoleSplitter.addEventListener('pointerup', finishConsoleResize);
consoleSplitter.addEventListener('pointercancel', finishConsoleResize);
consoleSplitter.addEventListener('dblclick', () => applyConsoleHeight(null));
consoleSplitter.addEventListener('keydown', event => {
  // Arrows nudge from wherever the pane currently sits, auto-sized or not.
  const current = consoleHeight || el('log').getBoundingClientRect().height;
  if (event.key === 'ArrowUp') applyConsoleHeight(current + 20);
  else if (event.key === 'ArrowDown') applyConsoleHeight(current - 20);
  else if (event.key === 'Home') applyConsoleHeight(MIN_CONSOLE_HEIGHT);
  else if (event.key === 'End') applyConsoleHeight(Infinity);
  else if (event.key === 'Escape') applyConsoleHeight(null);
  else return;
  event.preventDefault();
});
window.addEventListener('resize', () => { if (consoleHeight) applyConsoleHeight(); });

async function run() {
  const errors = validateGraph().filter(issue => issue.blocking);
  if (errors.length) {
    const first = errors[0];
    log(`cannot run: ${errors.length} validation error${errors.length === 1 ? '' : 's'}`);
    for (const issue of errors) {
      const block = insts.find(inst => inst.uid === issue.uid);
      log(`  ${block?.name || block?.id || issue.uid}: ${issue.message}`);
    }
    select(first.uid);
    return;
  }
  if (!insts.some(i => i.id !== OPTIONS_ID)) { log('nothing to run — add some blocks'); return; }
  const recordingFiles: RunnerInputFile[] = [];
  const fileOverrides = new Map<string, string>();
  const addedPaths = new Set<string>();
  for (const block of insts) {
    if (!block.enabled || block.bypassed) continue;
    const fileParam = LOCAL_FILE_PARAMS[block.id];
    if (!fileParam) continue;
    const savedPath = String(block.params[fileParam] || '');
    if (block.localFileToken) {
      const file = localFilesByToken.get(block.localFileToken);
      if (!file) {
        log(`cannot run: choose the local file for "${block.name}" again`);
        select(block.uid);
        return;
      }
      const path = `/local-files/${block.localFileToken}/${encodeURIComponent(file.name)}`;
      fileOverrides.set(block.name, path);
      if (!addedPaths.has(path)) {
        recordingFiles.push({ kind: 'local', path, file });
        addedPaths.add(path);
      }
      continue;
    }

    // An Image File Source with no local picture names a URL the runner fetches
    // for itself, so there is nothing to bind — only an empty field to catch.
    if (block.id === 'paint_image_source') {
      if (!savedPath) {
        log(`cannot run: choose an image for "${block.name}" with Browse, or type a URL`);
        select(block.uid);
        return;
      }
      continue;
    }

    if (savedPath.startsWith('/recordings/')) {
      const recording = await resolveRemoteRecording(savedPath);
      if (!recording) {
        log(`cannot run: recording for "${block.name}" is unavailable`);
        select(block.uid);
        return;
      }
      if (!addedPaths.has(savedPath)) {
        recordingFiles.push({
          kind: 'http',
          path: savedPath,
          url: recording.downloadUrl,
          size: recording.byteLength,
        });
        addedPaths.add(savedPath);
      }
      continue;
    }

    if (!savedPath) {
      log(`cannot run: choose a file for "${block.name}"`);
    } else {
      log(`cannot run: "${savedPath}" is not accessible to the browser; ` +
          `open "${block.name}" properties and choose it with Browse`);
    }
    select(block.uid);
    return;
  }
  for (const file of recordingFiles) {
    if (file.kind === 'local' && file.file.size === 0) {
      const block = insts.find(item => fileOverrides.get(item.name) === file.path);
      log(`cannot run: local file for "${block?.name || 'File Source'}" is empty`);
      if (block) select(block.uid);
      return;
    }
    if (file.kind === 'http' && file.size === 0) {
      const block = insts.find(item => String(item.params.file || '') === file.path);
      log(`cannot run: recording for "${block?.name || 'File Source'}" is empty`);
      if (block) select(block.uid);
      return;
    }
  }
  // The runner parses native .grc directly (it lowers disabled/bypassed blocks
  // and variables itself). We hand it a *resolved* doc — parameter expressions
  // evaluated to concrete values — since the runner can't evaluate expressions;
  // the saved/shared .grc keeps the raw expressions.
  if (pendingRunnerToken) pendingRunnerRecordings.delete(pendingRunnerToken);
  const token = typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  pendingRunnerToken = token;
  pendingRunnerRecordings.set(token, recordingFiles);
  const url = '/runner/build/runner.html?recordingToken=' + encodeURIComponent(token) +
    '#' + encodeURIComponent(grcTextForRun(fileOverrides));
  const frame = el('runFrame') as HTMLIFrameElement;
  el('runEmpty').hidden = true;
  frame.hidden = false;
  setRunnerRunning(true);
  activateWorkspaceTab('qtgui');
  frame.src = url;
  const doc = buildGrcDoc();
  log('▶ running ' + doc.blocks.length + ' blocks, ' + doc.connections.length + ' connections');
}

function stop() {
  if (pendingRunnerToken) {
    pendingRunnerRecordings.delete(pendingRunnerToken);
    pendingRunnerToken = null;
  }
  const frame = el('runFrame') as HTMLIFrameElement;
  frame.src = 'about:blank'; // unloading the iframe stops its WASM workers
  frame.hidden = true;
  el('runEmpty').hidden = false;
  setRunnerRunning(false);
  activateWorkspaceTab('editor');
  log('■ flowgraph stopped');
}

// ---- Palette ----
// ---- GRC-style block tree (collapsible categories + search) ----
interface LibraryBlock { id: string; label: string; runnable: boolean; unavailableReason?: string; module: string }
interface Cat { name: string; subs: Map<string, Cat>; blocks: LibraryBlock[] }

// Blocks that stay loadable and runnable but are not offered in the palette:
// upstream deprecated them in favour of a replacement listed right beside them,
// and showing both only invites picking the wrong one. A .grc that already uses
// one still opens, runs and round-trips.
const PALETTE_HIDDEN = new Set([
  'blocks_throttle',   // "Throttle (old)" — superseded by blocks_throttle2
]);

function buildTree(blocks: any[]): Cat {
  const root: Cat = { name: '', subs: new Map(), blocks: [] };
  for (const b of blocks) {
    if (PALETTE_HIDDEN.has(b.id)) continue;
    // Generated metadata uses an array so a literal slash in a native category
    // name (for example "Industrial I/O") is not mistaken for tree nesting.
    // Accept the old string form as well for compatibility with stale metadata.
    const category = b.category || ['Other'];
    const parts = (Array.isArray(category) ? category : String(category).split('/'))
      .map(String).filter(Boolean);
    let node = root;
    for (const part of parts) {
      let sub = node.subs.get(part);
      if (!sub) { sub = { name: part, subs: new Map(), blocks: [] }; node.subs.set(part, sub); }
      node = sub;
    }
    node.blocks.push({
      id: b.id, label: b.label || b.id, runnable: !!b.runnable,
      unavailableReason: b.unavailable_reason || undefined,
      module: b.module || 'core',
    });
  }
  return root;
}
const matchesQ = (b: { id: string; label: string }, q: string) => !q || (b.label + ' ' + b.id).toLowerCase().includes(q);
function catMatches(node: Cat, q: string): boolean {
  return !q || node.blocks.some(b => matchesQ(b, q)) || [...node.subs.values()].some(s => catMatches(s, q));
}

// Category side modules the runner has fetched this session. This state is shown
// in Help > WebAssembly Modules & Debug Info, but deliberately not in the block
// palette.
const loadedModules = new Set<string>();

// The runner iframe posts a 'gr-module' message as each category side module is
// fetched. Track it for the debug-info dialog.
window.addEventListener('message', (e) => {
  const d = (e as MessageEvent).data;
  if (!d) return;
  if (d.type === 'gr-recording-ready') {
    const tab = recordingTabForMessage(e as MessageEvent);
    if (tab) {
      tab.ready = true;
      postFileSourceSelection(tab);
    }
    return;
  }
  if (d.type === 'gr-recording-selection') {
    applyRecordingSelection(e as MessageEvent, d);
    return;
  }
  // A flowgraph that fails to build shows an error in the runner pane; mirror it
  // here so the reason is in the log next to the Run that caused it.
  if (d.type === 'gr-error' && typeof d.message === 'string') {
    setRunnerRunning(false, 'Flowgraph failed');
    log(`run failed: ${d.message}`);
    return;
  }
  // Anything the running flowgraph printed: Message Debug's PDU dumps, Print
  // Header, Print Timestamp. The runner batches these, so `lines` is a burst and
  // `dropped` counts what it shed to keep up.
  if (d.type === 'gr-print' && Array.isArray(d.lines)) {
    const lines = d.lines.map(String);
    if (d.dropped > 0) lines.push(`… ${d.dropped} more line(s) dropped`);
    logLines(lines);
    return;
  }
  if (d.type !== 'gr-module' || typeof d.module !== 'string') return;
  if (d.state === 'loaded') loadedModules.add(d.module);
});

function makeBlockItem(b: LibraryBlock, indent: number): HTMLElement {
  // A hand-written schema in RUNNABLE means we support the block even if the
  // generated library marks it unavailable (e.g. the plain `variable` block,
  // which the editor resolves away instead of handing to the runner).
  const run = !!RUNNABLE[b.id];
  const item = document.createElement('div');
  item.className = 'pal-item ' + (run ? 'runnable' : 'unavailable');
  item.style.paddingLeft = indent + 'px';
  item.textContent = b.label;
  item.title = !run ? `${b.id} — ${b.unavailableReason || 'not available in WebAssembly'}`
    : b.id;
  item.setAttribute('aria-disabled', String(!run));
  item.onclick = () => run ? addBlock(b.id) :
    log(`"${b.id}" is unavailable: ${b.unavailableReason || 'not implemented in WebAssembly'}`);
  // Right-click works on unavailable blocks too: an example that uses one is
  // still worth reading even when the runner cannot execute it.
  item.oncontextmenu = e => {
    e.preventDefault(); e.stopPropagation();
    showPaletteMenu(e.clientX, e.clientY, b);
  };
  return item;
}
// Right-click menu for a palette block (the canvas has its own, showMenu()).
function showPaletteMenu(x: number, y: number, b: LibraryBlock) {
  closeMenu();
  const m = document.createElement('div'); m.className = 'ctxmenu';
  const d = document.createElement('div'); d.className = 'ctxitem';
  d.textContent = 'Show Examples';
  d.onclick = () => { closeMenu(); showExamplesFor(b.id, b.label); };
  m.appendChild(d);
  document.body.appendChild(m);
  m.style.left = Math.min(x, window.innerWidth - m.offsetWidth - 6) + 'px';
  m.style.top = Math.min(y, window.innerHeight - m.offsetHeight - 6) + 'px';
  menuEl = m;
}
function makeCatRow(name: string, container: HTMLElement, open: boolean, bold = false,
                    indent = 6): HTMLElement {
  const row = document.createElement('div'); row.className = 'cat-row'; row.style.paddingLeft = indent + 'px';
  const tri = document.createElement('span'); tri.className = 'tri';
  const nm = document.createElement('span'); nm.className = 'cat-name';
  nm.textContent = name; if (bold) nm.style.fontWeight = '600';
  row.append(tri, nm);
  const kids = document.createElement('div');
  tri.textContent = open ? '▾' : '▸'; kids.style.display = open ? 'block' : 'none';
  row.onclick = () => {
    const isOpen = kids.style.display !== 'none';
    kids.style.display = isOpen ? 'none' : 'block'; tri.textContent = isOpen ? '▸' : '▾';
  };
  container.append(row, kids);
  return kids;
}
function renderTree(node: Cat, container: HTMLElement, depth: number, q: string) {
  for (const s of [...node.subs.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!catMatches(s, q)) continue;
    const kids = makeCatRow(s.name, container, !!q || (depth === 0 && s.name === 'Core'),
                            false, 6 + depth * 13);
    renderTree(s, kids, depth + 1, q);
  }
  for (const b of [...node.blocks].filter(b => matchesQ(b, q)).sort((a, b) => a.label.localeCompare(b.label)))
    container.appendChild(makeBlockItem(b, 6 + depth * 13 + 16));
}

let LIB: any = { blocks: [] };
let activatePaletteTab: ((which: 'blocks' | 'examples' | 'recordings') => void) | null = null;
async function buildPalette() {
  const pal = el('palette');
  // ---- tab bar: Blocks | Example Flowgraphs | SigMF Recordings ----
  const tabs = document.createElement('div'); tabs.className = 'paltabs';
  const blocksPanel = document.createElement('div'); blocksPanel.className = 'paltab-panel';
  const examplesPanel = document.createElement('div'); examplesPanel.className = 'paltab-panel'; examplesPanel.hidden = true;
  const recordingsPanel = document.createElement('div'); recordingsPanel.className = 'paltab-panel'; recordingsPanel.hidden = true;
  const tabBlocks = document.createElement('button'); tabBlocks.className = 'paltab active'; tabBlocks.textContent = 'Blocks';
  const tabExamples = document.createElement('button'); tabExamples.className = 'paltab'; tabExamples.textContent = 'Example Flowgraphs';
  const tabRecordings = document.createElement('button'); tabRecordings.className = 'paltab'; tabRecordings.textContent = 'SigMF Recordings';
  let examplesLoaded = false;
  let recordingsLoaded = false;
  const activate = (which: 'blocks' | 'examples' | 'recordings') => {
    const blocks = which === 'blocks';
    const examples = which === 'examples';
    const recordings = which === 'recordings';
    tabBlocks.classList.toggle('active', blocks);
    tabExamples.classList.toggle('active', examples);
    tabRecordings.classList.toggle('active', recordings);
    blocksPanel.hidden = !blocks; examplesPanel.hidden = !examples; recordingsPanel.hidden = !recordings;
    if (examples && !examplesLoaded) { examplesLoaded = true; buildExamples(examplesPanel); }
    if (recordings && !recordingsLoaded) { recordingsLoaded = true; buildRecordings(recordingsPanel); }
  };
  tabBlocks.onclick = () => activate('blocks');
  tabExamples.onclick = () => activate('examples');
  tabRecordings.onclick = () => activate('recordings');
  activatePaletteTab = activate;   // lets "Show Examples" switch tabs
  tabs.append(tabBlocks, tabExamples, tabRecordings);

  // ---- Blocks tab: search box + category tree (existing palette) ----
  const search = document.createElement('input');
  search.className = 'palsearch'; search.placeholder = 'Search blocks…';
  paletteSearch = search;
  const tree = document.createElement('div'); tree.className = 'tree';
  blocksPanel.append(search, tree);
  pal.append(tabs, blocksPanel, examplesPanel, recordingsPanel);
  try {
    LIB = await (await fetch(BLOCKS_URL).then(r => r.ok ? r : fetch('/editor/public/blocks.json'))).json();
    installGeneratedBlocks(LIB.blocks || []);
  } catch (e) { log('block library not loaded: ' + e); }
  const draw = (q: string) => {
    tree.textContent = '';
    renderTree(buildTree(LIB.blocks), tree, 0, q);
  };
  draw('');
  search.oninput = () => draw(search.value.trim().toLowerCase());
}

// ---- Example Flowgraphs tab ------------------------------------------------
// The examples live anywhere below example_flowgraphs/. The COOP/COEP dev
// server (server.mjs) lists that tree at /example_flowgraphs, so new files and
// directories show up here automatically without a hand-maintained manifest.

// "Show Examples" on a palette block filters this list to the examples that use
// that block. Each entry's block ids are only known once its .grc has been
// fetched and parsed, so the filter re-runs as those arrive.
// `item` is the row wrapper (button + its copy-link button), so hiding it hides
// both.
// `text` is what the search box matches against: the file name plus the title,
// author and description out of the .grc, lowercased. It starts as the file name
// alone, because that is all that is known before the .grc arrives.
interface ExampleEntry { file: string; item: HTMLElement; blockIds: Set<string> | null; text: string }
const exampleEntries: ExampleEntry[] = [];
let exampleFilter: { id: string; label: string } | null = null;
let applyExampleFilter: (() => void) | null = null;

function showExamplesFor(id: string, label: string) {
  exampleFilter = { id, label };
  activatePaletteTab?.('examples');   // builds the tab on first visit
  applyExampleFilter?.();             // ...which is why this comes after
  log(`showing example flowgraphs that use "${label}"`);
}

// ---- deep links to an example (#example=<name>) ----------------------------
// Every example in the palette hands out a link to itself. Unlike the #fg= share
// URL, which embeds a frozen gzipped copy of the flowgraph, this carries only the
// relative path: the link stays short and always opens the current version of
// that example. The fragment is left in the address bar on load so the link can
// be bookmarked and reloaded.
// Loading an example points the address bar at it, so the link can be copied
// straight out of the URL bar and a reload brings the same example back. Every
// other way of replacing the canvas (New, Close, opening a .grc) clears it again
// with setExampleHash(null), so the URL never claims an example that is no longer
// on the canvas. replaceState rather than assigning location.hash: no history
// entry, hence no Back button that looks like it should undo the load but cannot.
function setExampleHash(file: string | null) {
  const url = file ? exampleUrl(file) : location.href.split('#')[0];
  if (url !== location.href) history.replaceState(null, '', url);
}
async function copyExampleUrl(file: string) {
  const url = exampleUrl(file);
  log(await copyText(url) ? `copied a link to "${file}": ${url}`
        : 'could not copy automatically — link logged below:\n' + url);
}
// Used by the #example= hash on startup; the palette's own click handler loads
// the .grc it already fetched instead of going through here.
async function loadExampleByName(name: string) {
  const file = normalizeExamplePath(name);
  const res = await fetch('/example_flowgraphs/' + encodeExamplePath(file));
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  const fg = parseGrc(await res.text());
  const title = String(fg.options?.parameters?.title || file);
  loadFlowgraphAnimated(fg);          // resets history itself
  setExampleHash(file);               // normalizes e.g. a link written with .grc
  setCurrentFileName(file);           // Save writes the example back under its own name
  log(`loaded example "${title}" from link`);
  void bindFlowgraphRecordings(fg, title);
}

async function buildExamples(panel: HTMLElement) {
  const list = document.createElement('div'); list.className = 'ex-list';
  const status = document.createElement('div'); status.className = 'ex-empty'; status.textContent = 'Loading examples…';
  panel.append(status);
  let files: string[] = [];
  try {
    files = await (await fetch('/example_flowgraphs')).json();
  } catch (e) {
    status.textContent = 'Could not load example flowgraphs.';
    log('example flowgraphs not loaded: ' + e); return;
  }
  if (!files.length) { status.textContent = 'No example flowgraphs found.'; return; }

  // Search box: matches every whitespace-separated term against the entry's
  // title/author/description/file name, so "estevez afsk" narrows by both. It is
  // independent of the block filter below — both apply at once.
  const search = document.createElement('input');
  search.className = 'palsearch ex-search';
  search.placeholder = 'Search examples…';
  search.setAttribute('aria-label', 'Search example flowgraphs');
  let terms: string[] = [];
  const onQuery = () => {
    terms = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    refresh();
  };
  search.oninput = onQuery;
  search.onkeydown = e => {
    if (e.key === 'Escape' && search.value) { e.stopPropagation(); search.value = ''; onQuery(); }
  };

  // Filter banner: only visible while a block filter is active, and its button
  // is the way back to the full list.
  const bar = document.createElement('div'); bar.className = 'ex-filter'; bar.hidden = true;
  const barText = document.createElement('div'); barText.className = 'ex-filter-text';
  const clear = document.createElement('button'); clear.className = 'ex-filter-clear';
  clear.textContent = 'Show all';
  clear.onclick = () => { exampleFilter = null; refresh(); log('showing all example flowgraphs'); };
  bar.append(barText, clear);
  const noMatch = document.createElement('div'); noMatch.className = 'ex-empty'; noMatch.hidden = true;

  const refresh = () => {
    const f = exampleFilter;
    const q = terms.join(' ');
    bar.hidden = !f;
    let shown = 0, pending = 0;
    for (const entry of exampleEntries) {
      const hit = terms.every(t => entry.text.includes(t));
      if (!f) { entry.item.hidden = !hit; if (hit) shown++; continue; }
      if (!entry.blockIds) { entry.item.hidden = true; pending++; continue; }
      const match = entry.blockIds.has(f.id) && hit;
      entry.item.hidden = !match;
      if (match) shown++;
    }
    // A directory stays visible when any descendant is visible. Filtering and
    // searching expand matching paths so the result is not hidden in a closed
    // disclosure; clearing the query leaves the user's open state alone.
    const directories = [...list.querySelectorAll<HTMLDetailsElement>('.ex-directory')].reverse();
    for (const details of directories) {
      const contents = details.querySelector<HTMLElement>(':scope > .rec-directory-contents');
      const hasVisibleChild = !!contents && [...contents.children]
        .some(child => !(child as HTMLElement).hidden);
      details.hidden = !hasVisibleChild;
      if ((f || q) && hasVisibleChild) details.open = true;
    }
    if (f) {
      barText.textContent =
        `Filtered: ${shown} of ${exampleEntries.length} examples use “${f.label}”` +
        (q ? ` and match “${q}”` : '') +
        (pending ? ' (still loading…)' : '');
      noMatch.textContent = pending ? '' : `No example flowgraph uses “${f.label}”${q ? ` and matches “${q}”` : ''}.`;
    } else if (q) {
      noMatch.textContent = `No example flowgraph matches “${q}”.`;
    }
    noMatch.hidden = (!f && !q) || shown > 0 || pending > 0;
  };
  applyExampleFilter = refresh;

  status.remove(); panel.append(search, bar, list, noMatch);
  exampleEntries.length = 0;
  const addExample = (file: string, container: HTMLElement) => {
    // A row, not just the button, because the copy-link button sits on top of it
    // and a button cannot contain another button.
    const row = document.createElement('div'); row.className = 'ex-row';
    const item = document.createElement('button'); item.className = 'ex-item';
    const title = document.createElement('div'); title.className = 'ex-title';
    title.textContent = exampleFileName(file).replace(/\.grc$/, '');
    item.append(title);
    const link = document.createElement('button'); link.className = 'ex-link';
    link.textContent = '🔗'; link.title = `Copy a link to this example (${exampleUrl(file)})`;
    link.setAttribute('aria-label', `Copy a link to ${file}`);
    link.onclick = e => { e.stopPropagation(); void copyExampleUrl(file); };
    row.append(item, link);
    container.append(row);
    const entry: ExampleEntry = { file, item: row, blockIds: null, text: file.toLowerCase() };
    exampleEntries.push(entry);
    // Fetch the file to show its title/description and load it on click.
    fetch('/example_flowgraphs/' + encodeExamplePath(file)).then(r => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.text();
    }).then(text => {
      const fg = parseGrc(text);
      const params = fg.options?.parameters || {};
      const fgTitle = params.title || params.id;
      const fgAuthor = params.author;
      const fgDesc = params.description || params.comment;
      entry.text = [file, fgTitle, fgAuthor, fgDesc].filter(Boolean).join(' ').toLowerCase();
      if (fgTitle) title.textContent = String(fgTitle);
      if (fgAuthor) {
        const author = document.createElement('div'); author.className = 'ex-author';
        author.textContent = `by ${String(fgAuthor)}`; item.append(author);
      }
      if (fgDesc) {
        const desc = document.createElement('div'); desc.className = 'ex-desc';
        desc.textContent = String(fgDesc); item.append(desc);
      }
      const blocks = Array.isArray(fg.blocks) ? fg.blocks : [];
      const n = blocks.length;
      entry.blockIds = new Set(blocks.map((b: any) => String(b?.id)));
      refresh();
      const meta = document.createElement('div'); meta.className = 'ex-meta';
      meta.textContent = `${file} · ${n} block${n === 1 ? '' : 's'}`;
      item.append(meta);
      item.onclick = () => {
        try {
          loadFlowgraphAnimated(fg);
          setExampleHash(file);
          setCurrentFileName(file);
          log(`loaded example "${fgTitle || file}"`);
          void bindFlowgraphRecordings(fg, String(fgTitle || file));
        } catch (err) { log(`failed to load example "${file}": ${err}`); }
      };
    }).catch(err => {
      // An unparseable example can never match a block filter, but it must stop
      // counting as pending or the banner claims it is still loading forever.
      entry.blockIds = new Set(); refresh();
      item.disabled = true; title.textContent = `${file} (failed to load)`;
      log(`example "${file}" not loaded: ${err}`);
    });
  };

  const renderDirectory = (directory: ExampleDirectory, container: HTMLElement) => {
    const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
    for (const child of [...directory.directories.values()].sort((a, b) => byName(a.name, b.name))) {
      const details = document.createElement('details');
      details.className = 'rec-directory ex-directory';
      const summary = document.createElement('summary'); summary.className = 'rec-directory-head';
      const name = document.createElement('span'); name.className = 'rec-directory-name';
      name.textContent = child.name;
      const count = document.createElement('span'); count.className = 'rec-directory-count';
      const total = exampleTreeCount(child);
      count.textContent = `${total} example${total === 1 ? '' : 's'}`;
      summary.append(name, count);
      const contents = document.createElement('div'); contents.className = 'rec-directory-contents';
      renderDirectory(child, contents);
      details.append(summary, contents);
      container.append(details);
    }
    for (const file of [...directory.files].sort(byName)) addExample(file, container);
  };
  renderDirectory(buildExampleTree(files), list);
  refresh();
}

// ---- Recordings tab -------------------------------------------------------
// The R2 bucket's scheduled Worker owns index.json. The editor reads that
// index and both SigMF objects directly from R2, so publishing a recording does
// not require a repository or Pages rebuild.

const remoteRecordingsByPath = new Map<string, ExampleRecording>();
let exampleRecordingsPromise: Promise<ExampleRecording[]> | null = null;

function bindRemoteRecording(recording: ExampleRecording): string {
  const path = '/recordings/' + recording.dataFile;
  remoteRecordingsByPath.set(path, recording);
  return path;
}

function loadExampleRecordings(): Promise<ExampleRecording[]> {
  if (exampleRecordingsPromise) return exampleRecordingsPromise;
  exampleRecordingsPromise = (async () => {
    const response = await fetch(recordingsBucketUrl('index.json'), { cache: 'no-store' });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const payload = await response.json();
    if (!Array.isArray(payload)) throw new Error('invalid R2 recordings index');
    const recordings = payload
      .map(entry => recordingFromR2Index(entry as R2RecordingIndexEntry))
      .filter((entry): entry is ExampleRecording => entry !== null);
    if (recordings.length !== payload.length)
      console.warn(`ignored ${payload.length - recordings.length} invalid R2 recording index entries`);
    for (const recording of recordings) bindRemoteRecording(recording);
    return recordings;
  })().catch(error => {
    // A transient bucket-index failure should not make every later attempt fail.
    exampleRecordingsPromise = null;
    throw error;
  });
  return exampleRecordingsPromise;
}

async function resolveRemoteRecording(path: string): Promise<ExampleRecording | undefined> {
  const existing = remoteRecordingsByPath.get(path);
  if (existing) return existing;
  await loadExampleRecordings();
  return remoteRecordingsByPath.get(path);
}

function flowgraphRecordingPaths(doc: any): string[] {
  const paths = new Set<string>();
  for (const block of Array.isArray(doc?.blocks) ? doc.blocks : []) {
    if (block?.id !== 'blocks_file_source') continue;
    const path = String(block.parameters?.file || '');
    if (path.startsWith('/recordings/')) paths.add(path);
  }
  return [...paths];
}

async function bindFlowgraphRecordings(doc: any, exampleName: string) {
  const paths = flowgraphRecordingPaths(doc);
  if (!paths.length) return;
  try {
    const recordings = await loadExampleRecordings();
    const byPath = new Map(recordings.map(recording =>
      [bindRemoteRecording(recording), recording] as const));
    const missing = paths.filter(path => !byPath.has(path));
    for (const path of missing)
      log(`example "${exampleName}" references unavailable recording "${path}"`);
    const ready = paths.filter(path => byPath.has(path)).length;
    if (ready)
      log(`ready to stream ${ready} recording${ready === 1 ? '' : 's'} for example "${exampleName}"`);
  } catch (error) {
    log(`recordings for example "${exampleName}" unavailable: ${error}`);
  }
}

// ---- Recording view route ---------------------------------------------------
// The recording view is this same Vite build's second entry (editor/recording/
// + editor/src/recording/, adapted from IQEngine), emitted at /recording/. Its
// 'url' data source takes a recording as a pair of URLs packed into the route as
// base64url, so a recording needs no backend, no Azure account and no local
// file picking to be viewable:
//
//   /recording/#/view/url/<base64url meta URL>/<base64url data URL>/<name>
//
// The route goes after the '#' because the viewer uses hash routing: Cloudflare
// Pages cannot serve index.html for arbitrary paths under a sub-directory (a
// wildcard rewrite there turns into a redirect and swallows the app's own asset
// requests), so /recording/ has to stay a plain directory of static files.
//
// The URLs are absolute R2 URLs so the route keeps working wherever the viewer
// is served from. Both the metadata and data objects come from the bucket.

async function addRecordingFileSource(recording: ExampleRecording, format: FileSourceFormat) {
  await paletteReady;
  const addIShortToComplex = isCi16Datatype(recording.datatype);
  const converterId = 'blocks_interleaved_short_to_complex';
  if (addIShortToComplex && !RUNNABLE[converterId])
    throw new Error('IShort To Complex is not available');

  const virtualPath = bindRemoteRecording(recording);
  const block = addBlock('blocks_file_source', undefined, undefined, {
    file: virtualPath,
    type: format.type,
    repeat: 'False',
    vlen: format.vlen,
    begin_tag: 'pmt.PMT_NIL',
    offset: 0,
    length: 0,
  }, false);
  if (!block) throw new Error('File Source is not available');

  if (addIShortToComplex) {
    const converter = addBlock(
      converterId,
      block.x + geom(block).w + 80,
      block.y,
      { vector_input: 'False', scale_factor: 32767.0 },
      false,
    )!;
    conns.push({ from: block.uid, fp: 0, to: converter.uid, tp: 0 });
    selectedBlocks = new Set([block.uid, converter.uid]);
    selected = converter.uid;
    selectedConnection = null;
    render();
    recordHistory();
    log(`added streaming File Source and IShort To Complex for "${recording.name}"`);
    return;
  }

  render();
  recordHistory();
  log(`added streaming File Source for "${recording.name}"`);
}

function makeRecordingItem(recording: ExampleRecording): HTMLElement {
  const item = document.createElement('article'); item.className = 'rec-item';
  item.tabIndex = 0; item.setAttribute('role', 'button');
  const head = document.createElement('div'); head.className = 'rec-head';
  const title = document.createElement('div'); title.className = 'rec-title';
  // The containing directory rows already show the relative path. Keep the
  // card itself to the recording's basename instead of repeating that path.
  title.textContent = recording.name.split('/').filter(Boolean).pop() || recording.name;
  const badge = document.createElement('span'); badge.className = 'rec-badge';
  badge.textContent = 'Stream';
  head.append(title, badge);
  const props = document.createElement('dl'); props.className = 'rec-props';
  const addProperty = (label: string, value: string | number | null) => {
    const key = document.createElement('dt'); key.textContent = label;
    const val = document.createElement('dd'); val.textContent = displayRecordingValue(value);
    props.append(key, val);
  };
  addProperty('Data Type', recording.datatype);
  addProperty('Sample Rate', displaySi(recording.sampleRate, 'Hz'));
  addProperty('Author', recording.author);
  addProperty('Samples', displaySi(recording.sampleCount, ''));
  // Both files and the index come directly from the recording bucket.
  const sizeKey = document.createElement('dt'); sizeKey.textContent = 'Size';
  const sizeVal = document.createElement('dd'); sizeVal.className = 'rec-size';
  sizeVal.append(displayBytes(recording.byteLength));
  const addDownloadLink = (label: string, url: string, fileName: string) => {
    const link = document.createElement('a'); link.className = 'rec-dl';
    // download= is a file name, not a path: a recording in a collection
    // sub-directory still saves under its own base name.
    link.href = url; link.download = fileName.split('/').pop()!; link.rel = 'noopener';
    link.textContent = label;
    // Clicking a link must not also drop a File Source on the canvas.
    link.onclick = event => event.stopPropagation();
    sizeVal.append(link);
  };
  addDownloadLink('data file', recording.downloadUrl, recording.dataFile);
  addDownloadLink('meta file', recording.metadataUrl, recording.metaFile);
  props.append(sizeKey, sizeVal);
  const streamNote = document.createElement('div'); streamNote.className = 'rec-progress';
  streamNote.textContent = 'Read on demand in bounded byte ranges while the flowgraph runs.';
  item.append(head, props, streamNote);

  const format = sigmfFileSourceFormat(recording.datatype);
  if (!format) {
    badge.textContent = 'Unsupported';
    item.setAttribute('aria-disabled', 'true');
    item.title = `File Source cannot directly represent ${recording.datatype || 'this datatype'}`;
    return item;
  }

  const useRecording = async () => {
    try {
      await addRecordingFileSource(recording, format);
    } catch (error) {
      log(`recording "${recording.name}" could not be added: ${error}`);
    }
  };
  item.onclick = () => { void useRecording(); };
  item.onkeydown = event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    if ((event.target as HTMLElement)?.closest('a')) return;
    event.preventDefault(); void useRecording();
  };
  return item;
}


function renderRecordingTree(directory: RecordingDirectory, container: HTMLElement) {
  const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true });
  for (const child of [...directory.directories.values()].sort((a, b) => byName(a.name, b.name))) {
    const details = document.createElement('details'); details.className = 'rec-directory';
    // Deliberately do not set details.open: every directory, including nested
    // ones, starts collapsed and the browser supplies keyboard disclosure.
    const summary = document.createElement('summary'); summary.className = 'rec-directory-head';
    const name = document.createElement('span'); name.className = 'rec-directory-name';
    name.textContent = child.name;
    const count = document.createElement('span'); count.className = 'rec-directory-count';
    const total = recordingTreeCount(child);
    count.textContent = `${total} recording${total === 1 ? '' : 's'}`;
    summary.append(name, count);
    const contents = document.createElement('div'); contents.className = 'rec-directory-contents';
    renderRecordingTree(child, contents);
    details.append(summary, contents);
    container.append(details);
  }
  for (const recording of [...directory.recordings].sort((a, b) => byName(a.name, b.name)))
    container.append(makeRecordingItem(recording));
}

async function buildRecordings(panel: HTMLElement) {
  const list = document.createElement('div'); list.className = 'rec-list';
  const status = document.createElement('div'); status.className = 'ex-empty';
  status.textContent = 'Loading recordings…'; panel.append(status);
  let recordings: ExampleRecording[] = [];
  try {
    recordings = await loadExampleRecordings();
  } catch (e) {
    status.textContent = 'Could not load recordings.';
    log('recordings not loaded: ' + e); return;
  }
  if (!recordings.length) { status.textContent = 'No SigMF recordings found.'; return; }
  status.remove(); panel.append(list);
  renderRecordingTree(buildRecordingTree(recordings), list);
}

// ---- GRC-style menu bar + toolbar ----------------------------------------
// These mirror grc/gui/Bars.py (MENU_BAR_LIST / TOOLBAR_LIST). Actions that
// exist in the desktop GUI but can't work inside a browser tab are kept in
// place but greyed out, with a hover tooltip explaining why. GTK itself can't
// run in WebAssembly, so this is a hand-built reimplementation rather than a
// port of the GTK menus.

// Reasons shown when hovering an action that is unavailable in the WASM build.
const R_QUIT = "A browser tab can't quit the application — just close the tab instead.";
const R_HIER = "Hierarchical blocks aren't supported in the WebAssembly editor.";
const R_XML = "GRC no longer uses XML flowgraphs, so there are no XML parser errors to display.";
const R_TODO = "This display option isn't implemented in the browser editor yet.";

// ---- hover tooltip (explains why an action is unavailable) ----
let wasmTipEl: HTMLDivElement | null = null;
function ensureTip(): HTMLDivElement {
  if (!wasmTipEl) {
    wasmTipEl = document.createElement('div'); wasmTipEl.id = 'wasmTip'; wasmTipEl.hidden = true;
    document.body.appendChild(wasmTipEl);
  }
  return wasmTipEl;
}
function positionTip(node: HTMLElement) {
  const t = ensureTip(), r = node.getBoundingClientRect();
  let left = r.right + 8, top = r.top;
  if (left + t.offsetWidth > window.innerWidth - 8) left = r.left - t.offsetWidth - 8;
  if (top + t.offsetHeight > window.innerHeight - 8) top = window.innerHeight - t.offsetHeight - 8;
  t.style.left = Math.max(8, left) + 'px'; t.style.top = Math.max(8, top) + 'px';
}
function attachTip(node: HTMLElement, text: string) {
  node.addEventListener('mouseenter', () => { const t = ensureTip(); t.textContent = text; t.hidden = false; positionTip(node); });
  node.addEventListener('mousemove', () => positionTip(node));
  node.addEventListener('mouseleave', hideTip);
}
function hideTip() { if (wasmTipEl) wasmTipEl.hidden = true; }

// ---- action helpers that the menu/toolbar wire into ----
function openFileDialog() { (el('fileOpen') as HTMLInputElement).click(); }
function cutSelected() { if (!selectedBlocks.size) return; copyBlocks(); deleteBlocks(); }
function deleteSelection() { if (selectedConnection) deleteConnection(selectedConnection); else deleteBlocks(); }
function selectAll() {
  selectedBlocks = new Set(insts.map(i => i.uid));
  selected = insts.length ? insts[insts.length - 1].uid : null;
  selectedConnection = null; render();
}
function openPropsForSelected() { if (selected) showPropsDialog(G0(selected)); }
function togglePalette() { el('app').classList.toggle('hide-palette'); }
function toggleConsole() { el('workspace').classList.toggle('console-hidden'); }
function toggleScrollLock() { autoScrollLog = !autoScrollLog; log(`console autoscroll ${autoScrollLog ? 'on' : 'off'}`); }
function clearConsole() { el('log').textContent = ''; }
function toggleHideDisabled() { hideDisabled = !hideDisabled; render(); }
function toggleSnapToGrid() {
  snapToGrid = !snapToGrid;
  log(`snap to grid ${snapToGrid ? 'on' : 'off'}`);
}
function openLink(url: string) { window.open(url, '_blank', 'noopener'); }

// ---- enable/state predicates (evaluated each time a menu opens) ----
function hasSel() { return selectedBlocks.size > 0; }
function hasSelOrConn() { return selectedBlocks.size > 0 || !!selectedConnection; }
function canUndo() { return historyIndex > 0; }
function canRedo() { return historyIndex < graphHistory.length - 1; }
function canPaste() { return !!clipboard; }
function hasBlocks() { return insts.length > 0; }

// ---- simple info dialogs (reuse the existing .modal/.dlg styling) ----
function openDialog(title: string, build: (body: HTMLElement) => void, wide = false): HTMLElement {
  closeMenus(); closeMenu(); document.querySelector('.modal')?.remove();
  const overlay = document.createElement('div'); overlay.className = 'modal';
  const dlg = document.createElement('div'); dlg.className = 'dlg' + (wide ? ' shortcut-dlg' : '');
  const head = document.createElement('div'); head.className = 'dlghead'; head.textContent = title;
  const body = document.createElement('div'); body.className = 'dlgbody';
  build(body);
  const foot = document.createElement('div'); foot.className = 'dlgfoot';
  const close = document.createElement('button'); close.textContent = 'Close'; close.onclick = () => overlay.remove();
  foot.appendChild(close);
  dlg.append(head, body, foot); overlay.appendChild(dlg); document.body.appendChild(overlay);
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) overlay.remove(); });
  close.focus();
  return overlay;
}
const TYPE_NAMES: Record<string, string> = {
  complex: 'Complex Float 32', float: 'Float 32', int: 'Integer 32',
  short: 'Integer 16', byte: 'Byte', message: 'Async Message', '': 'Wildcard',
};
function showTypesDialog() {
  openDialog('Port & Data Types', body => {
    for (const [k, color] of Object.entries(DTYPE_COLOR)) {
      const row = document.createElement('div'); row.className = 'type-row';
      const sw = document.createElement('span'); sw.className = 'type-swatch'; sw.style.background = color;
      const nm = document.createElement('span'); nm.textContent = TYPE_NAMES[k] ?? k;
      row.append(sw, nm); body.appendChild(row);
    }
  });
}
function showErrorsDialog() {
  openDialog('Flowgraph Errors', body => {
    const issues = validateGraph();
    if (!issues.length) { body.textContent = 'No errors — the flowgraph is valid.'; return; }
    for (const issue of issues) {
      const b = insts.find(i => i.uid === issue.uid);
      const row = document.createElement('div'); row.className = 'err-row';
      row.textContent = `${b?.name || b?.id || issue.uid}: ${issue.message}`;
      body.appendChild(row);
    }
  }, true);
}
function showAboutDialog() {
  openDialog('About GNU Radio World', body => {
    body.classList.add('about-body');
    body.innerHTML = aboutHtml;
  });
}

// ---- contribute the open flowgraph as a repo example ----
// The editor is a static site with no backend and no credentials, so a
// contribution is a hand-off: the .grc goes on the clipboard and GitHub's web
// new-file editor opens at the right path. GitHub forks the repo for anyone
// without write access, so "Propose new file" becomes a pull request. Examples
// come from the directory listing, so the PR only ever adds one .grc file.
// The Options block's title is the only human name a flowgraph carries; without
// one the dialog opens on the generic fallback for the contributor to replace.
function suggestedExampleName(): string {
  const opt = insts.find(i => i.id === OPTIONS_ID);
  return sanitizeExampleName(String(opt?.params.title || '').trim());
}
function contributeExample() {
  const grc = grcText();
  let nameInput!: HTMLInputElement;
  let pathLine!: HTMLElement;
  let taken: string[] = [];
  let clash!: HTMLElement;
  const currentName = () => sanitizeExampleName(nameInput.value);
  const refresh = () => {
    const name = currentName();
    pathLine.textContent = examplePath(name);
    const exists = taken.some(f => f.toLowerCase() === name.toLowerCase());
    clash.textContent = exists
      ? `An example named ${name} already exists — pick another name unless you mean to replace it.` : '';
    clash.hidden = !exists;
  };
  const overlay = openDialog('Contribute Example Flowgraph', body => {
    const intro = document.createElement('div'); intro.className = 'contrib-intro';
    intro.textContent =
      `Share this flowgraph with the community. It is added to ${EXAMPLES_REPO.dir}/ in the ` +
      `${EXAMPLES_REPO.owner}/${EXAMPLES_REPO.repo} repository through a pull request, and appears in the ` +
      'Examples tab of the editor once merged.';
    const steps = document.createElement('ol'); steps.className = 'contrib-steps';
    for (const text of [
      '“Copy & Open GitHub” copies this flowgraph and opens GitHub’s new-file page at the path below.',
      'Paste (Ctrl+V) into the file editor on that page.',
      'Click “Propose new file” — GitHub forks the repository for you and opens the pull request.',
    ]) { const li = document.createElement('li'); li.textContent = text; steps.appendChild(li); }

    const row = document.createElement('div'); row.className = 'contrib-name';
    const label = document.createElement('label'); label.textContent = 'File name'; label.htmlFor = 'contribName';
    nameInput = document.createElement('input');
    nameInput.id = 'contribName'; nameInput.type = 'text'; nameInput.value = suggestedExampleName();
    nameInput.oninput = refresh;
    row.append(label, nameInput);
    pathLine = document.createElement('div'); pathLine.className = 'contrib-path';
    clash = document.createElement('div'); clash.className = 'contrib-warn'; clash.hidden = true;

    body.append(intro, steps, row, pathLine, clash);

    // Non-blocking nudge: a flowgraph with errors makes a poor example.
    const issues = validateGraph();
    if (issues.length) {
      const warn = document.createElement('div'); warn.className = 'contrib-warn';
      warn.textContent = `This flowgraph has ${issues.length} validation ` +
        `${issues.length === 1 ? 'issue' : 'issues'} (View ▸ Flowgraph Errors) — consider fixing them first.`;
      body.appendChild(warn);
    }

    // Guaranteed manual-copy path when the clipboard is unavailable.
    const ta = document.createElement('textarea');
    ta.className = 'contrib-copy'; ta.readOnly = true; ta.value = grc;
    ta.onclick = () => ta.select();
    body.appendChild(ta);
  });

  const foot = overlay.querySelector('.dlgfoot')!;
  const go = document.createElement('button'); go.className = 'run'; go.textContent = 'Copy & Open GitHub';
  go.onclick = () => {
    // Both the clipboard write and the popup need the click's user activation, so
    // start the copy without awaiting it and open the tab in the same tick.
    const name = currentName();
    const copied = copyText(grc);
    openLink(newExampleFileUrl(name));
    log(`opened a GitHub pull request page for ${examplePath(name)}`);
    void copied.then(ok => log(ok
      ? 'copied the flowgraph to the clipboard — paste it into the GitHub editor with Ctrl+V'
      : 'could not copy automatically — copy the flowgraph text from the dialog instead'));
  };
  foot.prepend(go);

  // Populate the "name already used" check once the example list arrives.
  void fetch('/example_flowgraphs').then(r => r.json()).then(files => {
    if (Array.isArray(files)) { taken = files.map(String); refresh(); }
  }).catch(() => { /* listing unavailable (e.g. offline) — skip the check */ });
  refresh();
  nameInput.focus(); nameInput.select();
}

// ---- menu model + builder ----
type MenuItem =
  | { label: string; key?: string; run?: () => void; reason?: string;
      enabled?: () => boolean; check?: () => boolean; danger?: boolean; sub?: (MenuItem | 'sep')[] };
interface TopMenu { label: string; items: (MenuItem | 'sep')[] }

const MENUS: TopMenu[] = [
  { label: 'File', items: [
    { label: 'About GNU Radio World', run: showAboutDialog },
    'sep',
    { label: 'New', key: 'Ctrl+N', run: () => clearFlowgraph() },
    { label: 'Duplicate', key: 'Ctrl+Shift+D', run: duplicateFlowgraph, enabled: hasBlocks },
    { label: 'Open…', key: 'Ctrl+O', run: openFileDialog },
    'sep',
    { label: 'Save', key: 'Ctrl+S', run: () => saveFlowgraph() },
    { label: 'Copy URL', run: copyFlowgraphUrl, enabled: hasBlocks },
    { label: 'Contribute as Example…', run: contributeExample, enabled: hasBlocks },
    'sep',
    { label: 'Screen Capture…', key: 'Ctrl+P', run: saveScreenshot },
    'sep',
    { label: 'Close', key: 'Ctrl+W', run: () => clearFlowgraph() },
    { label: 'Quit', key: 'Ctrl+Q', reason: R_QUIT },
  ] },
  { label: 'Edit', items: [
    { label: 'Undo', key: 'Ctrl+Z', run: undo, enabled: canUndo },
    { label: 'Redo', key: 'Ctrl+Y', run: redo, enabled: canRedo },
    'sep',
    { label: 'Cut', key: 'Ctrl+X', run: cutSelected, enabled: hasSel },
    { label: 'Copy', key: 'Ctrl+C', run: () => copyBlocks(), enabled: hasSel },
    { label: 'Paste', key: 'Ctrl+V', run: () => pasteBlock(), enabled: canPaste },
    { label: 'Delete', key: 'Del', run: deleteSelection, enabled: hasSelOrConn, danger: true },
    { label: 'Select All', key: 'Ctrl+A', run: selectAll, enabled: hasBlocks },
    'sep',
    { label: 'Rotate Counterclockwise', key: '←', run: () => rotateSelected(-90), enabled: hasSel },
    { label: 'Rotate Clockwise', key: '→', run: () => rotateSelected(90), enabled: hasSel },
    { label: 'Align', sub: [
      { label: 'Vertical Align Top', key: 'Shift+T', run: () => alignSelected('top') },
      { label: 'Vertical Align Middle', key: 'Shift+M', run: () => alignSelected('middle') },
      { label: 'Vertical Align Bottom', key: 'Shift+B', run: () => alignSelected('bottom') },
      'sep',
      { label: 'Horizontal Align Left', key: 'Shift+L', run: () => alignSelected('left') },
      { label: 'Horizontal Align Center', key: 'Shift+C', run: () => alignSelected('center') },
      { label: 'Horizontal Align Right', key: 'Shift+R', run: () => alignSelected('right') },
    ] },
    { label: 'Auto-Arrange Blocks', run: autoArrangeBlocks, enabled: hasBlocks },
    'sep',
    { label: 'Enable', key: 'E', run: () => setSelectedEnabled(true), enabled: hasSel },
    { label: 'Disable', key: 'D', run: () => setSelectedEnabled(false), enabled: hasSel },
    { label: 'Bypass', key: 'B', run: bypassSelected, enabled: hasSel },
    'sep',
    { label: 'Properties', key: 'Return', run: openPropsForSelected, enabled: () => !!selected },
  ] },
  { label: 'View', items: [
    { label: 'Show Block Tree Panel', key: 'Ctrl+B', run: togglePalette,
      check: () => !el('app').classList.contains('hide-palette') },
    'sep',
    { label: 'Show Console Panel', key: 'Ctrl+R', run: toggleConsole,
      check: () => !el('workspace').classList.contains('console-hidden') },
    { label: 'Console Scroll Lock', run: toggleScrollLock, check: () => !autoScrollLog },
    { label: 'Save Console', key: 'Ctrl+Shift+P', run: saveConsole },
    { label: 'Clear Console', key: 'Ctrl+L', run: clearConsole },
    'sep',
    { label: 'Show Variable Editor', key: 'Ctrl+E', run: showVariableEditor },
    { label: 'Show parameter expressions in block', reason: R_TODO },
    { label: 'Show parameter value in block', reason: R_TODO },
    'sep',
    { label: 'Hide Variables', reason: R_TODO },
    { label: 'Hide Disabled Blocks', key: 'Ctrl+D', run: toggleHideDisabled, check: () => hideDisabled },
    { label: 'Auto-Hide Port Labels', reason: R_TODO },
    { label: 'Snap to Grid', run: toggleSnapToGrid, check: () => snapToGrid },
    { label: 'Show Block Comments', reason: R_TODO },
    { label: 'Show All Block IDs', reason: R_TODO },
    { label: 'Show Properties Field Colors', reason: R_TODO },
    'sep',
    { label: 'Zoom In', key: 'Ctrl++', run: () => setZoom(zoom * 1.15) },
    { label: 'Zoom Out', key: 'Ctrl+-', run: () => setZoom(zoom / 1.15) },
    { label: 'Reset Zoom', key: 'Ctrl+0', run: () => setZoom(1) },
    'sep',
    { label: 'Flowgraph Errors', run: showErrorsDialog },
  ] },
  { label: 'Run', items: [
    { label: 'Execute', key: 'F6', run: run },
    { label: 'Kill', key: 'F7', run: stop },
  ] },
  { label: 'Help', items: [
    { label: 'Help', key: 'F1', run: () => openLink('https://wiki.gnuradio.org/index.php/Main_Page') },
    { label: 'Types', run: showTypesDialog },
    { label: 'Keyboard Shortcuts', key: 'Ctrl+K', run: showShortcutHelp },
    { label: 'WebAssembly Modules & Debug Info…',
      run: () => showDebugInfo({ openDialog, library: () => LIB, blocksUrl: BLOCKS_URL, loadedModules }) },
    { label: 'Parser Errors', reason: R_XML },
    'sep',
    { label: 'Get Involved', run: () => openLink('https://www.gnuradio.org/get-involved/') },
    { label: 'About', run: showAboutDialog },
  ] },
];

function buildMenuDrop(items: (MenuItem | 'sep')[], submenu = false): HTMLElement {
  const drop = document.createElement('div');
  drop.className = 'menu-drop' + (submenu ? ' submenu' : '');
  drop.setAttribute('role', 'menu');
  for (const it of items) {
    if (it === 'sep') { drop.appendChild(Object.assign(document.createElement('div'), { className: 'menu-sep' })); continue; }
    const row = document.createElement('div');
    row.className = 'menuitem' + (it.danger ? ' danger' : '');
    row.setAttribute('role', 'menuitem');
    const check = document.createElement('span'); check.className = 'mi-check';
    check.textContent = it.check && it.check() ? '✓' : '';
    const label = document.createElement('span'); label.className = 'mi-label'; label.textContent = it.label;
    row.append(check, label);
    if (it.sub) {
      row.classList.add('has-sub');
      const arrow = document.createElement('span'); arrow.className = 'mi-arrow'; arrow.textContent = '▸';
      row.appendChild(arrow);
      row.appendChild(buildMenuDrop(it.sub, true));
    } else {
      const key = document.createElement('span'); key.className = 'mi-key'; key.textContent = it.key || '';
      row.appendChild(key);
      if (it.reason) { row.classList.add('disabled'); attachTip(row, it.reason); }
      else if (it.enabled && !it.enabled()) { row.classList.add('disabled'); }
      else row.addEventListener('click', e => { e.stopPropagation(); closeMenus(); it.run && it.run(); });
    }
    drop.appendChild(row);
  }
  return drop;
}
function closeMenus() {
  document.querySelectorAll('#menus .menu-top.open').forEach(t => {
    t.classList.remove('open'); t.querySelector('.menu-drop')?.remove();
  });
  hideTip();
}
function openTop(top: HTMLElement, items: (MenuItem | 'sep')[]) {
  closeMenus();
  top.appendChild(buildMenuDrop(items));
  top.classList.add('open');
}
function buildMenuBar() {
  const menus = el('menus'); menus.textContent = '';
  for (const m of MENUS) {
    const top = document.createElement('div'); top.className = 'menu-top';
    top.setAttribute('role', 'menuitem'); top.tabIndex = 0;
    const lbl = document.createElement('span'); lbl.textContent = m.label; top.appendChild(lbl);
    top.addEventListener('click', e => {
      e.stopPropagation();
      if (top.classList.contains('open')) closeMenus(); else openTop(top, m.items);
    });
    top.addEventListener('mouseenter', () => {
      if (menus.querySelector('.menu-top.open') && !top.classList.contains('open')) openTop(top, m.items);
    });
    menus.appendChild(top);
  }
}
document.addEventListener('mousedown', e => {
  if (!(e.target as HTMLElement).closest('#menus')) closeMenus();
});

// ---- icon toolbar (mirrors TOOLBAR_LIST) ----
interface Tool { icon: string; label: string; key?: string; run?: () => void; reason?: string }
const TOOLBAR: (Tool | 'sep')[] = [
  { icon: '📄', label: 'New', key: 'Ctrl+N', run: () => clearFlowgraph() },
  { icon: '📂', label: 'Open', key: 'Ctrl+O', run: openFileDialog },
  { icon: '💾', label: 'Save', key: 'Ctrl+S', run: () => saveFlowgraph() },
  { icon: '✖', label: 'Close', key: 'Ctrl+W', run: () => clearFlowgraph() },
  'sep',
  { icon: '🧮', label: 'Variable Editor', key: 'Ctrl+E', run: showVariableEditor },
  { icon: '📷', label: 'Screen Capture', key: 'Ctrl+P', run: saveScreenshot },
  'sep',
  { icon: '✂', label: 'Cut', key: 'Ctrl+X', run: cutSelected },
  { icon: '⧉', label: 'Copy', key: 'Ctrl+C', run: () => copyBlocks() },
  { icon: '📋', label: 'Paste', key: 'Ctrl+V', run: () => pasteBlock() },
  { icon: '🗑', label: 'Delete', key: 'Del', run: deleteSelection },
  'sep',
  { icon: '↶', label: 'Undo', key: 'Ctrl+Z', run: undo },
  { icon: '↷', label: 'Redo', key: 'Ctrl+Y', run: redo },
  'sep',
  { icon: '⚠', label: 'Flowgraph Errors', run: showErrorsDialog },
  { icon: '▶', label: 'Execute', key: 'F6', run: run },
  { icon: '■', label: 'Kill', key: 'F7', run: stop },
  'sep',
  { icon: '⟲', label: 'Rotate Counterclockwise', key: '←', run: () => rotateSelected(-90) },
  { icon: '⟳', label: 'Rotate Clockwise', key: '→', run: () => rotateSelected(90) },
  'sep',
  { icon: '🔌', label: 'Enable', key: 'E', run: () => setSelectedEnabled(true) },
  { icon: '⭘', label: 'Disable', key: 'D', run: () => setSelectedEnabled(false) },
  { icon: '⤳', label: 'Bypass', key: 'B', run: bypassSelected },
  { icon: '👁', label: 'Hide Disabled Blocks', key: 'Ctrl+D', run: toggleHideDisabled },
  'sep',
  { icon: '↧', label: 'Open Hier', reason: R_HIER },
];
function buildToolbar() {
  const bar = el('toolbar'); bar.textContent = '';
  for (const t of TOOLBAR) {
    if (t === 'sep') { bar.appendChild(Object.assign(document.createElement('div'), { className: 'tsep' })); continue; }
    const b = document.createElement('button'); b.className = 'tbtn'; b.textContent = t.icon;
    b.setAttribute('aria-label', t.label);
    if (t.reason) { b.classList.add('disabled'); b.setAttribute('aria-disabled', 'true'); attachTip(b, t.reason); }
    else { b.title = t.label + (t.key ? ` (${t.key})` : ''); b.onclick = () => t.run && t.run(); }
    bar.appendChild(b);
  }
}

buildMenuBar();
buildToolbar();
el('btnStop').addEventListener('click', stop);
(el('fileOpen') as HTMLInputElement).addEventListener('change', async event => {
  const input = event.currentTarget as HTMLInputElement, file = input.files?.[0]; if (!file) return;
  try { loadFlowgraph(parseGrc(await file.text())); setExampleHash(null); setCurrentFileName(file.name); }
  catch (error) { log('could not open flowgraph: ' + error); }
  input.value = '';
});

const paletteReady = buildPalette();
ensureOptionsBlock();
select(null); render();
log('Editor ready. Click ▶ Run to execute the flowgraph in WebAssembly.');
// A flowgraph named by the URL fragment wins over the default example.
// Returns whether the fragment claimed the canvas.
async function loadFlowgraphFromUrl(): Promise<boolean> {
  const hash = new URLSearchParams(location.hash.slice(1));
  const cleanUrl = () => history.replaceState(null, '', location.href.split('#')[0]);
  const token = hash.get('duplicate');
  if (token) {
    try {
      const saved = localStorage.getItem(token); if (!saved) throw new Error('duplicate data is no longer available');
      localStorage.removeItem(token); loadFlowgraph(parseGrc(saved)); resetHistory();
      cleanUrl();
      return true;
    } catch (error) { log('could not duplicate flowgraph: ' + error); }
    return false;
  }
  // #example=<path> opens a .grc anywhere below example_flowgraphs/. The
  // fragment is deliberately left in place: it is short, and keeping it makes
  // the link bookmarkable and reloadable.
  const example = hash.get('example');
  if (example) {
    try { await loadExampleByName(example); return true; }
    catch (error) { log(`could not load example "${example}" from link: ${error}`); }
    return false;
  }
  const fg = hash.get('fg');
  if (!fg) return false;
  try {
    loadFlowgraph(parseGrc(await gunzip(base64UrlToBytes(fg)))); resetHistory();
    log('loaded flowgraph from URL');
    cleanUrl();
    return true;
  } catch (error) { log('could not load flowgraph from URL: ' + error); }
  return false;
}

paletteReady.then(async () => {
  if (!await loadFlowgraphFromUrl()) {
    try { await loadExampleByName('digital/psk_constellation.grc'); }
    catch (error) { log(`could not load default example "digital/psk_constellation.grc": ${error}`); }
  }
  historyReady = true; resetHistory();
});
