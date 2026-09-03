import { NOTE_BG_PARAM } from './note';
import {
  CHALLENGE_ID, CHALLENGE_ID_PARAM, CHALLENGE_TITLE_PARAM,
  CHALLENGE_REQUIRES_PARAM, CHALLENGE_CRITERIA_PARAM,
} from './challenge';

export type ParamType = 'number' | 'string' | 'enum';
// `raw` marks a GRC dtype: raw parameter — free-form Python (vectors, matrices).
// Like numeric params these are evaluated before the flowgraph goes to the runner.
// `dtype` keeps the original GRC dtype (only the generated blocks carry one); the
// block face uses it to pick a truncation style for long values.
export interface ParamDef {
  id: string; label: string; type: ParamType; def: any; options?: string[];
  optionLabels?: string[];
  category?: string; hide?: string; hideIfEmpty?: boolean; raw?: boolean; dtype?: string;
  optionAttributes?: Record<string, string[]>;
  // The running flowgraph can still change this one: its factory installed a
  // numeric setter under this id, so a QT GUI control naming it here drives the
  // live block instead of only its construction-time value. Read out of the
  // factories by gen_registry.py and carried in blocks.json; the Properties
  // dialog underlines these, as native GRC does.
  live?: boolean;
  showWhen?: (params: Record<string, any>) => boolean;
  // Free-form prose (the Note block's text): edited in a textarea so it can hold
  // line breaks, which .grc round-trips as a double-quoted `\n` scalar.
  multiline?: boolean;
  // An `#rrggbb` fill (the Note block's background): edited with the browser's
  // native colour picker plus a Default button, since a hex field is the one
  // parameter type nobody can read back. Empty means "unset", not "black".
  color?: boolean;
}
export interface PortTemplate {
  dtype: string;
  vlen: string;
  domain: string;
  id: string;
  label: string;
  multiplicity: string;
  // Native's EvaluatedFlag, so a `${ ... }` expression over the block's own
  // parameters is legal here and is resolved per instance (see portOptional).
  optional: string | boolean;
  hide: string | boolean;
}
export interface ResolvedPort {
  dtype: string;
  vlen: number | string;
  domain: string;
  id: string;
  name: string;
  streamIndex: number;
  optional: boolean;
  hidden: boolean;
}
// inTypes/outTypes give per-port dtypes (for converters); otherwise ports follow the
// block's `type` param (complex/float) if it has one, else `dtype` (default complex).
export interface RunnableDef {
  label: string; inputs: number; outputs: number; params: ParamDef[];
  documentation?: string; apiDocumentation?: string; wikiUrl?: string;
  // The vendored out-of-tree package this definition came from. This is source
  // provenance ("gr-ham"), not the runner's downloadable module name ("ham").
  ootModule?: string;
  // Native GRC's implicit `id` parameter is `hide: all` unless the block's yaml
  // carries the `show_id` flag (Variable, QT GUI Range, Probe Signal, …), in
  // which case it is `hide: none` and appears both on the block face and in the
  // Properties dialog. See grc/core/blocks/_build.py `build_params`.
  showId?: boolean;
  // Native GRC adds minoutbuf/maxoutbuf to every DSP block definition that
  // declares at least one output port (stream or message). This is recorded
  // from blocks.json rather than inferred from the hand-written stream-port
  // counts, which intentionally omit some optional message ports.
  nativeOutputBuffers?: boolean;
  dtype?: string; inTypes?: string[]; outTypes?: string[];
  inDomains?: string[]; outDomains?: string[]; inIds?: string[]; outIds?: string[];
  inLabels?: string[]; outLabels?: string[];
  inLabelBase?: string; outLabelBase?: string;
  // Per-port `optional` for definitions with no port templates (the
  // hand-written schemas), filled in from blocks.json. An optional port needs
  // no connection, so the connectivity check has to know about it.
  inOptional?: boolean[]; outOptional?: boolean[];
  inStreamIndices?: number[]; outStreamIndices?: number[];
  inputTemplates?: PortTemplate[]; outputTemplates?: PortTemplate[];
}

// Generated block-library metadata. The editor is served from the site root,
// so blocks.json (Vite `public/`) sits next to index.html.
export const BLOCKS_URL = '/blocks.json';

// GRC dtype -> port colour (from grc/core/Constants.py).
export const DTYPE_COLOR: Record<string, string> = {
  complex: '#2196F3', float: '#F57C00', int: '#009688',
  short: '#FFEB3B', byte: '#D500F9', message: '#BDBDBD', '': '#ffffff',
};

