// GNU Radio WebAssembly Flowgraph Editor (TypeScript).
// Loads the block library, lets you place/connect/configure blocks on an SVG
// canvas, and Runs the flowgraph by handing JSON to the C++/WASM runner via a
// URL hash (runner.html#<encoded json>).

type ParamType = 'number' | 'string' | 'enum';
interface ParamDef { id: string; label: string; type: ParamType; def: any; options?: string[]; category?: string }
// inTypes/outTypes give per-port dtypes (for converters); otherwise ports follow the
// block's `type` param (complex/float) if it has one, else `dtype` (default complex).
interface RunnableDef {
  label: string; inputs: number; outputs: number; params: ParamDef[];
  dtype?: string; inTypes?: string[]; outTypes?: string[];
  inDomains?: string[]; outDomains?: string[]; inIds?: string[]; outIds?: string[];
  inStreamIndices?: number[]; outStreamIndices?: number[];
}

// GRC dtype -> port colour (from grc/core/Constants.py).
const DTYPE_COLOR: Record<string, string> = {
  complex: '#2196F3', float: '#F57C00', int: '#009688',
  short: '#FFEB3B', byte: '#D500F9', message: '#BDBDBD', '': '#ffffff',
};

// A "type" selector shared by the type-parameterized blocks (like GRC's io-type param).
const TYPE_PARAM: ParamDef = { id: 'type', label: 'Type', type: 'enum', def: 'complex', options: ['complex', 'float'] };
const INTEGER_TYPE_PARAM: ParamDef = { id: 'type', label: 'Type', type: 'enum', def: 'byte', options: ['byte', 'short', 'int'] };
const STREAM_TYPE_PARAM: ParamDef = { id: 'type', label: 'Type', type: 'enum', def: 'complex', options: ['complex', 'float', 'int', 'short', 'byte'] };
const BOOL_OPTIONS = ['true', 'false'];
const TRIGGER_MODES = ['free', 'auto', 'normal', 'tag'];
const LINE_COLORS = ['blue', 'red', 'green', 'black', 'cyan', 'magenta', 'yellow', 'dark red', 'dark green', 'dark blue'];
const LINE_STYLES = ['1', '2', '3', '4', '5', '0'];
const LINE_MARKERS = ['0', '1', '2', '3', '4', '6', '7', '8', '9', '-1'];

