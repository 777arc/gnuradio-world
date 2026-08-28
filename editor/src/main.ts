// GNU Radio WebAssembly Flowgraph Editor (TypeScript).
// Loads the block library, lets you place/connect/configure blocks on an SVG
// canvas, and Runs the flowgraph by handing JSON to the C++/WASM runner via a
// URL hash (runner.html#<encoded json>).

import './editor.css';
import { dumpGrc, parseGrc, type GrcDoc, type GrcScalar } from './grc';
import { ceilToGrid, centeredPortSlot, constrainBlockPosition, SNAP_GRID_SIZE } from './grid';
import { arrangeFlowgraph, type LayoutNode } from './layout';
import { evaluate as evalExpr, buildScope, formatValue as fmtExprVal, serializeForRunner, type Scope, type Value } from './expr';
import { wrapNoteText, NOTE_FONT_SIZE } from './note';
import {
  layoutColumns,
  packLayout,
  parseTiles,
  placeTile,
  rowsUsed,
  serializeTiles,
  type TileMap,
  type WidgetRef,
} from './gui-layout';
import {
  EXAMPLES_REPO, examplePath, newExampleFileUrl, newRepoFileUrl, sanitizeExampleName,
} from './contribute';
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
  installAudioResumeRelay,
} from './audio';
import { EVALUATED_DTYPES, VARIABLE_IDS, effectiveDtype, validateFlowgraph } from './validation';
import {
  type UsbPreparationProblem,
  type UsbRadio,
} from './usb-radio';
import { RTLSDR_RADIO } from './rtlsdr';
import { PLUTOSDR_RADIO } from './plutosdr';
import { HACKRF_RADIO } from './hackrf';
import {
  displaySi,
  encodeRecordingPath,
  isCi16Datatype,
  normalizeRecordingKey,
  RECORDING_ID,
  RECORDING_PARAM,
  recordingDataPath,
  recordingFromR2Index,
  recordingUrl,
  recordingsBucketUrl,
  type ExampleRecording,
  type FileSourceFormat,
  type R2RecordingIndexEntry,
} from './recording-catalog';
import {
  sanitizeSigmfBase,
  SIGMF_FILE_PARAM,
  SIGMF_SINK_ID,
  SIGMF_SOURCE_ID,
  type SigmfBinding,
} from './sigmf-blocks';
import {
  encodeExamplePath,
  exampleFileName,
  exampleUrl,
  normalizeExamplePath,
} from './example-catalog';
import {
  BLOCK_COMMENT_ID,
  blockFlags,
  installGeneratedBlocks,
  installNativeBlockParams,
  numericOrExpression,
  portOptional,
} from './block-library';
import {
  EPY_BLOCK_ID, EPY_IO_CACHE_PARAM, EPY_SOURCE_PARAM, epyDefForCache,
  epySourceError, isForeignIoCache, pythonRuntime,
} from './epy';
import {
  JS_BLOCK_ID, JS_IO_PARAM, JS_LOCAL_SOURCE_PARAM, JS_SOURCE_PARAM,
  acceptJsSource, exerciseJsSource, generateBlockYml, isJsSourceAccepted, jsDefForCache,
  jsIntrospector, jsSourceError, jsSourceOf, jsSourceParamOf, listLocalJsBlocks,
  parseJsIo, sourceHash,
  sanitizeBlockId, saveLocalJsBlock, serializeJsIo, setJsSourceError,
  type JsBlockIo, type LocalJsBlock,
} from './js-block';
import { showDebugInfo } from './debug-panel';
import { showVersionsDialog } from './versions';
import { isBenchmarkFrameSource, showBenchmarkDialog } from './benchmark';
import {
  isSdrSpeedTestFrameSource,
  showSdrSpeedTestDialog,
} from './sdr-speed-test';
import type { CatalogEntry } from './ai/catalog';
import type { AiReadDeps } from './ai/tools';
import type { HarnessDeps, RunAuthorization } from './ai/harness';
import { createAiPanel, type AiPanel } from './ai/panel';
import { TrainingSession, type TrainingProgress } from './training';
import {
  dismissUnpacedRunWarning,
  shouldWarnAboutUnpacedRun,
  unpacedRunWarningDismissed,
} from './run-pacing';
import aiSystemPrompt from './ai/system-prompt.md?raw';
import {
  buildMenuBar,
  buildToolbar,
  closeMenus,
  installMenuDismissal,
  type Tool,
  type TopMenu,
} from './app-chrome';
import {
  makePaletteSearch,
  renderPaletteTree,
  type LibraryBlock,
} from './palette-tree';
import { EditorGraphState } from './editor-state';
import { showVariableEditor as openVariableEditor } from './variable-editor';
import {
  showPropertiesDialog,
  type PropertiesDialogDeps,
} from './properties-dialog';
import { renderCanvas } from './canvas-renderer';
import { CanvasConnectionController } from './canvas-connections';
import { CanvasGestureController } from './canvas-gestures';
import {
  WorkspaceTabsController,
  type WorkspaceTab,
  type WorkspaceTabEntry,
} from './workspace-tabs';
import {
  runFlowgraph,
  stopFlowgraph,
  takeRecordingFiles,
  updateRunningCanvasState as updateRunCanvasState,
  type RunOptions,
  type RunSessionDeps,
  type RunSessionState,
  type RunnerInputFile,
} from './run-session';
import { createRecordingTabs } from './recording-tabs';
import { createExamplePalette } from './example-palette';
import { createRecordingPalette } from './recording-palette';

const SVGNS = 'http://www.w3.org/2000/svg';
const el = (id: string) => document.getElementById(id)!;
/**
 * The WebUSB radios the editor knows how to wire up: a device picker in the
 * Properties dialog, the device a block face resolves to, and the permission
 * prompt on the Run click. Adding one is adding it here. See ./usb-radio.
 */
const USB_RADIOS: UsbRadio[] = [RTLSDR_RADIO, PLUTOSDR_RADIO, HACKRF_RADIO];
const radioForDtype = (dtype?: string): UsbRadio | undefined =>
  USB_RADIOS.find(radio => radio.dtype === dtype);
// ?training=<example path> opens that example as a lesson template rather than
// putting its real blocks on the canvas. It wins over `embed`: an embedded
// layout has no palette, so it would be impossible to complete the lesson.
const TRAINING_EXAMPLE = (() => {
  const value = new URLSearchParams(location.search).get('training');
  return value?.trim() || null;
})();
// ?embed=1 — the layout another site frames. Declared up here rather than beside
// the rest of the embed wiring further down because the history functions, which
// are declared before it, keep its "open in GNU Radio World" link current.
const EMBEDDED = (() => {
  if (TRAINING_EXAMPLE) return false;
  const value = new URLSearchParams(location.search).get('embed');
  return value !== null && value !== '0' && value.toLowerCase() !== 'false';
})();
// ?no_scroll=1 and ?no_controls=1 — both no-ops without `embed`, same truthy
// rule as it and `click_to_load`. See the embed-controls/embed-no-scroll wiring
// further down.
const EMBED_NO_SCROLL = (() => {
  const value = new URLSearchParams(location.search).get('no_scroll');
  return value !== null && value !== '0' && value.toLowerCase() !== 'false';
})();
const EMBED_NO_CONTROLS = (() => {
  const value = new URLSearchParams(location.search).get('no_controls');
  return value !== null && value !== '0' && value.toLowerCase() !== 'false';
})();
const embedRun = el('embedRun') as HTMLButtonElement;
const embedOpen = el('embedOpen') as HTMLAnchorElement;
const embedZoom = el('embedZoom');
const embedPlayBlock = el('embedPlayBlock') as HTMLButtonElement;
const embedOpenBlock = el('embedOpenBlock') as HTMLAnchorElement;
const trainingNodesG = el('trainingNodes'), trainingWiresG = el('trainingWires');
const nodesG = el('nodes'), wiresG = el('wires'), selectionG = el('selectionOverlay');
const svg = el('svg') as unknown as SVGSVGElement;

const state = new EditorGraphState();
let trainingSession: TrainingSession | null = null;
let autoScrollLog = true;
let zoom = 1;
let hideDisabled = false;
// Native GRC's canvas display preferences. These affect only presentation: the
// underlying blocks and their raw parameter expressions still serialize and run
// exactly as before.
let hideVariables = false;
let showParameterExpressions = false;
let showParameterValues = true;
let autoHidePortLabels = false;
let showPropertiesFieldColors = false;
// Unlike desktop GRC's historical preference default, the WASM editor starts
// with snapping enabled so newly opened sessions get aligned movement.
let snapToGrid = true;
// Native GRC draws no grid at all — the canvas is one flat brush, and the only
// grid it has is the invisible one Snap to Grid rounds to. The drawn grid is
// this editor's own, on by default because it is what makes the snapping it
// also defaults to legible.
let showGrid = true;
// GRC's grc/show_block_comments preference defaults to true. Comments remain
// editable and serializable while hidden; this only controls their canvas text.
let showBlockComments = true;
// GRC's View ▸ Show All Block IDs (`grc/show_block_ids`): off by default, and
// when on it forces the otherwise hidden `id` parameter onto every block face
// and into every Properties dialog.
let showAllBlockIds = false;
let paletteSearch: HTMLInputElement | null = null;

function canvasBlockHidden(inst: Inst): boolean {
  return (hideDisabled && !inst.enabled) || (hideVariables && VARIABLE_IDS.has(inst.id));
}

// Whether this block exposes its instance ID, as native GRC decides it: the
// block's `show_id` flag, or the global override. The Options block is the one
// exception to native, which shows the flowgraph id there: this editor derives
// that id from the Title instead, so the block has no ID to show or edit and
// the override must not conjure one.
// Keyed by block id rather than through defFor(): show_id is a property of the
// block *type*, and a Python Block's synthesized definition inherits it unchanged.
function blockIdVisible(inst: Inst): boolean {
  if (inst.id === OPTIONS_ID) return false;
  return showAllBlockIds || !!RUNNABLE[inst.id]?.showId;
}

// block-defs.ts contains the hand-written schemas available before the palette
// fetch resolves. Give them native's implicit Comment parameter synchronously,
// so even the initial Options instance has the complete schema. The palette
// installer repeats this after adding generated-only definitions.
installNativeBlockParams();

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
// wants a picture, where a File Source takes any IQ file.
const LOCAL_FILE_ACCEPT: Record<string, string> = {
  paint_image_source: 'image/*',
};

// GR World Recording (RECORDING_ID/RECORDING_PARAM, defined beside the .grc
// migration in recording-catalog.ts) is a hosted SigMF recording, named by the
// base key the bucket index calls `base_filename`. It is the browser-only
// counterpart of File Source, which — as in native GNU Radio — opens a file on
// this computer and nothing else. Its parameter's dtype is browser-only too:
// the Properties dialog renders it as a chooser over the live recordings index.
const RECORDING_DTYPE = 'gr_world_recording';

// Public HTTP Recording: raw IQ at any public URL, for data hosted somewhere
// this project does not control. Its URL is not a path the runner can resolve,
// so the Run path rewrites this parameter the way it rewrites a local file's —
// see HTTP_RECORDING_PREFIX.
const HTTP_RECORDING_ID = 'wasm_public_http_recording';
const HTTP_RECORDING_PARAM = 'url';
const HTTP_RECORDING_PREFIX = '/recordings/external/';

// The parameter the Run path rewrites to a path the runner resolves a browser
// binding through, per block. A local file becomes /local-files/..., a public
// URL /recordings/external/...; GR World Recording is absent because the runner
// derives its path from the recording key itself.
const RUN_BOUND_PARAMS: Record<string, string> = {
  ...LOCAL_FILE_PARAMS,
  [HTTP_RECORDING_ID]: HTTP_RECORDING_PARAM,
  // SigMF Source reads the .sigmf-data of a bound pair, through the same
  // /local-files/... path a File Source's file resolves through.
  [SIGMF_SOURCE_ID]: SIGMF_FILE_PARAM,
  // SigMF Sink is the one block whose path is an *output*: /local-output/...,
  // kept distinct so the runner's two binding maps cannot be confused.
  [SIGMF_SINK_ID]: SIGMF_FILE_PARAM,
};

const localFilesByToken = new Map<string, File>();
// A SigMF Source's two files and the metadata read out of them, and a SigMF
// Sink's chosen output folder. Both keyed by the same per-instance
// `localFileToken`, and both session-only for the same reason a File Source's
// file is: a .grc keeps a name, never a handle.
const sigmfBindingsByToken = new Map<string, SigmfBinding>();
const sigmfOutputDirsByToken = new Map<string, FileSystemDirectoryHandle>();
function newLocalFileToken(): string {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

// Publish a recording's sample rate as the flowgraph's samp_rate -- what SigMF
// Source's "Use as samp_rate" toggle is for. Reports whether anything changed;
// the caller owns the redraw and the history entry, so picking a recording and
// the rate it brought with it are one undo step rather than two.
//
// A native GRC flowgraph is born with a samp_rate variable (makeSampRateInst(),
// matching upstream's default_flow_graph.grc), which is why upstream flowgraphs
// refer to it as though it were always there -- but it is an ordinary Variable
// once placed, so it can have been renamed or deleted. Say so rather than
// conjuring one back: a flowgraph without a samp_rate has not asked for one.
function applySampRateFromSigmf(rate: number, source: string): boolean {
  const variable = state.insts.find(i => i.id === 'variable' && i.name === 'samp_rate');
  if (!variable) {
    log(`note: "${source}" is ${displaySi(rate, 'Hz')}, but this flowgraph has no ` +
        `samp_rate variable to write it to`);
    return false;
  }
  const value = String(rate);
  if (String(variable.params.value) === value) return false;
  variable.params.value = value;
  log(`samp_rate ← ${displaySi(rate, 'Hz')} from "${source}"`);
  return true;
}

// The rate a SigMF Source's committed state asks to publish, if any. Read on the
// way out of the Properties dialog rather than as the reader clicks, so that
// Cancel cancels this too -- and so that switching the toggle on with a
// recording already bound publishes it, not just re-picking the files.
function sigmfSampRateToPublish(
  id: string, params: Record<string, any>, token: string | undefined,
): { rate: number; source: string } | null {
  if (id !== SIGMF_SOURCE_ID || String(params.use_samp_rate) !== 'True') return null;
  const bound = token ? sigmfBindingsByToken.get(token) : undefined;
  return bound?.sampleRate ? { rate: bound.sampleRate, source: bound.base } : null;
}

const ISHORT_TO_COMPLEX_ID = 'blocks_interleaved_short_to_complex';

// An interleaved 16-bit recording is a *short* stream, which is GNU Radio's own
// convention for such a file and not something anyone wants for its own sake:
// what they want is complex samples, one IShort To Complex away. The Recordings
// palette already drops that block alongside a GR World Recording for a ci16
// card (addRecordingBlock), so picking a ci16 recording for a SigMF Source does
// the same rather than leaving the reader to notice the hint and wire it up.
//
// Only ever *adds*: an output that already goes somewhere is a flowgraph the
// reader built, and a second converter appearing beside it would be an edit
// nobody asked for. Returns whether it added one, so the caller can log it.
function attachIShortToComplex(block: Inst): boolean {
  if (state.conns.some(c => c.from === block.uid)) return false;
  if (!RUNNABLE[ISHORT_TO_COMPLEX_ID]) {
    log('note: IShort To Complex is not available, so this recording’s short ' +
        'stream has to be converted by hand');
    return false;
  }
  const converter = addBlock(
    ISHORT_TO_COMPLEX_ID,
    block.x + geom(block).w + 80,
    block.y,
    { vector_input: 'False', scale_factor: 32767.0 },
    false,
  );
  if (!converter) return false;
  state.conns.push({ from: block.uid, fp: 0, to: converter.uid, tp: 0 });
  return true;
}

// Whether a SigMF Source's committed state describes an interleaved-integer
// recording, which is the case that needs the converter above.
function sigmfNeedsIShortToComplex(id: string, token: string | undefined): boolean {
  if (id !== SIGMF_SOURCE_ID) return false;
  const bound = token ? sigmfBindingsByToken.get(token) : undefined;
  return !!bound && isCi16Datatype(bound.datatype);
}

type EditorSnapshot = GraphSnapshot & { training?: TrainingProgress };
const graphHistory: EditorSnapshot[] = [];
let historyIndex = -1;
let historyReady = false;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));
function snapshot(): EditorSnapshot {
  return clone({ insts: state.insts, conns: state.conns, counter: state.counter,
    ...(trainingSession ? { training: trainingSession.capture() } : {}) });
}
// The three places the canvas changes as a whole are also the three that decide
// where an embed's "open in GNU Radio World" link points: an untouched flowgraph
// links to itself by name, an edited one carries the edit.
function resetHistory() {
  graphHistory.length = 0; graphHistory.push(snapshot()); historyIndex = 0;
  void refreshEmbedOpen();
}
function recordHistory() {
  if (!historyReady) return;
  graphHistory.splice(historyIndex + 1);
  graphHistory.push(snapshot());
  if (graphHistory.length > 100) graphHistory.shift();
  historyIndex = graphHistory.length - 1;
  updateRunningCanvasState();
  void refreshEmbedOpen();
}
function restoreHistory(index: number) {
  if (index < 0 || index >= graphHistory.length) return;
  historyIndex = index;
  void refreshEmbedOpen();
  const restored = clone(graphHistory[index]);
  state.insts = restored.insts; state.conns = restored.conns; state.counter = restored.counter;
  trainingSession?.restore(restored.training);
  state.clearSelection(); cancelConnect();
  render();
  updateRunningCanvasState();
}
function undo() { restoreHistory(historyIndex - 1); }
function redo() { restoreHistory(historyIndex + 1); }

// The console pane holds at most this many lines. A running flowgraph can print
// continuously (a Message Debug on a fast frame source emits hundreds of lines a
// second), and an unbounded textContent grows without limit and gets slower with
// every append, so drop the oldest lines once the pane is full.
const LOG_MAX_LINES = 4000;
const logSubscribers = new Set<(lines: string[]) => void>();

// Append a burst in one pass. A running flowgraph delivers stdout in batches of
// up to a couple of hundred lines; rewriting the pane once per batch instead of
// once per line keeps the cost proportional to the batch, not to batch x buffer.
function logLines(lines: string[]) {
  if (!lines.length) return;
  for (const subscriber of logSubscribers) subscriber([...lines]);
  const l = el('log');
  const existing = l.textContent ? l.textContent.split('\n') : [];
  if (existing.length && existing[existing.length - 1] === '') existing.pop();
  const all = existing.concat(lines);
  const kept = all.length > LOG_MAX_LINES ? all.slice(all.length - LOG_MAX_LINES) : all;
  l.textContent = kept.join('\n') + '\n';
  if (autoScrollLog) l.scrollTop = l.scrollHeight;
  // Collapsed, the pane is where a runner error would have gone unseen, so the
  // collapse bar carries a dot until it is opened again.
  const workspace = el('workspace');
  if (workspace.classList.contains('console-hidden')) workspace.classList.add('console-unread');
}

function log(s: string) { logLines([s]); }

// GRC-style geometry: title bar + "Label: value" parameter rows, typed ports.
// The two text sizes are the app's own: 16px for body text everywhere, one step
// up for a block's title. They have to match `.blk text.title` and
// `.blk text.param` in editor.css, because the measurements below are what size
// the box the CSS then draws the text into.
const TITLE_FONT_SIZE = 18, PARAM_FONT_SIZE = 16;
// PAD is the block's inner padding, and it is one number on all four sides:
// TITLE_BASELINE puts the title's cap line PAD below the top edge, TEXT_PAD_*
// are the same PAD left and right, and the row block is positioned so the last
// parameter's descender clears the bottom edge by PAD as well (see rowsTop).
const TITLE_H = 26, ROW_H = 20, PAD = 8, PORT_H = 17;
// Baselines within the title bar and within a parameter row: PAD under the top
// edge for the title, and the row's own text sitting on the same rhythm.
const TITLE_BASELINE = 21, ROW_BASELINE = 15;
// A subtitle under the title says where a non-core block came from (gr-ham), or
// which language supplies an inline block's source (Python/JavaScript). Source
// provenance wins if an OOT eventually ships a non-C++ block: the package a user
// needs is the promise this label makes. Size and colour set it apart from the
// title; SUBTITLE_GAP is deliberately tight — a subtitle rather than a second
// line of the name — and SUBTITLE_H is the height it adds to the title bar.
const SUBTITLE_FONT_SIZE = 12, SUBTITLE_H = 14, SUBTITLE_GAP = 14;
const subtitleFor = (inst: Inst, d: RunnableDef) => d.ootModule ||
  (inst.id === EPY_BLOCK_ID ? 'Python' : inst.id === JS_BLOCK_ID ? 'JavaScript' : '');
// Ports sit three grid cells apart, which is what gives a multi-port block room
// to breathe between its tabs. Block heights stay rounded to *two* cells, not to
// the pitch: that keeps the group's midpoint on the grid and, unlike rounding to
// three, leaves the same slack under every block whatever its row count (see
// BODY_SLACK). An even-sized group would straddle that midpoint by half a pitch
// and land 5px off the grid, so `centeredPortSlot` snaps the group itself —
// otherwise a one-output block could never be lined up with either input of a
// two-input block, whatever the grid does.
const PORT_PITCH = SNAP_GRID_SIZE * 3;
const BLOCK_H_STEP = SNAP_GRID_SIZE * 2;
// Horizontal breathing room around the title/parameter text inside a block.
const TEXT_PAD_L = 8, TEXT_PAD_R = 8;
// Port labels are the one piece of canvas text kept below the app's 16px: the
// tab has to stay inside the 20px port pitch, and "in0"/"out0" is a legend for
// the tab rather than something read as prose.
const PORT_FONT_SIZE = 14, PORT_LABEL_PAD = 6, PORT_MIN_W = 20;
// Native GRC's PORT_LABEL_HIDDEN_WIDTH: compact enough to read as a connector
// tab rather than an empty labelled box, while still landing on this editor's
// 10px grid.
const PORT_HIDDEN_W = 10;
// A face with dozens of parameters (dvbs2_bbheader_source has 37) grows into a
// wall that dwarfs everything else on the canvas, so it is cut to this many
// lines with the last one saying how many are missing. Properties still shows
// the whole set; only the drawn face is capped.
const MAX_FACE_ROWS = 14, MORE_ROW_ID = '__more';
// Floor on a block's drawn width, so a one-word block is still a box rather than
// a sliver. Sized against the title font, which is the widest text a block has.
const BLOCK_MIN_W = 140;
// Slack between the title bar plus the rows and the block's bottom edge. Half of
// it lands above the first row (rowsTop centers the block of rows) and half
// below the last one, where together with the row's own descender room it comes
// to exactly PAD — so the gap under the last parameter matches the gap over the
// title and the gap at either side. `geom` gets the same number for free: with
// TITLE_H ≡ 6 and ROW_H ≡ 0 mod BLOCK_H_STEP, rounding the height up to that
// step always leaves 14.
const BODY_SLACK = 14;
// Rows sit centered in the body: the height is rounded up to the port pitch, and
// giving that slack to the bottom alone left the text visibly high in the block.
const rowsTop = (h: number, rows: number, headH = TITLE_H) => (h + headH - rows * ROW_H) / 2;

