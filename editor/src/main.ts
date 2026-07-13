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

const SVGNS = 'http://www.w3.org/2000/svg';
const el = (id: string) => document.getElementById(id)!;
const nodesG = el('nodes'), wiresG = el('wires'), svg = el('svg') as unknown as SVGSVGElement;

let insts: Inst[] = [];
let conns: Conn[] = [];
let selected: string | null = null;
let selectedConnection: Conn | null = null;
let counter = 0;
let pending: { uid: string; port: number } | null = null;  // in-progress connection from an output

function log(s: string) { const l = el('log'); l.textContent += s + '\n'; l.scrollTop = l.scrollHeight; }

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

// Numeric GRC fields may also contain a variable ID (for example a signal
// source's frequency can be `freq`, the ID of a QT GUI Range).
function numericOrExpression(value: string): number | string {
  const text = value.trim();
  if (!text) return '';
  const number = Number(text);
  return Number.isFinite(number) ? number : text;
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

function geom(inst: Inst) {
  const d = RUNNABLE[inst.id];
  // Categorized parameters belong in the modal notebook, not in the compact
  // block rendering (equivalent to GRC's `hide: part`).
  const rows = d.params.filter(p => !p.category)
    .map(p => ({ l: p.label + ': ', v: fmtVal(inst.params[p.id]) }));
  const nports = Math.max(d.inputs, d.outputs, 1);
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
  select(uid); render();
}

// ---- block operations (used by the context menu) ----
function deleteBlock(uid: string) {
  insts = insts.filter(i => i.uid !== uid);
  conns = conns.filter(c => c.from !== uid && c.to !== uid);
  if (selected === uid) selected = null;
  if (selectedConnection && (selectedConnection.from === uid || selectedConnection.to === uid)) selectedConnection = null;
  renderProps(); render();
}
function deleteConnection(conn: Conn) {
  conns = conns.filter(c => c !== conn);
  if (selectedConnection === conn) selectedConnection = null;
  renderProps(); render();
}
function duplicateBlock(uid: string) {
  const s = insts.find(i => i.uid === uid); if (!s) return;
  const nu = 'b' + (++counter);
  insts.push({ uid: nu, id: s.id, name: s.id.replace(/^.*_/, '') + counter,
    x: s.x + 24, y: s.y + 24, params: { ...s.params }, enabled: s.enabled,
    rotation: s.rotation, bypassed: s.bypassed });
  select(nu);
}
function toggleEnabled(uid: string) {
  const s = insts.find(i => i.uid === uid); if (s) { s.enabled = !s.enabled; render(); }
}
function rotate(uid: string, deg: number) {
  const s = insts.find(i => i.uid === uid); if (s) { s.rotation = (((s.rotation + deg) % 360) + 360) % 360; render(); }
}
function toggleBypass(uid: string) {
  const s = insts.find(i => i.uid === uid);
  const d = s && RUNNABLE[s.id];
  if (!s || !d) return;
  if (d.inputs !== 1 || d.outputs !== 1) { log('bypass only works on 1-in/1-out blocks'); return; }
  s.bypassed = !s.bypassed; render();
}

// ---- clipboard (Cut/Copy/Paste) ----
let clipboard: Omit<Inst, 'uid' | 'x' | 'y'> | null = null;
function copyBlock(uid: string) {
  const s = insts.find(i => i.uid === uid); if (!s) return;
  clipboard = { id: s.id, name: s.name, params: { ...s.params }, enabled: s.enabled, rotation: s.rotation, bypassed: s.bypassed };
  log('copied ' + s.name);
}
function pasteBlock(x = 80, y = 80) {
  if (!clipboard) return;
  const uid = 'b' + (++counter);
  insts.push({ ...clipboard, params: { ...clipboard.params }, uid,
    name: clipboard.id.replace(/^.*_/, '') + counter, x, y });
  select(uid); render();
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
  item('Cut', () => { copyBlock(inst.uid); deleteBlock(inst.uid); });
  item('Copy', () => copyBlock(inst.uid));
  item('Paste', () => pasteBlock(inst.x + 30, inst.y + 30));
  item('Duplicate', () => duplicateBlock(inst.uid));
  sep();
  item('Rotate Clockwise', () => rotate(inst.uid, 90));
  item('Rotate Counterclockwise', () => rotate(inst.uid, -90));
  item(inst.enabled ? 'Disable' : 'Enable', () => toggleEnabled(inst.uid));
  item(inst.bypassed ? 'Un-Bypass' : 'Bypass', () => toggleBypass(inst.uid));
  sep();
  item('Delete', () => deleteBlock(inst.uid), true);
  document.body.appendChild(m);
  m.style.left = Math.min(x, window.innerWidth - m.offsetWidth - 6) + 'px';
  m.style.top = Math.min(y, window.innerHeight - m.offsetHeight - 6) + 'px';
  menuEl = m;
}
document.addEventListener('mousedown', e => { if (menuEl && !menuEl.contains(e.target as Node)) closeMenu(); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') { closeMenu(); document.querySelector('.modal.props')?.remove(); return; }
  const el = document.activeElement;
  if (el && ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName)) return; // don't hijack typing
  const ctrl = e.ctrlKey || e.metaKey;
  if (e.key === 'Delete' && (selectedConnection || selected)) {
    e.preventDefault();
    if (selectedConnection) deleteConnection(selectedConnection);
    else if (selected) deleteBlock(selected);
  }
  else if (ctrl && e.key === 'c' && selected) copyBlock(selected);
  else if (ctrl && e.key === 'x' && selected) { copyBlock(selected); deleteBlock(selected); }
  else if (ctrl && e.key === 'v') pasteBlock();
  else if (ctrl && e.key === 'ArrowRight' && selected) { e.preventDefault(); rotate(selected, 90); }
  else if (ctrl && e.key === 'ArrowLeft' && selected) { e.preventDefault(); rotate(selected, -90); }
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

  const addField = (category: string, label: string, node: HTMLElement) => {
    const row = document.createElement('div'); row.className = 'dlgrow';
    const l = document.createElement('label'); l.textContent = label;
    row.appendChild(l); row.appendChild(node); panels.get(category)!.appendChild(row);
    return node;
  };
  const nameI = addField('General', 'ID', document.createElement('input')) as HTMLInputElement;
  nameI.value = tmp.name; nameI.oninput = () => tmp.name = nameI.value.replace(/\s+/g, '_');
  for (const p of d.params) {
    if (p.type === 'enum') {
      const s = document.createElement('select');
      (p.options || []).forEach(o => { const opt = document.createElement('option'); opt.value = o; opt.textContent = o; s.appendChild(opt); });
      s.value = String(tmp.params[p.id]); s.onchange = () => tmp.params[p.id] = s.value;
      addField(p.category || 'General', `${p.label}  (${p.id})`, s);
    } else {
      const inp = document.createElement('input'); inp.value = String(tmp.params[p.id]);
      inp.oninput = () => tmp.params[p.id] = p.type === 'number' ? numericOrExpression(inp.value) : inp.value;
      addField(p.category || 'General', `${p.label}  (${p.id})`, inp);
    }
  }

  const foot = document.createElement('div'); foot.className = 'dlgfoot';
  const apply = () => { inst.name = tmp.name; inst.params = { ...tmp.params }; select(inst.uid); render(); };
  const btn = (label: string, fn: () => void, cls = '') => {
    const b = document.createElement('button'); b.textContent = label; if (cls) b.className = cls; b.onclick = fn; return b;
  };
  foot.appendChild(btn('Cancel', () => overlay.remove()));
  foot.appendChild(btn('Apply', apply));
  foot.appendChild(btn('OK', () => { apply(); overlay.remove(); }, 'run'));

  activateTab('General');
  dlg.append(head, tabBar, body, foot); overlay.appendChild(dlg); document.body.appendChild(overlay);
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) overlay.remove(); });
  nameI.focus(); nameI.select();
}