// A "type" selector shared by the type-parameterized blocks (like GRC's io-type param).
const TYPE_PARAM: ParamDef = { id: 'type', label: 'Type', type: 'enum', def: 'complex', options: ['complex', 'float'], hide: 'part' };
const INTEGER_TYPE_PARAM: ParamDef = { id: 'type', label: 'Type', type: 'enum', def: 'byte', options: ['byte', 'short', 'int'], hide: 'part' };
const STREAM_TYPE_PARAM: ParamDef = { id: 'type', label: 'Type', type: 'enum', def: 'complex', options: ['complex', 'float', 'int', 'short', 'byte'], hide: 'part' };
// GRC's Vector Length, shared by the blocks whose ports are `vlen: ${vlen}`.
// Declaring it is what lets a vector stream reach the block at all: an
// undeclared parameter is dropped, and portMeta() then reads every port as
// vlen 1, so the connection is refused as a vector-length mismatch.
const VLEN_PARAM: ParamDef = { id: 'vlen', label: 'Vector Length', type: 'number', def: 1 };
// GRC-native enum vocabularies (values stored/serialized verbatim, matching
// grc block YAML so saved .grc is byte-compatible with desktop GRC).
const BOOL_OPTIONS = ['True', 'False'];
const TRIGGER_MODES = ['qtgui.TRIG_MODE_FREE', 'qtgui.TRIG_MODE_AUTO', 'qtgui.TRIG_MODE_NORM', 'qtgui.TRIG_MODE_TAG'];
const TRIGGER_SLOPES = ['qtgui.TRIG_SLOPE_POS', 'qtgui.TRIG_SLOPE_NEG'];
const LINE_COLORS = ['blue', 'red', 'green', 'black', 'cyan', 'magenta', 'yellow', 'dark red', 'dark green', 'dark blue'];
// The frequency/constellation sinks store colours as quoted strings in GRC.
const LINE_COLORS_Q = LINE_COLORS.map(c => `"${c}"`);
// Line style ids are Qt::PenStyle (0 = NoPen, 1 = SolidLine … 5 = DashDotDotLine)
// and marker ids are QwtSymbol::Style (-1 = NoSymbol, 0 = Ellipse … 9 = XCross).
// Both carry their labels here rather than inheriting them from the block yaml:
// GRC's sinks order these lists differently from one another (the marker "None"
// is first on the Time Sink and last on the Constellation Sink) and its Time
// Sink leaves style 0 and marker 5 unlabelled, so one correct pairing shared by
// every sink beats ten yaml lists that disagree.
const LINE_STYLES = ['1', '2', '3', '4', '5', '0'];
const LINE_STYLE_LABELS = ['Solid', 'Dash', 'Dots', 'Dash-Dot', 'Dash-Dot-Dot', 'None'];
// GRC's frequency-sink Average options (None / Low / Medium / High smoothing).
const FFT_AVERAGES = ['1.0', '0.2', '0.1', '0.05'];
// analog::noise_type_t, in the yaml's own order.
const NOISE_TYPES = ['analog.GR_UNIFORM', 'analog.GR_GAUSSIAN', 'analog.GR_LAPLACIAN',
  'analog.GR_IMPULSE'];
// GRC's FFT window enum, spelled as upstream's yaml does (the runner's choice()
// accepts both this and the `fft::window::WIN_*` form a cpp_template emits).
const FFT_WINDOWS = ['window.WIN_RECTANGULAR', 'window.WIN_BLACKMAN_hARRIS',
  'window.WIN_HAMMING', 'window.WIN_HANN', 'window.WIN_BLACKMAN',
  'window.WIN_KAISER', 'window.WIN_FLATTOP'];
const FFT_WINDOW_LABELS = ['Rectangular', 'Blackman-harris', 'Hamming', 'Hann',
  'Blackman', 'Kaiser', 'Flat-top'];