function templateScope(params: Record<string, any>): Scope {
  const scope: Scope = { ...varScope };
  for (const [id, raw] of Object.entries(params)) {
    const text = String(raw ?? '').trim();
    if (typeof raw === 'number' || typeof raw === 'boolean') scope[id] = raw;
    else if (text === 'True' || text === 'False') scope[id] = text === 'True';
    else if (text && Number.isFinite(Number(text))) scope[id] = Number(text);
    else scope[id] = listParam(text);
  }
  return scope;
}

// A parameter holding a *list* is worth evaluating before it goes into a
// template scope, because a port template can count it: the Bercurve Sink's
// input multiplicity is `len(esno)*2*num_curves`, and with `esno` left as the
// text "numpy.arange(0.0, 4.0, .5)" that len() is the length of the string —
// 26 input ports where the flowgraph wants 8. Only a value that evaluates to a
// list is substituted: a number or a bool would change how an existing `hide`
// or `optional` expression reads, while nothing can ask a *string* parameter
// for its length and mean it.
function listParam(text: string): Value {
  if (!/[[(]/.test(text)) return text;
  const result = evalExpr(text, varScope);
  return result.ok && Array.isArray(result.value) ? result.value : text;
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
  // GRC's "a count, unless an explicit list overrides it" idiom:
  //   ${ nchans if outchans is None else len(outchans) }
  // expr.ts has no conditional expressions (nor `is`), so this would otherwise
  // fall back to a single port -- and for the Hierarchical Polyphase
  // Channelizer, which is where it appears, one port is not a cosmetic loss: a
  // hier block's io_signature fixes the output count, so every channel it does
  // not bring out is an unconnected port the runner refuses to start with.
  const listOverride = String(raw ?? '').trim().match(
    /^\$\{\s*(\w+)\s+if\s+(\w+)\s+is\s+None\s+else\s+len\(\s*\2\s*\)\s*\}$/);
  if (listOverride) {
    const override = listParam(String(params[listOverride[2]] ?? 'None').trim());
    const count = Array.isArray(override)
      ? override.length
      : Number(templateValue('${' + listOverride[1] + '}', params));
    return Number.isFinite(count) && count >= 1 ? Math.trunc(count) : 1;
  }
  const value = templateValue(raw, params);
  const number = Number(value);
  // GRC's EvaluatedPInt falls back to one for zero, negative or invalid values.
  return Number.isFinite(number) && number >= 1 ? Math.trunc(number) : 1;
}

// Blocks whose parameters and ports are not a property of their block id: they
// come from source the user wrote, so the definition is synthesized per instance
// from the interface that instance caches. Both blocks that work this way
// register here rather than each adding a branch to defFor -- the JS Block's
// parameters are derived rather than declared, and the repo's most common
// hand-authored-flowgraph failure is the editor silently dropping a parameter its
// schema does not declare. This map is what stands between that trap and them.
const DERIVED = new Map<string, (base: RunnableDef, inst: Inst) => RunnableDef>([
  [EPY_BLOCK_ID, (base, inst) => epyDefForCache(base, inst.params[EPY_IO_CACHE_PARAM])],
  [JS_BLOCK_ID, (base, inst) => jsDefForCache(base, inst.params[JS_IO_PARAM])],
]);

// A block's definition. For everything but those two this is the schema RUNNABLE
// holds for its block id.
//
// Every consumer that reads a definition *for an instance* goes through here.
// The id-keyed lookups that remain -- the palette, RUNNABLE[OPTIONS_ID] -- are
// asking a different question and are right to stay as they are.
function defFor(inst: Inst): RunnableDef {
  const base = RUNNABLE[inst.id];
  const derive = DERIVED.get(inst.id);
  return base && derive ? derive(base, inst) : base;
}

function resolvedPorts(inst: Inst, kind: 'in' | 'out'): ResolvedPort[] | null {
  const d = defFor(inst);
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
        optional: portOptional(port.optional, inst.params),
        hidden,
      });
      if (domain === 'stream') ++streamIndex;
    }
  }
  return result;
}

function legacyPortCount(inst: Inst, kind: 'in' | 'out'): number {
  const d = defFor(inst);
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
  const d = defFor(inst);
  const domains = kind === 'in' ? d.inDomains : d.outDomains;
  const types = kind === 'in' ? d.inTypes : d.outTypes;
  const ids = kind === 'in' ? d.inIds : d.outIds;
  const labels = kind === 'in' ? d.inLabels : d.outLabels;
  const indices = kind === 'in' ? d.inStreamIndices : d.outStreamIndices;
  const optional = kind === 'in' ? d.inOptional : d.outOptional;
  const domain = domains?.[i] || 'stream';
  // Ports of a hand-written schema carry no vlen template of their own, but the
  // whole GRC family that has a Vector Length parameter puts `vlen: ${vlen}` on
  // every port, so read it off the instance when the schema declares one. Null
  // Sink is why this matters: without it, terminating any vector stream is
  // refused as a vector-length mismatch.
  const vlen = d.params.some(p => p.id === 'vlen')
    ? Number(templateValue('${vlen}', inst.params))
    : 1;
  return {
    dtype: types?.[i] || '',
    vlen: Number.isFinite(vlen) && vlen >= 1 ? Math.trunc(vlen) : 1,
    domain,
    id: ids?.[i] ?? (domain === 'stream' ? String(indices?.[i] ?? i) : String(i)),
    name: labels?.[i] || `${kind}${legacyPortCount(inst, kind) > 1 ? i : ''}`,
    streamIndex: domain === 'stream' ? (indices?.[i] ?? i) : -1,
    optional: optional?.[i] ?? false,
    hidden: false,
  };
}

function visiblePortIndices(inst: Inst, kind: 'in' | 'out'): number[] {
  const count = portCount(inst, kind);
  return Array.from({ length: count }, (_, i) => i)
    .filter(i => !portMeta(inst, kind, i).hidden);
}