// Curated schemas for blocks the WASM runner registry supports. Param names (and the
// `type` values complex/float) match the runner's factories exactly.
const RUNNABLE: Record<string, RunnableDef> = {
  // ---- sources ----
  analog_sig_source_x: {
    label: 'Signal Source', inputs: 0, outputs: 1, params: [
      TYPE_PARAM,
      { id: 'samp_rate', label: 'Sample Rate', type: 'number', def: 32000 },
      { id: 'waveform', label: 'Waveform', type: 'enum', def: 'cos', options: ['cos', 'sin', 'square', 'triangle', 'saw'] },
      { id: 'frequency', label: 'Frequency', type: 'number', def: 2000 },
      { id: 'amplitude', label: 'Amplitude', type: 'number', def: 1.0 },
    ],
  },
  analog_noise_source_x: {
    label: 'Noise Source', inputs: 0, outputs: 1, params: [
      TYPE_PARAM,
      { id: 'amplitude', label: 'Amplitude', type: 'number', def: 1.0 },
      { id: 'seed', label: 'Seed', type: 'number', def: 0 }] },
  analog_random_source_x: {
    label: 'Random Source', inputs: 0, outputs: 1, params: [
      INTEGER_TYPE_PARAM,
      { id: 'min', label: 'Minimum', type: 'number', def: 0 },
      { id: 'max', label: 'Maximum', type: 'number', def: 2 },
      { id: 'num_samps', label: 'Num Samples', type: 'number', def: 1000 },
      { id: 'repeat', label: 'Repeat', type: 'enum', def: 'true', options: ['true', 'false'] },
    ],
  },
  analog_random_uniform_source_x: {
    label: 'Random Uniform Source', inputs: 0, outputs: 1, params: [
      INTEGER_TYPE_PARAM,
      { id: 'minimum', label: 'Minimum', type: 'number', def: 0 },
      { id: 'maximum', label: 'Maximum', type: 'number', def: 2 },
      { id: 'seed', label: 'Seed', type: 'number', def: 0 },
    ],
  },
  analog_const_source_x: {
    label: 'Constant Source', inputs: 0, outputs: 1, params: [
      { id: 'type', label: 'Type', type: 'enum', def: 'complex', options: ['complex', 'float', 'int', 'short', 'byte'] },
      { id: 'const', label: 'Constant', type: 'string', def: '0' },
    ],
  },
  blocks_null_source: { label: 'Null Source', inputs: 0, outputs: 1, params: [STREAM_TYPE_PARAM] },
  digital_psk_mod: {
    label: 'PSK Mod', inputs: 1, outputs: 1, params: [
      { id: 'constellation_points', label: 'Constellation Points', type: 'number', def: 8 },
      { id: 'mod_code', label: 'Gray Code', type: 'enum', def: 'gray', options: ['gray', 'none'] },
      { id: 'differential', label: 'Differential', type: 'enum', def: 'true', options: ['true', 'false'] },
      { id: 'samples_per_symbol', label: 'Samples/Symbol', type: 'number', def: 2 },
      { id: 'excess_bw', label: 'Excess BW', type: 'number', def: 0.35 },
    ],
    inTypes: ['byte'], outTypes: ['complex'],
  },
  // ---- flow control ----
  blocks_throttle: {
    label: 'Throttle', inputs: 1, outputs: 1, params: [
      STREAM_TYPE_PARAM,
      { id: 'samp_rate', label: 'Sample Rate', type: 'number', def: 32000 }] },
  blocks_head: {
    label: 'Head', inputs: 1, outputs: 1, params: [
      STREAM_TYPE_PARAM,
      { id: 'num_items', label: 'Num Items', type: 'number', def: 10000000 }] },
  blocks_delay: {
    label: 'Delay', inputs: 1, outputs: 1, params: [
      STREAM_TYPE_PARAM,
      { id: 'delay', label: 'Delay (items)', type: 'number', def: 0 }] },
  // ---- math (type-parameterized: complex or float) ----
  blocks_add_xx: { label: 'Add', inputs: 2, outputs: 1, params: [TYPE_PARAM] },
  blocks_sub_xx: { label: 'Subtract', inputs: 2, outputs: 1, params: [TYPE_PARAM] },
  blocks_multiply_xx: { label: 'Multiply', inputs: 2, outputs: 1, params: [TYPE_PARAM] },
  blocks_divide_xx: { label: 'Divide', inputs: 2, outputs: 1, params: [TYPE_PARAM] },
  blocks_multiply_const_xx: {
    label: 'Multiply Const', inputs: 1, outputs: 1, params: [
      TYPE_PARAM,
      { id: 'constant', label: 'Constant', type: 'number', def: 1.0 }] },
  blocks_conjugate_cc: { label: 'Conjugate', inputs: 1, outputs: 1, params: [], dtype: 'complex' },
  // ---- type converters (per-port dtypes) ----
  blocks_complex_to_mag: { label: 'Complex to Mag', inputs: 1, outputs: 1, params: [],
    inTypes: ['complex'], outTypes: ['float'] },
  blocks_complex_to_mag_squared: { label: 'Complex to Mag^2', inputs: 1, outputs: 1, params: [],
    inTypes: ['complex'], outTypes: ['float'] },
  blocks_complex_to_float: { label: 'Complex to Float', inputs: 1, outputs: 2, params: [],
    inTypes: ['complex'], outTypes: ['float', 'float'] },
  blocks_float_to_complex: { label: 'Float to Complex', inputs: 2, outputs: 1, params: [],
    inTypes: ['float', 'float'], outTypes: ['complex'] },
  // ---- variables / controls ----
  variable_qtgui_range: {
    label: 'QT GUI Range', inputs: 0, outputs: 0, params: [
      { id: 'label', label: 'Label', type: 'string', def: '' },
      { id: 'rangeType', label: 'Type', type: 'enum', def: 'float', options: ['float', 'int'] },
      { id: 'value', label: 'Default Value', type: 'number', def: 50 },
      { id: 'start', label: 'Start', type: 'number', def: 0 },
      { id: 'stop', label: 'Stop', type: 'number', def: 100 },
      { id: 'step', label: 'Step', type: 'number', def: 1 },
      { id: 'widget', label: 'Widget', type: 'enum', def: 'counter_slider',
        options: ['counter_slider', 'counter', 'slider', 'dial', 'eng_slider', 'eng'] },
      { id: 'orient', label: 'Orientation', type: 'enum', def: 'horizontal',
        options: ['horizontal', 'vertical'] },
      { id: 'min_len', label: 'Minimum Length', type: 'number', def: 200 },
    ],
  },
  // ---- sinks ----
  blocks_null_sink: { label: 'Null Sink', inputs: 1, outputs: 0, params: [STREAM_TYPE_PARAM] },
  qtgui_time_sink_x: {
    label: 'QT GUI Time Sink', inputs: 1, outputs: 0, params: [
      TYPE_PARAM,
      { id: 'name', label: 'Title', type: 'string', def: 'Scope' },
      { id: 'size', label: 'Num Points', type: 'number', def: 1024 },
      { id: 'samp_rate', label: 'Sample Rate', type: 'number', def: 32000 },
      { id: 'ylabel', label: 'Y Axis Label', type: 'string', def: 'Amplitude', category: 'General' },
      { id: 'yunit', label: 'Y Axis Unit', type: 'string', def: '', category: 'General' },
      { id: 'grid', label: 'Grid', type: 'enum', def: 'false', options: BOOL_OPTIONS, category: 'General' },
      { id: 'autoscale', label: 'Autoscale', type: 'enum', def: 'false', options: BOOL_OPTIONS, category: 'General' },
      { id: 'ymin', label: 'Y min', type: 'number', def: -1, category: 'General' },
      { id: 'ymax', label: 'Y max', type: 'number', def: 1, category: 'General' },
      { id: 'update_time', label: 'Update Period', type: 'number', def: 0.1, category: 'General' },
      { id: 'tr_mode', label: 'Trigger Mode', type: 'enum', def: 'free', options: TRIGGER_MODES, category: 'Trigger' },
      { id: 'tr_slope', label: 'Trigger Slope', type: 'enum', def: 'positive', options: ['positive', 'negative'], category: 'Trigger' },
      { id: 'tr_level', label: 'Trigger Level', type: 'number', def: 0, category: 'Trigger' },
      { id: 'tr_delay', label: 'Trigger Delay', type: 'number', def: 0, category: 'Trigger' },
      { id: 'tr_chan', label: 'Trigger Channel', type: 'number', def: 0, category: 'Trigger' },
      { id: 'tr_tag', label: 'Trigger Tag Key', type: 'string', def: '', category: 'Trigger' },
      { id: 'ctrlpanel', label: 'Control Panel', type: 'enum', def: 'false', options: BOOL_OPTIONS, category: 'Config' },
      { id: 'legend', label: 'Legend', type: 'enum', def: 'true', options: BOOL_OPTIONS, category: 'Config' },
      { id: 'axislabels', label: 'Axis Labels', type: 'enum', def: 'true', options: BOOL_OPTIONS, category: 'Config' },
      { id: 'stemplot', label: 'Stem Plot', type: 'enum', def: 'false', options: BOOL_OPTIONS, category: 'Config' },
      { id: 'label1', label: 'Line 1 Label', type: 'string', def: 'Signal 1', category: 'Config' },
      { id: 'width1', label: 'Line 1 Width', type: 'number', def: 1, category: 'Config' },
      { id: 'color1', label: 'Line 1 Color', type: 'enum', def: 'blue', options: LINE_COLORS, category: 'Config' },
      { id: 'style1', label: 'Line 1 Style', type: 'enum', def: '1', options: LINE_STYLES, category: 'Config' },
      { id: 'marker1', label: 'Line 1 Marker', type: 'enum', def: '0', options: LINE_MARKERS, category: 'Config' },
      { id: 'alpha1', label: 'Line 1 Alpha', type: 'number', def: 1, category: 'Config' },
    ] },
  qtgui_freq_sink_x: {
    label: 'QT GUI Frequency Sink', inputs: 1, outputs: 0, params: [
      { id: 'name', label: 'Title', type: 'string', def: 'Spectrum' },
      { id: 'fftsize', label: 'FFT Size', type: 'number', def: 1024 },
      { id: 'samp_rate', label: 'Sample Rate', type: 'number', def: 32000 },
      { id: 'fc', label: 'Center Frequency', type: 'number', def: 0 },
      { id: 'grid', label: 'Grid', type: 'enum', def: 'false', options: BOOL_OPTIONS, category: 'General' },
      { id: 'autoscale', label: 'Autoscale', type: 'enum', def: 'false', options: BOOL_OPTIONS, category: 'General' },
      { id: 'ymin', label: 'Y min', type: 'number', def: -140, category: 'General' },
      { id: 'ymax', label: 'Y max', type: 'number', def: 10, category: 'General' },
      { id: 'update_time', label: 'Update Period', type: 'number', def: 0.1, category: 'General' },
      { id: 'tr_mode', label: 'Trigger Mode', type: 'enum', def: 'free', options: TRIGGER_MODES, category: 'Trigger' },
      { id: 'tr_level', label: 'Trigger Level', type: 'number', def: 0, category: 'Trigger' },
      { id: 'tr_chan', label: 'Trigger Channel', type: 'number', def: 0, category: 'Trigger' },
      { id: 'tr_tag', label: 'Trigger Tag Key', type: 'string', def: '', category: 'Trigger' },
      { id: 'ctrlpanel', label: 'Control Panel', type: 'enum', def: 'false', options: BOOL_OPTIONS, category: 'Config' },
      { id: 'legend', label: 'Legend', type: 'enum', def: 'true', options: BOOL_OPTIONS, category: 'Config' },
      { id: 'axislabels', label: 'Axis Labels', type: 'enum', def: 'true', options: BOOL_OPTIONS, category: 'Config' },
      { id: 'label1', label: 'Line 1 Label', type: 'string', def: '', category: 'Config' },
      { id: 'width1', label: 'Line 1 Width', type: 'number', def: 1, category: 'Config' },
      { id: 'color1', label: 'Line 1 Color', type: 'enum', def: 'blue', options: LINE_COLORS, category: 'Config' },
      { id: 'style1', label: 'Line 1 Style', type: 'enum', def: '1', options: LINE_STYLES, category: 'Config' },
      { id: 'marker1', label: 'Line 1 Marker', type: 'enum', def: '-1', options: LINE_MARKERS, category: 'Config' },
      { id: 'alpha1', label: 'Line 1 Alpha', type: 'number', def: 1, category: 'Config' },
    ], dtype: 'complex' },
  qtgui_const_sink_x: {
    label: 'QT GUI Constellation Sink', inputs: 1, outputs: 0, params: [
      { id: 'name', label: 'Title', type: 'string', def: 'Constellation' },
      { id: 'size', label: 'Num Points', type: 'number', def: 1024 },
      { id: 'update_time', label: 'Update Period', type: 'number', def: 0.1 },
      { id: 'autoscale', label: 'Autoscale', type: 'enum', def: 'false', options: ['true', 'false'] },
      { id: 'grid', label: 'Grid', type: 'enum', def: 'false', options: ['true', 'false'] },
      { id: 'xmin', label: 'X min', type: 'number', def: -2 },
      { id: 'xmax', label: 'X max', type: 'number', def: 2 },
      { id: 'ymin', label: 'Y min', type: 'number', def: -2 },
      { id: 'ymax', label: 'Y max', type: 'number', def: 2 },
      { id: 'tr_mode', label: 'Trigger Mode', type: 'enum', def: 'free', options: TRIGGER_MODES, category: 'Trigger' },
      { id: 'tr_slope', label: 'Trigger Slope', type: 'enum', def: 'positive', options: ['positive', 'negative'], category: 'Trigger' },
      { id: 'tr_level', label: 'Trigger Level', type: 'number', def: 0, category: 'Trigger' },
      { id: 'tr_chan', label: 'Trigger Channel', type: 'number', def: 0, category: 'Trigger' },
      { id: 'tr_tag', label: 'Trigger Tag Key', type: 'string', def: '', category: 'Trigger' },
      { id: 'legend', label: 'Legend', type: 'enum', def: 'true', options: BOOL_OPTIONS, category: 'Config' },
      { id: 'axislabels', label: 'Axis Labels', type: 'enum', def: 'true', options: BOOL_OPTIONS, category: 'Config' },
      { id: 'label1', label: 'Line 1 Label', type: 'string', def: '', category: 'Config' },
      { id: 'width1', label: 'Line 1 Width', type: 'number', def: 1, category: 'Config' },
      { id: 'color1', label: 'Line 1 Color', type: 'enum', def: 'blue', options: LINE_COLORS, category: 'Config' },
      { id: 'style1', label: 'Line 1 Style', type: 'enum', def: '1', options: LINE_STYLES, category: 'Config' },
      { id: 'marker1', label: 'Line 1 Marker', type: 'enum', def: '0', options: LINE_MARKERS, category: 'Config' },
      { id: 'alpha1', label: 'Line 1 Alpha', type: 'number', def: 1, category: 'Config' },
    ], dtype: 'complex' },
};