function select(uid: string | null) {
  selected = uid;
  selectedConnection = null;
  renderProps(); render();
}

function selectConnection(conn: Conn) {
  // Give keyboard shortcuts back to the canvas if the palette/property editor
  // previously held focus. The SVG path itself is not a focusable element.
  (document.activeElement as HTMLElement | null)?.blur();
  selected = null;
  selectedConnection = conn;
  renderProps(); render();
}

function svgPoint(evt: MouseEvent): { x: number; y: number } {
  const r = svg.getBoundingClientRect();
  return { x: evt.clientX - r.left, y: evt.clientY - r.top };
}

const svgEl = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>): SVGElementTagNameMap[K] => {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
};

function render() {
  nodesG.textContent = ''; wiresG.textContent = '';
  const G = (uid: string) => insts.find(i => i.uid === uid)!;
  // wires (from output right-edge to input left-edge, GRC-style curves)
  for (const c of conns) {
    const a = G(c.from), b = G(c.to); if (!a || !b) continue;
    const pa = portPos(a, 'out', c.fp), pb = portPos(b, 'in', c.tp);
    const x1 = a.x + pa.x, y1 = a.y + pa.y, x2 = b.x + pb.x, y2 = b.y + pb.y;
    const [c1x, c1y] = ctrl(pa.edge, x1, y1, 42);
    const [c2x, c2y] = ctrl(pb.edge, x2, y2, 42);
    const d = `M${x1},${y1} C${c1x},${c1y} ${c2x},${c2y} ${x2},${y2}`;
    const isSelected = c === selectedConnection;
    const wire = svgEl('g', { class: 'wire-group' });
    wire.appendChild(svgEl('path', { class: 'wire' + (isSelected ? ' sel' : ''), d,
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
    const { d, rows, h, w } = geom(inst);
    const g = svgEl('g', { class: 'blk' + (inst.uid === selected ? ' sel' : '') +
      (inst.enabled ? '' : ' disabled') + (inst.bypassed ? ' bypassed' : ''),
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
      const tx = svgEl('text', { class: 'param', x: '6', y: String(y) });
      const l = document.createElementNS(SVGNS, 'tspan'); l.textContent = r.l;
      const v = document.createElementNS(SVGNS, 'tspan'); v.setAttribute('class', 'pval'); v.textContent = r.v;
      tx.appendChild(l); tx.appendChild(v); g.appendChild(tx);
    });
    // Drag from anywhere on the block; ports stopPropagation so they still connect.
    g.addEventListener('mousedown', e => startDrag(e, inst));
    g.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); select(inst.uid); showMenu(e.clientX, e.clientY, inst); });
    for (let i = 0; i < d.inputs; i++) addPort(g, inst, 'in', i, portColor(inst, 'in', i));
    for (let i = 0; i < d.outputs; i++) addPort(g, inst, 'out', i, portColor(inst, 'out', i));
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
      pending = null; render();
    }
  });
  g.appendChild(r);
}
const G0 = (uid: string) => insts.find(i => i.uid === uid)!;