function remapConnectionsForPortChange(inst: Inst, nextParams: Record<string, any>) {
  const def = defFor(inst);
  if (!def.inputTemplates && !def.outputTemplates) return;
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
  state.conns = state.conns.flatMap(connection => {
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
  const d = defFor(inst);
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
  const d = defFor(inst);
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
  if (connectionController.portLabelHidden(`${inst.uid}:${kind}:${i}`))
    return PORT_HIDDEN_W;
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
function rebuildScope() { varScope = buildScope(state.insts); }

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
interface ParamDisplay {
  expression?: string;
  value: string;
}

function paramDisplay(p: ParamDef, raw: any): ParamDisplay {
  const cut = (s: string, style = 0) => truncateValue(p.label, s, style);
  const fileStyle = p.dtype === 'file_open' || p.dtype === 'file_save' ? -1 : 0;
  // A radio's device is the one parameter whose empty value means something
  // ("first available"), so it resolves to the radio it will actually open
  // rather than drawing an empty row. See UsbRadio.display().
  const radio = radioForDtype(p.dtype);
  if (radio) return { value: cut(radio.display(String(raw ?? ''))) };
  if (p.type !== 'number' && !p.raw) {
    const optionIndex = p.options?.indexOf(String(raw)) ?? -1;
    const display = optionIndex >= 0 ? p.optionLabels?.[optionIndex] ?? raw : raw;
    return { value: cut(fmtVal(display), fileStyle) };
  }
  if (typeof raw === 'number') return { value: cut(fmtVal(raw)) };
  const s = String(raw ?? '').trim();
  if (!s) return { value: '' };
  const r = evalExpr(s, varScope);
  if (!r.ok) return { value: cut(fmtVal(raw), fileStyle) };
  const value = typeof r.value === 'number'
    ? cut(fmtVal(r.value))
    : cut(fmtExprVal(r.value), Array.isArray(r.value) ? 1 : 0);
  // Native only treats text as an expression when evaluation changes what is
  // displayed. A literal remains an ordinary value even with the expression
  // toggle enabled.
  const evaluated = s !== String(r.value);
  if (evaluated && showParameterExpressions) {
    return {
      expression: cut(s, p.raw && Array.isArray(r.value) ? 1 : fileStyle),
      value: showParameterValues ? value : '',
    };
  }
  return { value };
}

interface FaceRow { id: string; l: string; v: string; expression?: string }
const faceRowText = (row: FaceRow) =>
  (row.expression || '') + (row.expression && row.v ? '=' : '') + row.v;

// The red message drawn under an invalid block, at `.blk text.validation-error`
// in editor.css: line pitch, and the average glyph width the wrap column is
// estimated from (the text is proportional, so this only has to be close).
const ERROR_LINE_H = 17, ERROR_CHAR_W = 8;
// Native positions the comment text immediately below the block and uses the
// application's ordinary (non-bold) font. A small top gap corresponds to the
// text-document margin in Qt and BLOCK_LABEL_PADDING in the GTK canvas.
const COMMENT_FONT_SIZE = 14, COMMENT_LINE_H = 17, COMMENT_BASELINE = 14, COMMENT_GAP = 4;

interface BlockCommentGeometry {
  lines: string[];
  width: number;
  height: number;
}

function blockCommentGeometry(inst: Inst): BlockCommentGeometry {
  const value = String(inst.params[BLOCK_COMMENT_ID] ?? '');
  if (!showBlockComments || !value) return { lines: [], width: 0, height: 0 };
  // One SVG text node per line preserves native's explicit line breaks without
  // treating a comment imported from an untrusted .grc as executable markup.
  const lines = value.split(/\r\n?|\n/);
  return {
    lines,
    width: Math.ceil(Math.max(0, ...lines.map(line => textW(line, COMMENT_FONT_SIZE)))),
    height: COMMENT_GAP + lines.length * COMMENT_LINE_H,
  };
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

function validateGraph(blocks: Inst[] = state.insts, connections: Conn[] = state.conns): ValidationIssue[] {
  const issues = validateFlowgraph(blocks, connections,
                                   { portCount, portMeta, portType, def: defFor });
  // A Python or JS Block whose source could not be read is invalid, the way it is
  // in native GRC (embedded_python.py attaches `_epy_reload_error` to the Code
  // parameter). The rule lives here rather than in validation.ts because the
  // error comes from having *run* the source, not from anything in the .grc.
  for (const block of blocks) {
    const message = block.id === EPY_BLOCK_ID ? epySourceError(block.uid)
      : block.id === JS_BLOCK_ID ? jsSourceError(block.uid) : '';
    // Blocking only while the block is active, as validation.ts treats every
    // other issue: a disabled block with broken code cannot break a run.
    if (message)
      issues.push({ uid: block.uid,
                    field: block.id === JS_BLOCK_ID ? JS_SOURCE_PARAM : EPY_SOURCE_PARAM,
                    message, blocking: block.enabled && !block.bypassed });

    // A SigMF Sink's name is the stem of two real files, so an empty one has
    // nothing to write to. Unlike a source's missing binding -- which is a
    // session fact and belongs on the Run path -- this is wrong in the .grc
    // itself, so it is a validation error and shows on the block.
    if (block.id === SIGMF_SINK_ID &&
        !sanitizeSigmfBase(String(block.params[SIGMF_FILE_PARAM] || '')))
      issues.push({ uid: block.uid, field: SIGMF_FILE_PARAM,
                    message: 'Give the recording a name; both files take it as their stem.',
                    blocking: block.enabled && !block.bypassed });
  }
  return issues;
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
  const rows: FaceRow[] = lines.map(line => ({ id: 'note', l: '', v: line }));
  let w = textW(d.label, TITLE_FONT_SIZE, true);
  for (const line of lines) w = Math.max(w, textW(line, NOTE_FONT_SIZE));
  return {
    d, rows, subtitle: '', headH: TITLE_H,
    h: TITLE_H + Math.max(rows.length * ROW_H, ROW_H) + BODY_SLACK,
    w: Math.max(BLOCK_MIN_W, Math.ceil(w) + TEXT_PAD_L + TEXT_PAD_R),
  };
}

// The GUI Layout block's body is a miniature of the runner window: one rectangle
// per widget, where that widget will actually appear. A parameter row holding
// `{"qtgui_freq_sink_x_0":[0,0,8,4]}` tells a reader nothing, and the whole
// point of the block is the arrangement, so the arrangement is what it shows.
// Same idea as the Note block above, whose body is its text.
const LAYOUT_THUMB_W = 240;      // px of block face the grid is drawn across
const LAYOUT_THUMB_CELL_H = 15;  // px per grid row in the miniature
const LAYOUT_THUMB_MAX_ROWS = 14;
const LAYOUT_THUMB_FONT = 9;
export interface LayoutThumbTile { name: string; x: number; y: number; w: number; h: number }
// Shorten to fit a measured width, ellipsis included. truncateValue() above
// counts characters, which is right for a parameter row in a monospaced column
// and wrong for a tile whose width is whatever fraction of the grid it spans.
function truncateToWidth(text: string, maxWidth: number, fontSize: number): string {
  if (textW(text, fontSize) <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && textW(cut + '…', fontSize) > maxWidth) cut = cut.slice(0, -1);
  return cut + '…';
}
function layoutGeom(inst: Inst, d: RunnableDef) {
  const columns = layoutColumns(inst.params.columns);
  const tiles = layoutTilesFor(inst);
  // An empty grid still draws its outline, so the block reads as "nothing is
  // placed here yet" rather than as a block with a missing body.
  const rows = Math.max(1, Math.min(rowsUsed(tiles), LAYOUT_THUMB_MAX_ROWS));
  const cellW = LAYOUT_THUMB_W / columns;
  const thumb: LayoutThumbTile[] = [];
  for (const [name, tile] of Object.entries(tiles)) {
    if (tile.row >= LAYOUT_THUMB_MAX_ROWS) continue;   // clipped; the dialog shows all
    thumb.push({
      name,
      x: tile.col * cellW, y: tile.row * LAYOUT_THUMB_CELL_H,
      w: tile.w * cellW,
      h: Math.min(tile.h, LAYOUT_THUMB_MAX_ROWS - tile.row) * LAYOUT_THUMB_CELL_H,
    });
  }
  const thumbH = rows * LAYOUT_THUMB_CELL_H;
  // The title bar is exactly as tall as the title: TITLE_BASELINE puts an 18px
  // cap line at PAD, and the descenders of "GUI Layout" land on TITLE_H itself.
  // So the grid needs a gap of its own under it, or the two touch. PAD on both
  // sides of the grid rather than BODY_SLACK underneath it, which would leave
  // the block padded at the bottom and not at the top.
  return {
    d, rows: [] as FaceRow[], subtitle: '', headH: TITLE_H,
    h: TITLE_H + PAD + thumbH + PAD,
    w: Math.max(BLOCK_MIN_W, LAYOUT_THUMB_W + TEXT_PAD_L + TEXT_PAD_R),
    thumb, thumbH, thumbTop: TITLE_H + PAD,
  };
}

function geom(inst: Inst) {
  const d = defFor(inst);
  if (inst.id === NOTE_ID) return noteGeom(inst, d);
  if (inst.id === LAYOUT_ID) return layoutGeom(inst, d);
  // Categorized parameters belong in the modal notebook. Native GRC also keeps
  // parameters marked `hide: part` or `hide: all` off the block face.
  const rows: FaceRow[] = d.params
    .filter(p => {
      const hide = parameterHideValue(p.hide, inst.params);
      return !p.category && hide !== 'part' && hide !== 'all' &&
        !(p.hideIfEmpty && !String(inst.params[p.id] ?? '').trim());
    })
    .map(p => {
      const display = paramDisplay(p, inst.params[p.id]);
      return { id: p.id, l: p.label + ': ', v: display.value,
        expression: display.expression };
    });
  // A block's identifier is its instance name rather than a regular parameter.
  // Native GRC only draws it for the `show_id` blocks — Variable, QT GUI Range
  // and friends, whose ID *is* the name other blocks reference — or when the
  // View ▸ Show All Block IDs toggle is on.
  if (blockIdVisible(inst))
    rows.unshift({ id: 'id', l: 'ID: ', v: truncateValue('ID', inst.name) });
  if (rows.length > MAX_FACE_ROWS) {
    const hidden = rows.length - (MAX_FACE_ROWS - 1);
    rows.length = MAX_FACE_ROWS - 1;
    rows.push({ id: MORE_ROW_ID, l: '', v: `… ${hidden} more parameters` });
  }
  const nports = Math.max(visiblePortIndices(inst, 'in').length,
    visiblePortIndices(inst, 'out').length, 1);
  const bodyH = Math.max(rows.length * ROW_H + PAD, nports * PORT_PITCH + PAD, ROW_H);
  // Two grid cells keep the centered port group's midpoint on the grid. Width is
  // one-cell aligned so right-edge ports align as well.
  const subtitle = subtitleFor(inst, d);
  const headH = TITLE_H + (subtitle ? SUBTITLE_H : 0);
  const h = ceilToGrid(headH + bodyH, BLOCK_H_STEP);
  let w = Math.max(textW(d.label, TITLE_FONT_SIZE, true),
                   textW(subtitle, SUBTITLE_FONT_SIZE));
  for (const r of rows)
    w = Math.max(w, textW(r.l, PARAM_FONT_SIZE, true) +
      textW(faceRowText(r), PARAM_FONT_SIZE));
  w = ceilToGrid(Math.max(BLOCK_MIN_W, Math.ceil(w) + TEXT_PAD_L + TEXT_PAD_R));
  return { d, rows, h, w, subtitle, headH };
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
  const vSlot = centeredPortSlot(h, count, slot, PORT_PITCH);
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

function connectionPath(a: Inst, fp: number, b: Inst, tp: number): string {
  const pa = portPos(a, 'out', fp), pb = portPos(b, 'in', tp);
  const x1 = a.x + pa.x, y1 = a.y + pa.y, x2 = b.x + pb.x, y2 = b.y + pb.y;
  const { k, bowA, bowB } = wireShape(pa.edge, pb.edge, x1, y1, x2, y2);
  const [sx, sy] = ctrl(pa.edge, x1, y1, 15);
  const [c1x, c1y] = ctrl(pa.edge, x1, y1, k, bowA);
  const [c2x, c2y] = ctrl(pb.edge, x2, y2, k, bowB);
  const [ex, ey] = ctrl(pb.edge, x2, y2, 15);
  return `M${x1},${y1} L${sx},${sy} C${c1x},${c1y} ${c2x},${c2y} ${ex},${ey} L${x2},${y2}`;
}

// Block instance names follow native GRC's `_get_unique_id`
// (grc/gui_qt/components/canvas/flowgraph.py): the first free `<base>_<n>`
// counting from 0, where the base is the block key for a newly placed block and
// the name being copied for a paste or duplicate. Deriving it from the names in
// use rather than from a running counter is what makes a collision impossible —
// undo, paste and a loaded flowgraph all feed the same set.
function namesInUse(): Set<string> {
  return new Set([
    ...state.insts.map(inst => inst.name),
    ...(trainingSession ? trainingSession.reservedNames(state.insts) : []),
  ]);
}

function uniqueBlockName(base: string, taken: Set<string> = namesInUse()): string {
  for (let n = 0; ; ++n) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function addBlock(id: string, x = 60 + (state.counter % 5) * 30, y = 60 + (state.counter % 7) * 24,
                  paramOverrides: Record<string, any> = {}, record = true): Inst | null {
  const d = RUNNABLE[id]; if (!d) { log('block "' + id + '" is not runnable yet'); return null; }
  if (id === OPTIONS_ID || id === LAYOUT_ID) {
    const existing = state.insts.find(i => i.id === id);
    if (existing) {
      log(`only one ${d.label} block is allowed per flowgraph`);
      select(existing.uid); return existing;
    }
  }
  const uid = 'b' + (++state.counter);
  const params: Record<string, any> = {};
  d.params.forEach(p => params[p.id] = p.def);
  Object.assign(params, paramOverrides);
  const position = constrainBlockPosition(x, y, snapToGrid);
  const inst: Inst = {
    uid, id, name: uniqueBlockName(id),
    x: position.x, y: position.y, params,
    enabled: true, rotation: 0, bypassed: false,
  };
  state.insts.push(inst);
  select(uid);
  if (record) recordHistory();
  return inst;
}

// ---- the JavaScript Block --------------------------------------------------
// A JS Block's parameters and ports come from its own source, exactly as a
// Python Block's do -- but deriving them costs a few milliseconds in a sandboxed
// iframe rather than a 16 MB download, so it happens as the code is typed. These
// two helpers are what both editing surfaces (the Properties dialog's inline
// field and the popup editor) share. See editor/src/js-block.ts.

/**
 * Record a freshly derived interface on a parameter set, and give every newly
 * derived parameter its default. Without the second half, adding a parameter to
 * a descriptor would leave the instance with no value for it -- and the editor
 * drops what its definition does not declare, so the block would run on the
 * descriptor's default while the dialog showed nothing at all.
 */
function applyJsIo(params: Record<string, any>, io: JsBlockIo) {
  params[JS_IO_PARAM] = serializeJsIo(io);
  for (const [id, def] of io.params || [])
    if (params[id] === undefined)
      params[id] = def === null || def === undefined ? '' : def;
}

interface JsCodeModalOptions {
  title: string;
  source: string;
  uid: string;
  /** Called on every successful derivation, and on Save with the final source. */
  apply(source: string, io: JsBlockIo | null): void;
  /** Save & Close. */
  onSave(source: string): void;
  /** Redraw whatever surface the caller owns. */
  render(): void;
}

// A dynamic import that 404s. The editor is a long-lived single-page app and its
// chunk names carry a content hash, so a tab left open across a rebuild or a
// deploy still asks for the chunk names it was loaded with -- and those are gone.
// Nothing is wrong with the app; the page just has to be reloaded. Say that,
// rather than reporting a bare TypeError nobody can act on.
// Each engine words the failure differently.
const CHUNK_GONE = /failed to fetch dynamically imported module|error loading dynamically imported module|importing a module script failed/i;

function describeImportFailure(error: unknown, what: string): string {
  const message = String((error as Error)?.message || error);
  return CHUNK_GONE.test(message)
    ? `${what} could not be loaded because this page is running an older build ` +
      `of the editor — reload the page.`
    : `${what} failed to load: ${message}`;
}

// Dynamically imported for the same reason CodeMirror is: nothing here is
// fetched by a session that never opens a JS Block.
function openJsCodeModal(options: JsCodeModalOptions) {
  void import('./code-modal').then(({ openCodeModal }) => openCodeModal({
    title: options.title,
    source: options.source,
    onDerived: (io, source) => {
      options.apply(source, io);
      // Typed in this session, so it needs no Run consent: the prompt exists for
      // JavaScript that arrived from a link, not for what the user just wrote.
      acceptJsSource(source);
      setJsSourceError(options.uid, '');
      options.render(); render();
    },
    onError: (message, source) => {
      options.apply(source, null);
      setJsSourceError(options.uid, message.split('\n')[0].trim() ||
                       'the block\'s source could not be read');
      options.render(); render();
    },
    onSave: source => { options.apply(source, null); options.onSave(source); },
    onSaveAsBlock: (source, io) => saveJsBlockAs(source, io),
  })).catch(error => log(describeImportFailure(error, 'the code editor')));
}

// ---- block operations (used by the context menu and shortcuts) ----
function deleteBlocks(uids = state.selectedBlocks, record = true) {
  if (!uids.size) return;
  // Options and GUI Layout are required singletons, so the *last* of each
  // stays -- but a duplicate is deletable, and has to be: a canvas holding two
  // fails validation on the duplicate ID, and a guard that refused every copy
  // by id left no way back out of that state.
  const remaining = new Map<string, number>();
  for (const i of state.insts)
    if (i.id === OPTIONS_ID || i.id === LAYOUT_ID)
      remaining.set(i.id, (remaining.get(i.id) || 0) + 1);
  state.insts = state.insts.filter(i => {
    if (!uids.has(i.uid)) return true;
    if (i.id === OPTIONS_ID || i.id === LAYOUT_ID) {
      const count = remaining.get(i.id) || 0;
      if (count <= 1) return true;
      remaining.set(i.id, count - 1);
    }
    return false;
  });
  state.conns = state.conns.filter(c => !uids.has(c.from) && !uids.has(c.to));
  state.selectedBlocks.clear(); state.selected = null; state.selectedConnection = null;
  render(); if (record) recordHistory();
}
function deleteConnection(conn: Conn) {
  state.conns = state.conns.filter(c => c !== conn);
  if (state.selectedConnection === conn) state.selectedConnection = null;
  render(); recordHistory();
}
function duplicateBlock(uid: string) {
  const s = state.insts.find(i => i.uid === uid); if (!s) return;
  if (s.id === OPTIONS_ID || s.id === LAYOUT_ID) {
    log(`only one ${defFor(s).label} block is allowed per flowgraph`); return;
  }
  const nu = 'b' + (++state.counter);
  const position = constrainBlockPosition(s.x + 24, s.y + 24, snapToGrid);
  state.insts.push({ uid: nu, id: s.id, name: uniqueBlockName(s.name),
    x: position.x, y: position.y, params: { ...s.params }, enabled: s.enabled,
    rotation: s.rotation, bypassed: s.bypassed });
  select(nu); recordHistory();
}
// ---- clipboard (Cut/Copy/Paste) ----
interface GraphClipboard { blocks: Inst[]; connections: Conn[] }
let clipboard: GraphClipboard | null = null;
function copyBlock(uid: string) {
  copyBlocks(state.selectedBlocks.has(uid) ? state.selectedBlocks : new Set([uid]));
}
function copyBlocks(uids = state.selectedBlocks) {
  // Options and GUI Layout are singletons; never copy them (so paste can't
  // duplicate one).
  const blocks = state.insts.filter(i =>
    uids.has(i.uid) && i.id !== OPTIONS_ID && i.id !== LAYOUT_ID);
  if (!blocks.length) return;
  clipboard = clone({ blocks, connections: state.conns.filter(c => uids.has(c.from) && uids.has(c.to)) });
  log(`copied ${blocks.length} block${blocks.length === 1 ? '' : 's'}`);
}
function pasteBlock(x = 80, y = 80) {
  if (!clipboard) return;
  const minX = Math.min(...clipboard.blocks.map(b => b.x));
  const minY = Math.min(...clipboard.blocks.map(b => b.y));
  const remap = new Map<string, string>();
  // As in native GRC, a pasted block keeps its own ID when nothing else holds it
  // and is renamed off that ID otherwise, so `x_0` pasted beside itself becomes
  // `x_0_0`. The set grows as blocks land so one paste cannot collide with itself.
  const taken = new Set(state.insts.map(i => i.name));
  const added: Inst[] = clipboard.blocks.map(source => {
    const uid = 'b' + (++state.counter); remap.set(source.uid, uid);
    const position = constrainBlockPosition(
      x + source.x - minX, y + source.y - minY, snapToGrid);
    const name = taken.has(source.name) ? uniqueBlockName(source.name, taken) : source.name;
    taken.add(name);
    return { ...clone(source), uid, name, x: position.x, y: position.y };
  });
  state.insts.push(...added);
  state.conns.push(...clipboard.connections.map(c => ({ ...c, from: remap.get(c.from)!, to: remap.get(c.to)! })));
  state.selectedBlocks = new Set(added.map(i => i.uid)); state.selected = added.length ? added[added.length - 1].uid : null;
  state.selectedConnection = null; render(); recordHistory();
}

function selectedInsts(): Inst[] { return state.insts.filter(i => state.selectedBlocks.has(i.uid)); }
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
// Auto-arrange: hand the whole flowgraph to the layout engine and drop every
// block on the coordinate it comes back with. Everything the engine needs is
// measured here — box size, how far the port tabs stick out on each side, and
// the y offset of every port — so `layout.ts` stays DOM-free and unit testable.
function autoArrangeBlocks(record = true) {
  if (!state.insts.length) return;
  // Ports have to face the way the layout flows, so a hand-rotated block is
  // straightened first: a 90° block's ports sit on its top and bottom edges, and
  // no left-to-right wire into one of those can ever come out straight.
  for (const inst of state.insts) inst.rotation = 0;
  const nodes: LayoutNode[] = state.insts.map(inst => {
    const { w, h } = geom(inst);
    const offsets = (kind: 'in' | 'out') =>
      Array.from({ length: portCount(inst, kind) }, (_, i) => portPos(inst, kind, i).y);
    const pad = (kind: 'in' | 'out') =>
      Math.max(0, ...visiblePortIndices(inst, kind).map(i => portWidth(inst, kind, i)));
    return {
      uid: inst.uid, w, h, leftPad: pad('in'), rightPad: pad('out'),
      in: offsets('in'), out: offsets('out'),
      // Both singletons park in the corner ahead of everything else; neither is
      // wired to anything, so they would otherwise land wherever they fell.
      pinned: inst.id === OPTIONS_ID || inst.id === LAYOUT_ID,
    };
  });
  const byUid = new Map(state.insts.map(inst => [inst.uid, inst]));
  for (const at of arrangeFlowgraph(nodes, state.conns)) {
    const inst = byUid.get(at.uid)!;
    const position = constrainBlockPosition(at.x, at.y, snapToGrid);
    inst.x = position.x; inst.y = position.y;
  }
  render(); if (record) recordHistory();
  log(`arranged ${state.insts.length} block${state.insts.length === 1 ? '' : 's'}`);
}
function cycleBlockType(direction: number) {
  const blocks = selectedInsts(); let changed = false;
  for (const block of blocks) {
    const param = defFor(block).params.find(p => p.id === 'type' && p.options?.length);
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
    const key = candidates.find(id => defFor(block).params.some(p => p.id === id));
    if (!key) continue;
    const nextParams = { ...block.params,
      [key]: Math.max(1, Math.trunc(Number(block.params[key]) || 1) + delta) };
    remapConnectionsForPortChange(block, nextParams);
    block.params = nextParams;
    changed = true;
  }
  if (changed) { render(); recordHistory(); }
}
// ZOOM_MIN is a floor against zoom hitting exactly 0 (scale(0) hides every
// block and makes the canvas unreachable), not a legibility limit — there is
// no lower bound on how small a link or an embed may want the canvas drawn.
const ZOOM_MIN = 0.01, ZOOM_MAX = 2.5, ZOOM_STEP = 1.15;
function setZoom(next: number) {
  zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, next));
  // Draw the grid at the snap spacing so every line is a legal block position.
  el('canvasWrap').style.setProperty('--grid-size', `${SNAP_GRID_SIZE * zoom}px`); render();
  // The zoom buttons grey out at the clamp, so a click that could not change
  // anything looks like one rather than logging the same percentage. Every
  // button carrying the tool's name is updated, which is both the toolbar's pair
  // and the embedded layout's — an embed has no toolbar to reach.
  for (const [label, atLimit] of [['Zoom In', zoom >= ZOOM_MAX], ['Zoom Out', zoom <= ZOOM_MIN]] as const) {
    for (const button of document.querySelectorAll<HTMLButtonElement>(`button[data-tool="${label}"]`)) {
      button.classList.toggle('disabled', atLimit); button.disabled = atLimit;
    }
  }
  log(`zoom ${Math.round(zoom * 100)}%`);
}
// ?zoom=<level> — the zoom the canvas opens at, so a link or an embed can hand
// its reader a flowgraph already sized to the frame. A query parameter for the
// same reason `embed` is one: it is a property of how the page was opened, not
// of which flowgraph the fragment names, and the app never rewrites it as the
// reader zooms. Otherwise always a percentage — "5" and "5%" both mean 5% — so
// there is no value where the meaning flips; setZoom clamps whatever comes out
// to the same range the toolbar buttons reach.
//
// `fit` is the one word it takes instead of a number, doing what Ctrl+9 does.
// A percentage cannot serve an embed that does not know what it is framing: the
// generated example pages (editor/gen/gen_example_pages.mjs) put every one of 79
// flowgraphs into the same 16:10 frame, and they range from three blocks to
// forty. Applied here with the rest, i.e. after the flowgraph has loaded, which
// is the whole reason it can measure anything.
function applyZoomFromUrl() {
  const raw = new URLSearchParams(location.search).get('zoom');
  if (raw === null) return;
  if (raw.trim().toLowerCase() === 'fit') { zoomToFitWhenMeasurable(); return; }
  const value = Number(raw.trim().replace(/%$/, ''));
  if (!Number.isFinite(value) || value <= 0) { log(`ignoring ?zoom=${raw}: not a positive number`); return; }
  setZoom(value / 100);
}
// ?center=<x>,<y> — the canvas coordinate (in flowgraph units, the same x/y a
// block's own position is stored in) to center the viewport on when the page
// loads, so a link or an embed can open scrolled to one part of a flowgraph too
// big for its frame instead of the top-left corner render() leaves it at. A
// query parameter for the same reason `zoom` is one: it is a property of how
// the page was opened, and nothing in the app rewrites it as the reader scrolls.
// Applied after `?zoom=`, since the pixel position of a canvas coordinate scales
// with it.
function applyCenterFromUrl() {
  const raw = new URLSearchParams(location.search).get('center');
  if (raw === null) return;
  const parts = raw.split(',').map(part => Number(part.trim()));
  if (parts.length !== 2 || parts.some(n => !Number.isFinite(n))) {
    log(`ignoring ?center=${raw}: expected "x,y"`); return;
  }
  const [x, y] = parts;
  const scroller = el('canvasScroll');
  const pane = scroller.getBoundingClientRect();
  scroller.scrollTo(x * zoom - pane.width / 2, y * zoom - pane.height / 2);
}
// Scale the canvas down until the whole flowgraph fits the visible pane — the
// quickest way to get your bearings on a screen narrower than the graph. It
// never scales *up* past 100%: a two-block flowgraph blown up to fill the pane
// reads as a mistake, and setZoom's own floor keeps a huge one legible rather
// than fitting it at any cost.
function zoomToFit(): boolean {
  let right = 0, bottom = 0;
  for (const inst of state.insts) {
    if (canvasBlockHidden(inst)) continue;
    const { w, h } = geom(inst);
    const comment = blockCommentGeometry(inst);
    right = Math.max(right, inst.x + Math.max(w, comment.width));
    bottom = Math.max(bottom, inst.y + h + comment.height);
  }
  if (!right || !bottom) { log('nothing to fit'); return false; }
  const pane = el('canvasWrap').getBoundingClientRect();
  const margin = 16;
  // A pane too small to hold the margin makes every ratio below zero or
  // negative, and setZoom would clamp that to ZOOM_MIN -- a flowgraph shrunk to
  // 1% and apparently blank. It happens whenever the canvas is measured while
  // hidden, which a click-to-load embed keeps it until its reader presses Load.
  // Decline instead, and let the caller decide whether to wait.
  if (pane.width <= margin || pane.height <= margin) return false;
  setZoom(Math.min(1, (pane.width - margin) / right, (pane.height - margin) / bottom));
  el('canvasScroll').scrollTo(0, 0);
  return true;
}
// `?zoom=fit` on a canvas that cannot be measured yet. Rather than poll for a
// fixed while -- a click-to-load embed stays display:none until someone presses
// Load, which may be never -- wait for the pane to acquire a size and fit then.
function zoomToFitWhenMeasurable() {
  if (zoomToFit()) return;
  const wrap = el('canvasWrap');
  const observer = new ResizeObserver(() => {
    if (wrap.getBoundingClientRect().width <= 0) return;
    observer.disconnect();
    zoomToFit();
  });
  observer.observe(wrap);
}
// ---- Options block: the singleton flowgraph-metadata block (GRC-style) ----
// Every flowgraph has exactly one, holding title/author/copyright/description.
const OPTIONS_ID = 'options';
// The Options block's browser-only scheduler choice. Its default is left out of
// the saved .grc entirely -- see buildGrcDoc -- so `def` here and the value the
// runner falls back to have to stay the same string. See docs/schedulers.md.
const SCHEDULER_PARAM = 'scheduler';
const SCHEDULER_DEFAULT = 'tpb';
// The id a flowgraph with no Title gets, matching native's default_flow_graph.grc.
const DEFAULT_FLOWGRAPH_ID = 'default';
function makeOptionsInst(): Inst {
  const params: Record<string, any> = {};
  RUNNABLE[OPTIONS_ID].params.forEach(p => params[p.id] = p.def);
  // Its instance name is internal — the .grc gets the derived flowgraph id, and
  // nothing displays this — but it still has to be a legal, unique block ID.
  return { uid: 'b' + (++state.counter), id: OPTIONS_ID, name: OPTIONS_ID,
    x: 10, y: 10, params, enabled: true, rotation: 0, bypassed: false };
}
// Guarantee the current flowgraph has an Options block (loaded/legacy files may lack one).
function ensureOptionsBlock() {
  if (!state.insts.some(i => i.id === OPTIONS_ID)) state.insts.unshift(makeOptionsInst());
}

// ---- GUI Layout block: the other required singleton ----
// Where the flowgraph's QT GUI widgets go in the runner window, as a grid. Like
// Options it is placed automatically and cannot be deleted or duplicated, so a
// flowgraph is always arrangeable without anyone having to know the block
// exists. A .grc that predates it simply has no tiles, which the runner renders
// as the vertical stack it always used to.
const LAYOUT_ID = 'wasm_gui_layout';
const LAYOUT_PARAM = 'layout';
const LAYOUT_DTYPE = 'gui_layout';
function makeLayoutInst(): Inst {
  const params: Record<string, any> = {};
  RUNNABLE[LAYOUT_ID].params.forEach(p => params[p.id] = p.def);
  return { uid: 'b' + (++state.counter), id: LAYOUT_ID, name: uniqueBlockName(LAYOUT_ID),
    x: 10, y: 120, params, enabled: true, rotation: 0, bypassed: false };
}
// Clearance kept around the block that is being dropped in, so it neither
// touches its neighbours nor covers the port tabs and wires between them.
const LAYOUT_DROP_GAP = SNAP_GRID_SIZE * 3;
// Where a *newly inserted* GUI Layout block goes. Every .grc written before this
// block existed — which is most of `example_flowgraphs/`, and anything from
// desktop GRC — gets one on load, so the position cannot be a fixed corner: the
// corner belongs to whoever arranged the flowgraph, and the block lands on top
// of them. Start beside the header row the arrangement puts Options in (the two
// singletons belong together) and slide down until nothing is in the way, which
// terminates because below the lowest block everything is free.
function placeLayoutInst(inst: Inst) {
  const box = (i: Inst) => { const { w, h } = geom(i); return { x: i.x, y: i.y, w, h }; };
  const boxes = state.insts.filter(i => i !== inst).map(box);
  if (!boxes.length) return;
  const self = geom(inst);
  const header = state.insts.find(i => i.id === OPTIONS_ID) ?? state.insts[0];
  const headerBox = box(header);
  // The header band is the row Options sits in; the block goes after whatever
  // else is already in that row rather than on top of the first one of them.
  const inHeader = boxes.filter(b => b.y < headerBox.y + headerBox.h && headerBox.y < b.y + b.h);
  const x = Math.max(...inHeader.map(b => b.x + b.w), headerBox.x + headerBox.w) + LAYOUT_DROP_GAP;
  const clear = (y: number) => !boxes.some(b =>
    x < b.x + b.w + LAYOUT_DROP_GAP && b.x < x + self.w + LAYOUT_DROP_GAP &&
    y < b.y + b.h + LAYOUT_DROP_GAP && b.y < y + self.h + LAYOUT_DROP_GAP);
  let y = headerBox.y;
  while (!clear(y)) y += SNAP_GRID_SIZE;
  ({ x: inst.x, y: inst.y } = constrainBlockPosition(x, y, snapToGrid));
}
function ensureLayoutBlock() {
  // A build with no generated library yet (the very first paint) has no schema
  // to build one from; the next load settles it.
  if (!RUNNABLE[LAYOUT_ID]) return;
  if (state.insts.some(i => i.id === LAYOUT_ID)) return;
  const inst = makeLayoutInst();
  placeLayoutInst(inst);
  state.insts.push(inst);
}
const layoutInst = (): Inst | undefined => state.insts.find(i => i.id === LAYOUT_ID);
// The blocks that take a tile: those whose factory builds a QWidget. Only the
// C++ knows which those are, so the answer comes from the generated library's
// `gui` flag, which each block declares for itself as `gui: true`. Disabled
// blocks are left out because the runner never builds them.
function guiWidgets(): WidgetRef[] {
  return state.insts.filter(i => i.enabled && !i.bypassed && GUI_BLOCK_IDS.has(i.id))
    .map(i => ({ name: i.name, id: i.id }));
}
function layoutTilesFor(inst: Inst | undefined = layoutInst()): TileMap {
  if (!inst) return {};
  return packLayout(guiWidgets(), parseTiles(String(inst.params[LAYOUT_PARAM] ?? '{}')),
                    layoutColumns(inst.params.columns));
}
// Write a new arrangement back into the flowgraph. This is what makes a drag --
// in the Properties dialog or over the running window -- part of the .grc rather
// than a view setting: it lands in the block's parameter, so Save writes it and
// the next Run reads it.
function setLayoutTiles(tiles: TileMap, record = true) {
  const inst = layoutInst();
  if (!inst) return;
  const text = serializeTiles(tiles);
  if (text === String(inst.params[LAYOUT_PARAM] ?? '')) return;
  inst.params[LAYOUT_PARAM] = text;
  render();
  if (record) recordHistory();
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
  return { uid: 'b' + (++state.counter), id: 'variable', name: 'samp_rate',
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

function exitTrainingMode(stripQuery = true) {
  if (!trainingSession) return;
  trainingSession = null;
  if (!stripQuery) return;
  const url = new URL(location.href);
  url.searchParams.delete('training');
  history.replaceState(null, '', url.pathname + url.search + url.hash);
}

function clearFlowgraph(record = true) {
  exitTrainingMode();
  state.insts = []; state.conns = []; state.counter = 0; state.selected = null; state.selectedBlocks.clear();
  state.insts.push(makeSampRateInst());   // the default flowgraph's one variable
  state.selectedConnection = null; cancelConnect();
  ensureOptionsBlock(); ensureLayoutBlock(); render();
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
// Native GRC writes every block's implicit parameters whether or not they hold
// anything -- `comment` on all of them, plus `alias`/`affinity` and the output
// buffer bounds on a block with ports (grc/core/blocks/block.py `export_data`,
// and any .grc desktop GRC saves). A block whose own parameters are all
// defaults would otherwise serialize as a bare `parameters:` key, which reads
// back as YAML null and makes native GRC fail at `parameters.items()`. Match
// native so a file written here loads there.
function withImplicitParams(inst: Inst, params: Record<string, GrcScalar>): Record<string, GrcScalar> {
  // A variable or GUI control has no ports, and native gives it `comment` only;
  // the output buffer bounds exist only on a block that has an output to size.
  // Native counts a declared output port of either domain, visible or not
  // (qtgui_freq_sink_x's hidden `freq` message port earns it the pair, while
  // qtgui_time_sink_x, which declares none, does not), so read the schema
  // rather than the live port count.
  const def = defFor(inst);
  const hasOutput = def?.nativeOutputBuffers ??
    ((def?.outputTemplates?.length ?? def?.outputs ?? 0) > 0);
  const implicit: Record<string, GrcScalar> = VARIABLE_IDS.has(inst.id)
    ? { comment: '' }
    : hasOutput
      ? { affinity: '', alias: '', comment: '', maxoutbuf: '0', minoutbuf: '0' }
      : { affinity: '', alias: '', comment: '' };
  const merged: Record<string, GrcScalar> = { ...params };
  for (const [key, value] of Object.entries(implicit))
    if (!(key in merged)) merged[key] = value;
  return Object.fromEntries(Object.keys(merged).sort().map(k => [k, merged[k]]));
}
function grcStates(inst: Inst): Record<string, any> {
  return { coordinate: [Math.round(inst.x), Math.round(inst.y)], rotation: inst.rotation, state: grcState(inst) };
}
// Derive the flowgraph id from the Options Title. Native generates a top block
// class and .py file from this id, so it has to satisfy the same rule native
// validates ids against (`^[A-Za-z]\w*$`, grc/core/params/dtypes.py): every
// character that is not a letter, digit or underscore — spaces above all —
// becomes an underscore, and a title that does not begin with a letter gets a
// prefix, since a leading digit or underscore is not a legal id there.
function flowgraphId(): string {
  const opt = state.insts.find(i => i.id === OPTIONS_ID);
  const id = String(opt?.params.title || '').trim().replace(/[^A-Za-z0-9_]/g, '_');
  if (!id) return DEFAULT_FLOWGRAPH_ID;
  return /^[A-Za-z]/.test(id) ? id : `fg_${id}`;
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
  return buildScope(state.insts.filter(i => i.id === 'variable'));
}
// The Run path's parameter values: every expression parameter evaluated against
// the flowgraph's variables, so the runner receives concrete numbers and taps.
function resolveParamsForRun(inst: Inst, scope: Scope): Record<string, any> {
  const def = defFor(inst);
  const out: Record<string, any> = { ...inst.params };
  if (!def) return out;
  for (const p of def.params) {
    const dtype = effectiveDtype(inst, def, p);
    // Numeric, vector and `raw` params are evaluated; enum/string params pass
    // through. `raw` covers things like an OFDM carrier allocation written as
    // `list(range(-26, -21)) + ...`; the vector dtypes cover the commonest GRC
    // idiom of all, filter taps written as `firdes.low_pass(...)` or
    // `[1/sps] * sps`. Neither is something the runner can evaluate itself.
    if (p.type !== 'number' && !p.raw && !EVALUATED_DTYPES.has(dtype)) continue;
    const raw = out[p.id];
    if (typeof raw !== 'string') continue;          // already a numeric/bool literal
    const s = raw.trim();
    if (!s || Number.isFinite(Number(s))) continue; // empty or a plain number already
    const r = evalExpr(s, scope);
    // Only substitute a concrete (non-string) result; symbolic values (enum
    // constants) and anything referencing a live control are left as raw text.
    if (r.ok && typeof r.value !== 'string')
      out[p.id] = serializeForRunner(r.value, dtype === 'complex_vector');
  }
  return out;
}

function buildGrcDoc(resolve = false): GrcDoc {
  const runScope = resolve ? buildRunScope() : {};
  const paramsOf = (i: Inst) => grcParams(resolve ? resolveParamsForRun(i, runScope) : i.params);
  const byUid = (u: string) => state.insts.find(i => i.uid === u);
  // options: a top-level block (not in `blocks`), carrying flowgraph metadata.
  const opt = state.insts.find(i => i.id === OPTIONS_ID);
  const optionParams: Record<string, GrcScalar> = { generate_options: 'qt_gui', id: flowgraphId() };
  if (opt) for (const [k, v] of Object.entries(opt.params)) {
    // `scheduler` is browser-only and defaults to the scheduler the runner would
    // have used anyway, so writing it out at its default would add a key to
    // every .grc in the repository -- and to every file a user has saved -- for
    // no change in behaviour. Omitting it keeps those byte-identical.
    if (k === SCHEDULER_PARAM && String(v) === SCHEDULER_DEFAULT) continue;
    optionParams[k] = String(v);
  }
  const options = { parameters: grcParams(optionParams),
    states: opt ? grcStates(opt) : { coordinate: [10, 10], rotation: 0, state: 'enabled' } };

  // blocks: everything except options, GRC order (variables first, then by name).
  const isVar = (i: Inst) => VARIABLE_IDS.has(i.id);
  const blocks = state.insts.filter(i => i.id !== OPTIONS_ID)
    .sort((a, b) => (Number(!isVar(a)) - Number(!isVar(b))) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    .map(i => ({ name: i.name, id: i.id,
      parameters: withImplicitParams(i, paramsOf(i)), states: grcStates(i) }));

  // connections: 4-tuples for streams, dicts (file_format 2) for message ports.
  const connections: Array<GrcScalar[] | Record<string, GrcScalar>> = [];
  for (const c of state.conns) {
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
    const param = RUN_BOUND_PARAMS[block.id];
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
  log(`saved ${state.insts.length} blocks to ${file}`);
}

// ---- .grc import (parsed GrcDoc tree -> editor model) ----
function stateToFlags(state: any): { enabled: boolean; bypassed: boolean } {
  const s = String(state ?? 'enabled');
  return { enabled: s !== 'disabled', bypassed: s === 'bypassed' };
}
// Alternate spellings of a parameter id, per block id: `current id -> id found
// in a file this schema does not match`. Either direction lands here -- an id
// this editor wrote before its schema matched upstream GRC's, or upstream GRC's
// own id for a field this schema still spells differently. Consulted only when
// the current id is absent, so a .grc keeps its value instead of silently
// falling back to the schema default.
const LEGACY_PARAM_IDS: Record<string, Record<string, string>> = {
  // Deprecated "Throttle (old)", superseded by blocks_throttle2. Its rate was
  // written as `samp_rate`; upstream has always called it samples_per_second.
  blocks_throttle: { samples_per_second: 'samp_rate' },
  // These three sinks' rate field is `samp_rate` here but `bw`/`srate` upstream,
  // so a .grc written by native GRC carries the value under a name this schema
  // does not declare -- and an undeclared parameter is dropped in silence,
  // leaving the sink's axis at the schema default. Read the upstream spelling
  // as a fallback so such a file keeps its rate. (The runner accepts both
  // spellings too, for a .grc handed straight to runner.html.)
  qtgui_freq_sink_x: { samp_rate: 'bw' },
  qtgui_waterfall_sink_x: { samp_rate: 'bw' },
  qtgui_time_sink_x: { samp_rate: 'srate' },
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
  const def = defFor(inst);
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
function loadFlowgraph(doc: any, record = true) {
  if (!doc || !Array.isArray(doc.blocks))
    throw new Error('not a GNU Radio .grc flowgraph');
  exitTrainingMode();
  state.insts = []; state.conns = []; state.counter = 0;
  // Whatever was on the canvas is gone, and with it the file Save writes to; the
  // callers that do know a name (an example, an opened .grc) set it back after.
  setCurrentFileName(null);
  // options: a top-level block in .grc; becomes the editor's singleton Options.
  // A hand-written .grc -- which is what `replace_flowgraph` receives from a
  // model -- often lists it under `blocks:` as well, or *only* there. Both
  // shapes have to land on exactly one Options: a second one is undeletable
  // and fails validation on its duplicate ID, leaving the flowgraph
  // permanently unrunnable. So the top-level key wins, an entry under
  // `blocks:` is adopted when there is no top-level key to lose, and the
  // block loop below skips every OPTIONS_ID entry either way.
  const optBlock = doc.blocks.find((b: any) => b?.id === OPTIONS_ID);
  const optRaw = doc.options?.parameters || !optBlock ? (doc.options || {}) : optBlock;
  const optFlags = stateToFlags(optRaw.states?.state);
  const optCoord = Array.isArray(optRaw.states?.coordinate) ? optRaw.states.coordinate : [10, 10];
  // The file's `id` is not carried into the model: it is derived from the Title
  // again on save, so there is nowhere for a loaded one to live.
  state.insts.push({ uid: 'b' + (++state.counter), id: OPTIONS_ID, name: OPTIONS_ID,
    x: Number(optCoord[0]) || 10, y: Number(optCoord[1]) || 10,
    params: importParams(RUNNABLE[OPTIONS_ID], optRaw.parameters || {}),
    enabled: optFlags.enabled, rotation: Number(optRaw.states?.rotation) || 0, bypassed: optFlags.bypassed });

  const nameToUid = new Map<string, string>();
  doc.blocks.forEach((b: any, index: number) => {
    // A Python or JS Block's parameters are whatever its source declares, so its
    // definition has to be built from the file's own cached interface before its
    // values can be imported -- importParams keeps only what the definition
    // declares, and the derived parameters would otherwise be dropped.
    // Already placed above, from whichever of the two shapes carried it.
    if (b.id === OPTIONS_ID) return;
    // The GUI Layout singleton legitimately lives in `blocks:`, so here it is
    // the second and later ones that are dropped rather than all of them.
    if (b.id === LAYOUT_ID && state.insts.some(i => i.id === LAYOUT_ID)) {
      log(`ignored a duplicate GUI Layout block "${b.name || b.id}"`);
      return;
    }
    const derive = DERIVED.get(b.id);
    const def = derive && RUNNABLE[b.id]
      ? derive(RUNNABLE[b.id], { params: b.parameters || {} } as Inst)
      : RUNNABLE[b.id];
    if (!def) { log(`skipped unsupported block "${b.id}"`); return; }
    // Written by desktop GRC as a Python tuple repr under `states`, which this
    // editor cannot read. Say so once rather than silently showing no ports.
    if (b.id === EPY_BLOCK_ID && !b.parameters?.[EPY_IO_CACHE_PARAM] &&
        isForeignIoCache(b.states?.[EPY_IO_CACHE_PARAM]))
      log(`"${b.name}": Python Block written by desktop GRC — open its Properties ` +
          `and load Python to read its ports and parameters`);
    const coord = Array.isArray(b.states?.coordinate) ? b.states.coordinate
      : [60 + (index % 4) * 190, 60 + Math.floor(index / 4) * 130];
    const flags = stateToFlags(b.states?.state);
    const uid = 'b' + (++state.counter), name = String(b.name || b.id);
    nameToUid.set(name, uid);
    state.insts.push({ uid, id: b.id, name, x: Number(coord[0]) || 0, y: Number(coord[1]) || 0,
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
    state.conns.push({ from, fp: portIndex(G0(from), 'out', sp), to, tp: portIndex(G0(to), 'in', tp) });
  }
  ensureOptionsBlock();
  // A .grc written before this block existed -- every upstream example, and
  // anything desktop GRC saved -- gets one here, so it is arrangeable without
  // the reader having to add anything. Its tiles start empty, which is the
  // vertical stack such a flowgraph has always been rendered as.
  ensureLayoutBlock();
  state.selected = null; state.selectedBlocks.clear(); state.selectedConnection = null; cancelConnect();
  render(); if (record) recordHistory(); log(`opened ${state.insts.length} blocks`);
}

function startTrainingFlowgraph(doc: any, file: string, title: string) {
  const unavailable = [...new Set((doc.blocks || [])
    .map((block: any) => String(block?.id || ''))
    .filter((id: string) => !RUNNABLE[id] || PALETTE_HIDDEN.has(id)))];
  if (unavailable.length)
    throw new Error(`lesson requires unavailable palette block${unavailable.length === 1 ? '' : 's'}: ` +
      unavailable.join(', '));

  // Use the ordinary importer once, while the application is still hidden on
  // startup, so legacy parameters, dynamic ports and generated definitions are
  // normalized exactly as they are for a normal example. The resulting graph
  // becomes the immutable lesson; only the two editor-managed singletons remain
  // real on the learner's canvas.
  loadFlowgraph(doc, false);
  const template: GraphSnapshot = clone({
    insts: state.insts,
    conns: state.conns,
    counter: state.counter,
  });
  trainingSession = new TrainingSession(template, [OPTIONS_ID, LAYOUT_ID]);
  state.insts = clone(template.insts.filter(block => block.id === OPTIONS_ID || block.id === LAYOUT_ID));
  state.conns = [];
  state.counter = template.counter;
  state.selected = null; state.selectedBlocks.clear(); state.selectedConnection = null; cancelConnect();
  setExampleHash(null);
  setCurrentFileName(file);
  render();
  resetHistory();
  const counts = trainingSession.counts(state.insts, state.conns);
  log(`started training example "${title}": ${counts.totalBlocks} block${counts.totalBlocks === 1 ? '' : 's'} ` +
      `and ${counts.totalConnections} connection${counts.totalConnections === 1 ? '' : 's'} to complete`);
}
// Fly-in / fly-out transition used when opening an example flowgraph: the blocks
// already on the canvas scatter off-screen in random directions while the
// example's blocks sweep in from off-screen to their loaded positions.
function loadFlowgraphAnimated(doc: any) {
  // Opening an example replaces what is on the canvas, so a flowgraph still
  // running is the *old* one: stop it rather than leave the QT GUI pane showing
  // a graph the canvas no longer describes. stop() returns to the editor tab,
  // which the fly-in also needs -- the canvas has no size while it is hidden.
  if (runnerRunning) stop();
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
  if (!state.insts.length) return;
  const token = `grc-duplicate-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  try {
    localStorage.setItem(token, grcText());
    const duplicateUrl = new URL(location.href);
    duplicateUrl.searchParams.delete('training');
    duplicateUrl.hash = `duplicate=${encodeURIComponent(token)}`;
    const duplicate = window.open(duplicateUrl.toString(), '_blank');
    if (duplicate) { log('duplicated flowgraph in a new tab'); return; }
    localStorage.removeItem(token);
  } catch { /* fall through to an in-canvas copy if storage or popups are unavailable */ }
  const ids = new Set(state.insts.map(i => i.uid)); copyBlocks(ids);
  const minX = Math.min(...state.insts.map(i => i.x)), minY = Math.min(...state.insts.map(i => i.y));
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
// Native GRC gives a combo box to *any* parameter that carries an options list,
// not only to `dtype: enum`: `build_param_entrys` in
// gnuradio/grc/gui_qt/components/dialogs.py branches on
// `param.dtype == "enum" or param.options`, and makes the combo **editable**
// for the non-enum ones. Editable is not decoration — plenty of those lists are
// suggestions rather than a closed set (audio_sink's Sample Rate defaults to
// the `samp_rate` variable, which is on none of them; Fast Noise Source's Noise
// Type is `dtype: raw` with four options), so the field cannot be a bare
// <select>: that would silently rewrite whatever the flowgraph already holds
// into the first option on the list, which is the one thing a properties dialog
// must never do. It cannot be a <datalist> either — that looks like the web's
// editable combo and is not one, because browsers filter those suggestions
// against the text already in the field, so a parameter sitting on one of its
// own options offers that option alone and hides its siblings.
//
// What works is a real select carrying the options *plus* whatever value the
// flowgraph holds, and a "Custom value…" entry that swaps in a text field for an
// expression or a variable name.
function showVariableEditor() {
  openVariableEditor({
    state,
    closeContextMenu: closeMenu,
    render,
    recordHistory,
    validateGraph,
    showFieldColors: () => showPropertiesFieldColors,
  });
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
  item('Cut', () => { copyBlock(inst.uid); deleteBlocks(state.selectedBlocks.has(inst.uid) ? state.selectedBlocks : new Set([inst.uid])); });
  item('Copy', () => copyBlock(inst.uid));
  item('Paste', () => pasteBlock(inst.x + 30, inst.y + 30));
  item('Duplicate', () => duplicateBlock(inst.uid));
  sep();
  item('Rotate Clockwise', () => rotateSelected(90));
  item('Rotate Counterclockwise', () => rotateSelected(-90));
  item(inst.enabled ? 'Disable' : 'Enable', () => setSelectedEnabled(!inst.enabled));
  item(inst.bypassed ? 'Un-Bypass' : 'Bypass', () => bypassSelected());
  sep();
  item('Delete', () => deleteBlocks(state.selectedBlocks.has(inst.uid) ? state.selectedBlocks : new Set([inst.uid])), true);
  document.body.appendChild(m);
  m.style.left = Math.min(x, window.innerWidth - m.offsetWidth - 6) + 'px';
  m.style.top = Math.min(y, window.innerHeight - m.offsetHeight - 6) + 'px';
  menuEl = m;
}
function showConnectionMenu(x: number, y: number, conn: Conn) {
  closeMenu();
  const m = document.createElement('div'); m.className = 'ctxmenu';
  const d = document.createElement('div');
  d.className = 'ctxitem danger';
  d.textContent = 'Delete Connection';
  d.onclick = () => { closeMenu(); deleteConnection(conn); };
  m.appendChild(d);
  document.body.appendChild(m);
  m.style.left = Math.min(x, window.innerWidth - m.offsetWidth - 6) + 'px';
  m.style.top = Math.min(y, window.innerHeight - m.offsetHeight - 6) + 'px';
  menuEl = m;
}
// pointerdown, not mousedown: the canvas handlers below call preventDefault(),
// which stops a tap from ever synthesising the compatibility mouse event.
document.addEventListener('pointerdown', e => { if (menuEl && !menuEl.contains(e.target as Node)) closeMenu(); });
const SHORTCUTS: [string, string][] = [
  ['Ctrl+N / O', 'New / open flowgraph'], ['Ctrl+S', 'Save flowgraph'],
  ['Ctrl+Shift+D', 'Duplicate flowgraph'], ['Ctrl+W / Ctrl+Q', 'Close flowgraph / app'],
  ['Ctrl+P', 'Save flowgraph screenshot'], ['Ctrl+Shift+P', 'Save console'], ['Ctrl+L', 'Clear console'],
  ['Ctrl+Z / Ctrl+Y', 'Undo / redo'], ['Ctrl+A', 'Select all'], ['Delete', 'Delete selection'],
  ['Ctrl+X / C / V', 'Cut / copy / paste'], ['Left / Right', 'Rotate counterclockwise / clockwise'],
  ['Return', 'Block properties'], ['E / D / B', 'Enable / disable / bypass'],
  ['C', 'Create hierarchy (not available in WASM)'],
  ['Up / Down', 'Previous / next block type'], ['+ / −', 'Increase / decrease dynamic ports'],
  ['Ctrl++ / Ctrl+− / Ctrl+0', 'Zoom in / out / reset'], ['Ctrl+9', 'Zoom to fit the flowgraph'],
  ['Ctrl+D', 'Hide disabled blocks'],
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
  overlay.addEventListener('pointerdown', e => { if (e.target === overlay) overlay.remove(); });
}
function consume(e: KeyboardEvent) { e.preventDefault(); e.stopPropagation(); }
document.addEventListener('keydown', e => {
  const ctrl = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
  if (e.key === 'Escape') {
    closeMenu(); closeMenus();
    if (cancelConnect()) render();
    document.querySelector('.modal')?.remove();
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
  if (ctrl && (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd')) { consume(e); setZoom(zoom * ZOOM_STEP); return; }
  if (ctrl && (e.key === '-' || e.key === '_' || e.code === 'NumpadSubtract')) { consume(e); setZoom(zoom / ZOOM_STEP); return; }
  if (ctrl && key === '9') { consume(e); zoomToFit(); return; }
  if (ctrl && key === '0') { consume(e); setZoom(1); return; }
  if (ctrl && key === 'd') { consume(e); toggleHideDisabled(); return; }
  if (ctrl && key === 'e') { consume(e); showVariableEditor(); return; }
  if (ctrl && key === 'r') { consume(e); toggleConsole(); return; }
  if (ctrl && key === 'b') { consume(e); togglePalette(); return; }
  // Everything below is a bare-key shortcut, so anything the user is typing into
  // keeps them. A code editor is the case a tag list alone misses: CodeMirror's
  // editable surface is a contenteditable <div>, not a form control, so without
  // isContentEditable, typing `d` into the Embedded Python Block's source
  // disabled the block instead.
  //
  // The event's target, not activeElement: a handler nearer the field can move
  // focus before this one runs. Enter in the AI dock's prompt submits, and the
  // submit handler disables the textarea while the turn is in flight, which
  // blurs it — so by the time the event bubbles to document, activeElement is
  // <body> and Enter opened the selected block's properties dialog as well.
  const typing = (node: EventTarget | null) => {
    const el = node as HTMLElement | null;
    return !!el && (['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) || el.isContentEditable);
  };
  if (typing(e.target) || typing(document.activeElement)) return;

  if (ctrl && key === 'z') { consume(e); e.shiftKey ? redo() : undo(); }
  else if (ctrl && key === 'y') { consume(e); redo(); }
  else if (ctrl && key === 'a') {
    consume(e); state.selectedBlocks = new Set(state.insts.map(i => i.uid)); state.selected = state.insts.length ? state.insts[state.insts.length - 1].uid : null;
    state.selectedConnection = null; render();
  }
  else if (e.key === 'Delete' && (state.selectedConnection || state.selectedBlocks.size)) {
    consume(e); if (state.selectedConnection) deleteConnection(state.selectedConnection); else deleteBlocks();
  }
  else if (ctrl && key === 'c' && state.selectedBlocks.size) { consume(e); copyBlocks(); }
  else if (ctrl && key === 'x' && state.selectedBlocks.size) { consume(e); copyBlocks(); deleteBlocks(); }
  else if (ctrl && key === 'v') { consume(e); pasteBlock(); }
  else if (e.key === 'ArrowRight' && !ctrl && state.selectedBlocks.size) { consume(e); rotateSelected(90); }
  else if (e.key === 'ArrowLeft' && !ctrl && state.selectedBlocks.size) { consume(e); rotateSelected(-90); }
  else if (e.key === 'ArrowUp' && !ctrl && state.selectedBlocks.size) { consume(e); cycleBlockType(-1); }
  else if (e.key === 'ArrowDown' && !ctrl && state.selectedBlocks.size) { consume(e); cycleBlockType(1); }
  else if (e.key === 'Enter' && state.selected) { consume(e); showPropsDialog(G0(state.selected)); }
  else if (!ctrl && !e.shiftKey && key === 'e') { consume(e); setSelectedEnabled(true); }
  else if (!ctrl && !e.shiftKey && key === 'd') { consume(e); setSelectedEnabled(false); }
  else if (!ctrl && !e.shiftKey && key === 'b') { consume(e); bypassSelected(); }
  else if (!ctrl && !e.shiftKey && key === 'c') { consume(e); log('hierarchical blocks are not supported in WebAssembly'); }
  else if (!ctrl && (e.key === '+' || e.key === '=')) { consume(e); changePortCount(1); }
  else if (!ctrl && (e.key === '-' || e.key === '_')) { consume(e); changePortCount(-1); }
  else if (!ctrl && !e.shiftKey && key === 'g') { consume(e); toggleShowGrid(); }
});

// ---- block Properties dialog (GRC-style modal) ----
const propertiesDialogDeps: PropertiesDialogDeps = {
  state,
  closeMenu,
  defFor,
  blockIdVisible,
  localFileParams: LOCAL_FILE_PARAMS,
  localFileAccept: LOCAL_FILE_ACCEPT,
  recordingDtype: RECORDING_DTYPE,
  layoutDtype: LAYOUT_DTYPE,
  newLocalFileToken,
  loadExampleRecordings,
  radioForDtype,
  localFilesByToken,
  sigmfBindingsByToken,
  sigmfOutputDirsByToken,
  log,
  validateGraph,
  remapConnectionsForPortChange,
  render,
  guiWidgets,
  openJsCodeModal,
  applyJsIo,
  sigmfSampRateToPublish,
  applySampRateFromSigmf,
  sigmfNeedsIShortToComplex,
  attachIShortToComplex,
  select,
  recordHistory,
  showFieldColors: () => showPropertiesFieldColors,
};

function showPropsDialog(inst: Inst) {
  showPropertiesDialog(inst, propertiesDialogDeps);
}

function select(uid: string | null, additive = false) {
  if (uid === null) state.selectedBlocks.clear();
  else if (additive) {
    if (state.selectedBlocks.has(uid)) state.selectedBlocks.delete(uid); else state.selectedBlocks.add(uid);
  } else if (!state.selectedBlocks.has(uid) || state.selectedBlocks.size === 1) {
    state.selectedBlocks.clear(); state.selectedBlocks.add(uid);
  }
  state.selected = uid !== null && state.selectedBlocks.has(uid) ? uid : ([...state.selectedBlocks].pop() || null);
  state.selectedConnection = null;
  render();
}

function selectConnection(conn: Conn) {
  // Give keyboard shortcuts back to the canvas if the palette/property editor
  // previously held focus. The SVG path itself is not a focusable element.
  (document.activeElement as HTMLElement | null)?.blur();
  state.selected = null; state.selectedBlocks.clear();
  state.selectedConnection = conn;
  render();
}

function svgPoint(evt: MouseEvent): { x: number; y: number } {
  const r = svg.getBoundingClientRect();
  return { x: (evt.clientX - r.left) / zoom, y: (evt.clientY - r.top) / zoom };
}

const connectionController = new CanvasConnectionController({
  state,
  wires: wiresG,
  portPosition: portPos,
  controlPoint: ctrl,
  svgPoint,
  autoHidePortLabels: () => autoHidePortLabels,
  render,
  recordHistory,
  log,
});

function cancelConnect(): boolean {
  return connectionController.cancel();
}

const svgEl = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>): SVGElementTagNameMap[K] => {
  const e = document.createElementNS(SVGNS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  return e;
};

function addTrainingPort(g: SVGGElement, inst: Inst, kind: 'in' | 'out', idx: number) {
  const p = portPos(inst, kind, idx);
  const pw = portWidth(inst, kind, idx);
  let x: number, y: number, w: number, h: number;
  if (p.edge === 'L') { w = pw; h = PORT_H; x = p.x; y = p.y - PORT_H / 2; }
  else if (p.edge === 'R') { w = pw; h = PORT_H; x = p.x - pw; y = p.y - PORT_H / 2; }
  else if (p.edge === 'T') { w = PORT_H; h = pw; x = p.x - PORT_H / 2; y = p.y; }
  else { w = PORT_H; h = pw; x = p.x - PORT_H / 2; y = p.y - pw; }
  g.appendChild(svgEl('rect', { class: 'port', x: String(x), y: String(y),
    width: String(w), height: String(h) }));
  const cx = x + w / 2, cy = y + h / 2;
  const label = svgEl('text', { class: 'port-label', x: String(cx), y: String(cy),
    'text-anchor': 'middle', 'dominant-baseline': 'central' });
  if (p.edge === 'T' || p.edge === 'B')
    label.setAttribute('transform', `rotate(-90 ${cx} ${cy})`);
  label.textContent = portLabel(inst, kind, idx);
  g.appendChild(label);
}

function render() {
  renderCanvas({
    state, zoom, trainingSession, trainingNodesG, trainingWiresG, nodesG, wiresG,
    selectionG, rebuildScope, validateGraph, canvasBlockHidden, portMeta,
    connectionPath, cancelConnect, selectConnection, showConnectionMenu, geom, rowsTop,
    blockCommentGeometry, wrapValidationMessage, truncateToWidth, startDrag,
    select, showMenu, visiblePortIndices, addTrainingPort, addPort, portColor,
    updateCanvasExtent, syncRecordingTabs, TITLE_BASELINE, SUBTITLE_H, TITLE_H,
    SUBTITLE_GAP, ROW_H, ROW_BASELINE, TEXT_PAD_L, MORE_ROW_ID, LAYOUT_THUMB_W,
    LAYOUT_THUMB_FONT, COMMENT_GAP, COMMENT_BASELINE, COMMENT_LINE_H,
    ERROR_LINE_H, ERROR_CHAR_W,
  });
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
  const blocks = [...state.insts, ...(trainingSession?.unfilledBlocks(state.insts) || [])];
  for (const inst of blocks) {
    if (canvasBlockHidden(inst)) continue;
    const { w, h } = geom(inst);
    const comment = blockCommentGeometry(inst);
    right = Math.max(right, inst.x + Math.max(w, comment.width));
    bottom = Math.max(bottom, inst.y + h + comment.height);
  }
  svg.style.minWidth = `${Math.ceil((right + CANVAS_MARGIN) * zoom)}px`;
  svg.style.minHeight = `${Math.ceil((bottom + CANVAS_MARGIN) * zoom)}px`;
}

function addPort(g: SVGGElement, inst: Inst, kind: 'in' | 'out', idx: number, color: string) {
  // Native GRC ports are typed, colored tabs whose width follows their centered
  // label. Auto-hide reduces that to PORT_HIDDEN_W until hover; because
  // portPos() reads the same width, the connection remains attached to the
  // tab's moving outer edge just as it does natively.
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
  connectionController.bindPort(r, inst, kind, idx);
  g.appendChild(r);
  g.appendChild(text);
}
const G0 = (uid: string) => state.insts.find(i => i.uid === uid)!;

function adoptTrainingTarget(actual: Inst, target: Inst) {
  remapConnectionsForPortChange(actual, target.params);
  actual.name = target.name;
  actual.x = target.x;
  actual.y = target.y;
  actual.params = clone(target.params);
  actual.enabled = target.enabled;
  actual.rotation = target.rotation;
  actual.bypassed = target.bypassed;
  delete actual.localFileToken;
  log(`placed ${defFor(actual).label} as ${target.name}`);
}

const gestureController = new CanvasGestureController({
  state,
  svg,
  selectionLayer: selectionG,
  connections: connectionController,
  zoom: () => zoom,
  snapToGrid: () => snapToGrid,
  trainingSession: () => trainingSession,
  svgPoint,
  canvasBlockHidden,
  geom,
  render,
  select,
  showProperties: showPropsDialog,
  adoptTrainingTarget,
  recordHistory,
});

function startDrag(event: PointerEvent, inst: Inst): void {
  gestureController.startDrag(event, inst);
}

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
// The bindings handed to one run: files a source reads, and the destinations a
// sink writes. `meta` is a SigMF Source's .sigmf-meta text, carried beside the
// samples so the runner's factory can build its tag plan without any of it
// reaching the .grc. An 'output' has no File and no size -- a folder handle to
// stream into, or nothing at all, in which case the runner buffers and
// downloads at the end.
const runSessionState: RunSessionState = {
  pendingFiles: new Map<string, RunnerInputFile[]>(),
  pendingToken: null,
  generation: 0,
  runningGraphSnapshot: null,
  active: false,
};

// How big the file at a Public HTTP Recording's URL is. The reader needs the
// length up front to bound its ranges, and there is no metadata to take it
// from, so ask the server: HEAD first, and a one-byte range for the hosts that
// serve ranges but not HEAD. Either answer also proves the URL is reachable
// with this origin's CORS headers, which is what makes it worth doing before
// the flowgraph starts rather than inside the reader worker.

// ---- embedded mode (?embed=1) ----------------------------------------------
// What another site frames to show one flowgraph: editor.css drops everything
// around #workspaceContent, leaving the canvas and the QT GUI pane, and two
// controls over them. #embedRun is Run and Stop both, because the pane on screen
// follows the run state — running opens the QT GUI, stopping comes back to the
// canvas — so there is never a moment where both would be offered. #embedOpen
// hands the flowgraph to the full application in a tab of its own.
// A query parameter rather than a fragment key: the fragment already says which
// flowgraph to open (#example=…) and is rewritten as the reader works, while
// this is a property of the host page's <iframe src> that nothing may touch —
// which is also what makes dropping the whole query the right way to leave.
if (EMBEDDED) el('app').classList.add('embedded');
// ?no_scroll=1 — a host that would rather clip an oversized flowgraph than show
// scrollbars over it. editor.css turns this off with #canvasScroll's overflow.
if (EMBEDDED && EMBED_NO_SCROLL) el('app').classList.add('embed-no-scroll');

// Same page without the embed flag, so an untouched embed hands over the clean,
// bookmarkable #example= link it was framed with. Once the reader has changed
// something that link would open a *different* flowgraph than the one on screen,
// so from then on the canvas rides along as the same frozen #fg= payload File ▸
// Copy Flowgraph URL hands out. Kept current rather than computed on click:
// gzipping is async, and an <a> has to know where it points before the click.
// A declaration, not a const: the history functions above call the refresh, and
// they run before this point in the module.
function embedOpenUrl() { return location.href.split('#')[0].split('?')[0] + location.hash; }
async function refreshEmbedOpen() {
  if (!EMBEDDED) return;
  let href: string;
  try { href = historyIndex > 0 ? await flowgraphToUrl() : embedOpenUrl(); }
  catch { href = embedOpenUrl(); }
  embedOpen.href = href;
  // ?no_controls=1's stand-in for #embedOpen — same destination, kept current
  // the same way.
  embedOpenBlock.href = href;
}

// Editor and QT GUI are the two fixed tabs; recording tabs ('rec:<key>') are
// added and removed by syncRecordingTabs() as recording blocks come and go, so the
// bar is a registry rather than the pair of buttons it used to be.
// `container` is what the bar orders and holds: a recording tab is a group of
// the tab button plus its close button, because a button cannot contain one.
const workspaceTabController = new WorkspaceTabsController({
  editorPane: el('editorPane'),
  runnerPane: el('runPane'),
  isRecordingTab: id => isRecordingTabId(id),
  recordingKey: id => recordingTabKey(id),
  openRecording: key => openRecordingPane(key),
  closeRecording: key => recordingTabsController.close(key),
},
{ id: 'editor', button: el('tabEditor') as HTMLButtonElement, panel: el('editorPane') },
{ id: 'qtgui', button: el('tabQtGui') as HTMLButtonElement, panel: el('runPane') });
const workspaceTabs = workspaceTabController.entries;

function activateWorkspaceTab(tab: WorkspaceTab): void {
  workspaceTabController.activate(tab);
}

function wireWorkspaceTab(entry: WorkspaceTabEntry): void {
  workspaceTabController.wire(entry);
}

let runnerRunning = false;

function updateRunningCanvasState(): void {
  updateRunCanvasState(runSessionDeps, runSessionState);
}

function markRunningCanvasStale(stale: boolean): void {
  el('runStatus').textContent = stale
    ? 'Running flowgraph — canvas has changed since'
    : 'Running flowgraph…';
  el('workspace').classList.toggle('run-stale', stale);
}

function updateEmbedRun(failed = false) {
  embedRun.classList.toggle('running', runnerRunning && !failed);
  embedRun.classList.toggle('failed', failed);
  embedRun.textContent = failed ? '⚠ Cannot run' : runnerRunning ? '■ Stop' : '▶ Run';
  const hint = failed ? 'The flowgraph could not be started'
    : runnerRunning ? 'Stop the flowgraph and return to the block editor'
    : 'Run the flowgraph and open its QT GUI';
  embedRun.title = hint;
  embedRun.setAttribute('aria-label', hint);
  // The QT GUI pane covers the canvas while the flowgraph runs, and zoom acts on
  // the canvas alone, so the pair goes away with it rather than sitting over the
  // widgets doing nothing.
  embedZoom.hidden = runnerRunning && !failed;
  // ?no_controls=1's block-styled stand-in: same states as #embedRun, applied
  // as classes instead of text since its "label" is the play/stop icon.
  embedPlayBlock.classList.toggle('running', runnerRunning && !failed);
  embedPlayBlock.classList.toggle('failed', failed);
  embedPlayBlock.title = hint;
  embedPlayBlock.setAttribute('aria-label', hint);
}

function setRunnerRunning(running: boolean, status?: string) {
  runnerRunning = running;
  updateEmbedRun();
  el('workspace').classList.toggle('running', running);
  if (!running) {
    runSessionState.active = false;
    runSessionState.runningGraphSnapshot = null;
    el('workspace').classList.remove('run-stale');
  }
  el('runStatus').textContent = status || (running ? 'Running flowgraph…' : 'No flowgraph running');
  (el('btnStop') as HTMLButtonElement).disabled = !running;
  // Arranging needs live widgets to drag. A new run re-enables the button when
  // its first widget report arrives.
  if (!running) {
    runnerLayout = null;
    setArrangeMode(false);
    (el('btnArrange') as HTMLButtonElement).disabled = true;
  }
  const qtTab = el('tabQtGui');
  const qtLabel = running ? 'QT GUI — flowgraph running' : 'QT GUI';
  qtTab.title = qtLabel;
  qtTab.setAttribute('aria-label', qtLabel);
}

if (EMBEDDED) {
  // ?no_controls=1 — a host that draws its own Run/zoom UI and wants the canvas
  // free of the row #embedControls otherwise floats over it (Run, the way out,
  // and the two zoom icons). It gets the lone block-styled Run button instead,
  // since without it an embed would have no way at all to start the flowgraph.
  if (!EMBED_NO_CONTROLS) el('embedControls').hidden = false;
  else el('embedPlayCorner').hidden = false;
  // The two canvas controls an embed keeps. Same calls as the toolbar's buttons
  // and Ctrl+±, which is what setZoom's shared `data-tool` lookup greys out.
  el('embedZoomIn').addEventListener('click', () => setZoom(zoom * ZOOM_STEP));
  el('embedZoomOut').addEventListener('click', () => setZoom(zoom / ZOOM_STEP));
  // The fragment names the flowgraph, and loading an example rewrites it.
  window.addEventListener('hashchange', () => void refreshEmbedOpen());
  void refreshEmbedOpen();
  let failedTimer = 0;
  const onEmbedRunClick = async () => {
    window.clearTimeout(failedTimer);
    // Neither call needs anything extra to move the reader: stop() already
    // returns to the canvas and run() already opens the QT GUI pane.
    if (runnerRunning) { stop(); return; }
    updateEmbedRun();   // clears a "cannot run" still on the button from before
    await run();
    // run() refuses a flowgraph that does not validate, and says why in the
    // console pane — which is one of the parts an embed does not show. So a run
    // that never started has to be visible on the button itself.
    if (!runnerRunning) {
      updateEmbedRun(/* failed */ true);
      failedTimer = window.setTimeout(() => updateEmbedRun(), 3000);
    }
  };
  embedRun.addEventListener('click', onEmbedRunClick);
  embedPlayBlock.addEventListener('click', onEmbedRunClick);
  updateEmbedRun();
}

// ---- Arrange mode: rearranging the widgets of a *running* flowgraph ---------
// The runner reports where its grid is on screen (in the iframe's own CSS
// pixels, which is what Qt's global coordinates are there) and which widget
// landed in which tile. This draws handles over them in the editor's own DOM,
// turns a drag into grid cells through the same gui-layout.ts rules the
// Properties designer uses, writes the result into the GUI Layout block -- so it
// is part of the flowgraph and Save keeps it -- and sends it down to be applied
// live. Nothing restarts: the plots keep plotting while they move.
interface RunnerWidget {
  name: string; id: string; col: number; row: number; w: number; h: number;
  /** Where it is on the Qt canvas, in the iframe's CSS pixels. For cropping a
   *  screenshot to one plot; absent from an older runner build's report. */
  rect?: { x: number; y: number; width: number; height: number };
}
interface RunnerLayoutReport {
  columns: number; rowHeight: number; arranged: boolean;
  rect: { x: number; y: number; width: number; height: number };
  widgets: RunnerWidget[];
}
let runnerLayout: RunnerLayoutReport | null = null;
let arrangeMode = false;
// Block ids the runner built a widget for that the generated library does not
// flag as `gui`. That means the block's metadata never declared `gui: true`, and
// the only symptom otherwise is a widget the editor cannot offer a tile for.
// Reported once per id per session.
const unflaggedGuiIds = new Set<string>();

const tilesFromReport = (report: RunnerLayoutReport): TileMap =>
  Object.fromEntries(report.widgets.map(w =>
    [w.name, { col: w.col, row: w.row, w: w.w, h: w.h }]));

function pushLayoutToRunner(tiles: TileMap) {
  const frame = el('runFrame') as HTMLIFrameElement;
  if (!frame.contentWindow || !runnerLayout) return;
  frame.contentWindow.postMessage({
    type: 'gr-set-layout', tiles: serializeTiles(tiles),
    columns: runnerLayout.columns, rowHeight: runnerLayout.rowHeight,
  }, location.origin);
}

function setArrangeMode(on: boolean) {
  arrangeMode = on && !!runnerLayout;
  const overlay = el('arrangeOverlay');
  overlay.hidden = !arrangeMode;
  const button = el('btnArrange') as HTMLButtonElement;
  button.classList.toggle('active', arrangeMode);
  button.setAttribute('aria-pressed', String(arrangeMode));
  if (arrangeMode) drawArrangeOverlay();
  else overlay.textContent = '';
}

function drawArrangeOverlay() {
  const overlay = el('arrangeOverlay');
  if (!arrangeMode || !runnerLayout) { overlay.textContent = ''; return; }
  const report = runnerLayout;
  const tiles = tilesFromReport(report);
  const rows = Math.max(1, rowsUsed(tiles));
  const cellW = report.rect.width / report.columns;
  const cellH = report.rect.height / rows;
  overlay.textContent = '';

  const frame = document.createElement('div');
  frame.className = 'arrange-grid';
  frame.style.left = `${report.rect.x}px`; frame.style.top = `${report.rect.y}px`;
  frame.style.width = `${report.rect.width}px`; frame.style.height = `${report.rect.height}px`;
  overlay.appendChild(frame);

  for (const widget of report.widgets) {
    const tile = document.createElement('div');
    tile.className = 'arrange-tile';
    tile.dataset.name = widget.name;
    tile.style.left = `${report.rect.x + widget.col * cellW}px`;
    tile.style.top = `${report.rect.y + widget.row * cellH}px`;
    tile.style.width = `${widget.w * cellW}px`;
    tile.style.height = `${widget.h * cellH}px`;
    const name = document.createElement('span');
    name.className = 'arrange-tile-name'; name.textContent = widget.name;
    const size = document.createElement('span');
    size.className = 'arrange-tile-size'; size.textContent = `${widget.w}×${widget.h}`;
    const handle = document.createElement('div');
    handle.className = 'arrange-tile-resize'; handle.setAttribute('aria-hidden', 'true');
    tile.append(name, size, handle);
    overlay.appendChild(tile);
  }

  const hint = document.createElement('div');
  hint.className = 'arrange-hint';
  hint.textContent = report.widgets.length
    ? 'Drag a widget to move it, or its corner to resize. Changes are saved into ' +
      'the flowgraph’s GUI Layout block. Press Arrange again to finish.'
    : 'This flowgraph has no QT GUI widgets to arrange.';
  overlay.appendChild(hint);
}

// One drag, from pointerdown on a tile to release. The tiles are recomputed on
// every cell boundary crossed and pushed straight down to the runner, so the
// real widgets move under the cursor; the .grc is written once, at the end, so
// Undo steps over whole drags rather than individual cells.
let arrangeDrag: {
  name: string; mode: 'move' | 'resize'; startX: number; startY: number;
  origin: { col: number; row: number; w: number; h: number };
  cellW: number; cellH: number; pointer: number;
} | null = null;

function initArrangeOverlay() {
  const overlay = el('arrangeOverlay');
  overlay.addEventListener('pointerdown', event => {
    const target = (event.target as HTMLElement).closest('.arrange-tile') as HTMLElement | null;
    if (!target || event.button !== 0 || !runnerLayout) return;
    const widget = runnerLayout.widgets.find(w => w.name === target.dataset.name);
    if (!widget) return;
    event.preventDefault();
    const rows = Math.max(1, rowsUsed(tilesFromReport(runnerLayout)));
    arrangeDrag = {
      name: widget.name,
      mode: (event.target as HTMLElement).classList.contains('arrange-tile-resize')
        ? 'resize' : 'move',
      startX: event.clientX, startY: event.clientY,
      origin: { col: widget.col, row: widget.row, w: widget.w, h: widget.h },
      cellW: runnerLayout.rect.width / runnerLayout.columns,
      cellH: runnerLayout.rect.height / rows,
      pointer: event.pointerId,
    };
    target.classList.add('dragging');
    overlay.setPointerCapture(event.pointerId);
  });

  overlay.addEventListener('pointermove', event => {
    if (!arrangeDrag || !runnerLayout || event.pointerId !== arrangeDrag.pointer) return;
    const dx = Math.round((event.clientX - arrangeDrag.startX) / arrangeDrag.cellW);
    const dy = Math.round((event.clientY - arrangeDrag.startY) / arrangeDrag.cellH);
    const origin = arrangeDrag.origin;
    const next = arrangeDrag.mode === 'move'
      ? { ...origin, col: origin.col + dx, row: origin.row + dy }
      : { ...origin, w: origin.w + dx, h: origin.h + dy };
    const settled = placeTile(tilesFromReport(runnerLayout), arrangeDrag.name, next,
                             runnerLayout.columns);
    if (serializeTiles(settled) === serializeTiles(tilesFromReport(runnerLayout))) return;
    // Optimistic: redraw the handles and move the real widgets now. The runner
    // echoes its own report back, which agrees with this and changes nothing.
    runnerLayout = { ...runnerLayout, widgets: runnerLayout.widgets.map(w =>
      ({ ...w, ...settled[w.name] })) };
    drawArrangeOverlay();
    overlay.querySelector(`.arrange-tile[data-name="${CSS.escape(arrangeDrag.name)}"]`)
      ?.classList.add('dragging');
    pushLayoutToRunner(settled);
  });

  const finish = (event: PointerEvent) => {
    if (!arrangeDrag || event.pointerId !== arrangeDrag.pointer) return;
    arrangeDrag = null;
    if (!runnerLayout) return;
    // Into the flowgraph, which is what makes the arrangement outlive this run.
    setLayoutTiles(tilesFromReport(runnerLayout));
    drawArrangeOverlay();
  };
  overlay.addEventListener('pointerup', finish);
  overlay.addEventListener('pointercancel', finish);

  (el('btnArrange') as HTMLButtonElement).addEventListener(
    'click', () => setArrangeMode(!arrangeMode));
}

// A fresh report from the runner: the widgets it built, their tiles, and where
// the grid sits in the iframe. Arrives on every run and whenever the window is
// moved, resized or rearranged.
function applyRunnerLayoutReport(payload: string) {
  let report: RunnerLayoutReport;
  try { report = JSON.parse(payload); } catch { return; }
  if (!report || !Array.isArray(report.widgets)) return;
  runnerLayout = report;
  (el('btnArrange') as HTMLButtonElement).disabled = !report.widgets.length;
  for (const widget of report.widgets) {
    if (GUI_BLOCK_IDS.has(widget.id) || unflaggedGuiIds.has(widget.id)) continue;
    unflaggedGuiIds.add(widget.id);
    log(`note: "${widget.id}" builds a GUI widget but its metadata does not ` +
        `declare "gui: true", so the layout designer cannot offer it a tile`);
  }
  // A drag redraws for itself, and a report arriving mid-drag would fight it.
  if (arrangeMode && !arrangeDrag) drawArrangeOverlay();
}

// runner.html is same-origin and takes this one-time payload before Qt/WASM
// starts. Descriptors retain either a browser File reference or a remote URL;
// the runner reads bounded slices/ranges instead of materializing whole files.
(window as any).__grTakeRecordingFiles = (token: string): RunnerInputFile[] => {
  return takeRecordingFiles(runSessionState, token);
};

// ---- Recording tabs (an embedded recording view per recording) --------------
// Every block with a recording behind it — a GR World Recording, or a File
// Source bound to a local file — gets its own workspace tab holding
// the recording viewer this same build emits at /recording/ (adapted from
// IQEngine; see editor/src/recording/), driven through its 'url' data source.
// One <iframe> per tab, created the first time that tab is activated and kept
// alive afterwards, which is what makes both halves of the laziness hold: the
// viewer bundle is requested once (later tabs hit the HTTP cache) and a
// recording's samples are requested only for tabs actually opened.
//
// The tab set is derived state — it never reaches the .grc — so it is rebuilt
// from `insts` on every render() rather than tracked through each mutation. The
// one exception is a *pinned* tab: the Recordings palette and the #recording=
// deep link both open a recording no block owns, so those tabs survive the sync
// and carry a close button instead. Both origins key a tab by the same
// '/recordings/...' path a GR World Recording would produce, so adding the block
// for a previewed recording adopts its tab rather than opening a second one.
const recordingTabsController = createRecordingTabs({
  state,
  workspaceTabs,
  workspaceController: workspaceTabController,
  workspaceContent: el('workspaceContent'),
  workspaceTabsElement: el('workspaceTabs'),
  wireWorkspaceTab,
  activateWorkspaceTab,
  localFilesByToken,
  sigmfBindingsByToken,
  scope: () => varScope,
  resolveParamsForRun,
  bindRemoteRecording,
  setUrlFragment,
  closePaletteDrawer,
  resolveRemoteRecording,
  render,
  recordHistory,
});

function isRecordingTabId(id: WorkspaceTab): boolean {
  return recordingTabsController.isRecordingTabId(id);
}

function recordingTabKey(id: WorkspaceTab): string {
  return recordingTabsController.recordingTabKey(id);
}

const recordingHashKey = (): string | null =>
  new URLSearchParams(location.hash.slice(1)).get('recording');

function syncRecordingTabs(): void {
  recordingTabsController.syncRecordingTabs();
}

function openRecordingPreview(recording: ExampleRecording): void {
  recordingTabsController.openRecordingPreview(recording);
}

function openRecordingPane(key: string): Promise<void> {
  return recordingTabsController.openRecordingPane(key);
}

function recordingSourceFor(block: Inst) {
  return recordingTabsController.recordingSourceFor(block);
}
// ---- Narrow-layout palette drawer ----
// When this matches, editor.css lays the palette over the canvas as a drawer
// instead of beside it — narrow screens, plus the short-and-wide one a phone
// makes when it is turned sideways. It repeats that file's query verbatim and is
// the only other copy of it. The state is the same `hide-palette` class the wide
// layout uses, so View ▸ Show Block Tree Panel and Ctrl+B keep working unchanged.
const NARROW_LAYOUT =
  window.matchMedia('(max-width:820px), (max-width:1000px) and (max-height:500px)');
const paletteToggle = el('paletteToggle');

function setPaletteOpen(open: boolean) {
  el('app').classList.toggle('hide-palette', !open);
  paletteToggle.setAttribute('aria-expanded', String(open));
  const label = open ? 'Hide block palette' : 'Show block palette';
  paletteToggle.setAttribute('aria-label', label);
  paletteToggle.title = label;
}
function togglePalette() { setPaletteOpen(el('app').classList.contains('hide-palette')); }
// A drawer covers the canvas, so anything that puts something *on* the canvas
// gets out of its own way. No-op in the wide layout, where the palette is not
// covering anything.
function closePaletteDrawer() { if (NARROW_LAYOUT.matches) setPaletteOpen(false); }

paletteToggle.addEventListener('click', togglePalette);
el('paletteScrim').addEventListener('click', () => setPaletteOpen(false));
// Open beside the canvas on a desktop, closed over it on a phone — where the
// flowgraph the reader followed a link to see is the thing worth showing first.
setPaletteOpen(!NARROW_LAYOUT.matches);
NARROW_LAYOUT.addEventListener('change', event => setPaletteOpen(!event.matches));

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
el('consoleToggle').addEventListener('click', toggleConsole);
syncConsoleToggle();
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

// ---- the browser-local JS block library ------------------------------------
// The repo pair (blocks/js/<id>.js + blocks/grc/<id>.block.yml) is the real
// destination -- a JS block that ships is a block everyone gets. But a static
// site with no backend cannot commit for you, so without this every block anyone
// writes is unusable until a pull request merges.
//
// A local block is *not* a new block id. Its instances are ordinary
// wasm_js_block instances carrying the source inline under `_js_source`, which is
// what makes a flowgraph shared as a link work for someone who does not have this
// library. Only a merged repo block gets an id of its own.
let localJsBlocks: LocalJsBlock[] = [];
let redrawPalette: (() => void) | null = null;

/** Palette entries for the saved blocks, in the shape buildTree() reads. */
function localJsPaletteEntries(): any[] {
  return localJsBlocks.map(block => ({
    id: block.id,
    label: block.label,
    runnable: true,
    category: (block.category || '[Custom JS Blocks]').replace(/^\[|\]$/g, '')
      .split('/').map(s => s.trim()).filter(Boolean),
    localJs: block,
  }));
}

async function refreshLocalJsBlocks() {
  localJsBlocks = await listLocalJsBlocks();
  // Saved here, so it needs no Run consent.
  for (const block of localJsBlocks) acceptJsSource(block.source);
  redrawPalette?.();
}

function placeLocalJsBlock(block: LocalJsBlock) {
  const params: Record<string, any> = { [JS_LOCAL_SOURCE_PARAM]: block.source };
  applyJsIo(params, block.io);
  const inst = addBlock(JS_BLOCK_ID, undefined, undefined, params, false);
  if (!inst) return;
  // Named after the saved block rather than after wasm_js_block, so a canvas of
  // them reads as the blocks they are.
  inst.name = uniqueBlockName(block.id);
  recordHistory();
  render();
}

// ---- Save as Block ---------------------------------------------------------
// Two things at once: the block is installed into the local library and appears
// in the palette immediately, and the two repo files it would become are offered
// as a download. The yml is generated from the descriptor -- it is authoritative
// for a repo block, so no human writes it by hand.
function saveJsBlockAs(source: string, io: JsBlockIo | null) {
  if (!io) {
    log('cannot save this block: its code has to read cleanly first');
    return;
  }
  let idInput!: HTMLInputElement;
  let labelInput!: HTMLInputElement;
  let categoryInput!: HTMLInputElement;
  let note!: HTMLElement;
  const currentId = () => sanitizeBlockId(idInput.value || io.label);
  const refresh = () => {
    const id = currentId();
    const clash = !!RUNNABLE[id] && id !== JS_BLOCK_ID;
    note.textContent = clash
      ? `"${id}" is already a block id in this editor — pick another.`
      : `blocks/js/${id}.js  ·  blocks/grc/${id}.block.yml`;
    note.classList.toggle('code-error', clash);
    return !clash;
  };
  const overlay = openDialog('Save as Block', body => {
    const row = (label: string, value: string, placeholder: string) => {
      const wrap = document.createElement('div'); wrap.className = 'dlgrow';
      const l = document.createElement('label'); l.textContent = label;
      const input = document.createElement('input');
      input.value = value; input.placeholder = placeholder;
      wrap.append(l, input); body.appendChild(wrap);
      return input;
    };
    labelInput = row('Label', io.label, 'JS Gain');
    idInput = row('Block ID', sanitizeBlockId(io.label), 'js_gain');
    categoryInput = row('Category', '[Custom JS Blocks]', '[Custom JS Blocks]/Filters');
    note = document.createElement('small'); note.className = 'code-status';
    body.appendChild(note);
    labelInput.oninput = () => {
      if (!idInput.dataset.touched) idInput.value = sanitizeBlockId(labelInput.value);
      refresh();
    };
    idInput.oninput = () => { idInput.dataset.touched = '1'; refresh(); };
  });
  const foot = overlay.querySelector('.dlgfoot')!;
  const save = document.createElement('button');
  save.type = 'button'; save.className = 'run'; save.textContent = 'Save';
  save.onclick = async () => {
    if (!refresh()) return;
    const block: LocalJsBlock = {
      id: currentId(),
      label: labelInput.value.trim() || io.label,
      category: categoryInput.value.trim() || '[Custom JS Blocks]',
      source, io, saved: Date.now(),
    };
    try {
      await saveLocalJsBlock(block);
    } catch (error) {
      log('could not save the block to this browser: ' + error);
      return;
    }
    acceptJsSource(source);
    await refreshLocalJsBlocks();
    overlay.remove();
    log(`saved "${block.label}" to this browser's block library — it is in the ` +
        `palette under ${block.category}`);
    offerRepoFiles(block);
  };
  foot.insertBefore(save, foot.firstChild);
  refresh();
}

// The pull request a saved block would become. The editor has no backend and no
// credentials, so this is a hand-off in the same shape as "contribute this
// flowgraph as an example": the two files are offered as downloads, and GitHub's
// new-file page is opened at the right path for anyone who would rather paste.
function offerRepoFiles(block: LocalJsBlock) {
  openDialog(`Contribute "${block.label}"`, body => {
    const lead = document.createElement('p');
    lead.textContent =
      'A JS block that ships is a block everyone gets. These are the two files ' +
      'a pull request would add — the .js is the implementation, the .yml is its ' +
      'palette entry and is authoritative for a repo block.';
    body.appendChild(lead);
    const files: [string, string][] = [
      [`blocks/js/${block.id}.js`, block.source],
      [`blocks/grc/${block.id}.block.yml`, generateBlockYml(block)],
    ];
    for (const [path, text] of files) {
      const row = document.createElement('div'); row.className = 'dlgrow';
      const label = document.createElement('label'); label.textContent = path;
      const buttons = document.createElement('div'); buttons.className = 'code-controls';
      const download = document.createElement('button');
      download.type = 'button'; download.textContent = 'Download';
      download.onclick = () => downloadBlob(text, 'text/plain', path.split('/').pop()!);
      const copy = document.createElement('button');
      copy.type = 'button'; copy.textContent = 'Copy';
      copy.onclick = () => {
        void navigator.clipboard?.writeText(text)
          .then(() => log(`copied ${path} to the clipboard`))
          .catch(() => log(`could not copy ${path}`));
      };
      const open = document.createElement('button');
      open.type = 'button'; open.textContent = 'Open on GitHub';
      open.onclick = () => window.open(newRepoFileUrl(path), '_blank', 'noopener');
      buttons.append(download, copy, open);
      row.append(label, buttons);
      body.appendChild(row);
    }
    const tail = document.createElement('small');
    tail.className = 'code-status';
    tail.textContent =
      'GitHub’s new-file page commits to a branch; put the second file on that ' +
      'same branch and the pull request is the two of them.';
    body.appendChild(tail);
  }, true);
}

// ---- Run consent for a flowgraph's JavaScript ------------------------------
// A .grc arriving from a link can carry arbitrary JavaScript, and the runner
// iframe is same-origin with the editor. So pressing Run on a flowgraph
// containing a JS Block whose source has not already been accepted shows the code
// and asks -- the same shape as the RTL-SDR device prompt on the Run click,
// remembered per source hash in localStorage.
//
// Source typed in this session is accepted as it is typed (every derivation
// accepts it), and a repo JS block is trusted because it went through review, so
// this only ever interrupts code that arrived from somewhere else.
const shippedJsDefault = () => String(
  RUNNABLE[JS_BLOCK_ID]?.params.find(p => p.id === JS_SOURCE_PARAM)?.def ?? '');

function unacceptedJsSources(): { block: Inst; source: string }[] {
  const out: { block: Inst; source: string }[] = [];
  const seen = new Set<string>();
  for (const block of state.insts) {
    if (block.id !== JS_BLOCK_ID || !block.enabled || block.bypassed) continue;
    const source = jsSourceOf(block.params);
    // The palette's own default ships with the app and went through review, so a
    // freshly placed block never asks.
    if (!source.trim() || source === shippedJsDefault() || seen.has(source) ||
        isJsSourceAccepted(source)) continue;
    seen.add(source);
    out.push({ block, source });
  }
  return out;
}

function askToRunJavaScript(pending: { block: Inst; source: string }[]): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      overlay.remove();
      resolve(ok);
    };
    const overlay = document.createElement('div'); overlay.className = 'modal';
    const dlg = document.createElement('div'); dlg.className = 'dlg dlg-code';
    const head = document.createElement('div'); head.className = 'dlghead';
    head.textContent = pending.length === 1
      ? 'Run this flowgraph’s JavaScript?'
      : `Run this flowgraph’s JavaScript? (${pending.length} blocks)`;
    const body = document.createElement('div'); body.className = 'dlgbody';
    const lead = document.createElement('p');
    lead.textContent =
      'This flowgraph carries JavaScript that did not come from this session. It ' +
      'runs in this tab with the same reach as the page itself, so read it before ' +
      'you run it.';
    body.appendChild(lead);
    for (const { block, source } of pending) {
      const name = document.createElement('div');
      name.className = 'code-consent-name';
      name.textContent = block.name;
      const pre = document.createElement('pre');
      pre.className = 'code-consent-source';
      pre.textContent = source;
      body.append(name, pre);
    }
    const foot = document.createElement('div'); foot.className = 'dlgfoot';
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.textContent = 'Cancel';
    cancel.onclick = () => finish(false);
    const accept = document.createElement('button');
    accept.type = 'button'; accept.className = 'run'; accept.textContent = 'Run it';
    accept.onclick = () => {
      for (const { source } of pending) acceptJsSource(source);
      finish(true);
    };
    foot.append(cancel, accept);
    dlg.append(head, body, foot);
    overlay.appendChild(dlg);
    document.body.appendChild(overlay);
    cancel.focus();
  });
}

// GNU Radio marks both explicit Throttle blocks and naturally paced I/O such as
// audio and SDRs with the `throttle` flag. Read that metadata rather than
// maintaining another hardware list here, so a future paced block automatically
// participates in this check when its block definition is added.
function rateLimiterIds(): Set<string> {
  return new Set((LIB.blocks || [])
    .filter((block: any) => blockFlags(block.flags).includes('throttle'))
    .map((block: any) => String(block.id)));
}

function askToRunUnpacedFlowgraph(): Promise<boolean> {
  if (unpacedRunWarningDismissed() ||
      !shouldWarnAboutUnpacedRun(state.insts, rateLimiterIds()))
    return Promise.resolve(true);

  return new Promise(resolve => {
    let settled = false;
    const finish = (runAnyway: boolean) => {
      if (settled) return;
      settled = true;
      window.removeEventListener('keydown', onKeyDown, true);
      if (runAnyway && dontRemind.checked) dismissUnpacedRunWarning();
      overlay.remove();
      resolve(runAnyway);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') finish(false);
    };

    const overlay = document.createElement('div');
    overlay.className = 'modal unpaced-run-warning';
    const dlg = document.createElement('div'); dlg.className = 'dlg';
    const head = document.createElement('div'); head.className = 'dlghead';
    head.textContent = 'Run without a rate limit?';
    const body = document.createElement('div'); body.className = 'dlgbody';
    const lead = document.createElement('p');
    lead.textContent =
      'This flowgraph has no enabled Throttle or naturally paced hardware block ' +
      '(such as an SDR or audio device). A configured sample rate does not pace ' +
      'GNU Radio by itself, so the flowgraph may run as fast as your CPU allows.';
    const advice = document.createElement('p');
    advice.textContent =
      'For real-time simulation or playback, you probably want to add one ' +
      'Throttle block at the highest sample rate in the flowgraph.';
    const reminder = document.createElement('label');
    reminder.className = 'unpaced-run-reminder';
    const dontRemind = document.createElement('input');
    dontRemind.type = 'checkbox';
    reminder.append(dontRemind, document.createTextNode('Don\'t remind me again'));
    body.append(lead, advice, reminder);

    const foot = document.createElement('div'); foot.className = 'dlgfoot';
    const cancel = document.createElement('button');
    cancel.type = 'button'; cancel.textContent = 'Cancel';
    cancel.onclick = () => finish(false);
    const runAnyway = document.createElement('button');
    runAnyway.type = 'button'; runAnyway.className = 'run';
    runAnyway.textContent = 'Run anyway';
    runAnyway.onclick = () => finish(true);
    foot.append(cancel, runAnyway);
    dlg.append(head, body, foot); overlay.appendChild(dlg);
    document.body.appendChild(overlay);
    overlay.addEventListener('pointerdown', event => {
      if (event.target === overlay) finish(false);
    });
    window.addEventListener('keydown', onKeyDown, true);
    cancel.focus();
  });
}

const runSessionDeps: RunSessionDeps = {
  state,
  trainingSession: () => trainingSession,
  log,
  validateGraph,
  select,
  askToRunUnpacedFlowgraph,
  // Whether the dialog above *would be shown*, which is the question an
  // unattended run has to answer for itself. Gated on the same dismissal, so
  // there is one rule rather than two: an unattended run declines exactly the
  // runs a human would have been asked to approve, and a reader who has turned
  // the warning off has said to let an unpaced graph run.
  isUnpacedFlowgraph: () => !unpacedRunWarningDismissed() &&
    shouldWarnAboutUnpacedRun(state.insts, rateLimiterIds()),
  usbRadios: USB_RADIOS,
  showUsbPreparationProblem,
  sigmfOutputDirsByToken,
  newLocalFileToken,
  unacceptedJsSources,
  askToRunJavaScript,
  resolveRemoteRecording,
  localFilesByToken,
  sigmfBindingsByToken,
  recordingPathForBlock: block => recordingSourceFor(block)?.path || null,
  grcTextForRun,
  buildGrcDoc,
  snapshot,
  localFileParams: LOCAL_FILE_PARAMS,
  optionsId: OPTIONS_ID,
  layoutId: LAYOUT_ID,
  httpRecordingId: HTTP_RECORDING_ID,
  httpRecordingParam: HTTP_RECORDING_PARAM,
  httpRecordingPrefix: HTTP_RECORDING_PREFIX,
  frame: el('runFrame') as HTMLIFrameElement,
  runEmpty: el('runEmpty'),
  setRunnerRunning,
  activateWorkspaceTab,
  markCanvasStale: markRunningCanvasStale,
};

async function run(options: RunOptions = {}): Promise<string | null> {
  return runFlowgraph(runSessionDeps, runSessionState, options);
}

function stop(): void {
  stopFlowgraph(runSessionDeps, runSessionState);
}

// ---- Palette ----
// ---- GRC-style block tree (collapsible categories + search) ----
// Blocks whose factory builds a QWidget, and so take a tile in the runner
// window's GUI Layout grid. Filled from the generated library's `gui` flag,
// which each block declares as `gui: true` in its overlay (or, for a runner-only
// block, its own yml) -- the C++ decides this, and the editor has no way to work
// it out for itself.
const GUI_BLOCK_IDS = new Set<string>();
// Blocks that stay loadable and runnable but are not offered in the palette:
// upstream deprecated them in favour of a replacement listed right beside them,
// and showing both only invites picking the wrong one. A .grc that already uses
// one still opens, runs and round-trips.
const PALETTE_HIDDEN = new Set([
  'blocks_throttle',   // "Throttle (old)" — superseded by blocks_throttle2
]);

// Passes the editor's own clicks down to a runner frame whose audio the
// autoplay policy is holding shut -- the reader is far more likely to click
// here than on the flowgraph window.
const audioResume = installAudioResumeRelay(
  () => el('runFrame') as HTMLIFrameElement, log);

// Category side modules the runner has fetched this session. This state is shown
// in Help > WebAssembly Modules & Debug Info, but deliberately not in the block
// palette.
const loadedModules = new Set<string>();

// The runner iframe posts a 'gr-module' message as each category side module is
// fetched. Track it for the debug-info dialog.
window.addEventListener('message', (e) => {
  const d = (e as MessageEvent).data;
  if (!d) return;
  // Both benchmark dialogs drive runners of their own. Their messages belong
  // to those dialogs, not to the Run status, console or loaded-module set.
  if (isBenchmarkFrameSource(e as MessageEvent) ||
      isSdrSpeedTestFrameSource(e as MessageEvent)) return;
  if (d.type === 'gr-recording-ready') {
    recordingTabsController.handleReady(e as MessageEvent);
    return;
  }
  if (d.type === 'gr-recording-selection') {
    recordingTabsController.applyRecordingSelection(e as MessageEvent, d);
    return;
  }
  // A flowgraph that fails to build shows an error in the runner pane; mirror it
  // here so the reason is in the log next to the Run that caused it.
  if (d.type === 'gr-error' && typeof d.message === 'string') {
    setRunnerRunning(false, 'Flowgraph failed');
    log(`run failed: ${d.message}`);
    return;
  }
  if (d.type === 'gr-info' && typeof d.message === 'string') {
    log(d.message);
    return;
  }
  // An AudioContext the browser will not let start without a gesture. The
  // flowgraph keeps running (Audio Sink paces itself by the wall clock while
  // nothing is draining it); all that is missing is the sound, so this asks for
  // a click rather than stopping anything. See docs/audio.md.
  if (d.type === 'gr-audio-blocked') {
    audioResume.blocked();
    return;
  }
  if (d.type === 'gr-audio-running') {
    audioResume.running();
    log('audio started');
    return;
  }
  // Where the running flowgraph's widgets ended up, for the Arrange overlay.
  if (d.type === 'gr-widgets' && typeof d.payload === 'string') {
    applyRunnerLayoutReport(d.payload);
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
  const run = !!b.localJs || !!RUNNABLE[b.id];
  const item = document.createElement('div');
  // The JS badge is a CSS ::after rather than an element, so the row's
  // textContent stays exactly the block's label — which is what the palette
  // search, the browser tests and anything else reading the list expect.
  item.className = 'pal-item ' + (run ? 'runnable' : 'unavailable') + (b.js ? ' pal-js' : '');
  item.style.paddingLeft = indent + 'px';
  item.textContent = b.label;
  // Generated content is decoration; the tooltip is where the same fact is said
  // in words, for anyone who cannot see the badge.
  item.title = !run ? `${b.id} — ${b.unavailableReason || 'not available in WebAssembly'}`
    : b.js ? `${b.id} — implemented in JavaScript` : b.id;
  item.setAttribute('aria-disabled', String(!run));
  item.onclick = () => {
    if (!run) { log(`"${b.id}" is unavailable: ${b.unavailableReason || 'not implemented in WebAssembly'}`); return; }
    if (b.localJs) placeLocalJsBlock(b.localJs);
    else addBlock(b.id);
    closePaletteDrawer();
  };
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
  const { bar: searchBar, input: search } = makePaletteSearch('Search blocks…', 'Search blocks');
  paletteSearch = search;
  const tree = document.createElement('div'); tree.className = 'tree';
  blocksPanel.append(searchBar, tree);
  pal.append(tabs, blocksPanel, examplesPanel, recordingsPanel);
  try {
    LIB = await (await fetch(BLOCKS_URL).then(r => r.ok ? r : fetch('/editor/public/blocks.json'))).json();
    installGeneratedBlocks(LIB.blocks || []);
    for (const block of LIB.blocks || [])
      if (block.gui) GUI_BLOCK_IDS.add(block.id);
  } catch (e) { log('block library not loaded: ' + e); }
  // Anything a Python Block prints while the editor reads it -- Pyodide's own
  // progress, or a print() at the top of the user's source -- goes to the same
  // console pane a running flowgraph's output goes to.
  pythonRuntime.onprint = line => log(line);
  const draw = (q: string) => {
    // The browser-local JS blocks join the generated library rather than living
    // in a tab of their own: a block someone wrote should be findable exactly
    // where every other block is.
    renderPaletteTree([...(LIB.blocks || []), ...localJsPaletteEntries()], tree, q, {
      hidden: PALETTE_HIDDEN,
      isJavaScript: block => !!block.localJs || block.id === JS_BLOCK_ID ||
        blockFlags(block.flags).includes('js'),
      makeBlockItem,
    });
  };
  redrawPalette = () => draw(search.value.trim().toLowerCase());
  draw('');
  search.oninput = () => draw(search.value.trim().toLowerCase());
  void refreshLocalJsBlocks();
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
const examplePaletteController = createExamplePalette({
  activateExamplesTab: () => activatePaletteTab?.('examples'),
  log,
  copyExampleUrl,
  closePaletteDrawer,
  trustExampleJavaScript,
  loadFlowgraphAnimated,
  setExampleHash,
  setCurrentFileName,
  bindFlowgraphRecordings,
});

function showExamplesFor(id: string, label: string): void {
  examplePaletteController.showExamplesFor(id, label);
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
//
// Two things can be named at once — #example= the flowgraph on the canvas and
// #recording= a recording view open beside it — so the fragment is rewritten one
// key at a time and each survives the other changing. The startup-only keys
// (#fg=, #duplicate=) are consumed and cleared before anything here runs, hence
// the whitelist. Values are written the way exampleUrl()/recordingUrl() write
// them rather than through URLSearchParams.toString(), which would percent-encode
// the separators in a recording key and make a copied link unreadable.
const FRAGMENT_KEYS = ['example', 'recording'] as const;
function setUrlFragment(patch: Partial<Record<(typeof FRAGMENT_KEYS)[number], string | null>>) {
  const current = new URLSearchParams(location.hash.slice(1));
  const parts: string[] = [];
  for (const key of FRAGMENT_KEYS) {
    const value = key in patch ? patch[key] : current.get(key);
    if (value === null || value === undefined) continue;
    parts.push(`${key}=` + (key === 'recording'
      ? encodeRecordingPath(value) : encodeURIComponent(value)));
  }
  const url = location.href.split('#')[0] + (parts.length ? '#' + parts.join('&') : '');
  if (url !== location.href) history.replaceState(null, '', url);
}
function setExampleHash(file: string | null) {
  setUrlFragment({ example: file && file.replace(/\.grc$/, '') });
}
async function copyExampleUrl(file: string) {
  const url = exampleUrl(file);
  log(await copyText(url) ? `copied a link to "${file}": ${url}`
        : 'could not copy automatically — link logged below:\n' + url);
}
async function copyRecordingUrl(name: string) {
  const url = recordingUrl(name);
  log(await copyText(url) ? `copied a link to recording "${name}": ${url}`
        : 'could not copy automatically — link logged below:\n' + url);
}
// Used by the #example= hash on startup; the palette's own click handler loads
// the .grc it already fetched instead of going through here.
/**
 * A flowgraph out of `example_flowgraphs/` is repository content: it went through
 * review the same way a repo JS block did, so its JavaScript is trusted as it is
 * loaded and never raises the Run prompt. A .grc from anywhere else -- a shared
 * link, a downloaded file -- deliberately does not go through here.
 */
function trustExampleJavaScript(fg: any) {
  for (const block of fg?.blocks || []) {
    if (String(block?.id) !== JS_BLOCK_ID) continue;
    const source = jsSourceOf(block.parameters || {});
    if (source.trim()) acceptJsSource(source);
  }
}

async function loadExampleByName(name: string, updateHash = true) {
  const file = normalizeExamplePath(name);
  const res = await fetch('/example_flowgraphs/' + encodeExamplePath(file));
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  const fg = parseGrc(await res.text());
  const title = String(fg.options?.parameters?.title || file);
  trustExampleJavaScript(fg);
  loadFlowgraphAnimated(fg);          // resets history itself
  if (updateHash) setExampleHash(file); // normalizes e.g. a link written with .grc
  setCurrentFileName(file);           // Save writes the example back under its own name
  log(`loaded example "${title}" from link`);
  void bindFlowgraphRecordings(fg, title);
}

async function loadTrainingByName(name: string) {
  const file = normalizeExamplePath(name);
  const res = await fetch('/example_flowgraphs/' + encodeExamplePath(file));
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  const fg = parseGrc(await res.text());
  const title = String(fg.options?.parameters?.title || file);
  trustExampleJavaScript(fg);
  startTrainingFlowgraph(fg, file, title);
  void bindFlowgraphRecordings(fg, title);
}

function buildExamples(panel: HTMLElement): Promise<void> {
  return examplePaletteController.buildExamples(panel);
}

// ---- Recordings tab -------------------------------------------------------
// The R2 bucket's scheduled Worker owns index.json. The editor reads that
// index and both SigMF objects directly from R2, so publishing a recording does
// not require a repository or Pages rebuild.

const remoteRecordingsByPath = new Map<string, ExampleRecording>();
let exampleRecordingsPromise: Promise<ExampleRecording[]> | null = null;

function bindRemoteRecording(recording: ExampleRecording): string {
  const path = recordingDataPath(recording.name);
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

// The hosted recordings a flowgraph reads.
function flowgraphRecordingPaths(doc: any): string[] {
  const paths = new Set<string>();
  for (const block of Array.isArray(doc?.blocks) ? doc.blocks : []) {
    if (block?.id !== RECORDING_ID) continue;
    const key = String(block.parameters?.[RECORDING_PARAM] || '');
    if (!key) continue;
    try { paths.add(recordingDataPath(key)); } catch { /* unusable key */ }
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

async function addRecordingBlock(recording: ExampleRecording, format: FileSourceFormat) {
  await paletteReady;
  const addIShortToComplex = isCi16Datatype(recording.datatype);
  const converterId = 'blocks_interleaved_short_to_complex';
  if (addIShortToComplex && !RUNNABLE[converterId])
    throw new Error('IShort To Complex is not available');

  // Binding the recording here is what lets its tab, and the Run path, resolve
  // the block's key without waiting on another index fetch.
  bindRemoteRecording(recording);
  const block = addBlock(RECORDING_ID, undefined, undefined, {
    [RECORDING_PARAM]: recording.name,
    type: format.type,
    repeat: 'False',
    offset: 0,
    length: 0,
  }, false);
  if (!block) throw new Error('GR World Recording is not available');

  if (addIShortToComplex) {
    const converter = addBlock(
      converterId,
      block.x + geom(block).w + 80,
      block.y,
      { vector_input: 'False', scale_factor: 32767.0 },
      false,
    )!;
    state.conns.push({ from: block.uid, fp: 0, to: converter.uid, tp: 0 });
    state.selectedBlocks = new Set([block.uid, converter.uid]);
    state.selected = converter.uid;
    state.selectedConnection = null;
    render();
    recordHistory();
    log(`added streaming GR World Recording and IShort To Complex for "${recording.name}"`);
    return;
  }

  render();
  recordHistory();
  log(`added streaming GR World Recording for "${recording.name}"`);
}



// One searchable row of the recordings tab. `text` is everything the search box
// matches against, lowercased: the full key (so a collection prefix such as
// "estevez/" narrows by itself), plus the author and datatype shown on the card.
// Unlike an example, all of it is known from the index up front — nothing here
// has to wait on a fetch.
const recordingPaletteController = createRecordingPalette({
  loadExampleRecordings,
  openRecordingPreview,
  copyRecordingUrl,
  addRecordingBlock,
  closePaletteDrawer,
  log,
});

function buildRecordings(panel: HTMLElement): Promise<void> {
  return recordingPaletteController.buildRecordings(panel);
}




// ---- GRC-style menu bar + toolbar ----------------------------------------
// These mirror grc/gui/Bars.py (MENU_BAR_LIST / TOOLBAR_LIST). Actions that
// exist in the desktop GUI but can't work inside a browser tab are kept in
// place but greyed out, with a hover tooltip explaining why. GTK itself can't
// run in WebAssembly, so this is a hand-built reimplementation rather than a
// port of the GTK menus.

// Reasons shown when hovering an action that is unavailable in the WASM build.
const R_QUIT = "A browser tab can't quit the application — just close the tab instead.";
const R_XML = "GRC no longer uses XML flowgraphs, so there are no XML parser errors to display.";

// ---- action helpers that the menu/toolbar wire into ----
function openFileDialog() { (el('fileOpen') as HTMLInputElement).click(); }
function cutSelected() { if (!state.selectedBlocks.size) return; copyBlocks(); deleteBlocks(); }
function deleteSelection() { if (state.selectedConnection) deleteConnection(state.selectedConnection); else deleteBlocks(); }
function selectAll() {
  state.selectedBlocks = new Set(state.insts.map(i => i.uid));
  state.selected = state.insts.length ? state.insts[state.insts.length - 1].uid : null;
  state.selectedConnection = null; render();
}
function openPropsForSelected() { if (state.selected) showPropsDialog(G0(state.selected)); }
function toggleConsole() {
  el('workspace').classList.toggle('console-hidden');
  syncConsoleToggle();
}
// The collapse bar is the narrow layout's stand-in for the splitter, so it has
// to follow the class however it was flipped — bar, View menu or Ctrl+R.
function syncConsoleToggle() {
  const workspace = el('workspace');
  const hidden = workspace.classList.contains('console-hidden');
  if (!hidden) workspace.classList.remove('console-unread');
  const button = el('consoleToggle');
  button.setAttribute('aria-expanded', String(!hidden));
  button.title = hidden ? 'Show console' : 'Hide console';
  el('consoleToggleCaret').textContent = hidden ? '▴' : '▾';
}
function toggleScrollLock() { autoScrollLog = !autoScrollLog; log(`console autoscroll ${autoScrollLog ? 'on' : 'off'}`); }
function clearConsole() { el('log').textContent = ''; }
function toggleHideDisabled() { hideDisabled = !hideDisabled; render(); }
function toggleHideVariables() {
  hideVariables = !hideVariables;
  if (hideVariables) {
    const hidden = new Set(state.insts.filter(inst => VARIABLE_IDS.has(inst.id)).map(inst => inst.uid));
    state.selectedBlocks = new Set([...state.selectedBlocks].filter(uid => !hidden.has(uid)));
    if (state.selected && hidden.has(state.selected)) state.selected = [...state.selectedBlocks].pop() || null;
    if (state.selectedConnection && (hidden.has(state.selectedConnection.from) || hidden.has(state.selectedConnection.to)))
      state.selectedConnection = null;
  }
  render();
}
function toggleShowParameterExpressions() {
  showParameterExpressions = !showParameterExpressions;
  render();
}
function toggleShowParameterValues() {
  showParameterValues = !showParameterValues;
  render();
}
function toggleAutoHidePortLabels() {
  autoHidePortLabels = !autoHidePortLabels;
  connectionController.resetHover();
  el('canvasWrap').classList.toggle('auto-hide-port-labels', autoHidePortLabels);
  render();
}
function toggleShowPropertiesFieldColors() {
  showPropertiesFieldColors = !showPropertiesFieldColors;
}
function toggleShowBlockComments() {
  showBlockComments = !showBlockComments;
  render();
}
function toggleShowAllBlockIds() {
  showAllBlockIds = !showAllBlockIds;
  render();
}
function toggleSnapToGrid() {
  snapToGrid = !snapToGrid;
  log(`snap to grid ${snapToGrid ? 'on' : 'off'}`);
}
// The grid lines themselves. Flipped from the View menu or G, so the class and
// the flag the menu's checkmark reads have to move together.
function toggleShowGrid() {
  showGrid = !showGrid;
  el('canvasWrap').classList.toggle('grid-hidden', !showGrid);
  log(`grid ${showGrid ? 'shown' : 'hidden'}`);
}
function openLink(url: string) { window.open(url, '_blank', 'noopener'); }

let aiPanel: AiPanel | null = null;

// ---- enable/state predicates (evaluated each time a menu opens) ----
function hasSel() { return state.selectedBlocks.size > 0; }
function hasSelOrConn() { return state.selectedBlocks.size > 0 || !!state.selectedConnection; }
function canUndo() { return historyIndex > 0; }
function canRedo() { return historyIndex < graphHistory.length - 1; }
function canPaste() { return !!clipboard; }
function hasBlocks() { return state.insts.length > 0; }

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
  overlay.addEventListener('pointerdown', e => { if (e.target === overlay) overlay.remove(); });
  close.focus();
  return overlay;
}

function showUsbPreparationProblem(problem: Exclude<UsbPreparationProblem, string>): void {
  openDialog(problem.title, body => {
    const message = document.createElement('p');
    message.textContent = problem.message;
    body.appendChild(message);
  });
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
      const b = state.insts.find(i => i.uid === issue.uid);
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
  const opt = state.insts.find(i => i.id === OPTIONS_ID);
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
    { label: 'Contribute Example…', run: contributeExample, enabled: hasBlocks },
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
    { label: 'Auto-Arrange Blocks', run: autoArrangeBlocks, enabled: hasBlocks },
    'sep',
    { label: 'Enable', key: 'E', run: () => setSelectedEnabled(true), enabled: hasSel },
    { label: 'Disable', key: 'D', run: () => setSelectedEnabled(false), enabled: hasSel },
    { label: 'Bypass', key: 'B', run: bypassSelected, enabled: hasSel },
    'sep',
    { label: 'Properties', key: 'Return', run: openPropsForSelected, enabled: () => !!state.selected },
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
    { label: 'Show parameter expressions in block', run: toggleShowParameterExpressions,
      check: () => showParameterExpressions },
    { label: 'Show parameter value in block', run: toggleShowParameterValues,
      check: () => showParameterValues },
    'sep',
    { label: 'Hide Variables', run: toggleHideVariables, check: () => hideVariables },
    { label: 'Hide Disabled Blocks', key: 'Ctrl+D', run: toggleHideDisabled, check: () => hideDisabled },
    { label: 'Auto-Hide Port Labels', run: toggleAutoHidePortLabels,
      check: () => autoHidePortLabels },
    { label: 'Show Grid', key: 'G', run: toggleShowGrid, check: () => showGrid },
    { label: 'Snap to Grid', run: toggleSnapToGrid, check: () => snapToGrid },
    { label: 'Show Block Comments', run: toggleShowBlockComments, check: () => showBlockComments },
    { label: 'Show All Block IDs', run: toggleShowAllBlockIds, check: () => showAllBlockIds },
    { label: 'Show Properties Field Colors', run: toggleShowPropertiesFieldColors,
      check: () => showPropertiesFieldColors },
    'sep',
    { label: 'Zoom In', key: 'Ctrl++', run: () => setZoom(zoom * ZOOM_STEP) },
    { label: 'Zoom Out', key: 'Ctrl+-', run: () => setZoom(zoom / ZOOM_STEP) },
    { label: 'Zoom to Fit', key: 'Ctrl+9', run: zoomToFit, enabled: hasBlocks },
    { label: 'Reset Zoom', key: 'Ctrl+0', run: () => setZoom(1) },
    'sep',
    { label: 'Flowgraph Errors', run: showErrorsDialog },
  ] },
  { label: 'Run', items: [
    { label: 'Execute', key: 'F6', run: run },
    { label: 'Kill', key: 'F7', run: stop },
  ] },
  { label: 'Tools', items: [
    { label: 'Types', run: showTypesDialog },
    { label: 'WebAssembly Modules & Debug Info…',
      run: () => showDebugInfo({ openDialog, library: () => LIB, blocksUrl: BLOCKS_URL, loadedModules }) },
    { label: 'Software Versions…', run: () => showVersionsDialog({ openDialog, copyText }) },
    { label: 'Benchmark Tool',
      run: () => showBenchmarkDialog({
        openDialog, log,
        isFlowgraphRunning: () => el('workspace').classList.contains('running'),
      }) },
    { label: 'SDR Receive Speed Test…',
      run: () => showSdrSpeedTestDialog({
        openDialog, log,
        isFlowgraphRunning: () => el('workspace').classList.contains('running'),
      }) },
    { label: 'Parser Errors', reason: R_XML },
  ] },
  { label: 'Help', items: [
    { label: 'Help', key: 'F1', run: () => openLink('https://wiki.gnuradio.org/index.php/Main_Page') },
    { label: 'Keyboard Shortcuts', key: 'Ctrl+K', run: showShortcutHelp },
    'sep',
    { label: 'Get Involved', run: () => openLink('https://www.gnuradio.org/get-involved/') },
    'sep',
    { label: 'Privacy Policy', run: () => openLink('/privacy.html') },
    { label: 'Terms of Service', run: () => openLink('/terms.html') },
    'sep',
    { label: 'About', run: showAboutDialog },
  ] },
];

// ---- icon toolbar (mirrors TOOLBAR_LIST) ----
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
  { icon: '🔍+', label: 'Zoom In', key: 'Ctrl++', run: () => setZoom(zoom * ZOOM_STEP) },
  { icon: '🔍−', label: 'Zoom Out', key: 'Ctrl+-', run: () => setZoom(zoom / ZOOM_STEP) },
];
/**
 * The blocks that reach real hardware, from the same predicates the run
 * authorization gate uses -- so what the model is warned about and what needs a
 * human click cannot drift apart. Marked in the catalog rather than only named
 * in the system prompt because a prohibition far from the point of use loses to
 * the model's prior: every FM receiver it has ever seen starts with an RTL-SDR.
 */
const HARDWARE_TX_IDS = ['wasm_hackrf_sink', 'wasm_plutosdr_sink'];
function isHardwareBlockId(id: string): boolean {
  if (HARDWARE_TX_IDS.includes(id)) return true;
  const probe = { id } as Inst;
  return USB_RADIOS.some(radio => radio.owns(probe));
}

function aiCatalogEntries(): CatalogEntry[] {
  const generated = new Map<string, CatalogEntry>();
  for (const block of LIB.blocks || []) {
    if (!RUNNABLE[block.id] || PALETTE_HIDDEN.has(block.id)) continue;
    const category = Array.isArray(block.category)
      ? block.category.map(String).join(' / ')
      : String(block.category || 'Other');
    generated.set(block.id, {
      id: String(block.id), label: String(block.label || block.id), category,
      javascript: block.id === JS_BLOCK_ID || blockFlags(block.flags).includes('js'),
      hardware: isHardwareBlockId(String(block.id)),
    });
  }
  for (const [id, def] of Object.entries(RUNNABLE)) {
    if (PALETTE_HIDDEN.has(id) || generated.has(id)) continue;
    generated.set(id, { id, label: def.label, category: 'Core / Editor',
      javascript: id === JS_BLOCK_ID, hardware: isHardwareBlockId(id) });
  }
  return [...generated.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function aiInstance(instOrId: Inst | string): Inst | null {
  if (typeof instOrId !== 'string') return instOrId;
  const def = RUNNABLE[instOrId];
  if (!def) return null;
  return {
    uid: '__describe__', id: instOrId, name: instOrId, x: 0, y: 0,
    params: Object.fromEntries(def.params.map(param => [param.id, param.def])),
    enabled: true, bypassed: false, rotation: 0,
  };
}

function aiPorts(instOrId: Inst | string, kind: 'in' | 'out'): ResolvedPort[] {
  const inst = aiInstance(instOrId);
  if (!inst) return [];
  const expanded = resolvedPorts(inst, kind);
  if (expanded) return expanded;
  return Array.from({ length: portCount(inst, kind) }, (_, index) => portMeta(inst, kind, index));
}

function aiBlock(name: string): Inst {
  const block = state.insts.find(item => item.name === name);
  if (!block) throw new Error(`no block named "${name}"`);
  return block;
}

function aiPortIndex(block: Inst, kind: 'in' | 'out', token: string | number): number {
  const ports = aiPorts(block, kind);
  const numeric = typeof token === 'number' ? token
    : /^\d+$/.test(String(token).trim()) ? Number(token) : -1;
  const index = numeric >= 0 ? numeric : ports.findIndex(item =>
    item.name === String(token) || item.id === String(token));
  if (!Number.isInteger(index) || index < 0 || index >= ports.length) {
    const valid = ports.map((item, i) => `${i}=${item.name || item.id}`).join(', ');
    throw new Error(`no ${kind} port "${token}" on "${block.name}"; valid ports are ${valid || 'none'}`);
  }
  return index;
}

function restoreAiSnapshot(snapshotState: GraphSnapshot, record: boolean): void {
  state.insts = clone(snapshotState.insts);
  state.conns = clone(snapshotState.conns);
  state.counter = snapshotState.counter;
  state.clearSelection(); cancelConnect();
  render();
  if (record) recordHistory();
}

function aiAuthorization(): Promise<RunAuthorization | null> {
  const tx = state.insts.find(block => block.enabled && !block.bypassed &&
    (block.id === 'wasm_hackrf_sink' || block.id === 'wasm_plutosdr_sink'));
  if (tx) {
    const frequency = tx.params.center_freq ?? tx.params.frequency ?? 'unknown';
    const rate = tx.params.samp_rate ?? tx.params.sample_rate ?? 'unknown';
    return Promise.resolve({
      title: `This flowgraph transmits with ${tx.name}.`,
      detail: `Centre frequency ${frequency}; sample rate ${rate}. Transmission requires approval every time.`,
      button: 'Transmit & Run',
    });
  }
  return (async () => {
    for (const radio of USB_RADIOS) {
      if (!await radio.needsGesture(state.insts)) continue;
      return {
        title: `This flowgraph opens a ${radio.name}.`,
        detail: 'The browser needs a hardware permission click before the visible run can start.',
        button: 'Allow & Run',
      };
    }
    return null;
  })();
}

function aiToolDependencies(): AiReadDeps {
  // list_examples reads every small .grc once to expose its native Options
  // metadata. Keep those texts for a later read_example call in the same dock,
  // and drop only a failed read so a transient response can be retried.
  const exampleTexts = new Map<string, Promise<string>>();
  const readAiExample = (path: string): Promise<string> => {
    const existing = exampleTexts.get(path);
    if (existing) return existing;
    const pending = (async () => {
      const response = await fetch('/example_flowgraphs/' + encodeExamplePath(path));
      if (!response.ok) throw new Error(`example "${path}" could not be read (${response.status})`);
      return response.text();
    })().catch(error => {
      exampleTexts.delete(path);
      throw error;
    });
    exampleTexts.set(path, pending);
    return pending;
  };

  const repoJsTexts = new Map<string, Promise<string>>();
  const isRepoJsId = (id: string): boolean => {
    const metadata = (LIB.blocks || []).find((block: any) => String(block.id) === id);
    return !!metadata && blockFlags(metadata.flags).includes('js');
  };
  const readRepoJs = (id: string): Promise<string> => {
    if (!isRepoJsId(id)) throw new Error(`block "${id}" is not implemented in repository JavaScript`);
    const existing = repoJsTexts.get(id);
    if (existing) return existing;
    const pending = fetch(`/runner/build/js/${encodeURIComponent(id)}.js`).then(response => {
      if (!response.ok) throw new Error(`JavaScript source for "${id}" is unavailable (${response.status})`);
      return response.text();
    }).catch(error => { repoJsTexts.delete(id); throw error; });
    repoJsTexts.set(id, pending);
    return pending;
  };
  const jsKind = (block: Inst): 'inline' | 'local' | 'repository' => {
    if (block.id !== JS_BLOCK_ID) {
      if (isRepoJsId(block.id)) return 'repository';
      throw new Error(`"${block.name}" is not a JavaScript-backed block`);
    }
    return String(block.params[JS_LOCAL_SOURCE_PARAM] || '').trim() ? 'local' : 'inline';
  };
  const jsSource = async (block: Inst): Promise<string> =>
    jsKind(block) === 'repository' ? readRepoJs(block.id) : jsSourceOf(block.params);
  const analyzeJs = async (source: string) =>
    (await import('./js-block-analysis')).analyzeJsSource(source);
  const portJson = (block: Inst, kind: 'in' | 'out') => aiPorts(block, kind).map((port, index) => ({
    index, id: port.id, label: port.name, domain: port.domain,
    dtype: port.dtype, vlen: port.vlen, optional: port.optional,
  }));
  const connectionJson = (connection: Conn): Record<string, unknown> => {
    const from = state.insts.find(block => block.uid === connection.from);
    const to = state.insts.find(block => block.uid === connection.to);
    return {
      from: from?.name || connection.from,
      output: from ? (aiPorts(from, 'out')[connection.fp]?.name || connection.fp) : connection.fp,
      to: to?.name || connection.to,
      input: to ? (aiPorts(to, 'in')[connection.tp]?.name || connection.tp) : connection.tp,
    };
  };
  const currentJsParams = (block: Inst, io: JsBlockIo) => Object.fromEntries(
    (io.params || []).map(([id, fallback]) =>
      [id, block.params[id] === undefined ? fallback : block.params[id]]));
  const inspectJs = async (block: Inst): Promise<Record<string, unknown>> => {
    const kind = jsKind(block);
    const source = await jsSource(block);
    const io = await jsIntrospector.describe(source);
    return {
      name: block.name, id: block.id, implementation: kind,
      source, source_hash: sourceHash(source), source_bytes: source.length,
      descriptor: io,
      parameters: currentJsParams(block, io),
      inputs: portJson(block, 'in'), outputs: portJson(block, 'out'),
      warnings: await analyzeJs(source),
      editable: kind !== 'repository',
      ...(kind === 'repository' ? { edit_hint: 'Call fork_js_block before changing this source.' } : {}),
    };
  };
  const setJsSource = async (block: Inst, source: string): Promise<Record<string, unknown>> => {
    if (jsKind(block) === 'repository')
      throw new Error(`"${block.name}" is a shipped repository JS block; call fork_js_block first`);
    const io = await jsIntrospector.describe(source); // validate before any mutation
    const warnings = await analyzeJs(source);
    const oldIo = parseJsIo(block.params[JS_IO_PARAM]);
    const beforeConnections = new Map(state.conns
      .filter(connection => connection.from === block.uid || connection.to === block.uid)
      .map(connection => [connection, connectionJson(connection)]));
    const next = { ...block.params };
    next[jsSourceParamOf(next)] = source;
    const nextIds = new Set((io.params || []).map(([id]) => id));
    for (const [id] of oldIo?.params || []) if (!nextIds.has(id)) delete next[id];
    applyJsIo(next, io);
    remapConnectionsForPortChange(block, next);
    block.params = next;
    setJsSourceError(block.uid, '');
    render();
    const live = new Set(state.conns);
    const dropped = [...beforeConnections.entries()]
      .filter(([connection]) => !live.has(connection)).map(([, description]) => description);
    return {
      name: block.name, source_hash: sourceHash(source), descriptor: io, warnings,
      interface_change: {
        inputs: { before: oldIo?.inputs || [], after: io.inputs || [] },
        outputs: { before: oldIo?.outputs || [], after: io.outputs || [] },
        parameters: { before: (oldIo?.params || []).map(([id]) => id),
          after: (io.params || []).map(([id]) => id) },
      },
      dropped_connections: dropped,
      review_required_before_run: !isJsSourceAccepted(source),
    };
  };
  const createJs = async (requestedName: string | undefined, source: string) => {
    const io = await jsIntrospector.describe(source); // a failure leaves no block behind
    const warnings = await analyzeJs(source);
    if (requestedName && state.insts.some(block => block.name === requestedName))
      throw new Error(`a block named "${requestedName}" already exists`);
    const block = addBlock(JS_BLOCK_ID, undefined, undefined, {}, false);
    if (!block) throw new Error('could not add an inline JS Block');
    if (requestedName) block.name = requestedName;
    block.params[JS_SOURCE_PARAM] = source;
    applyJsIo(block.params, io);
    setJsSourceError(block.uid, '');
    render();
    return { name: block.name, id: block.id, source_hash: sourceHash(source),
      descriptor: io, warnings, review_required_before_run: !isJsSourceAccepted(source) };
  };
  const forkJs = async (block: Inst) => {
    if (jsKind(block) !== 'repository')
      throw new Error(`"${block.name}" is already an editable ${jsKind(block)} JS Block`);
    const previousId = block.id;
    const source = await readRepoJs(block.id);
    const io = await jsIntrospector.describe(source);
    const before = state.conns
      .filter(connection => connection.from === block.uid || connection.to === block.uid)
      .map(connection => ({ connection, description: connectionJson(connection) }));
    const oldParams = { ...block.params };
    const base = RUNNABLE[JS_BLOCK_ID];
    const params = Object.fromEntries(base.params.map(param => [param.id, clone(param.def)]));
    params[JS_SOURCE_PARAM] = source;
    applyJsIo(params, io);
    for (const param of base.params)
      if (![JS_SOURCE_PARAM, JS_IO_PARAM, JS_LOCAL_SOURCE_PARAM].includes(param.id) &&
          oldParams[param.id] !== undefined)
        params[param.id] = oldParams[param.id];
    for (const [id, fallback] of io.params || [])
      params[id] = oldParams[id] === undefined ? fallback : oldParams[id];
    block.id = JS_BLOCK_ID;
    block.params = params;
    const inCount = aiPorts(block, 'in').length, outCount = aiPorts(block, 'out').length;
    const valid = new Set(state.conns.filter(connection =>
      (connection.from !== block.uid || connection.fp < outCount) &&
      (connection.to !== block.uid || connection.tp < inCount)));
    state.conns = state.conns.filter(connection => valid.has(connection));
    setJsSourceError(block.uid, '');
    render();
    return {
      name: block.name, previous_id: previousId,
      id: JS_BLOCK_ID, source_hash: sourceHash(source), descriptor: io,
      dropped_connections: before.filter(item => !valid.has(item.connection)).map(item => item.description),
      review_required_before_run: !isJsSourceAccepted(source),
    };
  };
  return {
    blocks: () => state.insts,
    connections: () => state.conns,
    entries: aiCatalogEntries,
    definition: value => typeof value === 'string' ? RUNNABLE[value] : defFor(value),
    ports: aiPorts,
    validate: () => validateGraph(),
    addBlock: (id, requestedName) => {
      if (!RUNNABLE[id] || PALETTE_HIDDEN.has(id))
        throw new Error(`block "${id}" is not in the runnable index`);
      const block = addBlock(id, undefined, undefined, {}, false);
      if (!block) throw new Error(`could not add block "${id}"`);
      if (requestedName) {
        if (state.insts.some(item => item !== block && item.name === requestedName)) {
          state.insts = state.insts.filter(item => item !== block);
          throw new Error(`a block named "${requestedName}" already exists`);
        }
        block.name = requestedName;
      }
      render();
      return block;
    },
    removeBlock: name => {
      const block = aiBlock(name);
      // Refusing the last Options or GUI Layout is right, but throwing for it
      // was not: apply_edits stops at the first failing entry, so one such
      // request in a batch that clears a canvas block by block discarded every
      // edit after it. Report it as a skip and let the rest of the batch run.
      if ((block.id === OPTIONS_ID || block.id === LAYOUT_ID) &&
          state.insts.filter(i => i.id === block.id).length < 2)
        return { removed: false,
                 reason: `${block.name} is a required singleton and stays on the canvas` };
      deleteBlocks(new Set([block.uid]), false);
      return { removed: true };
    },
    setParams: (name, params) => {
      const block = aiBlock(name);
      const next = { ...block.params, ...params };
      remapConnectionsForPortChange(block, next);
      block.params = next;
      render();
    },
    connect: (fromName, output, toName, input) => {
      const from = aiBlock(fromName), to = aiBlock(toName);
      if (from === to) throw new Error('a block cannot connect to itself');
      const fp = aiPortIndex(from, 'out', output), tp = aiPortIndex(to, 'in', input);
      const source = aiPorts(from, 'out')[fp], sink = aiPorts(to, 'in')[tp];
      if (source.domain !== sink.domain)
        throw new Error(`cannot connect ${source.domain} output to ${sink.domain} input`);
      state.conns = state.conns.filter(connection => !(connection.to === to.uid && connection.tp === tp));
      state.conns.push({ from: from.uid, fp, to: to.uid, tp });
      render();
    },
    disconnect: (fromName, output, toName, input) => {
      const from = aiBlock(fromName), to = aiBlock(toName);
      const fp = aiPortIndex(from, 'out', output), tp = aiPortIndex(to, 'in', input);
      const length = state.conns.length;
      state.conns = state.conns.filter(connection => !(connection.from === from.uid &&
        connection.fp === fp && connection.to === to.uid && connection.tp === tp));
      if (state.conns.length === length) throw new Error('that connection does not exist');
      render();
    },
    setEnabled: (name, state) => {
      const block = aiBlock(name);
      if (state === 'bypassed' && (portCount(block, 'in') !== 1 || portCount(block, 'out') !== 1))
        throw new Error(`"${name}" cannot be bypassed because it is not a 1-in/1-out block`);
      block.enabled = state !== 'disabled';
      block.bypassed = state === 'bypassed';
      render();
    },
    autoArrange: () => autoArrangeBlocks(false),
    replaceFlowgraph: grc => loadFlowgraph(parseGrc(grc), false),
    clearFlowgraph: () => clearFlowgraph(false),
    listExamples: async () => {
      const response = await fetch('/example_flowgraphs');
      if (!response.ok) throw new Error(`example listing failed (${response.status})`);
      const files = await response.json();
      return Array.isArray(files) ? files.map(String).sort() : [];
    },
    readExample: readAiExample,
    listRecordings: loadExampleRecordings,
    readRecordingMetadata: async requested => {
      let key: string;
      try { key = normalizeRecordingKey(requested); }
      catch { throw new Error(`invalid recording key "${requested}"; call list_recordings first`); }
      const recording = (await loadExampleRecordings()).find(item => item.name === key);
      if (!recording)
        throw new Error(`no hosted recording named "${requested}"; call list_recordings first`);
      const response = await fetch(recording.metadataUrl, { cache: 'no-store' });
      if (!response.ok)
        throw new Error(`metadata for "${key}" could not be read (${response.status})`);
      const metadata = await response.json();
      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
        throw new Error(`metadata for "${key}" is not a SigMF document`);
      return { recording, metadata: metadata as Record<string, unknown> };
    },
    inspectJsBlock: async name => inspectJs(aiBlock(name)),
    createJsBlock: createJs,
    setJsBlockSource: async (name, source) => setJsSource(aiBlock(name), source),
    forkJsBlock: async name => forkJs(aiBlock(name)),
    exerciseJsBlock: async args => {
      const named = String(args.name || '').trim();
      const explicit = args.source;
      if ((!named && typeof explicit !== 'string') || (named && typeof explicit === 'string'))
        throw new Error('exercise_js_block needs exactly one of name or source');
      const source = typeof explicit === 'string' ? explicit : await jsSource(aiBlock(named));
      const calls = Array.isArray(args.calls) ? args.calls.map((call: any) => ({
        nout: call.nout,
        inputs: call.inputs,
        setParams: call.set_params,
      })) : undefined;
      const result = await exerciseJsSource(source, {
        params: args.params as Record<string, unknown> | undefined,
        calls,
        forecastNout: args.forecast_nout === undefined ? undefined : Number(args.forecast_nout),
      });
      return { source_hash: sourceHash(source), warnings: await analyzeJs(source), ...result };
    },
    saveJsBlock: async (name, requestedId, requestedLabel, requestedCategory) => {
      const block = aiBlock(name), source = await jsSource(block);
      if (!isJsSourceAccepted(source))
        throw new Error('review and authorize this JavaScript in a run before saving it to the trusted local library');
      const io = await jsIntrospector.describe(source);
      const id = sanitizeBlockId(requestedId);
      if (RUNNABLE[id] && id !== block.id)
        throw new Error(`block id "${id}" already exists in the runnable catalog`);
      const saved: LocalJsBlock = {
        id,
        label: (requestedLabel || io.label || id).trim(),
        category: (requestedCategory || '[Custom JS Blocks]').trim(),
        source, io, saved: Date.now(),
      };
      await saveLocalJsBlock(saved);
      await refreshLocalJsBlocks();
      return { installed: true, id, label: saved.label, category: saved.category,
        repository_files: {
          [`blocks/js/${id}.js`]: source,
          [`blocks/grc/${id}.block.yml`]: generateBlockYml(saved),
        } };
    },
  };
}

function initializeAiPanel(): void {
  const harness: Omit<HarnessDeps, 'requestAuthorization'> = {
    // Nobody is at the keyboard on Graham's behalf: a run gate that exists to
    // ask a human is answered rather than shown. See RunOptions.
    run: () => run({ unattended: true }),
    frame: () => el('runFrame') as HTMLIFrameElement,
    blocks: () => state.insts,
    layout: () => runnerLayout,
    authorization: aiAuthorization,
    subscribeLogs: subscriber => {
      logSubscribers.add(subscriber);
      return () => logSubscribers.delete(subscriber);
    },
  };
  aiPanel = createAiPanel({
    openDialog, log, systemPrompt: aiSystemPrompt, entries: aiCatalogEntries,
    toolDeps: aiToolDependencies(), harness,
    // Reading the running window: the same frame the harness watches, and the
    // widget geometry the runner already reports for the Arrange overlay.
    capture: {
      frame: () => el('runFrame') as HTMLIFrameElement,
      layout: () => runnerLayout,
    },
    snapshot,
    commitHistory: recordHistory,
    restoreSnapshot: restoreAiSnapshot,
  });
}

buildMenuBar(MENUS, el('menus'));
buildToolbar(TOOLBAR, el('toolbar'));
installMenuDismissal();
el('btnStop').addEventListener('click', stop);
initArrangeOverlay();
(el('fileOpen') as HTMLInputElement).addEventListener('change', async event => {
  const input = event.currentTarget as HTMLInputElement, file = input.files?.[0]; if (!file) return;
  try { loadFlowgraph(parseGrc(await file.text())); setExampleHash(null); setCurrentFileName(file.name); }
  catch (error) { log('could not open flowgraph: ' + error); }
  input.value = '';
});

const paletteReady = buildPalette();
void paletteReady.then(initializeAiPanel);
ensureOptionsBlock();
// A radio block left on "first available" draws the device it resolves to, so
// the canvas has to redraw when one is plugged in or pulled out.
for (const radio of USB_RADIOS) radio.watch(() => render());
select(null); render();
log('Editor ready. Click ▶ Run to execute the flowgraph in WebAssembly.');
// A flowgraph named by the URL fragment wins over the default example.
// Returns whether the fragment claimed the canvas.
async function loadFlowgraphFromUrl(): Promise<boolean> {
  const hash = new URLSearchParams(location.hash.slice(1));
  // Drops the one-shot keys (#fg=, #duplicate=) while leaving #recording= alone:
  // a recording opened beside the flowgraph outlives whatever loaded the canvas.
  const cleanUrl = () => setUrlFragment({});
  if (TRAINING_EXAMPLE) {
    try { await loadTrainingByName(TRAINING_EXAMPLE); }
    catch (error) { log(`could not start training example "${TRAINING_EXAMPLE}": ${error}`); }
    // The query explicitly claimed the canvas. Even a bad lesson should not be
    // silently replaced by the welcome example, which would hide the mistake.
    return true;
  }
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

// #recording=<base key> opens the recording view for a bucket recording without
// putting anything on the canvas, so it composes with the flowgraph fragment:
// #example=x&recording=y opens both. Returns whether it opened one, which is
// what keeps the default example off a canvas the reader did not ask for.
async function openRecordingFromUrl(): Promise<boolean> {
  const key = recordingHashKey();
  if (!key) return false;
  try {
    const name = normalizeRecordingKey(key);
    const recording = (await loadExampleRecordings()).find(entry => entry.name === name);
    if (!recording) throw new Error('no recording with that name is in the bucket index');
    openRecordingPreview(recording);
    log(`opened the recording view of "${name}" from link`);
    return true;
  } catch (error) {
    log(`could not open recording "${key}" from link: ${error}`);
    setUrlFragment({ recording: null });
    return false;
  }
}

function showWelcomePopup() {
  const WELCOME_KEY = 'gnuradio_world_welcome_seen';
  try { if (localStorage.getItem(WELCOME_KEY)) return; } catch { return; }
  const overlay = document.createElement('div'); overlay.className = 'modal';
  const dlg = document.createElement('div'); dlg.className = 'dlg';
  const head = document.createElement('div'); head.className = 'dlghead'; head.textContent = 'Welcome to GNU Radio World';
  const body = document.createElement('div'); body.className = 'dlgbody';
  type Item = { text: string } | { parts: (string | HTMLElement)[] };
  const emailLink = document.createElement('a');
  emailLink.href = 'mailto:info@iqengine.org'; emailLink.textContent = 'info@iqengine.org';
  emailLink.style.color = 'var(--accent, #58a6ff)';
  const items: Item[] = [
    { text: 'GNU Radio World is very new and a work in progress \u2014 expect rough edges!' },
    { text: 'Example flowgraphs can be submitted via File \u203a Contribute Example.' },
    { parts: ['Example recordings can be submitted by emailing ', emailLink, ' with a way to download them.'] },
    { text: 'Features or bug fixes can be done very easily: open a new GitHub Issue, then click \u201cAssign to Agent\u201d to have AI do the work and make a PR. The PR will automatically build and after ~8 minutes give you a link to a live preview so you can verify the change.' },
  ];
  const ul = document.createElement('ul'); ul.style.cssText = 'margin:0;padding-left:1.4em;line-height:1.7';
  for (const item of items) {
    const li = document.createElement('li');
    if ('text' in item) { li.textContent = item.text; }
    else { for (const part of item.parts) li.append(part); }
    ul.appendChild(li);
  }
  body.appendChild(ul);
  const foot = document.createElement('div'); foot.className = 'dlgfoot';
  const close = document.createElement('button'); close.textContent = 'Got it';
  const dismiss = () => {
    try { localStorage.setItem(WELCOME_KEY, '1'); } catch { /* ignore */ }
    overlay.remove();
  };
  close.onclick = dismiss;
  foot.appendChild(close);
  dlg.append(head, body, foot); overlay.appendChild(dlg); document.body.appendChild(overlay);
  overlay.addEventListener('mousedown', e => { if (e.target === overlay) dismiss(); });
  close.focus();
}

// bootstrap.ts keeps the application hidden (or its click-to-load screen up)
// until this resolves. The palette becomes populated before the initial
// flowgraph fetch completes, but it must not become interactive in that gap: a
// block placed there would be discarded when the startup flowgraph arrived.
export const editorReady = paletteReady.then(async () => {
  const returnedFromOpenRouter = aiPanel?.isOAuthReturn() ?? false;
  const oauthRestore = aiPanel?.oauthRestore() ?? Promise.resolve(null);
  // The GUI Layout block needs its schema, which only arrives with the generated
  // library, so the canvas built before that gets its singleton here instead.
  ensureLayoutBlock(); render();
  // In this order so a link naming both lands on the recording, and so the
  // canvas is left empty for a link that names only one — the reader asked to
  // see that recording, not the default example.
  const loaded = await loadFlowgraphFromUrl();
  const opened = await openRecordingFromUrl();
  if (!loaded && !opened) {
    try { await loadExampleByName('digital/welcome_example.grc', /* updateHash */ false); }
    catch (error) { log(`could not load default example "digital/welcome_example.grc": ${error}`); }
  }
  const oauthSnapshot = await oauthRestore;
  if (oauthSnapshot) {
    restoreAiSnapshot(oauthSnapshot, false);
    log('restored the canvas after connecting OpenRouter');
  }
  // After the flowgraph, so the level a link asks for outlives any zoom the
  // load path chose for it.
  applyZoomFromUrl();
  applyCenterFromUrl();
  historyReady = true; resetHistory();
  // Nothing of the application's own is offered in an embed, and a modal about
  // contributing examples is the last thing a host page's reader asked for.
  if (!EMBEDDED && !returnedFromOpenRouter) showWelcomePopup();
});