interface Inst { uid: string; id: string; name: string; x: number; y: number; params: Record<string, any>; enabled: boolean; rotation: number; bypassed: boolean }
interface Conn { from: string; fp: number; to: string; tp: number }
interface ValidationIssue {
  uid: string;
  field: string;
  message: string;
  blocking: boolean;
  connection?: Conn;
}

const SVGNS = 'http://www.w3.org/2000/svg';
const el = (id: string) => document.getElementById(id)!;
const nodesG = el('nodes'), wiresG = el('wires'), svg = el('svg') as unknown as SVGSVGElement;

let insts: Inst[] = [];
let conns: Conn[] = [];
let selected: string | null = null;
let selectedBlocks = new Set<string>();
let selectedConnection: Conn | null = null;
let counter = 0;
let pending: { uid: string; port: number } | null = null;  // in-progress connection from an output
let autoScrollLog = true;
let zoom = 1;
let hideDisabled = false;
let paletteSearch: HTMLInputElement | null = null;

interface GraphSnapshot { insts: Inst[]; conns: Conn[]; counter: number }
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
  selected = null; selectedBlocks.clear(); selectedConnection = null; pending = null;
  renderProps(); render();
}
function undo() { restoreHistory(historyIndex - 1); }
function redo() { restoreHistory(historyIndex + 1); }

function log(s: string) {
  const l = el('log'); l.textContent += s + '\n';
  if (autoScrollLog) l.scrollTop = l.scrollHeight;
}

// GRC-style geometry: title bar + "Label: value" parameter rows, typed ports.
const TITLE_H = 22, ROW_H = 15, PAD = 6, PORT_W = 8, PORT_H = 13, PORT_GAP = 8;
// A port's dtype: explicit per-port (converters), else the block's `type` param
// (complex/float), else its fixed `dtype`, else complex.
function portType(inst: Inst, kind: 'in' | 'out', i: number): string {
  const d = RUNNABLE[inst.id];
  const arr = kind === 'in' ? d.inTypes : d.outTypes;
  if (arr && arr[i]) {
    const match = arr[i].match(/^\$([A-Za-z_]\w*)$/);
    return match ? String(inst.params[match[1]] || '') : arr[i];
  }
  return inst.params.type || d.dtype || 'complex';
}
const portColor = (inst: Inst, kind: 'in' | 'out', i: number) =>
  DTYPE_COLOR[portType(inst, kind, i)] || '#2196F3';

function fmtVal(v: any): string {
  if (typeof v === 'number' && Number.isInteger(v) && Math.abs(v) >= 1000) {
    if (v % 1000000 === 0) return v / 1000000 + 'M';
    if (v % 1000 === 0) return v / 1000 + 'k';
  }
  return String(v);
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

// Numeric GRC fields may also contain a variable ID (for example a signal
// source's frequency can be `freq`, the ID of a QT GUI Range).
function numericOrExpression(value: string): number | string {
  const text = value.trim();
  if (!text) return '';
  const number = Number(text);
  return Number.isFinite(number) ? number : text;
}

const NAME_FIELD = '__name';
const BLOCK_FIELD = '__block';

function validateGraph(blocks: Inst[] = insts, connections: Conn[] = conns): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const active = (block: Inst) => block.enabled && !block.bypassed;
  const activeNames = new Map<string, number>();
  for (const block of blocks.filter(active)) {
    const name = String(block.name || '').trim();
    activeNames.set(name, (activeNames.get(name) || 0) + 1);
  }
  const activeRanges = new Set(blocks
    .filter(block => active(block) && block.id === 'variable_qtgui_range' &&
      activeNames.get(String(block.name || '').trim()) === 1)
    .map(block => String(block.name || '').trim()));

  const add = (block: Inst, field: string, message: string, connection?: Conn) => {
    if (!issues.some(issue => issue.uid === block.uid && issue.field === field &&
      issue.message === message && issue.connection === connection))
      issues.push({ uid: block.uid, field, message, blocking: active(block), connection });
  };
  const finiteNumber = (value: any) => {
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value !== 'string' || !value.trim()) return false;
    return Number.isFinite(Number(value.trim()));
  };

  for (const block of blocks) {
    const def = RUNNABLE[block.id];
    if (!def) { add(block, BLOCK_FIELD, `Unknown block type "${block.id}".`); continue; }
    const name = String(block.name || '').trim();
    if (!name) add(block, NAME_FIELD, 'Block ID is required.');
    else if (active(block) && (activeNames.get(name) || 0) > 1)
      add(block, NAME_FIELD, `Block ID "${name}" is used more than once.`);

    for (const param of def.params) {
      const value = block.params?.[param.id];
      if (param.type === 'number') {
        const rangeReference = block.id !== 'variable_qtgui_range' && typeof value === 'string' &&
          activeRanges.has(value.trim());
        if (!finiteNumber(value) && !rangeReference)
          add(block, param.id, `${param.label} must be a finite number or a QT GUI Range ID.`);
      } else if (param.type === 'enum' && param.options?.length && !param.options.includes(String(value))) {
        add(block, param.id, `${param.label} has unsupported value "${String(value)}".`);
      }
    }

    // Mirror the constraints enforced by the C++ Range widget constructor.
    if (block.id === 'variable_qtgui_range') {
      const start = Number(block.params.start), stop = Number(block.params.stop);
      const step = Number(block.params.step), minLength = Number(block.params.min_len);
      if (Number.isFinite(start) && Number.isFinite(stop) && start > stop)
        add(block, 'stop', 'Range Stop must be greater than or equal to Start.');
      if (Number.isFinite(step) && step <= 0) add(block, 'step', 'Range Step must be greater than zero.');
      if (Number.isFinite(minLength) && minLength < 1)
        add(block, 'min_len', 'Minimum Length must be at least 1.');
    }
  }

  const byUid = new Map(blocks.map(block => [block.uid, block]));
  const occupiedInputs = new Map<string, Conn>();
  for (const connection of connections) {
    const source = byUid.get(connection.from), sink = byUid.get(connection.to);
    if (!source && !sink) continue;
    if (!source) { add(sink!, BLOCK_FIELD, 'Connection refers to a missing source block.', connection); continue; }
    if (!sink) { add(source, BLOCK_FIELD, 'Connection refers to a missing destination block.', connection); continue; }
    if (!active(source) || !active(sink)) continue;
    const sourceDef = RUNNABLE[source.id], sinkDef = RUNNABLE[sink.id];
    if (!sourceDef || !sinkDef) continue;
    if (!Number.isInteger(connection.fp) || connection.fp < 0 || connection.fp >= portCount(source, 'out')) {
      add(source, BLOCK_FIELD, `Connection uses invalid output port ${connection.fp}.`, connection); continue;
    }
    if (!Number.isInteger(connection.tp) || connection.tp < 0 || connection.tp >= portCount(sink, 'in')) {
      add(sink, BLOCK_FIELD, `Connection uses invalid input port ${connection.tp}.`, connection); continue;
    }
    const inputKey = `${sink.uid}:${connection.tp}`;
    if (occupiedInputs.has(inputKey))
      add(sink, BLOCK_FIELD, `Input port ${connection.tp} has more than one connection.`, connection);
    else occupiedInputs.set(inputKey, connection);

    const sourceDomain = sourceDef.outDomains?.[connection.fp] || 'stream';
    const sinkDomain = sinkDef.inDomains?.[connection.tp] || 'stream';
    if (sourceDomain !== sinkDomain) {
      add(sink, BLOCK_FIELD, `Cannot connect ${sourceDomain} output to ${sinkDomain} input.`, connection);
      continue;
    }
    if (sourceDomain === 'stream') {
      const sourceType = portType(source, 'out', connection.fp);
      const sinkType = portType(sink, 'in', connection.tp);
      if (sourceType && sinkType && sourceType !== sinkType)
        add(sink, BLOCK_FIELD, `Connection type mismatch: ${sourceType} output to ${sinkType} input.`, connection);
    }
  }
  return issues;
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