const LINE_MARKERS = ['-1', '0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
const LINE_MARKER_LABELS = ['None', 'Circle', 'Rectangle', 'Diamond', 'Triangle',
  'Down Triangle', 'Up Triangle', 'Left Triangle', 'Right Triangle', 'Cross', 'X-Cross'];
// Waterfall intensity color-map ids (match WaterfallDisplayPlot / GRC):
// 0 Multi Color, 1 White Hot, 2 Black Hot, 3 Incandescent, 5 Sunset, 6 Cool.
const WATERFALL_COLORS = ['0', '1', '2', '3', '5', '6'];

// Every QT GUI sink takes `nconnections` stream inputs, exactly as native GRC
// does: the runner's factories already pass it to time_sink/freq_sink/const_sink/
// waterfall_sink::make and configure that many lines, and legacyPortCount() turns
// the parameter into that many ports on the block face.
const NCONNECTIONS_PARAM: ParamDef = {
  id: 'nconnections', label: 'Number of Inputs', type: 'number', def: 1,
};

// Every rate field in GRC defaults to the *expression* `samp_rate`, never to a
// literal — which is what makes a freshly placed Frequency Sink draw a 1 MHz
// x-axis in a flowgraph whose samp_rate variable is 1 MHz instead of the 32 kHz
// one it was born with. A new flowgraph always carries that variable
// (makeSampRateInst() in main.ts), and the Run path evaluates the expression
// before the runner sees it, so the default resolves like any other reference.
// Blocks with a generated schema (the Eye, Time Raster and four-pane Sinks)
// inherit this default from their yaml; the hand-written schemas below have to
// spell it out, and did not, which left their axes stuck at 32 kHz.
const SAMP_RATE_PARAM: ParamDef = {
  id: 'samp_rate', label: 'Sample Rate', type: 'number', def: 'samp_rate',
};
// The three sinks that do not call it `samp_rate`. Upstream is not consistent
// with itself here -- the Time Sink says `srate`, the Frequency and Waterfall
// Sinks say `bw` and label it Bandwidth -- but these are the ids and labels a
// .grc carries, in either direction, so they are the ones to use.
const SRATE_PARAM: ParamDef = { ...SAMP_RATE_PARAM, id: 'srate' };
const BANDWIDTH_PARAM: ParamDef = {
  ...SAMP_RATE_PARAM, id: 'bw', label: 'Bandwidth (Hz)',
};

// GRC gives each sink ten configurable lines and hides the ones past the active
// line count; `configure_line` in runner/src/registry.cpp reads them back per
// line under the same names. The colour cycle matches the runner's own default
// list, so an unset line looks the same on both sides.
const MAX_LINES = 10;

interface LineParamOpts {
  // How many lines the sink actually draws. The Time Sink plots a complex input
  // as two lines (I and Q), which is why the runner passes it 2 * nconnections.
  lineCount: (params: Record<string, any>) => number;
  quotedColors?: boolean;          // the freq/const sinks store colours quoted
  labelPrefix?: string;            // '' leaves the default label empty
  style?: string;
  marker?: string;
  waterfall?: boolean;             // waterfall has a colour map, no style/marker
}

function lineParams(opts: LineParamOpts): ParamDef[] {
  const params: ParamDef[] = [];
  for (let i = 1; i <= MAX_LINES; i++) {
    // Line 1 is always shown; the rest appear as connections are added.
    const showWhen = i === 1 ? undefined
      : (p: Record<string, any>) => i <= opts.lineCount(p);
    const colors = opts.quotedColors ? LINE_COLORS_Q : LINE_COLORS;
    const color = colors[(i - 1) % colors.length];
    const label = `Line ${i} `;
    params.push({ id: `label${i}`, label: label + 'Label', type: 'string',
      def: opts.labelPrefix ? `${opts.labelPrefix} ${i}` : '', category: 'Config', showWhen });
    if (!opts.waterfall)
      params.push({ id: `width${i}`, label: label + 'Width', type: 'number', def: 1,
        category: 'Config', showWhen });
    params.push({ id: `color${i}`, label: label + 'Color', type: 'enum',
      def: opts.waterfall ? '0' : color,
      options: opts.waterfall ? WATERFALL_COLORS : colors, category: 'Config', showWhen });
    if (!opts.waterfall) {
      params.push({ id: `style${i}`, label: label + 'Style', type: 'enum', def: opts.style ?? '1',
        options: LINE_STYLES, optionLabels: LINE_STYLE_LABELS, category: 'Config', showWhen });
      params.push({ id: `marker${i}`, label: label + 'Marker', type: 'enum', def: opts.marker ?? '-1',
        options: LINE_MARKERS, optionLabels: LINE_MARKER_LABELS, category: 'Config', showWhen });
    }
    params.push({ id: `alpha${i}`, label: label + 'Alpha', type: 'number', def: 1,
      category: 'Config', showWhen });
  }
  return params;
}

// The number of lines each sink draws, given its parameters.
const nconn = (p: Record<string, any>) => Math.max(1, Math.trunc(Number(p.nconnections) || 1));
// A complex Time Sink input is drawn as two traces (I and Q).
const timeSinkLines = (p: Record<string, any>) => nconn(p) * (p.type === 'complex' ? 2 : 1);

// Curated schemas for blocks the WASM runner registry supports. Param names (and the
// `type` values complex/float) match the runner's factories exactly.
export const RUNNABLE: Record<string, RunnableDef> = {
  // ---- flowgraph options ----
  // GRC's per-flowgraph Options block: identification metadata for the graph.
  // Exactly one is auto-inserted per flowgraph (see ensureOptionsBlock). It has
  // no ports and becomes the top-level `options:` block in the saved .grc.
  // Title, Author, and Description are an intentional exception to blank-value
  // hiding: their labels remain visible on the Options block even when empty.
  // The Options block has no ID of its own here: the flowgraph id it writes to
  // the .grc is derived from the Title (see flowgraphId()), so there is nothing
  // to show or edit and `showId` stays off.
  options: {
    label: 'Options', inputs: 0, outputs: 0, params: [
      { id: 'title', label: 'Title', type: 'string', def: '' },
      { id: 'author', label: 'Author', type: 'string', def: '' },
      { id: 'copyright', label: 'Copyright', type: 'string', def: '', hideIfEmpty: true },
      { id: 'description', label: 'Description', type: 'string', def: '' },
      // Browser-only. Which scheduler the runner drives this flowgraph with --
      // see docs/schedulers.md. Native GRC ignores an options key it does not
      // know (grc/core/blocks/block.py's import_data swallows the KeyError), so
      // a .grc carrying this still opens there; it is dropped on a native
      // re-save, which is the whole cost of keeping it in the file.
      //
      // 'tpb' is deliberately NOT written out (see grcParams' caller in
      // main.ts): every options parameter is serialized, so a default that
      // reached the file would rewrite every .grc in the repository.
      { id: 'scheduler', label: 'Scheduler', type: 'enum', def: 'tpb',
        options: ['tpb', 'sts', 'det'],
        optionLabels: ['Thread-Per-Block (default)', 'Single-Threaded',
                       'Deterministic (bounded, repeatable)'] },
    ],
  },
  // GRC's canvas annotation. It has no GNU Radio block behind it — the runner
  // drops it while lowering, the same way it drops `options` and `variable` —
  // so a hand-written schema here is all the support it needs. Its text is the
  // block's whole body, rendered wrapped (see noteGeom).
  // `bgcolor` is browser-only: native GRC's Note has one parameter, so a .grc
  // carrying a colour still loads there (GRC warns about the extra key rather
  // than failing), and one written here omits it entirely while it is unset.
  note: {
    label: 'Note', inputs: 0, outputs: 0, params: [
      { id: 'note', label: 'Note', type: 'string', def: '', multiline: true },
      { id: NOTE_BG_PARAM, label: 'Background Color', type: 'string', def: '',
        color: true },
    ],
  },
  // The Challenge block, and the same story as Note above: metadata only, no
  // GNU Radio block behind it, dropped by the runner while lowering. Its body
  // on the canvas is the live checklist its `criteria` describe (challengeGeom
  // in main.ts), and it is in PALETTE_HIDDEN because authoring a challenge is a
  // repository activity rather than something to drop onto a flowgraph.
  //
  // Every parameter of it has to be declared here or the editor drops it
  // silently on load -- and a challenge whose criteria quietly became `[]`
  // would show an empty checklist that can never be completed. See
  // docs/challenges.md.
  [CHALLENGE_ID]: {
    label: 'Challenge', inputs: 0, outputs: 0, params: [
      { id: CHALLENGE_ID_PARAM, label: 'Challenge ID', type: 'string', def: '' },
      { id: CHALLENGE_TITLE_PARAM, label: 'Title', type: 'string', def: '' },
      { id: CHALLENGE_REQUIRES_PARAM, label: 'Requires', type: 'string', def: '' },
      { id: CHALLENGE_CRITERIA_PARAM, label: 'Success Criteria', type: 'string',
        def: '[]', multiline: true },
    ],
  },
  // ---- sources ----
  analog_sig_source_x: {
    label: 'Signal Source', inputs: 0, outputs: 1, params: [
      TYPE_PARAM,
      { ...SAMP_RATE_PARAM },
      { id: 'waveform', label: 'Waveform', type: 'enum', def: 'analog.GR_COS_WAVE',
        options: ['analog.GR_CONST_WAVE', 'analog.GR_SIN_WAVE', 'analog.GR_COS_WAVE', 'analog.GR_SQR_WAVE', 'analog.GR_TRI_WAVE', 'analog.GR_SAW_WAVE'] },
      { id: 'freq', label: 'Frequency', type: 'number', def: 1000 },
      { id: 'amp', label: 'Amplitude', type: 'number', def: 1.0 },
      { id: 'offset', label: 'Offset', type: 'number', def: 0 },
      { id: 'phase', label: 'Initial Phase (Radians)', type: 'number', def: 0 },
    ],
  },
  analog_noise_source_x: {
    label: 'Noise Source', inputs: 0, outputs: 1, params: [
      TYPE_PARAM,
      { id: 'noise_type', label: 'Noise Type', type: 'enum', def: 'analog.GR_GAUSSIAN',
        options: NOISE_TYPES, optionLabels: ['Uniform', 'Gaussian', 'Laplacian', 'Impulse'] },
      { id: 'amp', label: 'Amplitude', type: 'number', def: 1.0 },
      { id: 'seed', label: 'Seed', type: 'number', def: 0 }] },
  analog_random_source_x: {
    label: 'Random Source', inputs: 0, outputs: 1, params: [
      INTEGER_TYPE_PARAM,
      { id: 'min', label: 'Minimum', type: 'number', def: 0 },
      { id: 'max', label: 'Maximum', type: 'number', def: 2 },
      { id: 'num_samps', label: 'Num Samples', type: 'number', def: 1000 },
      { id: 'repeat', label: 'Repeat', type: 'enum', def: 'True', options: BOOL_OPTIONS },
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
  blocks_null_source: {
    label: 'Null Source', inputs: 0, outputs: 1, params: [
      STREAM_TYPE_PARAM,
      { id: 'vlen', label: 'Vector Length', type: 'number', def: 1 },
    ] },
  blocks_swapiq: {
    label: 'Swap IQ', inputs: 1, outputs: 1, params: [
      { id: 'datatype', label: 'Input Type', type: 'enum', def: 'complex',
        options: ['complex', 'short', 'byte'] },
    ],
    inTypes: ['$datatype'], outTypes: ['$datatype'],
  },
  ival_decimator: {
    label: 'Interleaved Stream Decimator', inputs: 1, outputs: 1, params: [
      { id: 'datatype', label: 'Input Type', type: 'enum', def: 'byte',
        options: ['byte', 'short'] },
      { id: 'decimation', label: 'Decimation', type: 'number', def: 1 },
    ],
    inTypes: ['$datatype'], outTypes: ['$datatype'],
  },
  digital_psk_mod: {
    label: 'PSK Mod', inputs: 1, outputs: 1, params: [
      { id: 'constellation_points', label: 'Constellation Points', type: 'number', def: 8 },
      { id: 'mod_code', label: 'Gray Code', type: 'enum', def: '"gray"', options: ['"gray"', '"none"'] },
      { id: 'differential', label: 'Differential', type: 'enum', def: 'True', options: BOOL_OPTIONS },
      { id: 'samples_per_symbol', label: 'Samples/Symbol', type: 'number', def: 2 },
      { id: 'excess_bw', label: 'Excess BW', type: 'number', def: 0.35 },
    ],
    inTypes: ['byte'], outTypes: ['complex'],
  },
  // ---- flow control ----
  // Throttle (blocks_throttle2) has no hand-written entry: the generated schema
  // already matches upstream.
  blocks_head: {
    label: 'Head', inputs: 1, outputs: 1, params: [
      STREAM_TYPE_PARAM,
      { id: 'num_items', label: 'Num Items', type: 'number', def: 10000000 },
      VLEN_PARAM] },
  blocks_delay: {
    label: 'Delay', inputs: 1, outputs: 1, params: [
      STREAM_TYPE_PARAM,
      { id: 'delay', label: 'Delay (items)', type: 'number', def: 0 },
      VLEN_PARAM] },
  // ---- math (type-parameterized: complex or float) ----
  blocks_add_xx: {
    label: 'Add', inputs: 2, outputs: 1, params: [
      TYPE_PARAM,
      { id: 'num_inputs', label: 'Num Inputs', type: 'number', def: 2 },
      { id: 'vlen', label: 'Vector Length', type: 'number', def: 1 },
    ] },
  blocks_sub_xx: {
    label: 'Subtract', inputs: 2, outputs: 1, params: [
      TYPE_PARAM,
      { id: 'num_inputs', label: 'Num Inputs', type: 'number', def: 2 },
      { id: 'vlen', label: 'Vector Length', type: 'number', def: 1 },
    ] },
  blocks_multiply_xx: {
    label: 'Multiply', inputs: 2, outputs: 1, params: [
      TYPE_PARAM,
      { id: 'num_inputs', label: 'Num Inputs', type: 'number', def: 2 },
      { id: 'vlen', label: 'Vector Length', type: 'number', def: 1 },
    ] },
  blocks_divide_xx: {
    label: 'Divide', inputs: 2, outputs: 1, params: [
      TYPE_PARAM,
      { id: 'num_inputs', label: 'Num Inputs', type: 'number', def: 2 },
      { id: 'vlen', label: 'Vector Length', type: 'number', def: 1 },
    ] },
  blocks_multiply_const_xx: {
    label: 'Multiply Const', inputs: 1, outputs: 1, params: [
      TYPE_PARAM,
      { id: 'const', label: 'Constant', type: 'number', def: 1.0 },
      VLEN_PARAM] },
  blocks_conjugate_cc: { label: 'Conjugate', inputs: 1, outputs: 1, params: [], dtype: 'complex' },
  // ---- type converters (per-port dtypes) ----
  blocks_complex_to_mag: { label: 'Complex to Mag', inputs: 1, outputs: 1, params: [VLEN_PARAM],
    inTypes: ['complex'], outTypes: ['float'] },
  blocks_complex_to_mag_squared: { label: 'Complex to Mag^2', inputs: 1, outputs: 1, params: [VLEN_PARAM],
    inTypes: ['complex'], outTypes: ['float'] },
  blocks_complex_to_float: { label: 'Complex to Float', inputs: 1, outputs: 2, params: [VLEN_PARAM],
    inTypes: ['complex'], outTypes: ['float', 'float'] },
  blocks_float_to_complex: { label: 'Float to Complex', inputs: 2, outputs: 1, params: [VLEN_PARAM],
    inTypes: ['float', 'float'], outTypes: ['complex'] },
  // ---- variables / controls ----
  // `variable` carries GRC's `show_id` flag, but it is not in the runner's
  // support manifest (the runner inlines variables rather than constructing
  // them), so installGeneratedBlocks skips it and the flag is set here instead.
  variable: {
    label: 'Variable', inputs: 0, outputs: 0, showId: true, params: [
      { id: 'value', label: 'Value', type: 'number', def: '0' },
    ],
  },
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
      { id: 'orient', label: 'Orientation', type: 'enum', def: 'QtCore.Qt.Horizontal',
        options: ['QtCore.Qt.Horizontal', 'QtCore.Qt.Vertical'] },
      { id: 'min_len', label: 'Minimum Length', type: 'number', def: 200 },
    ],
  },
  variable_qtgui_chooser: {
    label: 'QT GUI Chooser', inputs: 0, outputs: 0, params: [
      { id: 'label', label: 'Label', type: 'string', def: '' },
      { id: 'options', label: 'Options', type: 'string', def: '0, 1, 2' },
      { id: 'labels', label: 'Labels', type: 'string', def: '' },
      { id: 'value', label: 'Default option', type: 'number', def: 0 },
      { id: 'widget', label: 'Widget', type: 'enum', def: 'combo_box',
        options: ['combo_box', 'radio_buttons'] },
      { id: 'orient', label: 'Orientation', type: 'enum', def: 'Qt.QVBoxLayout',
        options: ['Qt.QHBoxLayout', 'Qt.QVBoxLayout'] },
    ],
  },
  variable_qtgui_push_button: {
    label: 'QT GUI Push Button', inputs: 0, outputs: 0, params: [
      { id: 'label', label: 'Label', type: 'string', def: '' },
      { id: 'value', label: 'Default Value', type: 'number', def: 0 },
      { id: 'pressed', label: 'Pressed', type: 'number', def: 1 },
      { id: 'released', label: 'Released', type: 'number', def: 0 },
    ],
  },
  variable_qtgui_check_box: {
    label: 'QT GUI Check Box', inputs: 0, outputs: 0, params: [
      { id: 'label', label: 'Label', type: 'string', def: '' },
      { id: 'type', label: 'Type', type: 'enum', def: 'int',
        options: ['real', 'int', 'bool'] },
      { id: 'value', label: 'Default Value', type: 'number', def: 1 },
      { id: 'true', label: 'True', type: 'number', def: 1 },
      { id: 'false', label: 'False', type: 'number', def: 0 },
    ],
  },
  variable_qtgui_entry: {
    label: 'QT GUI Entry', inputs: 0, outputs: 0, params: [
      { id: 'label', label: 'Label', type: 'string', def: '' },
      { id: 'type', label: 'Type', type: 'enum', def: 'int',
        options: ['real', 'int', 'bool'] },
      { id: 'value', label: 'Default Value', type: 'number', def: 0 },
      { id: 'entry_signal', label: 'Update Trigger', type: 'enum',
        def: 'editingFinished', options: ['returnPressed', 'editingFinished'] },
    ],
  },
  // ---- sinks ----
  // vlen is declared because a vector stream has to be terminable: the runner
  // sizes the sink from it, and without it here this schema (which supersedes
  // the generated one) drops the parameter and the connection is refused as a
  // vector-length mismatch.
  blocks_null_sink: {
    label: 'Null Sink', inputs: 1, outputs: 0, params: [
      STREAM_TYPE_PARAM,
      { id: 'vlen', label: 'Vector Length', type: 'number', def: 1 },
    ] },
  qtgui_time_sink_x: {
    label: 'QT GUI Time Sink', inputs: 1, outputs: 0, params: [
      TYPE_PARAM,
      { id: 'name', label: 'Title', type: 'string', def: 'Scope' },
      { id: 'size', label: 'Num Points', type: 'number', def: 1024 },
      { ...SRATE_PARAM },
      NCONNECTIONS_PARAM,
      { id: 'ylabel', label: 'Y Axis Label', type: 'string', def: 'Amplitude', category: 'General' },
      { id: 'yunit', label: 'Y Axis Unit', type: 'string', def: '', category: 'General' },
      { id: 'grid', label: 'Grid', type: 'enum', def: 'False', options: BOOL_OPTIONS, category: 'General' },
      { id: 'autoscale', label: 'Autoscale', type: 'enum', def: 'False', options: BOOL_OPTIONS, category: 'General' },
      { id: 'entags', label: 'Display Tags', type: 'enum', def: 'True',
        options: BOOL_OPTIONS, optionLabels: ['Yes', 'No'], category: 'General' },
      { id: 'ymin', label: 'Y min', type: 'number', def: -1, category: 'General' },
      { id: 'ymax', label: 'Y max', type: 'number', def: 1, category: 'General' },
      { id: 'update_time', label: 'Update Period', type: 'number', def: 0.1, category: 'General' },
      { id: 'tr_mode', label: 'Trigger Mode', type: 'enum', def: 'qtgui.TRIG_MODE_FREE', options: TRIGGER_MODES, category: 'Trigger' },
      { id: 'tr_slope', label: 'Trigger Slope', type: 'enum', def: 'qtgui.TRIG_SLOPE_POS', options: TRIGGER_SLOPES, category: 'Trigger' },
      { id: 'tr_level', label: 'Trigger Level', type: 'number', def: 0, category: 'Trigger' },
      { id: 'tr_delay', label: 'Trigger Delay', type: 'number', def: 0, category: 'Trigger' },
      { id: 'tr_chan', label: 'Trigger Channel', type: 'number', def: 0, category: 'Trigger' },
      { id: 'tr_tag', label: 'Trigger Tag Key', type: 'string', def: '', category: 'Trigger' },
      { id: 'ctrlpanel', label: 'Control Panel', type: 'enum', def: 'False', options: BOOL_OPTIONS, category: 'Config' },
      { id: 'legend', label: 'Legend', type: 'enum', def: 'True', options: BOOL_OPTIONS, category: 'Config' },
      { id: 'axislabels', label: 'Axis Labels', type: 'enum', def: 'True', options: BOOL_OPTIONS, category: 'Config' },
      { id: 'stemplot', label: 'Stem Plot', type: 'enum', def: 'False', options: BOOL_OPTIONS, category: 'Config' },
      ...lineParams({ lineCount: timeSinkLines, labelPrefix: 'Signal' }),
    ] },
  qtgui_freq_sink_x: {
    label: 'QT GUI Frequency Sink', inputs: 1, outputs: 0, params: [
      TYPE_PARAM,
      { id: 'name', label: 'Title', type: 'string', def: 'Spectrum' },
      { id: 'fftsize', label: 'FFT Size', type: 'number', def: 1024 },
      // Upstream's `wintype`, kept off the block face as its yaml's `hide: part`
      // does. Unlike native GRC, the default here is rectangular rather than
      // Blackman-harris, so the sink shows the unweighted spectrum until a
      // window is asked for; the runner's factory defaults to match.
      { id: 'wintype', label: 'Window Type', type: 'enum', def: 'window.WIN_RECTANGULAR',
        options: FFT_WINDOWS, optionLabels: FFT_WINDOW_LABELS, hide: 'part' },
      // A real input has a symmetric spectrum, so GRC offers to plot only its
      // positive half. Named as upstream: 'True' is the full width, 'False' half.
      { id: 'freqhalf', label: 'Spectrum Width', type: 'enum', def: 'True',
        options: BOOL_OPTIONS, optionLabels: ['Full', 'Half'],
        showWhen: (p) => p.type === 'float' },
      { ...BANDWIDTH_PARAM },
      { id: 'fc', label: 'Center Frequency', type: 'number', def: 0 },
      NCONNECTIONS_PARAM,
      { id: 'grid', label: 'Grid', type: 'enum', def: 'False', options: BOOL_OPTIONS, category: 'General' },
      { id: 'autoscale', label: 'Autoscale', type: 'enum', def: 'False', options: BOOL_OPTIONS, category: 'General' },
      // FFT smoothing alpha, as in GRC: 1 = off, 0.2/0.1/0.05 = low/medium/high.
      { id: 'average', label: 'Average (1 = off)', type: 'enum', def: '1.0', options: FFT_AVERAGES, category: 'General' },
      { id: 'ymin', label: 'Y min', type: 'number', def: -140, category: 'General' },
      { id: 'ymax', label: 'Y max', type: 'number', def: 10, category: 'General' },
      { id: 'update_time', label: 'Update Period', type: 'number', def: 0.1, category: 'General' },
      { id: 'tr_mode', label: 'Trigger Mode', type: 'enum', def: 'qtgui.TRIG_MODE_FREE', options: TRIGGER_MODES, category: 'Trigger' },
      { id: 'tr_level', label: 'Trigger Level', type: 'number', def: 0, category: 'Trigger' },
      { id: 'tr_chan', label: 'Trigger Channel', type: 'number', def: 0, category: 'Trigger' },
      { id: 'tr_tag', label: 'Trigger Tag Key', type: 'string', def: '', category: 'Trigger' },
      // Upstream's `label`/`units`, spelled as its yaml does rather than as the
      // Time Sink's `ylabel`/`yunit`: these two ids are what a native .grc carries.
      { id: 'label', label: 'Y Axis Label', type: 'string', def: 'Relative Gain', category: 'General' },
      { id: 'units', label: 'Y Axis Unit', type: 'string', def: 'dB', category: 'General' },
      // set_fft_window_normalized(): divides the window by its own power so a
      // window choice stops changing the level the spectrum is drawn at.
      { id: 'norm_window', label: 'Normalize Window Power', type: 'enum', def: 'False',
        options: BOOL_OPTIONS, optionLabels: ['Yes', 'No'], category: 'General' },
      { id: 'ctrlpanel', label: 'Control Panel', type: 'enum', def: 'False', options: BOOL_OPTIONS, category: 'Config' },
      { id: 'legend', label: 'Legend', type: 'enum', def: 'True', options: BOOL_OPTIONS, category: 'Config' },
      { id: 'axislabels', label: 'Axis Labels', type: 'enum', def: 'True', options: BOOL_OPTIONS, category: 'Config' },
      ...lineParams({ lineCount: nconn, quotedColors: true }),
    ], dtype: 'complex' },
  qtgui_const_sink_x: {
    label: 'QT GUI Constellation Sink', inputs: 1, outputs: 0, params: [
      { id: 'name', label: 'Title', type: 'string', def: 'Constellation' },
      { id: 'size', label: 'Num Points', type: 'number', def: 1024 },
      NCONNECTIONS_PARAM,
      { id: 'update_time', label: 'Update Period', type: 'number', def: 0.1 },
      { id: 'autoscale', label: 'Autoscale', type: 'enum', def: 'False', options: BOOL_OPTIONS },
      { id: 'grid', label: 'Grid', type: 'enum', def: 'False', options: BOOL_OPTIONS },
      { id: 'xmin', label: 'X min', type: 'number', def: -2 },
      { id: 'xmax', label: 'X max', type: 'number', def: 2 },
      { id: 'ymin', label: 'Y min', type: 'number', def: -2 },
      { id: 'ymax', label: 'Y max', type: 'number', def: 2 },
      { id: 'tr_mode', label: 'Trigger Mode', type: 'enum', def: 'qtgui.TRIG_MODE_FREE', options: TRIGGER_MODES, category: 'Trigger' },
      { id: 'tr_slope', label: 'Trigger Slope', type: 'enum', def: 'qtgui.TRIG_SLOPE_POS', options: TRIGGER_SLOPES, category: 'Trigger' },
      { id: 'tr_level', label: 'Trigger Level', type: 'number', def: 0, category: 'Trigger' },
      { id: 'tr_chan', label: 'Trigger Channel', type: 'number', def: 0, category: 'Trigger' },
      { id: 'tr_tag', label: 'Trigger Tag Key', type: 'string', def: '', category: 'Trigger' },
      { id: 'legend', label: 'Legend', type: 'enum', def: 'True', options: BOOL_OPTIONS, category: 'Config' },
      { id: 'axislabels', label: 'Axis Labels', type: 'enum', def: 'True', options: BOOL_OPTIONS, category: 'Config' },
      // A constellation is drawn as unconnected points: GRC's own defaults for
      // this sink are no line (Qt::NoPen) and a circle marker, unlike the Time
      // and Frequency Sinks, which draw a solid line and no marker.
      ...lineParams({ lineCount: nconn, quotedColors: true, style: '0', marker: '0' }),
    ], dtype: 'complex' },
  qtgui_waterfall_sink_x: {
    label: 'QT GUI Waterfall Sink', inputs: 1, outputs: 0, params: [
      // The runner builds waterfall_sink_f for a float input and always has;
      // without this parameter the editor could only ever ask for the complex one.
      TYPE_PARAM,
      { id: 'name', label: 'Title', type: 'string', def: 'Waterfall' },
      { id: 'fftsize', label: 'FFT Size', type: 'number', def: 1024 },
      // Same defaults and reasoning as the Frequency Sink's two.
      { id: 'wintype', label: 'Window Type', type: 'enum', def: 'window.WIN_RECTANGULAR',
        options: FFT_WINDOWS, optionLabels: FFT_WINDOW_LABELS, hide: 'part' },
      { id: 'freqhalf', label: 'Spectrum Width', type: 'enum', def: 'True',
        options: BOOL_OPTIONS, optionLabels: ['Full', 'Half'],
        showWhen: (p) => p.type === 'float' },
      { ...BANDWIDTH_PARAM },
      { id: 'fc', label: 'Center Frequency', type: 'number', def: 0 },
      NCONNECTIONS_PARAM,
      { id: 'int_min', label: 'Intensity Min', type: 'number', def: -140, category: 'General' },
      { id: 'int_max', label: 'Intensity Max', type: 'number', def: 10, category: 'General' },
      // Browser-only: gr-qtgui's waterfall has set_fft_average() but GRC exposes no
      // parameter for it, so an unaveraged row of a noise spectrum is ~5.6 dB of
      // per-bin speckle -- more spread than a Rayleigh channel's own frequency
      // selectivity. Same alpha choices the Frequency Sink offers. 1.0 = none,
      // which is what a .grc without the parameter falls back to in the runner.
      { id: 'average', label: 'Average', type: 'enum', def: '1.0',
        options: ['1.0', '0.2', '0.1', '0.05'],
        optionLabels: ['None', 'Low', 'Medium', 'High'], category: 'General' },
      { id: 'grid', label: 'Grid', type: 'enum', def: 'False', options: BOOL_OPTIONS, category: 'General' },
      { id: 'update_time', label: 'Update Period', type: 'number', def: 0.1, category: 'General' },
      { id: 'legend', label: 'Legend', type: 'enum', def: 'True', options: BOOL_OPTIONS, category: 'Config' },
      { id: 'axislabels', label: 'Axis Labels', type: 'enum', def: 'True', options: BOOL_OPTIONS, category: 'Config' },
      ...lineParams({ lineCount: nconn, waterfall: true }),
    ], dtype: 'complex' },
};