let drag: { inst: Inst; ox: number; oy: number } | null = null;
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
  select(inst.uid);
  const p = svgPoint(e); drag = { inst, ox: p.x - inst.x, oy: p.y - inst.y };
}
window.addEventListener('mousemove', e => {
  if (!drag) return; const p = svgPoint(e);
  drag.inst.x = Math.round(p.x - drag.ox); drag.inst.y = Math.round(p.y - drag.oy); render();
});
window.addEventListener('mouseup', () => { drag = null; });
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
  if (!selected) { body.textContent = 'Select a block or connection…'; return; }
  const inst = insts.find(i => i.uid === selected)!; const d = RUNNABLE[inst.id];
  body.innerHTML = '';
  const mk = (label: string, node: HTMLElement) => {
    const l = document.createElement('label'); l.textContent = label; body.appendChild(l); body.appendChild(node);
  };
  const nameI = document.createElement('input'); nameI.value = inst.name;
  nameI.oninput = () => { inst.name = nameI.value.replace(/\s+/g, '_'); render(); };
  mk('Block name (id)', nameI);
  for (const p of d.params.filter(p => !p.category)) {
    let node: HTMLElement;
    if (p.type === 'enum') {
      const s = document.createElement('select');
      (p.options || []).forEach(o => { const opt = document.createElement('option'); opt.value = o; opt.textContent = o; s.appendChild(opt); });
      s.value = String(inst.params[p.id]); s.onchange = () => { inst.params[p.id] = s.value; render(); };
      node = s;
    } else {
      const inp = document.createElement('input'); inp.value = String(inst.params[p.id]);
      inp.oninput = () => { inst.params[p.id] = p.type === 'number' ? numericOrExpression(inp.value) : inp.value; render(); };
      node = inp;
    }
    mk(p.label + '  (' + p.id + ')', node);
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
function run() {
  const fg = toFlowgraphJSON();
  if (!fg.blocks.length) { log('nothing to run — add some blocks'); return; }
  const url = '/runner/build/runner.html#' + encodeURIComponent(JSON.stringify(fg));
  const workspace = el('workspace');
  const pane = el('runPane');
  const frame = el('runFrame') as HTMLIFrameElement;
  pane.hidden = false;
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
el('btnClear').addEventListener('click', () => { insts = []; conns = []; select(null); render(); });
el('btnExport').addEventListener('click', () => log(JSON.stringify(toFlowgraphJSON(), null, 1)));

buildPalette();
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
log('Editor ready. Click ▶ Run to execute the flowgraph in WebAssembly.');