function generatedDefault(p: any): any {
  const value = (p.dtype === 'enum' && (p.default === undefined || p.default === ''))
    ? (p.options?.[0] ?? '') : (p.default ?? '');
  if (['int', 'real', 'float', 'hex'].includes(String(p.dtype)))
    return numericOrExpression(String(value));
  return String(value);
}

function multiplicity(value: any, defaults: Record<string, any>): number {
  const text = String(value ?? '1').trim();
  const direct = Number(text);
  if (Number.isFinite(direct)) return Math.max(0, Math.trunc(direct));
  const match = text.match(/^\$\{\s*([A-Za-z_]\w*)\s*\}$/);
  return match ? Math.max(0, Math.trunc(Number(defaults[match[1]]) || 0)) : 1;
}

function installGeneratedBlocks(blocks: any[]) {
  for (const block of blocks) {
    if (!block.runnable) continue;
    if (RUNNABLE[block.id]) continue; // richer custom WASM schema wins
    const params: ParamDef[] = (block.params || []).map((p: any) => ({
      id: String(p.id), label: String(p.label || p.id),
      type: p.dtype === 'enum' ? 'enum' :
        ['int', 'real', 'float', 'hex'].includes(String(p.dtype)) ? 'number' : 'string',
      def: generatedDefault(p),
      options: p.options ? p.options.map(String) : undefined,
      category: p.category || undefined,
    }));
    const defaults: Record<string, any> = {};
    params.forEach(p => defaults[p.id] = p.def);
    const expandPorts = (ports: any[]) => {
      const result: { dtype: string; domain: string; id: string; streamIndex: number }[] = [];
      let streamIndex = 0;
      for (const port of ports || []) {
        const count = multiplicity(port.multiplicity, defaults);
        for (let i = 0; i < count; ++i) {
          const domain = String(port.domain || 'stream');
          const id = String(port.id || (domain === 'stream' ? streamIndex : port.label || i));
          result.push({
            dtype: String(port.dtype || '').replace(/^\$\{\s*([A-Za-z_]\w*)\s*\}$/, '$$$1'),
            domain, id, streamIndex: domain === 'stream' ? streamIndex : -1,
          });
          if (domain === 'stream') ++streamIndex;
        }
      }
      return result;
    };
    const inputs = expandPorts(block.inputs), outputs = expandPorts(block.outputs);
    RUNNABLE[block.id] = {
      label: String(block.label || block.id), params,
      inputs: inputs.length, outputs: outputs.length,
      inTypes: inputs.map(p => p.dtype), outTypes: outputs.map(p => p.dtype),
      inDomains: inputs.map(p => p.domain), outDomains: outputs.map(p => p.domain),
      inIds: inputs.map(p => p.id), outIds: outputs.map(p => p.id),
      inStreamIndices: inputs.map(p => p.streamIndex),
      outStreamIndices: outputs.map(p => p.streamIndex),
    };
  }
}
const textW = (s: string, px: number) => s.length * px * 0.56;
function portCount(inst: Inst, kind: 'in' | 'out'): number {
  const d = RUNNABLE[inst.id];
  const key = kind === 'in'
    ? (d.params.some(p => p.id === 'num_inputs') ? 'num_inputs' :
       d.params.some(p => p.id === 'nconnections') && d.inputs ? 'nconnections' : '')
    : (d.params.some(p => p.id === 'num_outputs') ? 'num_outputs' :
       d.params.some(p => p.id === 'nconnections') && !d.inputs ? 'nconnections' : '');
  if (!key) return kind === 'in' ? d.inputs : d.outputs;
  const value = Number(inst.params[key]);
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : (kind === 'in' ? d.inputs : d.outputs);
}

function geom(inst: Inst) {
  const d = RUNNABLE[inst.id];
  // Categorized parameters belong in the modal notebook, not in the compact
  // block rendering (equivalent to GRC's `hide: part`).
  const rows = d.params.filter(p => !p.category)
    .map(p => ({ id: p.id, l: p.label + ': ', v: fmtVal(inst.params[p.id]) }));
  const nports = Math.max(portCount(inst, 'in'), portCount(inst, 'out'), 1);
  const bodyH = Math.max(rows.length * ROW_H + PAD, nports * (PORT_H + PORT_GAP) + PAD, ROW_H);
  const h = TITLE_H + bodyH;
  let w = textW(d.label, 13);
  for (const r of rows) w = Math.max(w, textW(r.l + r.v, 11));
  w = Math.max(104, Math.ceil(w) + 22);
  return { d, rows, h, w };
}
type Edge = 'L' | 'R' | 'T' | 'B';
// Port position (relative to the block) + which edge it sits on, honouring rotation.
function portPos(inst: Inst, kind: 'in' | 'out', i: number): { x: number; y: number; edge: Edge } {
  const { w, h } = geom(inst);
  const vSlot = TITLE_H + PAD + i * (PORT_H + PORT_GAP) + PORT_H / 2;
  const hSlot = 16 + i * (PORT_H + PORT_GAP) + PORT_H / 2;
  const map: Record<number, { in: Edge; out: Edge }> = {
    0: { in: 'L', out: 'R' }, 90: { in: 'T', out: 'B' },
    180: { in: 'R', out: 'L' }, 270: { in: 'B', out: 'T' },
  };
  const e = map[inst.rotation || 0][kind];
  if (e === 'L') return { x: 0, y: vSlot, edge: e };
  if (e === 'R') return { x: w, y: vSlot, edge: e };
  if (e === 'T') return { x: hSlot, y: 0, edge: e };
  return { x: hSlot, y: h, edge: e };
}
// Bezier control point offset outward from an edge (for nicely-curved wires).
function ctrl(edge: Edge, x: number, y: number, k: number): [number, number] {
  if (edge === 'L') return [x - k, y];
  if (edge === 'R') return [x + k, y];
  if (edge === 'T') return [x, y - k];
  return [x, y + k];
}

function addBlock(id: string, x = 60 + (counter % 5) * 30, y = 60 + (counter % 7) * 24) {
  const d = RUNNABLE[id]; if (!d) { log('block "' + id + '" is not runnable yet'); return; }
  const uid = 'b' + (++counter);
  const params: Record<string, any> = {};
  d.params.forEach(p => params[p.id] = p.def);
  insts.push({ uid, id, name: id.replace(/^.*_/, '') + counter, x, y, params, enabled: true, rotation: 0, bypassed: false });
  select(uid); recordHistory();
}

// ---- block operations (used by the context menu and shortcuts) ----
function deleteBlocks(uids = selectedBlocks) {
  if (!uids.size) return;
  insts = insts.filter(i => !uids.has(i.uid));
  conns = conns.filter(c => !uids.has(c.from) && !uids.has(c.to));
  selectedBlocks.clear(); selected = null; selectedConnection = null;
  renderProps(); render(); recordHistory();
}
function deleteConnection(conn: Conn) {
  conns = conns.filter(c => c !== conn);
  if (selectedConnection === conn) selectedConnection = null;
  renderProps(); render(); recordHistory();
}
function duplicateBlock(uid: string) {
  const s = insts.find(i => i.uid === uid); if (!s) return;
  const nu = 'b' + (++counter);
  insts.push({ uid: nu, id: s.id, name: s.id.replace(/^.*_/, '') + counter,
    x: s.x + 24, y: s.y + 24, params: { ...s.params }, enabled: s.enabled,
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
  const blocks = insts.filter(i => uids.has(i.uid));
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
    return { ...clone(source), uid, name: source.id.replace(/^.*_/, '') + counter,
      x: x + source.x - minX, y: y + source.y - minY };
  });
  insts.push(...added);
  conns.push(...clipboard.connections.map(c => ({ ...c, from: remap.get(c.from)!, to: remap.get(c.to)! })));
  selectedBlocks = new Set(added.map(i => i.uid)); selected = added.length ? added[added.length - 1].uid : null;
  selectedConnection = null; renderProps(); render(); recordHistory();
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
  }
  render(); recordHistory();
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
  if (changed) { renderProps(); render(); recordHistory(); }
}
function changePortCount(delta: number) {
  const candidates = ['nconnections', 'num_inputs', 'num_outputs', 'nports'];
  const blocks = selectedInsts(); let changed = false;
  for (const block of blocks) {
    const key = candidates.find(id => RUNNABLE[block.id].params.some(p => p.id === id));
    if (!key) continue;
    block.params[key] = Math.max(1, Math.trunc(Number(block.params[key]) || 1) + delta); changed = true;
  }
  if (changed) { renderProps(); render(); recordHistory(); }
}
function setZoom(next: number) {
  zoom = Math.max(0.4, Math.min(2.5, next));
  el('canvasWrap').style.setProperty('--grid-size', `${16 * zoom}px`); render();
  log(`zoom ${Math.round(zoom * 100)}%`);
}
function clearFlowgraph(record = true) {
  insts = []; conns = []; counter = 0; selected = null; selectedBlocks.clear();
  selectedConnection = null; pending = null; renderProps(); render();
  if (record) recordHistory();
}

interface EditorFile { format: 'gnuradio-wasm-flowgraph'; version: 1; blocks: Inst[]; connections: Conn[] }
function editorFile(): EditorFile {
  return { format: 'gnuradio-wasm-flowgraph', version: 1, blocks: clone(insts), connections: clone(conns) };
}
function downloadBlob(contents: BlobPart, type: string, filename: string) {
  const url = URL.createObjectURL(new Blob([contents], { type }));
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
function saveFlowgraph(saveAs = false) {
  downloadBlob(JSON.stringify(editorFile(), null, 2), 'application/json', saveAs ? 'flowgraph-as.json' : 'flowgraph.json');
  log(`saved ${insts.length} blocks`);
}
function loadFlowgraph(value: any) {
  if (value?.format === 'gnuradio-wasm-flowgraph' && Array.isArray(value.blocks)) {
    insts = clone(value.blocks); conns = clone(value.connections || []);
    counter = Math.max(0, ...insts.map(i => Number(i.uid.match(/\d+$/)?.[0]) || 0));
  } else if (Array.isArray(value?.blocks)) {
    insts = []; conns = []; counter = 0;
    value.blocks.forEach((b: any, index: number) => {
      const d = RUNNABLE[b.id]; if (!d) return;
      const uid = 'b' + (++counter), params: Record<string, any> = {};
      d.params.forEach(p => params[p.id] = b.params?.[p.id] ?? p.def);
      insts.push({ uid, id: b.id, name: b.name || b.id.replace(/^.*_/, '') + counter,
        x: 60 + (index % 4) * 190, y: 60 + Math.floor(index / 4) * 130,
        params, enabled: true, rotation: 0, bypassed: false });
    });
    const byName = (name: string) => insts.find(i => i.name === name);
    for (const c of value.connections || []) {
      const from = byName(c[0]), to = byName(c[2]);
      if (from && to && c[4] !== 'message') conns.push({ from: from.uid, fp: Number(c[1]), to: to.uid, tp: Number(c[3]) });
    }
  } else throw new Error('not a GNU Radio WASM flowgraph JSON file');
  selected = null; selectedBlocks.clear(); selectedConnection = null; pending = null;
  renderProps(); render(); recordHistory(); log(`opened ${insts.length} blocks`);
}
function duplicateFlowgraph() {
  if (!insts.length) return;
  const token = `grc-duplicate-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    localStorage.setItem(token, JSON.stringify(editorFile()));
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
    name.oninput = () => { variable.name = name.value.replace(/\s+/g, '_'); renderProps(); render(); refreshValidation(); };
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
        renderProps(); render(); refreshValidation();
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
  ['Ctrl+N / O', 'New / open flowgraph'], ['Ctrl+S / Ctrl+Shift+S', 'Save / save as'],
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
  ['Ctrl+F or /', 'Search blocks'], ['G', 'Toggle grid'], ['Ctrl+K or F1', 'Show these shortcuts'],
  ['F5 / F6 / F7', 'Generate / execute / stop'], ['Escape', 'Close dialog or menu'],
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
    closeMenu(); document.querySelector('.modal')?.remove();
    if (document.activeElement === paletteSearch && paletteSearch) {
      paletteSearch.value = ''; paletteSearch.dispatchEvent(new Event('input')); paletteSearch.blur();
    }
    return;
  }
  if (e.key === 'F1' || (ctrl && key === 'k')) { consume(e); showShortcutHelp(); return; }
  if (ctrl && key === 'n') { consume(e); clearFlowgraph(); return; }
  if (ctrl && key === 'o') { consume(e); (el('fileOpen') as HTMLInputElement).click(); return; }
  if (ctrl && key === 's') { consume(e); saveFlowgraph(e.shiftKey); return; }
  if (ctrl && e.shiftKey && key === 'd') { consume(e); duplicateFlowgraph(); return; }
  if (ctrl && e.shiftKey && key === 'p') { consume(e); saveConsole(); return; }
  if (ctrl && key === 'p') { consume(e); saveScreenshot(); return; }
  if (ctrl && key === 'l') { consume(e); el('log').textContent = ''; return; }
  if (ctrl && key === 'w') { consume(e); clearFlowgraph(); return; }
  if (ctrl && key === 'q') { consume(e); stop(); window.close(); return; }
  if (e.key === 'F5') { consume(e); const fg = toFlowgraphJSON(); log(`generated ${fg.blocks.length} blocks, ${fg.connections.length} connections`); return; }
  if (e.key === 'F6') { consume(e); run(); return; }
  if (e.key === 'F7') { consume(e); stop(); return; }
  if (e.key === 'ScrollLock') { consume(e); autoScrollLog = !autoScrollLog; log(`console autoscroll ${autoScrollLog ? 'on' : 'off'}`); return; }
  if (ctrl && (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd')) { consume(e); setZoom(zoom * 1.15); return; }
  if (ctrl && (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract')) { consume(e); setZoom(zoom / 1.15); return; }
  if (ctrl && key === '0') { consume(e); setZoom(1); return; }
  if (ctrl && key === 'd') { consume(e); hideDisabled = !hideDisabled; render(); return; }
  if (ctrl && key === 'e') { consume(e); showVariableEditor(); return; }
  if (ctrl && key === 'r') { consume(e); el('canvasWrap').classList.toggle('console-hidden'); return; }
  if (ctrl && key === 'b') { consume(e); el('app').classList.toggle('hide-palette'); return; }
  if (ctrl && key === 'f') {
    consume(e); el('app').classList.remove('hide-palette'); paletteSearch?.focus(); paletteSearch?.select(); return;
  }

  const active = document.activeElement;
  if (active && ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName)) return;

  if (ctrl && key === 'z') { consume(e); e.shiftKey ? redo() : undo(); }
  else if (ctrl && key === 'y') { consume(e); redo(); }
  else if (ctrl && key === 'a') {
    consume(e); selectedBlocks = new Set(insts.map(i => i.uid)); selected = insts.length ? insts[insts.length - 1].uid : null;
    selectedConnection = null; renderProps(); render();
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
  else if (!ctrl && e.key === '/') {
    consume(e); el('app').classList.remove('hide-palette'); paletteSearch?.focus(); paletteSearch?.select();
  }
  else if (!ctrl && !e.shiftKey && key === 'g') { consume(e); el('canvasWrap').classList.toggle('grid-hidden'); }
});

// ---- block Properties dialog (GRC-style modal) ----
function showPropsDialog(inst: Inst) {
  closeMenu();
  const d = RUNNABLE[inst.id]; if (!d) return;
  const tmp: { name: string; params: Record<string, any> } = { name: inst.name, params: { ...inst.params } };

  const overlay = document.createElement('div'); overlay.className = 'modal props';
  const dlg = document.createElement('div'); dlg.className = 'dlg';
  const head = document.createElement('div'); head.className = 'dlghead'; head.textContent = 'Properties: ' + d.label;
  const tabBar = document.createElement('div'); tabBar.className = 'dlgtabs'; tabBar.setAttribute('role', 'tablist');
  const body = document.createElement('div'); body.className = 'dlgbody';

  const categories = ['General', ...d.params.map(p => p.category || 'General').filter((cat, i, all) => cat !== 'General' && all.indexOf(cat) === i)];
  const panels = new Map<string, HTMLDivElement>();
  const tabs: HTMLButtonElement[] = [];
  const controls = new Map<string, { node: HTMLElement; error: HTMLElement }>();
  let refreshValidation = () => {};
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

  const addField = (category: string, label: string, node: HTMLElement, field: string) => {
    const row = document.createElement('div'); row.className = 'dlgrow';
    const l = document.createElement('label'); l.textContent = label;
    const control = document.createElement('div'); control.className = 'field-control';
    const error = document.createElement('small'); error.className = 'field-error'; error.hidden = true;
    control.append(node, error); row.append(l, control); panels.get(category)!.appendChild(row);
    controls.set(field, { node, error });
    return node;
  };
  const nameI = addField('General', 'ID', document.createElement('input'), NAME_FIELD) as HTMLInputElement;
  nameI.value = tmp.name;
  nameI.oninput = () => { tmp.name = nameI.value.replace(/\s+/g, '_'); refreshValidation(); };
  for (const p of d.params) {
    if (p.type === 'enum') {
      const s = document.createElement('select');
      (p.options || []).forEach(o => { const opt = document.createElement('option'); opt.value = o; opt.textContent = o; s.appendChild(opt); });
      s.value = String(tmp.params[p.id]);
      s.onchange = () => { tmp.params[p.id] = s.value; refreshValidation(); };
      addField(p.category || 'General', `${p.label}  (${p.id})`, s, p.id);
    } else {
      const inp = document.createElement('input'); inp.value = String(tmp.params[p.id]);
      inp.oninput = () => {
        tmp.params[p.id] = p.type === 'number' ? numericOrExpression(inp.value) : inp.value;
        refreshValidation();
      };
      addField(p.category || 'General', `${p.label}  (${p.id})`, inp, p.id);
    }
  }

  refreshValidation = () => {
    const candidate = { ...inst, name: tmp.name, params: tmp.params };
    const issues = validateGraph(insts.map(block => block.uid === inst.uid ? candidate : block));
    controls.forEach((control, field) =>
      setFieldError(control.node, control.error, fieldIssue(issues, inst.uid, field)));
  };

  const foot = document.createElement('div'); foot.className = 'dlgfoot';
  const apply = () => { inst.name = tmp.name; inst.params = { ...tmp.params }; select(inst.uid); recordHistory(); };
  const btn = (label: string, fn: () => void, cls = '') => {
    const b = document.createElement('button'); b.textContent = label; if (cls) b.className = cls; b.onclick = fn; return b;
  };
  foot.appendChild(btn('Cancel', () => overlay.remove()));
  foot.appendChild(btn('Apply', apply));
  foot.appendChild(btn('OK', () => { apply(); overlay.remove(); }, 'run'));

  activateTab('General');
  dlg.append(head, tabBar, body, foot); overlay.appendChild(dlg); document.body.appendChild(overlay);
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) overlay.remove(); });
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
  renderProps(); render();
}

function selectConnection(conn: Conn) {
  // Give keyboard shortcuts back to the canvas if the palette/property editor
  // previously held focus. The SVG path itself is not a focusable element.
  (document.activeElement as HTMLElement | null)?.blur();
  selected = null; selectedBlocks.clear();
  selectedConnection = conn;
  renderProps(); render();
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
  nodesG.textContent = ''; wiresG.textContent = '';
  nodesG.setAttribute('transform', `scale(${zoom})`);
  wiresG.setAttribute('transform', `scale(${zoom})`);
  const validation = validateGraph();
  const invalidConnections = new Set(validation.flatMap(issue => issue.connection ? [issue.connection] : []));
  const G = (uid: string) => insts.find(i => i.uid === uid)!;
  // wires (from output right-edge to input left-edge, GRC-style curves)
  for (const c of conns) {
    const a = G(c.from), b = G(c.to); if (!a || !b || (hideDisabled && (!a.enabled || !b.enabled))) continue;
    const pa = portPos(a, 'out', c.fp), pb = portPos(b, 'in', c.tp);
    const x1 = a.x + pa.x, y1 = a.y + pa.y, x2 = b.x + pb.x, y2 = b.y + pb.y;
    const [c1x, c1y] = ctrl(pa.edge, x1, y1, 42);
    const [c2x, c2y] = ctrl(pb.edge, x2, y2, 42);
    const d = `M${x1},${y1} C${c1x},${c1y} ${c2x},${c2y} ${x2},${y2}`;
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
      pending = null;
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
    // title + underline (GRC draws a rule under the bold title)
    const t = svgEl('text', { class: 'title', x: String(w / 2), y: '15', 'text-anchor': 'middle' });
    t.textContent = d.label; g.appendChild(t);
    g.appendChild(svgEl('line', { x1: '0', y1: String(TITLE_H), x2: String(w), y2: String(TITLE_H),
      stroke: '#000', 'stroke-width': '1' }));
    // parameter rows: "label: value"
    rows.forEach((r, i) => {
      const y = TITLE_H + PAD + i * ROW_H + 11;
      const tx = svgEl('text', { class: 'param' + (fieldIssue(blockIssues, inst.uid, r.id) ? ' invalid' : ''), x: '6', y: String(y) });
      const l = document.createElementNS(SVGNS, 'tspan'); l.textContent = r.l;
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
    for (let i = 0; i < portCount(inst, 'in'); i++) addPort(g, inst, 'in', i, portColor(inst, 'in', i));
    for (let i = 0; i < portCount(inst, 'out'); i++) addPort(g, inst, 'out', i, portColor(inst, 'out', i));
    nodesG.appendChild(g);
  }
}

function addPort(g: SVGGElement, inst: Inst, kind: 'in' | 'out', idx: number, color: string) {
  // GRC ports: small typed rectangles protruding from the block edge (rotation-aware).
  const p = portPos(inst, kind, idx);
  let x: number, y: number, w: number, h: number;
  if (p.edge === 'L') { w = PORT_W; h = PORT_H; x = -PORT_W + 2; y = p.y - PORT_H / 2; }
  else if (p.edge === 'R') { w = PORT_W; h = PORT_H; x = p.x - 2; y = p.y - PORT_H / 2; }
  else if (p.edge === 'T') { w = PORT_H; h = PORT_W; x = p.x - PORT_H / 2; y = -PORT_W + 2; }
  else { w = PORT_H; h = PORT_W; x = p.x - PORT_H / 2; y = p.y - 2; }
  const r = svgEl('rect', { class: 'port', x: String(x), y: String(y),
    width: String(w), height: String(h), fill: color });
  r.addEventListener('mousedown', e => {
    e.stopPropagation();
    if (kind === 'out') { pending = { uid: inst.uid, port: idx }; log('connect from ' + inst.name + ':' + idx + ' …'); }
    else if (pending) {
      if (selectedConnection && selectedConnection.to === inst.uid && selectedConnection.tp === idx) {
        selectedConnection = null;
      }
      conns = conns.filter(cn => !(cn.to === inst.uid && cn.tp === idx));
      conns.push({ from: pending.uid, fp: pending.port, to: inst.uid, tp: idx });
      log('  → ' + G0(pending.uid).name + ':' + pending.port + '  to  ' + inst.name + ':' + idx);
      pending = null; render(); recordHistory();
    }
  });
  g.appendChild(r);
}
const G0 = (uid: string) => insts.find(i => i.uid === uid)!;

let drag: { inst: Inst; ox: number; oy: number; starts: Map<string, { x: number; y: number }>; moved: boolean } | null = null;
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
  if (!drag) return; const p = svgPoint(e);
  const primary = drag.starts.get(drag.inst.uid)!;
  const nx = Math.round(p.x - drag.ox), ny = Math.round(p.y - drag.oy);
  const dx = nx - primary.x, dy = ny - primary.y;
  for (const inst of insts) {
    const start = drag.starts.get(inst.uid); if (!start) continue;
    inst.x = start.x + dx; inst.y = start.y + dy;
  }
  drag.moved ||= dx !== 0 || dy !== 0; render();
});
window.addEventListener('mouseup', () => { if (drag?.moved) recordHistory(); drag = null; });
svg.addEventListener('mousedown', () => { select(null); pending = null; });
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

function renderProps() {
  const body = el('propBody');
  if (selectedConnection) {
    const source = insts.find(i => i.uid === selectedConnection!.from);
    const sink = insts.find(i => i.uid === selectedConnection!.to);
    body.textContent = `${source?.name || selectedConnection.from}:${selectedConnection.fp} \u2192 ` +
      `${sink?.name || selectedConnection.to}:${selectedConnection.tp}\n\nPress Delete to remove this connection.`;
    return;
  }
  if (selectedBlocks.size > 1) {
    body.textContent = `${selectedBlocks.size} blocks selected\n\nUse Shift+T/M/B or Shift+L/C/R to align them.`;
    return;
  }
  if (!selected) { body.textContent = 'Select a block or connection…'; return; }
  const inst = insts.find(i => i.uid === selected)!; const d = RUNNABLE[inst.id];
  body.innerHTML = '';
  const mk = (label: string, node: HTMLElement, field: string) => {
    const l = document.createElement('label'); l.textContent = label;
    const control = document.createElement('div'); control.className = 'field-control';
    const error = document.createElement('small'); error.className = 'field-error'; error.hidden = true;
    control.append(node, error); body.append(l, control);
    const refresh = () => setFieldError(node, error, fieldIssue(validateGraph(), inst.uid, field));
    refresh(); return refresh;
  };
  const nameI = document.createElement('input'); nameI.value = inst.name;
  const refreshName = mk('Block name (id)', nameI, NAME_FIELD);
  nameI.oninput = () => { inst.name = nameI.value.replace(/\s+/g, '_'); refreshName(); render(); };
  nameI.onchange = recordHistory;
  for (const p of d.params.filter(p => !p.category)) {
    let node: HTMLElement;
    if (p.type === 'enum') {
      const s = document.createElement('select');
      (p.options || []).forEach(o => { const opt = document.createElement('option'); opt.value = o; opt.textContent = o; s.appendChild(opt); });
      s.value = String(inst.params[p.id]);
      node = s;
    } else {
      const inp = document.createElement('input'); inp.value = String(inst.params[p.id]);
      node = inp;
    }
    const refresh = mk(p.label + '  (' + p.id + ')', node, p.id);
    if (node instanceof HTMLSelectElement) {
      node.onchange = () => { inst.params[p.id] = node.value; refresh(); render(); recordHistory(); };
    } else if (node instanceof HTMLInputElement) {
      node.oninput = () => {
        inst.params[p.id] = p.type === 'number' ? numericOrExpression(node.value) : node.value;
        refresh(); render();
      };
      node.onchange = recordHistory;
    }
  }
}

function toFlowgraphJSON() {
  const byUid = (u: string) => insts.find(i => i.uid === u)!;
  const active = (u: string) => { const b = byUid(u); return b && b.enabled && !b.bypassed; };
  const bypassed = (u: string) => { const b = byUid(u); return b && b.enabled && b.bypassed; };
  // Resolve a downstream endpoint through bypassed blocks to active endpoints.
  const resolveDown = (uid: string, port: number, seen = new Set<string>()): { uid: string; port: number }[] => {
    if (active(uid)) return [{ uid, port }];
    if (!bypassed(uid) || seen.has(uid)) return [];
    seen.add(uid);
    return conns.filter(c => c.from === uid).flatMap(c => resolveDown(c.to, c.tp, seen));
  };
  const out: any[] = []; const seen = new Set<string>();
  for (const c of conns) {
    if (!active(c.from)) continue;               // start from active sources
    for (const d of resolveDown(c.to, c.tp)) {   // hop over any bypassed blocks
      const key = `${c.from}:${c.fp}>${d.uid}:${d.port}`;
      if (seen.has(key)) continue; seen.add(key);
      const sourceDef = RUNNABLE[byUid(c.from).id], sinkDef = RUNNABLE[byUid(d.uid).id];
      const message = sourceDef.outDomains?.[c.fp] === 'message' || sinkDef.inDomains?.[d.port] === 'message';
      out.push(message
        ? [byUid(c.from).name, sourceDef.outIds?.[c.fp] || String(c.fp),
           byUid(d.uid).name, sinkDef.inIds?.[d.port] || String(d.port), 'message']
        : [byUid(c.from).name, sourceDef.outStreamIndices?.[c.fp] ?? c.fp,
           byUid(d.uid).name, sinkDef.inStreamIndices?.[d.port] ?? d.port, 'stream']);
    }
  }
  return {
    blocks: insts.filter(i => active(i.uid)).map(i => ({ name: i.name, id: i.id, params: i.params })),
    connections: out,
  };
}

// ---- Run: hand the flowgraph to the WASM runner in the lower workspace pane ----
const MIN_PANE_HEIGHT = 120;
let lowerPaneRatio = 0.5;

function applySplitRatio(ratio = lowerPaneRatio) {
  const workspace = el('workspace');
  const splitter = el('paneSplitter');
  const splitterHeight = 7;
  const available = Math.max(0, workspace.clientHeight - splitterHeight);
  if (!available) return;
  const minimum = Math.min(MIN_PANE_HEIGHT, available / 2);
  const lowerHeight = Math.max(minimum, Math.min(available - minimum, available * ratio));
  lowerPaneRatio = lowerHeight / available;
  workspace.style.setProperty('--run-pane-height', `${lowerHeight}px`);
  splitter.setAttribute('aria-valuenow', String(Math.round(lowerPaneRatio * 100)));
}

function splitFromPointer(clientY: number) {
  const workspace = el('workspace');
  const rect = workspace.getBoundingClientRect();
  const available = Math.max(1, rect.height - 7);
  applySplitRatio((rect.bottom - clientY - 3.5) / available);
}

const paneSplitter = el('paneSplitter');
let resizingPanes = false;
paneSplitter.addEventListener('pointerdown', event => {
  if (!el('workspace').classList.contains('running')) return;
  resizingPanes = true;
  el('workspace').classList.add('resizing');
  paneSplitter.setPointerCapture(event.pointerId);
  splitFromPointer(event.clientY);
  event.preventDefault();
});
paneSplitter.addEventListener('pointermove', event => {
  if (resizingPanes) splitFromPointer(event.clientY);
});
const finishPaneResize = (event: PointerEvent) => {
  if (!resizingPanes) return;
  resizingPanes = false;
  el('workspace').classList.remove('resizing');
  if (paneSplitter.hasPointerCapture(event.pointerId))
    paneSplitter.releasePointerCapture(event.pointerId);
};
paneSplitter.addEventListener('pointerup', finishPaneResize);
paneSplitter.addEventListener('pointercancel', finishPaneResize);
paneSplitter.addEventListener('dblclick', () => applySplitRatio(0.5));
paneSplitter.addEventListener('keydown', event => {
  if (!el('workspace').classList.contains('running')) return;
  if (event.key === 'ArrowUp') lowerPaneRatio += 0.03;
  else if (event.key === 'ArrowDown') lowerPaneRatio -= 0.03;
  else if (event.key === 'Home') lowerPaneRatio = 0.85;
  else if (event.key === 'End') lowerPaneRatio = 0.15;
  else return;
  applySplitRatio();
  event.preventDefault();
});
window.addEventListener('resize', () => {
  if (el('workspace').classList.contains('running')) applySplitRatio();
});

function run() {
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
  const fg = toFlowgraphJSON();
  if (!fg.blocks.length) { log('nothing to run — add some blocks'); return; }
  const url = '/runner/build/runner.html#' + encodeURIComponent(JSON.stringify(fg));
  const workspace = el('workspace');
  const pane = el('runPane');
  const frame = el('runFrame') as HTMLIFrameElement;
  pane.hidden = false;
  applySplitRatio();
  workspace.classList.add('running');
  frame.src = url;
  el('btnRun').textContent = '↻ Restart';
  log('▶ running ' + fg.blocks.length + ' blocks, ' + fg.connections.length + ' connections');
}

function stop() {
  const frame = el('runFrame') as HTMLIFrameElement;
  frame.src = 'about:blank'; // unloading the iframe stops its WASM workers
  el('workspace').classList.remove('running');
  el('runPane').hidden = true;
  el('btnRun').textContent = '▶ Run';
  log('■ flowgraph stopped');
}

// ---- Palette ----
// ---- GRC-style block tree (collapsible categories + search) ----
interface LibraryBlock { id: string; label: string; runnable: boolean; unavailableReason?: string }
interface Cat { name: string; path: string; subs: Map<string, Cat>; blocks: LibraryBlock[] }

function buildTree(blocks: any[]): Cat {
  const root: Cat = { name: '', path: '', subs: new Map(), blocks: [] };
  for (const b of blocks) {
    const parts = String(b.category || 'Other').split('/').filter(Boolean);
    let node = root, path = '';
    for (const part of parts) {
      path = path ? path + '/' + part : part;
      let sub = node.subs.get(part);
      if (!sub) { sub = { name: part, path, subs: new Map(), blocks: [] }; node.subs.set(part, sub); }
      node = sub;
    }
    node.blocks.push({
      id: b.id, label: b.label || b.id, runnable: !!b.runnable,
      unavailableReason: b.unavailable_reason || undefined,
    });
  }
  return root;
}
const matchesQ = (b: { id: string; label: string }, q: string) => !q || (b.label + ' ' + b.id).toLowerCase().includes(q);
function catMatches(node: Cat, q: string): boolean {
  return !q || node.blocks.some(b => matchesQ(b, q)) || [...node.subs.values()].some(s => catMatches(s, q));
}

function makeBlockItem(b: LibraryBlock, indent: number): HTMLElement {
  const run = b.runnable && !!RUNNABLE[b.id];
  const item = document.createElement('div');
  item.className = 'pal-item ' + (run ? 'runnable' : 'unavailable');
  item.style.paddingLeft = indent + 'px';
  item.textContent = b.label;
  item.title = run ? b.id : `${b.id} — ${b.unavailableReason || 'not available in WebAssembly'}`;
  item.setAttribute('aria-disabled', String(!run));
  item.onclick = () => run ? addBlock(b.id) :
    log(`"${b.id}" is unavailable: ${b.unavailableReason || 'not implemented in WebAssembly'}`);
  return item;
}
function makeCatRow(name: string, container: HTMLElement, open: boolean, bold = false, indent = 6): HTMLElement {
  const row = document.createElement('div'); row.className = 'cat-row'; row.style.paddingLeft = indent + 'px';
  const tri = document.createElement('span'); tri.className = 'tri';
  const nm = document.createElement('span'); nm.textContent = name; if (bold) nm.style.fontWeight = '600';
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
    const kids = makeCatRow(s.name, container, !!q || (depth === 0 && s.name === 'Core'), false, 6 + depth * 13);
    renderTree(s, kids, depth + 1, q);
  }
  for (const b of [...node.blocks].filter(b => matchesQ(b, q)).sort((a, b) => a.label.localeCompare(b.label)))
    container.appendChild(makeBlockItem(b, 6 + depth * 13 + 16));
}

let LIB: any = { blocks: [] };
async function buildPalette() {
  const pal = el('palette');
  const search = document.createElement('input');
  search.className = 'palsearch'; search.placeholder = 'Search blocks…';
  paletteSearch = search;
  const tree = document.createElement('div'); tree.className = 'tree';
  pal.append(search, tree);
  try {
    LIB = await (await fetch('/editor/dist/blocks.json').then(r => r.ok ? r : fetch('/editor/public/blocks.json'))).json();
    installGeneratedBlocks(LIB.blocks || []);
  } catch (e) { log('block library not loaded: ' + e); }
  const draw = (q: string) => {
    tree.textContent = '';
    renderTree(buildTree(LIB.blocks), tree, 0, q);
  };
  draw('');
  search.oninput = () => draw(search.value.trim().toLowerCase());
}

el('btnRun').addEventListener('click', run);
el('btnStop').addEventListener('click', stop);
el('btnClear').addEventListener('click', () => clearFlowgraph());
el('btnExport').addEventListener('click', () => log(JSON.stringify(toFlowgraphJSON(), null, 1)));
el('btnKeys').addEventListener('click', showShortcutHelp);
(el('fileOpen') as HTMLInputElement).addEventListener('change', async event => {
  const input = event.currentTarget as HTMLInputElement, file = input.files?.[0]; if (!file) return;
  try { loadFlowgraph(JSON.parse(await file.text())); }
  catch (error) { log('could not open flowgraph: ' + error); }
  input.value = '';
});

const paletteReady = buildPalette();
// Seed with a multi-source demo (signal + noise -> add -> throttle -> scope).
addBlock('analog_sig_source_x', 50, 70);
addBlock('analog_noise_source_x', 50, 230);
addBlock('blocks_add_xx', 300, 130);
addBlock('blocks_throttle', 500, 130);
addBlock('qtgui_time_sink_x', 690, 130);
const [src, noise, add, thr, snk] = insts;
conns.push({ from: src.uid, fp: 0, to: add.uid, tp: 0 });
conns.push({ from: noise.uid, fp: 0, to: add.uid, tp: 1 });
conns.push({ from: add.uid, fp: 0, to: thr.uid, tp: 0 });
conns.push({ from: thr.uid, fp: 0, to: snk.uid, tp: 0 });
select(null); render();
historyReady = true; resetHistory();
log('Editor ready. Click ▶ Run to execute the flowgraph in WebAssembly.');
paletteReady.then(() => {
  const token = new URLSearchParams(location.hash.slice(1)).get('duplicate');
  if (!token) return;
  try {
    const saved = localStorage.getItem(token); if (!saved) throw new Error('duplicate data is no longer available');
    localStorage.removeItem(token); loadFlowgraph(JSON.parse(saved)); resetHistory();
    history.replaceState(null, '', location.href.split('#')[0]);
  } catch (error) { log('could not duplicate flowgraph: ' + error); }
});
