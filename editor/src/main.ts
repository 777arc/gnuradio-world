// GNU Radio WebAssembly Flowgraph Editor (TypeScript).
// Loads the block library, lets you place/connect/configure blocks on an SVG
// canvas, and Runs the flowgraph by handing JSON to the C++/WASM runner via a
// URL hash (runner.html#<encoded json>).

import './editor.css';
import { dumpGrc, parseGrc, type GrcDoc, type GrcScalar } from './grc';
import { boundsBetween, boundsIntersect, type Point } from './selection';
import { ceilToGrid, centeredPortSlot, constrainBlockPosition, SNAP_GRID_SIZE } from './grid';
import { arrangeFlowgraph, type LayoutNode } from './layout';
import { evaluate as evalExpr, buildScope, formatValue as fmtExprVal, serializeForRunner, type Scope, type Value } from './expr';
import { wrapNoteText, NOTE_FONT_SIZE } from './note';
import {
  layoutColumns,
  layoutRowHeight,
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
  AUDIO_SOURCE_ID,
  installAudioResumeRelay,
  prepareAudioCapture,
} from './audio';
import {
  NAME_FIELD,
  VARIABLE_IDS,
  validateFlowgraph,
} from './validation';
import {
  type UsbLike,
  type UsbPreparationProblem,
  type UsbRadio,
  usbApi,
} from './usb-radio';
import { RTLSDR_RADIO } from './rtlsdr';
import { PLUTOSDR_RADIO } from './plutosdr';
import { HACKRF_RADIO } from './hackrf';
import {
  buildRecordingTree,
  displayBytes,
  displayRecordingValue,
  displaySi,
  encodeRecordingPath,
  isCi16Datatype,
  normalizeRecordingKey,
  RECORDING_ID,
  RECORDING_PARAM,
  recordingDataPath,
  recordingFromR2Index,
  recordingTreeCount,
  recordingUrl,
  recordingViewUrl,
  recordingsBucketUrl,
  sigmfFileSourceFormat,
  type ExampleRecording,
  type FileSourceFormat,
  type R2RecordingIndexEntry,
  type RecordingDirectory,
} from './recording-catalog';
import {
  canPickOutputDirectory,
  pairSigmfFiles,
  pickOutputDirectory,
  parseSigmfMeta,
  sanitizeSigmfBase,
  sigmfSinkFileNames,
  sigmfStreamFormat,
  SIGMF_ACCEPT,
  SIGMF_DATA_SUFFIX,
  SIGMF_FILE_PARAM,
  SIGMF_META_SUFFIX,
  SIGMF_OPEN_DTYPE,
  SIGMF_OUTPUT_PICKER_HELP,
  SIGMF_OUTPUT_PREFIX,
  SIGMF_SAVE_DTYPE,
  SIGMF_SINK_ID,
  SIGMF_SOURCE_ID,
  type SigmfBinding,
} from './sigmf-blocks';
import {
  buildExampleTree,
  encodeExamplePath,
  exampleFileName,
  exampleTreeCount,
  exampleUrl,
  normalizeExamplePath,
  type ExampleDirectory,
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
  EPY_BLOCK_ID, EPY_CODE_DTYPE, EPY_IO_CACHE_PARAM, EPY_SOURCE_PARAM, epyDefForCache,
  epySourceError, isForeignIoCache, pythonRuntime, setEpySourceError,
} from './epy';
import {
  JS_BLOCK_ID, JS_CODE_DTYPE, JS_IO_PARAM, JS_LOCAL_SOURCE_PARAM, JS_SOURCE_PARAM,
  acceptJsSource, generateBlockYml, isJsSourceAccepted, jsDefForCache, jsIntrospector,
  jsSourceError, jsSourceOf, listLocalJsBlocks, parseJsIo,
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
import type { AiToolDeps } from './ai/tools';
import type { HarnessDeps, RunAuthorization } from './ai/harness';
import { createAiPanel, type AiPanel } from './ai/panel';
import { TrainingSession, type TrainingProgress } from './training';
import {
  dismissUnpacedRunWarning,
  shouldWarnAboutUnpacedRun,
  unpacedRunWarningDismissed,
} from './run-pacing';
import aiSystemPrompt from './ai/system-prompt.md?raw';

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

let insts: Inst[] = [];
let conns: Conn[] = [];
let selected: string | null = null;
let selectedBlocks = new Set<string>();
let selectedConnection: Conn | null = null;
let counter = 0;
let trainingSession: TrainingSession | null = null;
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
// Native GRC's canvas display preferences. These affect only presentation: the
// underlying blocks and their raw parameter expressions still serialize and run
// exactly as before.
let hideVariables = false;
let showParameterExpressions = false;
let showParameterValues = true;
let autoHidePortLabels = false;
let hoveredPortKey: string | null = null;
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
  const variable = insts.find(i => i.id === 'variable' && i.name === 'samp_rate');
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
  if (conns.some(c => c.from === block.uid)) return false;
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
  conns.push({ from: block.uid, fp: 0, to: converter.uid, tp: 0 });
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
  return clone({ insts, conns, counter,
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
  const state = clone(graphHistory[index]);
  insts = state.insts; conns = state.conns; counter = state.counter;
  trainingSession?.restore(state.training);
  selected = null; selectedBlocks.clear(); selectedConnection = null; cancelConnect();
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
  if (autoHidePortLabels && hoveredPortKey !== `${inst.uid}:${kind}:${i}`)
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

function validateGraph(blocks: Inst[] = insts, connections: Conn[] = conns): ValidationIssue[] {
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
    ...insts.map(inst => inst.name),
    ...(trainingSession ? trainingSession.reservedNames(insts) : []),
  ]);
}

function uniqueBlockName(base: string, taken: Set<string> = namesInUse()): string {
  for (let n = 0; ; ++n) {
    const candidate = `${base}_${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

function addBlock(id: string, x = 60 + (counter % 5) * 30, y = 60 + (counter % 7) * 24,
                  paramOverrides: Record<string, any> = {}, record = true): Inst | null {
  const d = RUNNABLE[id]; if (!d) { log('block "' + id + '" is not runnable yet'); return null; }
  if (id === OPTIONS_ID || id === LAYOUT_ID) {
    const existing = insts.find(i => i.id === id);
    if (existing) {
      log(`only one ${d.label} block is allowed per flowgraph`);
      select(existing.uid); return existing;
    }
  }
  const uid = 'b' + (++counter);
  const params: Record<string, any> = {};
  d.params.forEach(p => params[p.id] = p.def);
  Object.assign(params, paramOverrides);
  const position = constrainBlockPosition(x, y, snapToGrid);
  const inst: Inst = {
    uid, id, name: uniqueBlockName(id),
    x: position.x, y: position.y, params,
    enabled: true, rotation: 0, bypassed: false,
  };
  insts.push(inst);
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
function deleteBlocks(uids = selectedBlocks, record = true) {
  if (!uids.size) return;
  // Options and GUI Layout are required singletons and cannot be deleted.
  insts = insts.filter(i => !uids.has(i.uid) || i.id === OPTIONS_ID || i.id === LAYOUT_ID);
  conns = conns.filter(c => !uids.has(c.from) && !uids.has(c.to));
  selectedBlocks.clear(); selected = null; selectedConnection = null;
  render(); if (record) recordHistory();
}
function deleteConnection(conn: Conn) {
  conns = conns.filter(c => c !== conn);
  if (selectedConnection === conn) selectedConnection = null;
  render(); recordHistory();
}
function duplicateBlock(uid: string) {
  const s = insts.find(i => i.uid === uid); if (!s) return;
  if (s.id === OPTIONS_ID || s.id === LAYOUT_ID) {
    log(`only one ${defFor(s).label} block is allowed per flowgraph`); return;
  }
  const nu = 'b' + (++counter);
  const position = constrainBlockPosition(s.x + 24, s.y + 24, snapToGrid);
  insts.push({ uid: nu, id: s.id, name: uniqueBlockName(s.name),
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
  // Options and GUI Layout are singletons; never copy them (so paste can't
  // duplicate one).
  const blocks = insts.filter(i =>
    uids.has(i.uid) && i.id !== OPTIONS_ID && i.id !== LAYOUT_ID);
  if (!blocks.length) return;
  clipboard = clone({ blocks, connections: conns.filter(c => uids.has(c.from) && uids.has(c.to)) });
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
  const taken = new Set(insts.map(i => i.name));
  const added: Inst[] = clipboard.blocks.map(source => {
    const uid = 'b' + (++counter); remap.set(source.uid, uid);
    const position = constrainBlockPosition(
      x + source.x - minX, y + source.y - minY, snapToGrid);
    const name = taken.has(source.name) ? uniqueBlockName(source.name, taken) : source.name;
    taken.add(name);
    return { ...clone(source), uid, name, x: position.x, y: position.y };
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
// Auto-arrange: hand the whole flowgraph to the layout engine and drop every
// block on the coordinate it comes back with. Everything the engine needs is
// measured here — box size, how far the port tabs stick out on each side, and
// the y offset of every port — so `layout.ts` stays DOM-free and unit testable.
function autoArrangeBlocks(record = true) {
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
      in: offsets('in'), out: offsets('out'),
      // Both singletons park in the corner ahead of everything else; neither is
      // wired to anything, so they would otherwise land wherever they fell.
      pinned: inst.id === OPTIONS_ID || inst.id === LAYOUT_ID,
    };
  });
  const byUid = new Map(insts.map(inst => [inst.uid, inst]));
  for (const at of arrangeFlowgraph(nodes, conns)) {
    const inst = byUid.get(at.uid)!;
    const position = constrainBlockPosition(at.x, at.y, snapToGrid);
    inst.x = position.x; inst.y = position.y;
  }
  render(); if (record) recordHistory();
  log(`arranged ${insts.length} block${insts.length === 1 ? '' : 's'}`);
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
// reader zooms. Always a percentage — "5" and "5%" both mean 5% — so there is no
// value where the meaning flips; setZoom clamps whatever comes out to the same
// range the toolbar buttons reach.
function applyZoomFromUrl() {
  const raw = new URLSearchParams(location.search).get('zoom');
  if (raw === null) return;
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
function zoomToFit() {
  let right = 0, bottom = 0;
  for (const inst of insts) {
    if (canvasBlockHidden(inst)) continue;
    const { w, h } = geom(inst);
    const comment = blockCommentGeometry(inst);
    right = Math.max(right, inst.x + Math.max(w, comment.width));
    bottom = Math.max(bottom, inst.y + h + comment.height);
  }
  if (!right || !bottom) { log('nothing to fit'); return; }
  const pane = el('canvasWrap').getBoundingClientRect();
  const margin = 16;
  setZoom(Math.min(1, (pane.width - margin) / right, (pane.height - margin) / bottom));
  el('canvasScroll').scrollTo(0, 0);
}
// ---- Options block: the singleton flowgraph-metadata block (GRC-style) ----
// Every flowgraph has exactly one, holding title/author/copyright/description.
const OPTIONS_ID = 'options';
// The id a flowgraph with no Title gets, matching native's default_flow_graph.grc.
const DEFAULT_FLOWGRAPH_ID = 'default';
function makeOptionsInst(): Inst {
  const params: Record<string, any> = {};
  RUNNABLE[OPTIONS_ID].params.forEach(p => params[p.id] = p.def);
  // Its instance name is internal — the .grc gets the derived flowgraph id, and
  // nothing displays this — but it still has to be a legal, unique block ID.
  return { uid: 'b' + (++counter), id: OPTIONS_ID, name: OPTIONS_ID,
    x: 10, y: 10, params, enabled: true, rotation: 0, bypassed: false };
}
// Guarantee the current flowgraph has an Options block (loaded/legacy files may lack one).
function ensureOptionsBlock() {
  if (!insts.some(i => i.id === OPTIONS_ID)) insts.unshift(makeOptionsInst());
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
  return { uid: 'b' + (++counter), id: LAYOUT_ID, name: uniqueBlockName(LAYOUT_ID),
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
  const boxes = insts.filter(i => i !== inst).map(box);
  if (!boxes.length) return;
  const self = geom(inst);
  const header = insts.find(i => i.id === OPTIONS_ID) ?? insts[0];
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
  if (insts.some(i => i.id === LAYOUT_ID)) return;
  const inst = makeLayoutInst();
  placeLayoutInst(inst);
  insts.push(inst);
}
const layoutInst = (): Inst | undefined => insts.find(i => i.id === LAYOUT_ID);
// The blocks that take a tile: those whose factory builds a QWidget. Only the
// C++ knows which those are, so the answer comes from the generated library's
// `gui` flag, which each block declares for itself as `gui: true`. Disabled
// blocks are left out because the runner never builds them.
function guiWidgets(): WidgetRef[] {
  return insts.filter(i => i.enabled && !i.bypassed && GUI_BLOCK_IDS.has(i.id))
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
  insts = []; conns = []; counter = 0; selected = null; selectedBlocks.clear();
  insts.push(makeSampRateInst());   // the default flowgraph's one variable
  selectedConnection = null; cancelConnect();
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
  const opt = insts.find(i => i.id === OPTIONS_ID);
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
// Deliberately not here: the browser-only `pmt` dtype (Message Strobe's message,
// a Tag Object's key/value). Those are Python too, but they evaluate to a PMT
// rather than a number, so expr.ts has nothing to say about them and the runner
// parses the constructor call itself -- see wasm_registry::pmt_value().
const EVALUATED_DTYPES = new Set([
  'int', 'real', 'float', 'hex', 'raw',
  'int_vector', 'real_vector', 'float_vector', 'complex_vector',
]);

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
  log(`saved ${insts.length} blocks to ${file}`);
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
  insts = []; conns = []; counter = 0;
  // Whatever was on the canvas is gone, and with it the file Save writes to; the
  // callers that do know a name (an example, an opened .grc) set it back after.
  setCurrentFileName(null);
  // options: a top-level block in .grc; becomes the editor's singleton Options.
  const optRaw = doc.options || {};
  const optFlags = stateToFlags(optRaw.states?.state);
  const optCoord = Array.isArray(optRaw.states?.coordinate) ? optRaw.states.coordinate : [10, 10];
  // The file's `id` is not carried into the model: it is derived from the Title
  // again on save, so there is nowhere for a loaded one to live.
  insts.push({ uid: 'b' + (++counter), id: OPTIONS_ID, name: OPTIONS_ID,
    x: Number(optCoord[0]) || 10, y: Number(optCoord[1]) || 10,
    params: importParams(RUNNABLE[OPTIONS_ID], optRaw.parameters || {}),
    enabled: optFlags.enabled, rotation: Number(optRaw.states?.rotation) || 0, bypassed: optFlags.bypassed });

  const nameToUid = new Map<string, string>();
  doc.blocks.forEach((b: any, index: number) => {
    // A Python or JS Block's parameters are whatever its source declares, so its
    // definition has to be built from the file's own cached interface before its
    // values can be imported -- importParams keeps only what the definition
    // declares, and the derived parameters would otherwise be dropped.
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
  // A .grc written before this block existed -- every upstream example, and
  // anything desktop GRC saved -- gets one here, so it is arrangeable without
  // the reader having to add anything. Its tiles start empty, which is the
  // vertical stack such a flowgraph has always been rendered as.
  ensureLayoutBlock();
  selected = null; selectedBlocks.clear(); selectedConnection = null; cancelConnect();
  render(); if (record) recordHistory(); log(`opened ${insts.length} blocks`);
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
  const template: GraphSnapshot = clone({ insts, conns, counter });
  trainingSession = new TrainingSession(template, [OPTIONS_ID, LAYOUT_ID]);
  insts = clone(template.insts.filter(block => block.id === OPTIONS_ID || block.id === LAYOUT_ID));
  conns = [];
  counter = template.counter;
  selected = null; selectedBlocks.clear(); selectedConnection = null; cancelConnect();
  setExampleHash(null);
  setCurrentFileName(file);
  render();
  resetHistory();
  const counts = trainingSession.counts(insts, conns);
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
  if (!insts.length) return;
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
const CUSTOM_OPTION = '__grw_custom_value__';   // no GRC option can collide with it
function optionCombo(param: ParamDef, value: string, commit: (value: string) => void) {
  const wrap = document.createElement('div'); wrap.className = 'opt-combo';
  const select = document.createElement('select');
  const input = document.createElement('input');
  const hint = document.createElement('small'); hint.className = 'field-hint';
  hint.textContent = 'Custom value — reopen this dialog to choose from the list again.';
  input.hidden = hint.hidden = true;
  const labelOf = new Map((param.options || []).map(
    (option, index) => [option, param.optionLabels?.[index] ?? option]));
  // A stored value the list does not have leads it, so a variable or an
  // expression is shown as what it is rather than quietly replaced.
  const values = labelOf.has(value) ? [...labelOf.keys()] : [value, ...labelOf.keys()];
  for (const option of values) select.appendChild(new Option(labelOf.get(option) ?? option, option));
  select.appendChild(new Option('Custom value…', CUSTOM_OPTION));
  select.value = value;
  let current = value;
  select.onchange = () => {
    if (select.value !== CUSTOM_OPTION) { current = select.value; commit(current); return; }
    // The sentinel is a mode, never a value: the field keeps what it had, and
    // selects it, so typing replaces the option rather than appending to it.
    input.value = current;
    select.hidden = true; input.hidden = hint.hidden = false;
    input.focus(); input.select();
  };
  input.oninput = () => { current = input.value; commit(current); };
  wrap.append(select, input, hint);
  return { wrap, select, input };
}
function usesOptionCombo(param: ParamDef): boolean {
  return param.type !== 'enum' && !param.multiline && !!param.options?.length;
}

// Native GRC colors editable property fields by parameter dtype. Keep this map
// separate from stream-port colors: these are the brighter GTK property-entry
// colors, not the palette used for port tabs.
const PROPERTY_FIELD_COLORS: Record<string, string> = {
  complex: '#3399FF', real: '#FF8C69', float: '#FF8C69', int: '#00FF99',
  complex_vector: '#3399AA', real_vector: '#CC8C69', float_vector: '#CC8C69',
  int_vector: '#00CC99', bool: '#00FF99', hex: '#00FF99', string: '#CC66CC',
  id: '#DDDDDD', stream_id: '#DDDDDD', raw: '#DDDDDD',
};
function propertyFieldDtype(param: ParamDef): string {
  return param.dtype || (param.type === 'number' ? 'real' : param.type);
}
function colorPropertyRow(row: HTMLElement, dtype: string): void {
  if (!showPropertiesFieldColors) return;
  const color = PROPERTY_FIELD_COLORS[dtype];
  if (!color) return;
  row.classList.add('dtype-field');
  row.style.setProperty('--dtype-field-color', color);
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
    const add = (label: string, node: HTMLElement, field: string,
                 validationNode: HTMLElement = node, dtype = '') => {
      const row = document.createElement('div'); row.className = 'dlgrow';
      const l = document.createElement('label'); l.textContent = label;
      const control = document.createElement('div'); control.className = 'field-control';
      const error = document.createElement('small'); error.className = 'field-error'; error.hidden = true;
      control.append(node, error); row.append(l, control); body.appendChild(row);
      colorPropertyRow(row, dtype);
      controls.push({ uid: variable.uid, field, node: validationNode, error });
    };
    const name = document.createElement('input'); name.value = variable.name;
    name.oninput = () => { variable.name = name.value.replace(/\s+/g, '_'); render(); refreshValidation(); };
    name.onchange = recordHistory;
    add('ID', name, NAME_FIELD, name, 'id');
    for (const param of d.params) {
      const set = (value: string) => {
        variable.params[param.id] = param.type === 'number' ? numericOrExpression(value) : value;
        render(); refreshValidation();
      };
      if (usesOptionCombo(param)) {
        const combo = optionCombo(param, String(variable.params[param.id]), set);
        // addEventListener, not onchange: the combo needs its own change handler
        // to switch into custom mode.
        combo.select.addEventListener('change', recordHistory);
        combo.input.addEventListener('change', recordHistory);
        add(param.label, combo.wrap, param.id, combo.select, propertyFieldDtype(param));
        continue;
      }
      let input: HTMLInputElement | HTMLSelectElement;
      if (param.type === 'enum') {
        input = document.createElement('select');
        (param.options || []).forEach(option => input.appendChild(new Option(option, option)));
        input.value = String(variable.params[param.id]);
      } else {
        input = document.createElement('input'); input.value = String(variable.params[param.id]);
      }
      input.oninput = () => set(input.value);
      input.onchange = recordHistory;
      add(param.label, input, param.id, input, propertyFieldDtype(param));
    }
  }
  const foot = document.createElement('div'); foot.className = 'dlgfoot';
  const close = document.createElement('button'); close.textContent = 'Close'; close.onclick = () => overlay.remove(); foot.appendChild(close);
  dlg.append(head, body, foot); overlay.appendChild(dlg); document.body.appendChild(overlay);
  overlay.addEventListener('pointerdown', e => { if (e.target === overlay) overlay.remove(); });
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
  else if (!ctrl && (e.key === '+' || e.key === '=')) { consume(e); changePortCount(1); }
  else if (!ctrl && (e.key === '-' || e.key === '_')) { consume(e); changePortCount(-1); }
  else if (!ctrl && !e.shiftKey && key === 'g') { consume(e); toggleShowGrid(); }
});

// ---- block Properties dialog (GRC-style modal) ----
function showPropsDialog(inst: Inst) {
  closeMenu();
  const d = defFor(inst); if (!d) return;
  const tmp: { name: string; params: Record<string, any>; localFileToken?: string } = {
    name: inst.name,
    params: { ...inst.params },
    localFileToken: inst.localFileToken,
  };

  const overlay = document.createElement('div'); overlay.className = 'modal props';
  const dlg = document.createElement('div'); dlg.className = 'dlg';
  if (inst.id === EPY_BLOCK_ID || inst.id === JS_BLOCK_ID) dlg.classList.add('dlg-code');
  const head = document.createElement('div'); head.className = 'dlghead withclose';
  const headTitle = document.createElement('span'); headTitle.textContent = 'Properties: ' + d.label;
  const headClose = document.createElement('button'); headClose.className = 'dlgclose';
  headClose.type = 'button'; headClose.title = 'Close'; headClose.setAttribute('aria-label', 'Close');
  headClose.textContent = '×';
  headClose.onclick = () => closeDialog();
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
  // The Embedded Python Block's Code field, when this dialog has one: `pending`
  // is true while the source has been edited but not re-read by Python, which is
  // what blocks Apply/OK. `dispose` tears the code editor down with the dialog.
  // See the code-editor branch below.
  const code: {
    pending: boolean; busy: boolean; message: string;
    refresh: () => void; dispose: () => void;
  } = { pending: false, busy: false, message: '', refresh: () => {}, dispose: () => {} };
  // Same, for the GUI Layout block's designer: it owns a ResizeObserver on a
  // node that is about to be detached.
  const layoutDesigner: { dispose: () => void } = { dispose: () => {} };
  // Every way this dialog closes goes through here, so nothing leaks a mounted
  // CodeMirror or a live observer on a detached node.
  const closeDialog = () => { code.dispose(); layoutDesigner.dispose(); overlay.remove(); };
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
    dtype = '',
  ) => {
    const row = document.createElement('div'); row.className = 'dlgrow';
    const l = document.createElement('label'); l.textContent = label;
    const control = document.createElement('div'); control.className = 'field-control';
    const error = document.createElement('small'); error.className = 'field-error'; error.hidden = true;
    control.append(node, error); row.append(l, control); panels.get(category)!.appendChild(row);
    colorPropertyRow(row, dtype);
    controls.set(field, { node: validationNode, error });
    return node;
  };
  // Native GRC builds the `id` parameter as `hide: all` for every block without
  // the `show_id` flag, so the dialog has no ID field for them; the block ID is
  // generated and left alone unless View ▸ Show All Block IDs is on.
  if (blockIdVisible(inst)) {
    const nameInput = document.createElement('input');
    const nameI = addField('General', 'ID', nameInput, NAME_FIELD, nameInput, 'id') as HTMLInputElement;
    nameI.value = tmp.name;
    nameI.oninput = () => { tmp.name = nameI.value.replace(/\s+/g, '_'); refreshValidation(); };
  }
  for (const p of d.params) {
    // The derived-interface caches are written by the code reader, never by hand,
    // and are a JSON blob the length of a paragraph. Neither has a field, and
    // neither does the inlined source a local JS block's instance carries.
    if (p.id === EPY_IO_CACHE_PARAM || p.id === JS_IO_PARAM ||
        p.id === JS_LOCAL_SOURCE_PARAM) continue;
    if (p.type === 'enum') {
      const s = document.createElement('select');
      (p.options || []).forEach((o, index) => {
        const opt = document.createElement('option');
        opt.value = o;
        opt.textContent = p.optionLabels?.[index] ?? o;
        s.appendChild(opt);
      });
      s.value = String(tmp.params[p.id]);
      // Output Type is the recording's SigMF datatype for both blocks that read
      // one -- GR World Recording from the bucket index, SigMF Source from the
      // .sigmf-meta beside the samples. It is shown so the reader can see how
      // the samples are being read, and disabled because reading them as
      // anything else would only mis-read them. SigMF *Sink* is the opposite
      // case: there its Stream Type is chosen and the datatype follows.
      s.disabled = (inst.id === RECORDING_ID || inst.id === SIGMF_SOURCE_ID) &&
        p.id === 'type';
      s.onchange = () => { tmp.params[p.id] = s.value; refreshVisibility(); refreshValidation(); };
      addField(p.category || 'General', `${p.label}  (${p.id})`, s, p.id, s, propertyFieldDtype(p));
      if (s.disabled) {
        const hint = document.createElement('small'); hint.className = 'field-hint';
        hint.textContent = inst.id === SIGMF_SOURCE_ID
          ? 'Set from core:datatype in the recording’s .sigmf-meta.'
          : 'Set from the SigMF datatype of the recording above.';
        s.closest('.field-control')?.appendChild(hint);
      }
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
      addField(p.category || 'General', `${p.label}  (${p.id})`, picker, p.id, inp, propertyFieldDtype(p));
      refreshDetail();
      if (p.showWhen) conditionalRows.push({ param: p, row: picker.closest('.dlgrow') as HTMLElement });
    } else if (radioForDtype(p.dtype)) {
      // A WebUSB radio. Unlike a local file this binds nothing for the
      // session: the browser remembers the permission per origin, so all a .grc
      // needs is the serial number, and the runner's worker finds the device
      // again by itself. Degrades to a plain text field where WebUSB is absent,
      // so a flowgraph authored in Firefox still round-trips.
      const radio = radioForDtype(p.dtype)!;
      const picker = document.createElement('div'); picker.className = 'file-picker';
      const select = document.createElement('select');
      // The fallback for a .grc naming a dongle that is not plugged in, and for
      // a browser with no WebUSB at all: the value still round-trips.
      const typed = document.createElement('input');
      typed.hidden = true;
      typed.placeholder = 'serial number, or blank for the first available';
      const choose = document.createElement('button'); choose.type = 'button';
      choose.textContent = 'Add…';
      choose.title = `Grant this site access to another ${radio.name}`;
      const detail = document.createElement('small'); detail.className = 'file-picker-detail';
      let shared: UsbLike[] = [];

      // What the field offers and what it says about the current value are both
      // "which radio does this resolve to", so the radio modules own both the
      // options and the block-face display. Only the DOM wiring is here.
      const paint = () => {
        const serial = String(tmp.params[p.id] ?? '').trim();
        select.replaceChildren(...radio.options(serial, shared).map(o => {
          const option = document.createElement('option');
          option.value = o.value; option.textContent = o.label;
          return option;
        }));
        select.value = serial;
        detail.textContent = radio.describe(serial, shared);
      };

      // The same cache the block face draws from, so the dialog and the canvas
      // cannot name different dongles for one flowgraph.
      const refreshDevices = async () => {
        shared = await radio.refresh();
        if (!usbApi()) { select.hidden = true; typed.hidden = false; choose.disabled = true; }
        paint(); render();
      };
      const commit = (serial: string) => {
        tmp.params[p.id] = serial;
        paint(); refreshVisibility(); refreshValidation();
      };
      select.onchange = () => commit(select.value);
      typed.oninput = () => {
        tmp.params[p.id] = typed.value.trim();
        detail.textContent = radio.describe(typed.value.trim(), shared);
        refreshValidation();
      };
      choose.onclick = async () => {
        const usb = usbApi();
        if (!usb) return;
        try {
          const device: UsbLike =
            await usb.requestDevice({ filters: radio.filters });
          shared = await radio.refresh();
          // A radio with no serial cannot be named, so it can only ever be
          // reached as "first available".
          commit(device.serialNumber ?? '');
        } catch {
          await refreshDevices();   // the chooser was dismissed
        }
      };
      typed.value = String(tmp.params[p.id] ?? '');
      picker.append(select, typed, choose, detail);
      addField(p.category || 'General', `${p.label}  (${p.id})`, picker, p.id, select, propertyFieldDtype(p));
      paint();                  // synchronously, before the device list resolves
      void refreshDevices();
      if (p.showWhen) conditionalRows.push({ param: p, row: picker.closest('.dlgrow') as HTMLElement });
    } else if (p.dtype === RECORDING_DTYPE) {
      // GR World Recording's recording, chosen from the live bucket index — the
      // same list the Recordings palette tab draws. The block stores the key
      // alone, so a field that could only be a select degrades to a text input
      // when the index cannot be read: the flowgraph still runs, and a key typed
      // from a shared link still works.
      const picker = document.createElement('div'); picker.className = 'file-picker';
      const select = document.createElement('select');
      const typed = document.createElement('input');
      typed.hidden = true;
      typed.placeholder = 'estevez/by701';
      const detail = document.createElement('small'); detail.className = 'file-picker-detail';
      let known = new Map<string, ExampleRecording>();

      const describe = () => {
        const key = String(tmp.params[p.id] ?? '');
        const recording = known.get(key);
        if (!recording) {
          detail.textContent = key
            ? `"${key}" — streamed from the recordings bucket.`
            : 'No recording chosen. Pick one, or click a card in the Recordings tab.';
          return;
        }
        const parts = [
          recording.datatype || 'unknown datatype',
          displaySi(recording.sampleRate, 'Hz'),
          displayBytes(recording.byteLength),
        ];
        detail.textContent = parts.join(' · ') +
          (isCi16Datatype(recording.datatype)
            ? ' · interleaved 16-bit I/Q: feed IShort To Complex'
            : '');
      };
      // A recording's SigMF datatype decides how its samples are read, so
      // choosing one writes Output Type — the field the reader can see but not
      // edit — rather than leaving the block reading them as something else.
      const applyDatatype = (key: string) => {
        const format = sigmfFileSourceFormat(known.get(key)?.datatype ?? null);
        if (!format) return;
        tmp.params.type = format.type;
        const node = controls.get('type')?.node;
        if (node instanceof HTMLSelectElement) node.value = format.type;
      };
      const choose = (key: string) => {
        tmp.params[p.id] = key;
        applyDatatype(key);
        describe(); refreshVisibility(); refreshValidation();
      };
      select.onchange = () => choose(select.value);
      typed.oninput = () => { tmp.params[p.id] = typed.value.trim(); describe(); refreshValidation(); };

      const fill = (recordings: ExampleRecording[]) => {
        select.replaceChildren();
        const key = String(tmp.params[p.id] ?? '');
        // Only what this block can read: Output Type follows the datatype and
        // cannot be corrected by hand, so a datatype with no stream type of its
        // own (the palette greys those cards out) would be a dead end here.
        const keys = recordings.filter(recording => sigmfFileSourceFormat(recording.datatype))
          .map(recording => recording.name).sort();
        // The block's own recording is always offered, listed or not: a bucket
        // that has since dropped it must not silently reselect the block.
        if (!key || !keys.includes(key)) keys.unshift(key);
        for (const name of keys) {
          const option = document.createElement('option');
          option.value = name;
          option.textContent = name || '— choose a recording —';
          select.appendChild(option);
        }
        select.value = key;
      };
      fill([]);
      void loadExampleRecordings()
        .then(recordings => {
          known = new Map(recordings.map(recording => [recording.name, recording]));
          fill(recordings);
          describe();
        })
        .catch(error => {
          select.hidden = true;
          typed.hidden = false;
          typed.value = String(tmp.params[p.id] ?? '');
          detail.textContent = `Recordings index unavailable (${error}); type a recording key.`;
        });

      picker.append(select, typed, detail);
      addField(p.category || 'General', `${p.label}  (${p.id})`, picker, p.id, select, propertyFieldDtype(p));
      describe();
      if (p.showWhen) conditionalRows.push({ param: p, row: picker.closest('.dlgrow') as HTMLElement });
    } else if (p.dtype === SIGMF_OPEN_DTYPE) {
      // SigMF Source's recording: both halves at once. A browser cannot derive a
      // sibling file from a picked File, so the .sigmf-data and the .sigmf-meta
      // have to come out of the same dialog -- and the metadata is read here and
      // now, because Output Type follows from it and the samp_rate toggle
      // publishes from it.
      const picker = document.createElement('div'); picker.className = 'file-picker';
      const inp = document.createElement('input'); inp.value = String(tmp.params[p.id] ?? '');
      inp.placeholder = 'choose a .sigmf-data and its .sigmf-meta';
      const choose = document.createElement('button'); choose.type = 'button';
      choose.textContent = 'Browse…';
      const native = document.createElement('input'); native.type = 'file';
      native.className = 'file-picker-native'; native.tabIndex = -1;
      native.multiple = true;
      native.accept = SIGMF_ACCEPT;
      const detail = document.createElement('small'); detail.className = 'file-picker-detail';

      const describe = (problem?: string) => {
        if (problem) { detail.textContent = problem; return; }
        const bound = tmp.localFileToken
          ? sigmfBindingsByToken.get(tmp.localFileToken) : undefined;
        if (!bound) {
          detail.textContent = String(tmp.params[p.id] ?? '')
            ? `"${tmp.params[p.id]}" is not open in this browser session — choose ` +
              `its two files again with Browse.`
            : 'No recording selected for this browser session.';
          return;
        }
        const parts = [
          bound.datatype,
          bound.sampleRate ? displaySi(bound.sampleRate, 'Hz') : 'sample rate unknown',
          displayBytes(bound.data.size),
          `${bound.captures} capture${bound.captures === 1 ? '' : 's'}`,
          `${bound.annotations} annotation${bound.annotations === 1 ? '' : 's'}`,
        ];
        // Not "feed IShort To Complex", the way GR World Recording's chooser
        // puts it: here the block is already on the canvas, so committing this
        // dialog wires the converter up. Say what will happen, or not, rather
        // than leaving the reader to guess which.
        const converter = !isCi16Datatype(bound.datatype) ? ''
          : conns.some(c => c.from === inst.uid)
            ? ' · interleaved 16-bit I/Q: this is a short stream, so it needs an ' +
              'IShort To Complex'
            : ' · interleaved 16-bit I/Q: an IShort To Complex will be added after ' +
              'this block';
        detail.textContent = parts.join(' · ') + converter;
      };

      // Output Type is derived and disabled, so picking a recording is what sets
      // it -- the same arrangement GR World Recording has, for the same reason.
      const applyDatatype = (datatype: string) => {
        const format = sigmfStreamFormat(datatype);
        if (!format) return;
        tmp.params.type = format.type;
        const node = controls.get('type')?.node;
        if (node instanceof HTMLSelectElement) node.value = format.type;
      };

      inp.oninput = () => {
        // Typing a name cannot open a file, so it drops the binding rather than
        // leaving the field describing one recording and the block reading
        // another. Same rule as File Source's field.
        tmp.params[p.id] = inp.value;
        if (tmp.localFileToken) sigmfBindingsByToken.delete(tmp.localFileToken);
        tmp.localFileToken = undefined;
        describe(); refreshVisibility(); refreshValidation();
      };
      choose.onclick = () => native.click();
      native.onchange = async () => {
        const picked = [...(native.files || [])];
        native.value = '';           // so re-picking the same files still fires
        const pair = pairSigmfFiles(picked);
        if ('error' in pair) { describe(pair.error); return; }

        const metaText = await pair.meta.text();
        const meta = parseSigmfMeta(metaText);
        if ('error' in meta) { describe(meta.error); return; }
        if (!sigmfStreamFormat(meta.datatype)) {
          describe(`${meta.datatype} has no stream type here, so this block ` +
                   `could not read it. Open it on its own from the Recordings tab.`);
          return;
        }
        if (pair.data.size === 0) {
          describe(`${pair.base}${SIGMF_DATA_SUFFIX} is empty.`);
          return;
        }

        const token = newLocalFileToken();
        sigmfBindingsByToken.set(token, {
          base: pair.base, data: pair.data, meta: pair.meta, metaText,
          datatype: meta.datatype, sampleRate: meta.sampleRate,
          captures: meta.captures, annotations: meta.annotations,
        });
        tmp.localFileToken = token;
        tmp.params[p.id] = pair.base;
        inp.value = pair.base;
        applyDatatype(meta.datatype);
        describe(); refreshVisibility(); refreshValidation();
        // "Use as samp_rate" publishes on the way out of this dialog, not here,
        // so Cancel cancels it too. See sigmfSampRateToPublish().
      };
      picker.append(inp, choose, native, detail);
      addField(p.category || 'General', `${p.label}  (${p.id})`, picker, p.id, inp, propertyFieldDtype(p));
      describe();
      if (p.showWhen) conditionalRows.push({ param: p, row: picker.closest('.dlgrow') as HTMLElement });
    } else if (p.dtype === SIGMF_SAVE_DTYPE) {
      // SigMF Sink's destination: a base name the reader types, plus a folder to
      // put the pair in. The folder is a File System Access handle, bound for the
      // session like a File; where the API does not exist there is no folder to
      // choose at all and the runner buffers and downloads instead.
      const picker = document.createElement('div'); picker.className = 'file-picker';
      const inp = document.createElement('input'); inp.value = String(tmp.params[p.id] ?? '');
      inp.placeholder = 'recording name, without a suffix';
      const choose = document.createElement('button'); choose.type = 'button';
      choose.textContent = 'Choose folder…';
      const detail = document.createElement('small'); detail.className = 'file-picker-detail';
      const streaming = canPickOutputDirectory();
      choose.hidden = !streaming;

      const describe = (problem?: string) => {
        if (problem) { detail.textContent = problem; return; }
        const base = sanitizeSigmfBase(String(tmp.params[p.id] ?? ''));
        const dir = tmp.localFileToken
          ? sigmfOutputDirsByToken.get(tmp.localFileToken) : undefined;
        if (!base) {
          // The name is what is missing, so it leads -- but a folder just chosen
          // has to be acknowledged here too, or picking one looks like it failed.
          detail.textContent = 'Give the recording a name — both files take it as their stem.' +
            (dir ? ` They will go into "${dir.name}".` : '');
          return;
        }
        const files = sigmfSinkFileNames(base).join(' + ');
        if (!streaming) {
          detail.textContent = `${files} — downloaded when the flowgraph stops. ` +
            `This browser has no File System Access API, so the recording is held ` +
            `in memory until then; a Chromium browser streams it straight to disk.`;
          return;
        }
        detail.textContent = dir
          ? `${files} — written into "${dir.name}".`
          : `${files} — no folder chosen yet; you will be asked for one when you press Run. ` +
            SIGMF_OUTPUT_PICKER_HELP;
      };

      inp.oninput = () => {
        tmp.params[p.id] = inp.value;
        describe(); refreshVisibility(); refreshValidation();
      };
      inp.onblur = () => {
        // Normalized on the way out, not on every keystroke: the reader is
        // typing a filename stem, and a cursor that jumps mid-word is worse than
        // a name tidied once.
        const base = sanitizeSigmfBase(inp.value);
        if (base === inp.value) return;
        inp.value = base; tmp.params[p.id] = base;
        describe(); refreshValidation();
      };
      choose.onclick = async () => {
        try {
          // A click in this dialog is its own user gesture, so a reader who
          // configures the block up front is never prompted again at Run.
          const dir = await pickOutputDirectory();
          const token = tmp.localFileToken || newLocalFileToken();
          tmp.localFileToken = token;
          sigmfOutputDirsByToken.set(token, dir);
          describe(); refreshValidation();
        } catch {
          // Dismissed -- or a blocked folder was chosen and then dismissed,
          // which throws identically. Say what the restriction is rather than
          // leaving the field looking as though nothing happened.
          describe(`No folder chosen. ${SIGMF_OUTPUT_PICKER_HELP}`);
        }
      };
      picker.append(inp, choose, detail);
      addField(p.category || 'General', `${p.label}  (${p.id})`, picker, p.id, inp, propertyFieldDtype(p));
      describe();
      if (p.showWhen) conditionalRows.push({ param: p, row: picker.closest('.dlgrow') as HTMLElement });
    } else if (p.dtype === LAYOUT_DTYPE) {
      // The GUI Layout block's grid. Editing the JSON by hand is possible and
      // pointless, so the field is the arrangement itself: a drag-and-drop
      // miniature of the runner window, fetched on demand like the code editor.
      const mount = document.createElement('div');
      mount.className = 'gui-designer-mount';
      const fallback = document.createElement('small');
      fallback.className = 'field-hint';
      fallback.textContent = 'Loading the layout designer…';
      mount.appendChild(fallback);
      void import('./gui-layout-designer')
        .then(({ mountLayoutDesigner }) => {
          fallback.remove();
          const handle = mountLayoutDesigner(mount, {
            widgets: guiWidgets(),
            tiles: parseTiles(String(tmp.params[p.id] ?? '{}')),
            columns: layoutColumns(tmp.params.columns),
            rowHeight: layoutRowHeight(tmp.params.row_height),
            // Straight into the dialog's working copy, so OK saves the
            // arrangement and Cancel discards it like any other field.
            onChange: next => { tmp.params[p.id] = serializeTiles(next); },
          });
          layoutDesigner.dispose = () => handle.destroy();
        })
        .catch(error => { fallback.textContent = `Layout designer failed to load: ${error}`; });
      addField(p.category || 'General', p.label, mount, p.id, mount, propertyFieldDtype(p));
    } else if (p.dtype === EPY_CODE_DTYPE) {
      // The Embedded Python Block's source. Native GRC hands this parameter to an
      // external editor and re-reads the block every time the file is saved
      // (grc/gui_qt/external_editor.py); the browser equivalent is a code area
      // plus an explicit re-read, because re-reading means running the source in
      // Pyodide and Pyodide is a ~16 MB opt-in download.
      const area = document.createElement('textarea');
      area.className = 'code-editor'; area.rows = 22; area.spellcheck = false;
      area.value = String(tmp.params[p.id]);
      const committed = area.value;
      area.onkeydown = event => {
        // Tab indents instead of leaving the field: this is a Python editor, and
        // an accidental dedent is a syntax error rather than a cosmetic slip.
        // CodeMirror's own indentWithTab does the same once it has mounted.
        if (event.key !== 'Tab' || event.shiftKey) return;
        event.preventDefault();
        const start = area.selectionStart, end = area.selectionEnd;
        area.setRangeText('    ', start, end, 'end');
        tmp.params[p.id] = area.value;
      };
      // Syntax highlighting, line numbers and Python indentation, fetched on
      // demand and mirrored back into the textarea above -- which stays the
      // field's value either way. See editor/src/code-editor.ts.
      void import('./code-editor').then(({ mountCodeEditor }) => mountCodeEditor(area))
        .then(handle => { code.dispose = () => handle?.destroy(); })
        .catch(() => {});
      const status = document.createElement('small'); status.className = 'code-status';
      const reload = document.createElement('button');
      reload.type = 'button'; reload.className = 'code-reload';
      const readSource = async () => {
        code.busy = true; code.message = ''; code.refresh();
        try {
          const io = await pythonRuntime.introspect(String(tmp.params[p.id]));
          // Sorted keys, so re-reading identical code leaves the .grc byte
          // for byte unchanged (and matches the default in epy_block.block.yml).
          tmp.params[EPY_IO_CACHE_PARAM] = JSON.stringify(Object.fromEntries(
            Object.keys(io).sort().map(key => [key, (io as any)[key]])));
          setEpySourceError(inst.uid, '');
          code.pending = false; code.busy = false; code.message = '';
          // The parameter and port set has just changed, so the dialog it is
          // drawn from is stale. Commit and reopen -- the same effect as native
          // GRC rebuilding the block when the external editor saves.
          apply();
          closeDialog();
          log(`${inst.name}: read "${io.label}" — ${io.params.length} parameter(s), ` +
              `${io.sinks.length} input(s), ${io.sources.length} output(s)`);
          showPropsDialog(inst);
        } catch (error) {
          code.busy = false;
          code.message = String((error as Error).message || error);
          setEpySourceError(inst.uid, code.message.split('\n').slice(-1)[0].trim() ||
                            'the block\'s source could not be read');
          code.refresh();
          render();
        }
      };
      reload.onclick = () => { void readSource(); };
      area.oninput = () => {
        tmp.params[p.id] = area.value;
        code.pending = area.value !== committed;
        code.refresh();
        refreshValidation();
      };
      const field = document.createElement('div'); field.className = 'code-field';
      const controlsRow = document.createElement('div'); controlsRow.className = 'code-controls';
      controlsRow.append(reload, status);
      field.append(area, controlsRow);
      addField(p.category || 'General', p.label, field, p.id, area, propertyFieldDtype(p));
      code.refresh = () => {
        if (!overlay.isConnected && overlay.parentNode !== null) return;
        const state = pythonRuntime.state;
        reload.disabled = code.busy || state === 'loading';
        reload.textContent = code.busy ? 'Reading…'
          : state === 'loading' ? 'Starting Python…'
          : state === 'ready' ? 'Re-read this block from its code'
          : 'Load Python and read this block  (~16 MB)';
        status.textContent = code.message
          ? code.message.split('\n').slice(-1)[0].trim()
          : code.pending
            ? 'The code has changed. Read it to update this block’s parameters and ports.'
            : state === 'ready' ? 'Python is loaded.'
            : state === 'loading' ? 'Downloading and starting CPython…'
            : 'Parameters and ports below are from the last time this code was read.';
        status.classList.toggle('code-error', !!code.message);
      };
      code.refresh();
      pythonRuntime.onchange = () => code.refresh();
      // Already loaded it once in an earlier session? Then the opt-in has been
      // given and re-asking is just a click in the way. Nothing is fetched for a
      // user who has never loaded it.
      if (pythonRuntime.consented && pythonRuntime.state === 'absent')
        void pythonRuntime.load();
    } else if (p.dtype === JS_CODE_DTYPE) {
      // The JavaScript Block's source. Unlike the Python Block's Code field
      // there is no re-read button and no gating: deriving a JS block's
      // interface means evaluating its descriptor in a disposable sandbox, which
      // costs a few milliseconds and needs nothing downloaded. So it is
      // debounced on every keystroke and the panel below the field says what the
      // code currently means. See editor/src/js-block.ts.
      const area = document.createElement('textarea');
      area.className = 'code-editor'; area.rows = 18; area.spellcheck = false;
      area.value = String(tmp.params[p.id]);
      area.onkeydown = event => {
        if (event.key !== 'Tab' || event.shiftKey) return;
        event.preventDefault();
        area.setRangeText('  ', area.selectionStart, area.selectionEnd, 'end');
        tmp.params[p.id] = area.value;
      };
      void import('./code-editor')
        .then(({ mountCodeEditor }) => mountCodeEditor(area, 'javascript'))
        .then(handle => { code.dispose = () => handle?.destroy(); })
        .catch(() => {});
      const status = document.createElement('small'); status.className = 'code-status';
      const popout = document.createElement('button');
      popout.type = 'button'; popout.className = 'code-reload';
      popout.textContent = 'Expand Editor ⤢';
      popout.title = 'Open this code in a large resizable editor, ' +
                     'with a live view of the block it derives';
      popout.onclick = () => {
        // Seeded from the dialog's working copy and written back to it, so
        // Cancel still discards everything the popup did.
        openJsCodeModal({
          title: `Code: ${tmp.name}`,
          source: String(tmp.params[p.id]),
          apply: (source, io) => {
            tmp.params[p.id] = source;
            if (io) applyJsIo(tmp.params, io);
          },
          uid: inst.uid,
          onSave: () => {
            // The parameter and port set may have just changed, so the dialog
            // drawn from it is stale. Commit and reopen -- the same effect the
            // Python Block's re-read has.
            apply(); closeDialog(); showPropsDialog(inst);
          },
          render: () => { area.value = String(tmp.params[p.id]); refreshValidation(); },
        });
      };
      let deriveTimer: number | undefined;
      const describe = () => {
        const source = String(tmp.params[p.id]);
        jsIntrospector.describe(source).then(io => {
          if (!overlay.isConnected || String(tmp.params[p.id]) !== source) return;
          applyJsIo(tmp.params, io);
          acceptJsSource(source);   // typed here, so no Run consent for it
          setJsSourceError(inst.uid, '');
          code.message = '';
          code.refresh(); refreshValidation(); render();
        }).catch(error => {
          if (!overlay.isConnected || String(tmp.params[p.id]) !== source) return;
          code.message = String((error as Error)?.message || error);
          setJsSourceError(inst.uid, code.message.split('\n')[0].trim() ||
                           'the block\'s source could not be read');
          code.refresh(); refreshValidation(); render();
        });
      };
      area.oninput = () => {
        tmp.params[p.id] = area.value;
        clearTimeout(deriveTimer);
        deriveTimer = setTimeout(describe, 220) as unknown as number;
      };
      const field = document.createElement('div'); field.className = 'code-field';
      const controlsRow = document.createElement('div'); controlsRow.className = 'code-controls';
      controlsRow.append(popout, status);
      field.append(area, controlsRow);
      addField(p.category || 'General', p.label, field, p.id, area, propertyFieldDtype(p));
      code.refresh = () => {
        if (!overlay.isConnected && overlay.parentNode !== null) return;
        const io = parseJsIo(tmp.params[JS_IO_PARAM]);
        status.textContent = code.message
          ? code.message.split('\n')[0].trim()
          : io
            ? `${io.label} — ${io.inputs.length} input(s), ${io.outputs.length} ` +
              `output(s), ${io.params.length} parameter(s). ` +
              `Apply to update this block's fields.`
            : 'This block has no interface yet.';
        status.classList.toggle('code-error', !!code.message);
      };
      const previousDispose = code.dispose;
      code.dispose = () => { clearTimeout(deriveTimer); previousDispose(); };
      code.refresh();
      describe();
    } else if (usesOptionCombo(p)) {
      // A parameter with an options list that is not `dtype: enum` — see
      // optionCombo(): a dropdown of the options, still able to hold an
      // expression or a variable.
      const combo = optionCombo(p, String(tmp.params[p.id]), value => {
        tmp.params[p.id] = p.type === 'number' ? numericOrExpression(value) : value;
        refreshVisibility(); refreshValidation();
      });
      addField(p.category || 'General', `${p.label}  (${p.id})`, combo.wrap, p.id,
        combo.select, propertyFieldDtype(p));
      if (p.showWhen) conditionalRows.push({ param: p, row: combo.wrap.closest('.dlgrow') as HTMLElement });
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
      addField(p.category || 'General', `${p.label}  (${p.id})`, inp, p.id, inp, propertyFieldDtype(p));
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
    const publish = sigmfSampRateToPublish(inst.id, inst.params, inst.localFileToken);
    if (publish) applySampRateFromSigmf(publish.rate, publish.source);
    // Both of these are the *recording's* consequences rather than the reader's
    // edits, so they land here where the dialog commits: Cancel cancels them,
    // and the single recordHistory() below makes picking a recording one undo
    // step rather than three.
    if (sigmfNeedsIShortToComplex(inst.id, inst.localFileToken) &&
        attachIShortToComplex(inst))
      log(`added IShort To Complex after "${inst.name}": an interleaved 16-bit ` +
          `recording is a short stream`);
    select(inst.uid);
    recordHistory();
  };
  const btn = (label: string, fn: () => void, cls = '') => {
    const b = document.createElement('button'); b.textContent = label; if (cls) b.className = cls; b.onclick = fn; return b;
  };
  foot.appendChild(btn('Cancel', () => closeDialog()));
  const applyButton = btn('Apply', apply);
  const okButton = btn('OK', () => { apply(); closeDialog(); }, 'run');
  foot.append(applyButton, okButton);
  if (inst.id === EPY_BLOCK_ID) {
    // Committing edited code without re-reading it would leave the block's
    // parameters and ports describing the *previous* source: the flowgraph would
    // then be wired one way and built another, and only the runner would notice.
    // So the code has to be read before it can be applied.
    const refreshCode = code.refresh;
    code.refresh = () => {
      refreshCode();
      applyButton.disabled = okButton.disabled = code.pending || code.busy;
      applyButton.title = okButton.title = code.pending
        ? 'Read the code first, so this block’s parameters and ports match it' : '';
    };
    code.refresh();
  }

  activateTab('General');
  dlg.append(head, tabBar, body, foot); overlay.appendChild(dlg); document.body.appendChild(overlay);
  // Unlike the informational dialogs, this one holds unsaved edits: a stray click
  // on the backdrop must not discard them. Only OK/Cancel/× close it.
  refreshValidation();
  // The ID field when the block has one, otherwise its first real parameter.
  const first = panels.get('General')!.querySelector(
    'input:not([hidden]), select:not([hidden]), textarea:not([hidden])') as HTMLElement | null;
  first?.focus();
  if (first instanceof HTMLInputElement) first.select();
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

function renderTrainingGuides() {
  const status = el('trainingStatus');
  if (!trainingSession) {
    status.hidden = true;
    status.classList.remove('complete');
    document.querySelectorAll<HTMLButtonElement>('[data-tool="Execute"]')
      .forEach(button => button.disabled = false);
    return;
  }

  for (const guide of trainingSession.connectionGuides(insts, conns)) {
    if (portMeta(guide.from, 'out', guide.connection.fp).hidden ||
        portMeta(guide.to, 'in', guide.connection.tp).hidden) continue;
    trainingWiresG.appendChild(svgEl('path', { class: 'training-wire',
      d: connectionPath(guide.from, guide.connection.fp, guide.to, guide.connection.tp) }));
  }

  for (const target of trainingSession.unfilledBlocks(insts)) {
    const { d, h, w } = geom(target);
    const g = svgEl('g', { class: 'training-ghost',
      transform: `translate(${target.x},${target.y})` });
    g.appendChild(svgEl('rect', { class: 'body', width: String(w), height: String(h), rx: '2' }));
    const title = svgEl('text', { class: 'title', x: String(w / 2), y: String(h / 2),
      'text-anchor': 'middle', 'dominant-baseline': 'central' });
    title.textContent = d.label;
    g.appendChild(title);
    for (const i of visiblePortIndices(target, 'in')) addTrainingPort(g, target, 'in', i);
    for (const i of visiblePortIndices(target, 'out')) addTrainingPort(g, target, 'out', i);
    trainingNodesG.appendChild(g);
  }

  const counts = trainingSession.counts(insts, conns);
  const complete = trainingSession.complete(insts, conns);
  status.hidden = false;
  status.classList.toggle('complete', complete);
  status.textContent = complete
    ? `Training complete — ready to run`
    : `${counts.filledBlocks}/${counts.totalBlocks} blocks · ` +
      `${counts.filledConnections}/${counts.totalConnections} connections`;
  document.querySelectorAll<HTMLButtonElement>('[data-tool="Execute"]')
    .forEach(button => {
      button.disabled = !complete;
      button.title = complete ? 'Execute (F6)' : 'Complete the training flowgraph before running';
    });
}

function render() {
  rebuildScope();
  trainingNodesG.textContent = ''; trainingWiresG.textContent = '';
  nodesG.textContent = ''; wiresG.textContent = '';
  trainingNodesG.setAttribute('transform', `scale(${zoom})`);
  trainingWiresG.setAttribute('transform', `scale(${zoom})`);
  nodesG.setAttribute('transform', `scale(${zoom})`);
  wiresG.setAttribute('transform', `scale(${zoom})`);
  selectionG.setAttribute('transform', `scale(${zoom})`);
  const validation = validateGraph();
  const invalidConnections = new Set(validation.flatMap(issue => issue.connection ? [issue.connection] : []));
  const G = (uid: string) => insts.find(i => i.uid === uid)!;
  renderTrainingGuides();
  // wires (from output right-edge to input left-edge, GRC-style curves)
  for (const c of conns) {
    const a = G(c.from), b = G(c.to);
    if (!a || !b || canvasBlockHidden(a) || canvasBlockHidden(b)) continue;
    if (portMeta(a, 'out', c.fp).hidden || portMeta(b, 'in', c.tp).hidden) continue;
    // As in native GRC: a straight 15px run out of each port, a cubic bezier,
    // then a straight approach in. Control points 50px out, except on a wire
    // that has to double back on itself — see wireShape().
    const d = connectionPath(a, c.fp, b, c.tp);
    const isSelected = c === selectedConnection || (insts.length > 0 && selectedBlocks.size === insts.length);
    const isInvalid = invalidConnections.has(c);
    const wire = svgEl('g', { class: 'wire-group' });
    // The invalid stroke colour wins over the selected one (its CSS rule is later),
    // so the arrowhead follows it too.
    wire.appendChild(svgEl('path', { class: 'wire' + (isSelected ? ' sel' : '') +
      (isInvalid ? ' invalid' : ''), d,
      'marker-end': isInvalid ? 'url(#arrow-invalid)'
        : isSelected ? 'url(#arrow-selected)' : 'url(#arrow)' }));
    // Match the desktop GUI's forgiving line hit test without drawing a thick wire.
    wire.appendChild(svgEl('path', { class: 'wire-hit', d }));
    const activateConn = (e: MouseEvent) => {
      e.preventDefault(); e.stopPropagation();
      cancelConnect();
      selectConnection(c);
      showConnectionMenu(e.clientX, e.clientY, c);
    };
    wire.addEventListener('pointerdown', e => { if (e.button !== 0) return; activateConn(e); });
    wire.addEventListener('contextmenu', activateConn);
    wiresG.appendChild(wire);
  }
  // blocks
  for (const inst of insts) {
    if (canvasBlockHidden(inst)) continue;
    const { d, rows, h, w, subtitle, headH, thumb, thumbH, thumbTop } = geom(inst) as
      ReturnType<typeof geom> &
      { thumb?: LayoutThumbTile[]; thumbH?: number; thumbTop?: number };
    const comment = blockCommentGeometry(inst);
    const blockIssues = validation.filter(issue => issue.uid === inst.uid);
    const g = svgEl('g', { class: 'blk' + (selectedBlocks.has(inst.uid) ? ' sel' : '') +
      (trainingSession?.snapTargetForActual(inst.uid) ? ' training-snap' : '') +
      (inst.enabled ? '' : ' disabled') + (inst.bypassed ? ' bypassed' : '') +
      (blockIssues.length ? ' invalid' : ''),
      transform: `translate(${inst.x},${inst.y})` });
    const rect = svgEl('rect', { class: 'body', width: String(w), height: String(h), rx: '2' });
    g.appendChild(rect);
    // Native GRC has no title separator. With no face parameters, center the
    // title in the whole block instead of leaving it in an empty title row.
    // With a subtitle it is the pair that gets centered, so the title rises by
    // half the line the subtitle occupies.
    const titleY = (rows.length || thumb) ? TITLE_BASELINE
      : h / 2 - (subtitle ? SUBTITLE_H / 2 : 0);
    const titleAttrs: Record<string, string> = {
      class: 'title', x: String(w / 2), y: String(titleY), 'text-anchor': 'middle',
    };
    // A thumbnail is body content too: keep its title on the same alphabetic
    // baseline as a block with parameter rows. Only a truly bodyless block
    // centres its title vertically in the whole face.
    if (!rows.length && !thumb) titleAttrs['dominant-baseline'] = 'central';
    const t = svgEl('text', titleAttrs);
    t.textContent = d.label; g.appendChild(t);
    if (subtitle) {
      const s = svgEl('text', { ...titleAttrs, class: 'subtitle',
                                y: String(titleY + SUBTITLE_GAP) });
      s.textContent = subtitle; g.appendChild(s);
    }
    // parameter rows: "label: value"
    rows.forEach((r, i) => {
      const y = rowsTop(h, rows.length, headH) + i * ROW_H + ROW_BASELINE;
      const tx = svgEl('text', { class: 'param' + (fieldIssue(blockIssues, inst.uid, r.id) ? ' invalid' : '') +
        (r.id === MORE_ROW_ID ? ' pmore' : ''), x: String(TEXT_PAD_L), y: String(y) });
      const l = document.createElementNS(SVGNS, 'tspan'); l.setAttribute('class', 'plabel'); l.textContent = r.l;
      if (r.expression !== undefined) {
        const expression = document.createElementNS(SVGNS, 'tspan');
        expression.setAttribute('class', 'pexpr'); expression.textContent = r.expression;
        tx.appendChild(l); tx.appendChild(expression);
        if (r.v) {
          const equals = document.createElementNS(SVGNS, 'tspan'); equals.textContent = '=';
          tx.appendChild(equals);
        }
      } else tx.appendChild(l);
      const v = document.createElementNS(SVGNS, 'tspan'); v.setAttribute('class', 'pval'); v.textContent = r.v;
      tx.appendChild(v); g.appendChild(tx);
    });
    // The GUI Layout block's miniature runner window: the grid outline plus one
    // labelled rectangle per widget, in the position it will occupy.
    if (thumb) {
      const top = thumbTop ?? TITLE_H;
      g.appendChild(svgEl('rect', { class: 'gui-thumb-frame', x: String(TEXT_PAD_L),
        y: String(top), width: String(LAYOUT_THUMB_W), height: String(thumbH ?? 0) }));
      for (const tile of thumb) {
        g.appendChild(svgEl('rect', { class: 'gui-thumb-tile',
          x: String(TEXT_PAD_L + tile.x + 1), y: String(top + tile.y + 1),
          width: String(Math.max(1, tile.w - 2)), height: String(Math.max(1, tile.h - 2)),
          rx: '1' }));
        // Only label a tile with room for a legible word; a 1x1 control tile in
        // a 12-column grid is 20px wide, where any text is noise.
        if (tile.w < 34 || tile.h < 11) continue;
        const label = svgEl('text', { class: 'gui-thumb-label',
          x: String(TEXT_PAD_L + tile.x + tile.w / 2),
          y: String(top + tile.y + tile.h / 2), 'text-anchor': 'middle',
          'dominant-baseline': 'central' });
        label.textContent = truncateToWidth(tile.name, tile.w - 6, LAYOUT_THUMB_FONT);
        g.appendChild(label);
      }
    }
    // Native GRC draws the comment as a separate text item below the body, not
    // as another parameter row. It therefore neither changes the block/port
    // geometry nor participates in block selection or dragging.
    comment.lines.forEach((line, i) => {
      const text = svgEl('text', { class: 'comment', x: '0',
        y: String(h + COMMENT_GAP + COMMENT_BASELINE + i * COMMENT_LINE_H) });
      text.textContent = line;
      g.appendChild(text);
    });
    const messages = [...new Set(blockIssues.map(issue => issue.message))];
    const wrapped = messages.flatMap(message => wrapValidationMessage(message, Math.max(22, Math.floor(w / ERROR_CHAR_W))));
    wrapped.slice(0, 5).forEach((message, i) => {
      const error = svgEl('text', { class: 'validation-error', x: '0',
        y: String(h + comment.height + ERROR_LINE_H * (i + 1)) });
      error.textContent = message; g.appendChild(error);
    });
    if (wrapped.length > 5) {
      const more = svgEl('text', { class: 'validation-error', x: '0',
        y: String(h + comment.height + ERROR_LINE_H * 6) });
      more.textContent = `+${wrapped.length - 5} more lines`; g.appendChild(more);
    }
    // Drag from anywhere on the block; ports stopPropagation so they still connect.
    g.addEventListener('pointerdown', e => startDrag(e, inst));
    // Hold a touch that grabbed this block (or one of its ports, which are its
    // children) so it drags or wires instead of panning the canvas out from
    // under itself: without this the browser claims the gesture, the pointer
    // stream ends in `pointercancel`, and the block stops two frames in.
    // `touch-action:none` is the declarative form and cannot do the job — Blink
    // applies the property to CSS boxes, and an SVG child element is not one.
    // Cancelling the *move* rather than the touch start is what leaves a
    // long-press free to raise the block's context menu.
    // It has to be bound here, per block, rather than once on the canvas: touch
    // events keep targeting the node the gesture began on even after render()
    // has replaced it, and a detached node's events reach no ancestor.
    g.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
    g.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); if (!selectedBlocks.has(inst.uid)) select(inst.uid); showMenu(e.clientX, e.clientY, inst); });
    for (const i of visiblePortIndices(inst, 'in'))
      addPort(g, inst, 'in', i, portColor(inst, 'in', i));
    for (const i of visiblePortIndices(inst, 'out'))
      addPort(g, inst, 'out', i, portColor(inst, 'out', i));
    nodesG.appendChild(g);
  }
  updateCanvasExtent();
  syncRecordingTabs();   // one workspace tab per block with a recording behind it
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
  const blocks = [...insts, ...(trainingSession?.unfilledBlocks(insts) || [])];
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
  const hoverKey = `${inst.uid}:${kind}:${idx}`;
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
  r.addEventListener('pointerenter', () => {
    if (!autoHidePortLabels || connecting || hoveredPortKey === hoverKey) return;
    hoveredPortKey = hoverKey;
    render();
  });
  r.addEventListener('pointerleave', () => {
    // Keep the source expanded while a wire is armed or being dragged. The
    // connection completion/cancellation path collapses it and redraws once.
    if (!autoHidePortLabels || connecting || hoveredPortKey !== hoverKey) return;
    hoveredPortKey = null;
    render();
  });
  // Two ways to wire ports (GRC-style): left-drag from a port and release on a
  // compatible one, or click a port then click the other. Works from either an
  // output or an input.
  r.addEventListener('pointerdown', e => {
    if (e.button !== 0) return;
    e.stopPropagation(); e.preventDefault();
    // A touch is implicitly captured by the element it went down on, which would
    // send the release to the source port however far the finger travelled;
    // dropping the capture lets the port under the fingertip receive it, so a
    // drag connects on a touch screen exactly as it does with a mouse.
    if (r.hasPointerCapture(e.pointerId)) r.releasePointerCapture(e.pointerId);
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
  r.addEventListener('pointerup', e => {
    if (!connecting) return;
    e.stopPropagation();   // keep the window handler from cancelling the wire
    // Released on the source port itself: if the pointer barely moved this was a
    // click, so leave the wire armed for click-to-connect; otherwise it was a
    // drag that went nowhere, so abandon it.
    if (connecting.uid === inst.uid && connecting.port === idx && connecting.kind === kind) {
      const dp = connectDownPt;
      if (dp && Math.hypot(e.clientX - dp.x, e.clientY - dp.y) > CONNECT_CLICK_SLOP &&
          cancelConnect()) render();
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
  if (!inst) { if (cancelConnect()) render(); return; }
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
  const collapsedPort = autoHidePortLabels && hoveredPortKey !== null;
  connecting = null; connectDownPt = null;
  hoveredPortKey = null;
  if (connectPreview) { connectPreview.remove(); connectPreview = null; }
  return collapsedPort;
}
// Finish a drag on the given port, orienting the connection output→input.
function completeConnect(inst: Inst, kind: 'in' | 'out', idx: number) {
  if (!connecting) return;
  let out: { uid: string; port: number }, sink: { uid: string; port: number };
  if (connecting.kind === 'out' && kind === 'in') {
    out = { uid: connecting.uid, port: connecting.port }; sink = { uid: inst.uid, port: idx };
  } else if (connecting.kind === 'in' && kind === 'out') {
    out = { uid: inst.uid, port: idx }; sink = { uid: connecting.uid, port: connecting.port };
  } else { if (cancelConnect()) render(); return; }   // same direction (out→out / in→in): no connection
  if (out.uid === sink.uid) { if (cancelConnect()) render(); return; }  // don't connect a block to itself
  if (selectedConnection && selectedConnection.to === sink.uid && selectedConnection.tp === sink.port)
    selectedConnection = null;
  conns = conns.filter(cn => !(cn.to === sink.uid && cn.tp === sink.port));  // one wire per input
  conns.push({ from: out.uid, fp: out.port, to: sink.uid, tp: sink.port });
  log('  → ' + G0(out.uid).name + ':' + out.port + '  to  ' + G0(sink.uid).name + ':' + sink.port);
  cancelConnect(); render(); recordHistory();
}

let drag: { inst: Inst; ox: number; oy: number; starts: Map<string, { x: number; y: number }>;
  natural: { x: number; y: number }; moved: boolean } | null = null;
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
    if (canvasBlockHidden(inst)) continue;
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
// every press, so the browser never sees two clicks on the same element and
// its native 'dblclick' never fires. Track the last press ourselves instead.
let lastMouseDown: { uid: string; t: number } | null = null;
// Route the rest of a canvas gesture through the <svg> root. A touch is captured
// by whatever element it went down on, and render() replaces that element on
// every move — a dragged block's own <g> does not survive its first frame, and
// events aimed at a detached node reach no window listener. The root is stable.
function captureCanvasPointer(e: PointerEvent) { svg.setPointerCapture(e.pointerId); }
function startDrag(e: PointerEvent, inst: Inst) {
  e.stopPropagation();
  if (e.button !== 0) return;   // right/middle click: let the context menu handle it
  e.preventDefault();           // stop the browser from starting a text selection
  const now = Date.now();
  if (lastMouseDown && lastMouseDown.uid === inst.uid && now - lastMouseDown.t < 350) {
    lastMouseDown = null; drag = null;
    select(inst.uid);
    showPropsDialog(inst);        // same dialog as right-click → Properties
    return;
  }
  lastMouseDown = { uid: inst.uid, t: now };
  select(inst.uid, e.shiftKey);
  if (!selectedBlocks.has(inst.uid)) return;
  trainingSession?.clearSnapCandidate();
  captureCanvasPointer(e);
  const p = svgPoint(e);
  drag = { inst, ox: p.x - inst.x, oy: p.y - inst.y,
    starts: new Map(insts.filter(i => selectedBlocks.has(i.uid)).map(i => [i.uid, { x: i.x, y: i.y }])),
    natural: { x: inst.x, y: inst.y }, moved: false };
}
window.addEventListener('pointermove', e => {
  if (connecting) { updateConnectPreview(svgPoint(e)); return; }
  if (marquee) { updateMarquee(svgPoint(e)); return; }
  if (!drag) return; const p = svgPoint(e);
  const primary = drag.starts.get(drag.inst.uid)!;
  const natural = constrainBlockPosition(p.x - drag.ox, p.y - drag.oy, snapToGrid);
  drag.natural = natural;
  const snapTarget = selectedBlocks.size === 1
    ? trainingSession?.updateSnapCandidate(drag.inst, natural.x, natural.y, insts)
    : undefined;
  if (selectedBlocks.size !== 1) trainingSession?.clearSnapCandidate();
  const target = snapTarget ? { x: snapTarget.x, y: snapTarget.y } : natural;
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

const endPointerGesture = (e: PointerEvent) => {
  if (svg.hasPointerCapture(e.pointerId)) svg.releasePointerCapture(e.pointerId);
  const collapsedPort = connecting ? cancelConnect() : false; // released away: abandon the wire
  let redraw = false;
  if (drag) {
    const target = e.type === 'pointerup'
      ? trainingSession?.commitSnap(drag.inst.uid) : undefined;
    if (target) {
      adoptTrainingTarget(drag.inst, target);
      redraw = true;
    } else if (trainingSession?.snapTargetForActual(drag.inst.uid)) {
      // A cancelled pointer stream must not strand the uncommitted preview at
      // the target. Only one selected block can magnetically snap.
      drag.inst.x = drag.natural.x;
      drag.inst.y = drag.natural.y;
      redraw = true;
    }
    trainingSession?.clearSnapCandidate();
    if (drag.moved || target) recordHistory();
  }
  drag = null;
  if (marquee) { marquee.rect.remove(); marquee = null; }
  if (collapsedPort || redraw) render();
};
window.addEventListener('pointerup', endPointerGesture);
// The browser takes the gesture over when it decides a touch is a scroll (or the
// system does, mid-gesture). Without this the rubber band would be left painted
// on the canvas and a half-finished wire armed.
window.addEventListener('pointercancel', endPointerGesture);
svg.addEventListener('pointerdown', e => {
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
  // A finger on empty canvas pans it — that is the scroll container's gesture,
  // and a rubber band would fight it for the same drag. Deselecting, above,
  // still happens either way.
  if (e.pointerType === 'touch') return;
  captureCanvasPointer(e);
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
// The bindings handed to one run: files a source reads, and the destinations a
// sink writes. `meta` is a SigMF Source's .sigmf-meta text, carried beside the
// samples so the runner's factory can build its tag plan without any of it
// reaching the .grc. An 'output' has no File and no size -- a folder handle to
// stream into, or nothing at all, in which case the runner buffers and
// downloads at the end.
type RunnerInputFile =
  | { kind: 'local'; path: string; file: File; meta?: string }
  | { kind: 'http'; path: string; url: string; size: number; meta?: string }
  | { kind: 'output'; path: string; base: string; dir: FileSystemDirectoryHandle | null };
const pendingRunnerRecordings = new Map<string, RunnerInputFile[]>();
let pendingRunnerToken: string | null = null;

// How big the file at a Public HTTP Recording's URL is. The reader needs the
// length up front to bound its ranges, and there is no metadata to take it
// from, so ask the server: HEAD first, and a one-byte range for the hosts that
// serve ranges but not HEAD. Either answer also proves the URL is reachable
// with this origin's CORS headers, which is what makes it worth doing before
// the flowgraph starts rather than inside the reader worker.
async function publicHttpFileSize(url: string): Promise<number | null> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { return null; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  try {
    const response = await fetch(parsed.href, {
      method: 'HEAD', cache: 'no-store', mode: 'cors',
    });
    const size = Number(response.headers.get('Content-Length'));
    if (response.ok && Number.isSafeInteger(size) && size > 0) return size;
  } catch { /* Some range-capable hosts do not implement HEAD. */ }

  try {
    const response = await fetch(parsed.href, {
      headers: { Range: 'bytes=0-0' }, cache: 'no-store', mode: 'cors',
    });
    const match = /^bytes\s+0-0\/(\d+)$/i.exec(response.headers.get('Content-Range') || '');
    await response.body?.cancel();
    const size = Number(match?.[1]);
    return response.status === 206 && Number.isSafeInteger(size) && size > 0 ? size : null;
  } catch { return null; }
}

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
type WorkspaceTab = 'editor' | 'qtgui' | string;
interface WorkspaceTabEntry {
  id: WorkspaceTab; button: HTMLButtonElement; panel: HTMLElement; container?: HTMLElement;
}
const tabContainer = (entry: WorkspaceTabEntry): HTMLElement => entry.container || entry.button;
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
    // The close button stays out of the tab order — a tablist is one stop, moved
    // through with the arrow keys — so Delete on the focused tab is what closes a
    // recording nothing on the canvas owns.
    if (event.key === 'Delete' || event.key === 'Backspace') {
      const tab = isRecordingTabId(entry.id)
        ? recordingTabs.get(recordingTabKey(entry.id)) : undefined;
      if (!tab || tab.close.hidden) return;
      closeRecordingTab(tab);
      event.preventDefault();
      return;
    }
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

let runnerRunning = false;
let runningGraphSnapshot: string | null = null;

function updateRunningCanvasState(): void {
  if (!runnerRunning || !runningGraphSnapshot) return;
  const stale = JSON.stringify(snapshot()) !== runningGraphSnapshot;
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
    runningGraphSnapshot = null;
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
interface RunnerWidget { name: string; id: string; col: number; row: number; w: number; h: number }
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
  const files = pendingRunnerRecordings.get(token) || [];
  pendingRunnerRecordings.delete(token);
  if (pendingRunnerToken === token) pendingRunnerToken = null;
  return files;
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
interface RecordingSource {
  key: string;            // '/recordings/<path>' or 'local:<token>'
  label: string;          // tab text
  title: string;          // tooltip: the recording key or file name
  name: string;           // display name handed to the recording view
  kind: 'remote' | 'local';
  path: string;           // remote: the /recordings/... path this resolves through
  token?: string;         // local: key into localFilesByToken
  datatype?: string;      // local: SigMF datatype inferred from the block
  sampleRate?: number;    // local: samp_rate from the flowgraph, when numeric
  // A SigMF Source's real .sigmf-meta. The only local source that has one --
  // everything else local gets synthesizedSigmfMeta(), which infers a datatype
  // and a rate and has no captures or annotations to offer at all.
  metaText?: string;
  file?: File;            // local: the samples, when the block holds them itself
  offset: number;         // the block's sample selection
  length: number;
}

interface RecordingTab {
  source: RecordingSource;
  entry: WorkspaceTabEntry;
  label: HTMLElement;
  close: HTMLButtonElement;
  status: HTMLElement;
  frame: HTMLIFrameElement | null;
  opening: boolean;
  ready: boolean;
  pinned: boolean;        // opened without a block behind it; survives sync
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
// a complex recording — the same shape addRecordingBlock() builds for ci16.
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

// The three blocks that can have a recording behind them: File Source, for raw
// samples in a file on this computer; SigMF Source, for a SigMF recording on
// this computer; and GR World Recording, for a hosted one.
const RECORDING_BLOCK_IDS = new Set(['blocks_file_source', SIGMF_SOURCE_ID, RECORDING_ID]);

function recordingSourceFor(block: Inst): RecordingSource | null {
  const selection = fileSourceSelection(block);
  if (block.id === RECORDING_ID) {
    let path: string;
    try { path = recordingDataPath(String(block.params[RECORDING_PARAM] || '')); }
    catch { return null; }     // no recording chosen yet, or an unusable key
    // The label comes from the key, not from the recordings index, so drawing
    // the tab never has to wait on (or trigger) a fetch.
    const name = String(block.params[RECORDING_PARAM]);
    return {
      key: path, label: name.split('/').pop() || name, title: name, name,
      kind: 'remote', path,
      ...selection,
    };
  }
  if (!block.localFileToken) return null;

  // A SigMF Source is the one local block whose recording describes itself, so
  // its tab is driven by the real .sigmf-meta rather than one inferred from the
  // block's parameters -- which is what puts the recording's own annotations on
  // the spectrogram.
  if (block.id === SIGMF_SOURCE_ID) {
    const bound = sigmfBindingsByToken.get(block.localFileToken);
    if (!bound) return null;   // picked in a previous session; the Files are gone
    const name = bound.base + SIGMF_DATA_SUFFIX;
    return {
      key: 'sigmf:' + block.localFileToken,
      label: bound.base, title: name, name,
      kind: 'local', path: name, token: block.localFileToken,
      datatype: bound.datatype,
      sampleRate: bound.sampleRate ?? undefined,
      metaText: bound.metaText,
      file: bound.data,
      ...selection,
    };
  }

  const file = localFilesByToken.get(block.localFileToken);
  if (!file) return null;      // picked in a previous session; the File is gone
  const rate = Number(varScope['samp_rate']);
  return {
    key: 'local:' + block.localFileToken,
    label: file.name, title: file.name, name: file.name,
    kind: 'local', path: String(block.params.file || ''), token: block.localFileToken,
    datatype: localRecordingDatatype(block),
    sampleRate: Number.isFinite(rate) && rate > 0 ? rate : undefined,
    file,
    ...selection,
  };
}

function recordingSources(): RecordingSource[] {
  const sources: RecordingSource[] = [];
  const seen = new Set<string>();
  for (const block of insts) {
    if (!RECORDING_BLOCK_IDS.has(block.id)) continue;
    const source = recordingSourceFor(block);
    if (!source || seen.has(source.key)) continue;   // two blocks, one tab
    seen.add(source.key);
    sources.push(source);
  }
  return sources;
}

function createRecordingTab(source: RecordingSource): RecordingTab {
  const id = ++recordingTabCounter;
  // The button and its close control are siblings inside a group styled as one
  // tab: nesting a button inside a button is invalid, and the close control has
  // to be separately clickable and focusable.
  const group = document.createElement('div'); group.className = 'workspace-tab-group';
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'workspace-tab'; button.id = `tabRecording${id}`;
  button.setAttribute('role', 'tab'); button.setAttribute('aria-selected', 'false');
  button.tabIndex = -1;
  const label = document.createElement('span'); label.className = 'workspace-tab-label';
  button.appendChild(label);
  const close = document.createElement('button');
  close.type = 'button'; close.className = 'workspace-tab-close'; close.textContent = '×';
  close.tabIndex = -1; close.hidden = true;
  group.append(button, close);

  const panel = document.createElement('section');
  panel.className = 'workspace-panel recording-pane'; panel.id = `recordingPane${id}`;
  panel.setAttribute('role', 'tabpanel'); panel.setAttribute('aria-labelledby', button.id);
  button.setAttribute('aria-controls', panel.id);
  const status = document.createElement('div'); status.className = 'rec-pane-status';
  status.textContent = 'Open this tab to load the recording view.';
  panel.appendChild(status);
  el('workspaceContent').appendChild(panel);

  const entry: WorkspaceTabEntry = { id: 'rec:' + source.key, button, panel, container: group };
  wireWorkspaceTab(entry);
  workspaceTabs.push(entry);
  el('workspaceTabs').appendChild(group);
  const tab: RecordingTab = {
    source, entry, label, close, status, frame: null, opening: false, ready: false,
    pinned: false, viewerOffset: null, viewerLength: null, blobUrls: [],
  };
  close.onclick = event => { event.stopPropagation(); closeRecordingTab(tab); };
  return tab;
}

function destroyRecordingTab(tab: RecordingTab) {
  for (const url of tab.blobUrls) URL.revokeObjectURL(url);
  tabContainer(tab.entry).remove();
  tab.entry.panel.remove();   // drops the iframe, and with it the viewer's fetches
  const index = workspaceTabs.indexOf(tab.entry);
  if (index >= 0) workspaceTabs.splice(index, 1);
  recordingTabs.delete(tab.source.key);
  // As with #example=, the URL must not go on claiming what is no longer open.
  if (recordingHashKey() === recordingKeyOf(tab)) setUrlFragment({ recording: null });
  if (activeWorkspaceTab === tab.entry.id) activateWorkspaceTab('editor');
}

// The linkable form of what a tab shows: the recording's base key. A locally
// picked file has none — it exists only for this session — so it is not linkable.
function recordingKeyOf(tab: RecordingTab): string | null {
  return tab.source.kind === 'remote' ? tab.source.name : null;
}
const recordingHashKey = (): string | null =>
  new URLSearchParams(location.hash.slice(1)).get('recording');

// Only a pinned tab has a close button, so a block still owning this
// recording cannot be closed out from under the canvas.
function closeRecordingTab(tab: RecordingTab) {
  tab.pinned = false;
  if (recordingSources().some(source => source.key === tab.source.key)) {
    syncRecordingTabs();   // the canvas owns it after all: keep it, drop the ×
    return;
  }
  destroyRecordingTab(tab);
}

function describeRecordingTab(tab: RecordingTab, source: RecordingSource) {
  tab.source = source;
  tab.label.textContent = source.label;
  tab.entry.button.title = source.title;
  tab.entry.button.setAttribute('aria-label', `Recording ${source.title}`);
  tab.close.title = `Close the recording view of ${source.title} (Delete)`;
  tab.close.setAttribute('aria-label', `Close the recording view of ${source.title}`);
}

// Called from render(), so it must stay synchronous and free of network calls.
function syncRecordingTabs() {
  const sources = recordingSources();
  const wanted = new Set(sources.map(source => source.key));
  for (const tab of [...recordingTabs.values()])
    if (!wanted.has(tab.source.key) && !tab.pinned) destroyRecordingTab(tab);

  for (const source of sources) {
    let tab = recordingTabs.get(source.key);
    if (!tab) { tab = createRecordingTab(source); recordingTabs.set(source.key, tab); }
    describeRecordingTab(tab, source);
    if (tab.ready &&
        (tab.viewerOffset !== source.offset || tab.viewerLength !== source.length))
      postFileSourceSelection(tab);
  }

  // A pinned tab is closable exactly while no block owns its recording;
  // once one does, the canvas is what decides whether the tab exists.
  for (const tab of recordingTabs.values())
    tab.close.hidden = !tab.pinned || wanted.has(tab.source.key);

  // Keep the bar in canvas order, with tabs the canvas does not own after them.
  // Only the tab buttons are reordered: re-inserting a panel would re-insert its
  // iframe, which reloads the document inside it.
  const order = [workspaceTabs[0], workspaceTabs[1],
    ...sources.map(source => recordingTabs.get(source.key)!.entry),
    ...[...recordingTabs.values()]
      .filter(tab => !wanted.has(tab.source.key)).map(tab => tab.entry)];
  workspaceTabs.length = 0; workspaceTabs.push(...order);
  const bar = el('workspaceTabs');
  if (order.some((entry, index) => bar.children[index] !== tabContainer(entry)))
    for (const entry of order) bar.appendChild(tabContainer(entry));

  if (!workspaceTabs.some(entry => entry.id === activeWorkspaceTab))
    activateWorkspaceTab('editor');
}

// Opens the recording view for a recording nothing on the canvas refers to —
// the Recordings palette's View control and the #recording= link. The tab is
// keyed by the same '/recordings/...' path a GR World Recording would produce, so a
// recording already showing (either way) is revealed rather than duplicated.
function openRecordingPreview(recording: ExampleRecording) {
  const path = bindRemoteRecording(recording);
  const name = recording.name;
  let tab = recordingTabs.get(path);
  if (!tab) {
    const source: RecordingSource = {
      key: path, label: name.split('/').pop() || name, title: name, name,
      kind: 'remote', path, offset: 0, length: 0,
    };
    tab = createRecordingTab(source);
    recordingTabs.set(path, tab);
    describeRecordingTab(tab, source);
  }
  tab.pinned = true;
  syncRecordingTabs();          // places the tab in the bar and shows its ×
  activateWorkspaceTab(tab.entry.id);   // builds the iframe on first activation
  closePaletteDrawer();         // the drawer would be covering the tab it opened
  // Point the address bar at what is on screen, exactly as loading an example
  // does, so the link can be copied straight out of it and reloaded.
  setUrlFragment({ recording: normalizeRecordingKey(name) });
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
    if (!RECORDING_BLOCK_IDS.has(block.id) ||
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

    // The block can be deleted while the bucket index fetch below is in
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
      const file = tab.source.file;
      if (!file) {
        recordingPaneMessage(tab, tab.source.metaText !== undefined
          ? 'Choose this SigMF Source’s two files again.'
          : 'Choose the local file for this File Source again.');
        return;
      }
      // Blob URLs, not a copy of the file: the viewer reads them with the same
      // ranged requests it uses for an HTTP recording.
      dataUrl = URL.createObjectURL(file);
      // A SigMF Source brought its own metadata; everything else local gets one
      // inferred from the block, and is told so.
      metaUrl = URL.createObjectURL(new Blob(
        [tab.source.metaText ?? synthesizedSigmfMeta(tab.source, file)],
        { type: 'application/json' }));
      tab.blobUrls.push(dataUrl, metaUrl);
      if (tab.source.metaText === undefined) {
        const note = document.createElement('div'); note.className = 'rec-pane-note';
        note.textContent = `Metadata inferred from the File Source: ${tab.source.datatype}` +
          (tab.source.sampleRate ? ` at ${displaySi(tab.source.sampleRate, 'Hz')}` : ', sample rate unknown') +
          '. A local file carries no SigMF metadata.';
        tab.entry.panel.insertBefore(note, tab.status);
      }
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
    category: (block.category || '[Custom]').replace(/^\[|\]$/g, '')
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
    categoryInput = row('Category', '[Custom]', '[Custom]/Filters');
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
      category: categoryInput.value.trim() || '[Custom]',
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
  for (const block of insts) {
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
      !shouldWarnAboutUnpacedRun(insts, rateLimiterIds()))
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

async function run(): Promise<string | null> {
  if (trainingSession && !trainingSession.complete(insts, conns)) {
    const counts = trainingSession.counts(insts, conns);
    const blocks = counts.totalBlocks - counts.filledBlocks;
    const connections = counts.totalConnections - counts.filledConnections;
    log(`cannot run training flowgraph: ${blocks} block${blocks === 1 ? '' : 's'} and ` +
        `${connections} connection${connections === 1 ? '' : 's'} still to complete`);
    return null;
  }
  const errors = validateGraph().filter(issue => issue.blocking);
  if (errors.length) {
    const first = errors[0];
    log(`cannot run: ${errors.length} validation error${errors.length === 1 ? '' : 's'}`);
    for (const issue of errors) {
      const block = insts.find(inst => inst.uid === issue.uid);
      log(`  ${block?.name || block?.id || issue.uid}: ${issue.message}`);
    }
    select(first.uid);
    return null;
  }
  // Both singletons are placed automatically, so neither counts as something
  // the reader put on the canvas to run.
  if (!insts.some(i => i.id !== OPTIONS_ID && i.id !== LAYOUT_ID)) {
    log('nothing to run — add some blocks'); return null;
  }
  if (!await askToRunUnpacedFlowgraph()) {
    log('cancelled: the flowgraph has no rate limit');
    return null;
  }
  // The one thing that must happen under the Run click itself: WebUSB's
  // requestDevice() needs a user gesture, and neither the runner's constructor
  // nor its worker has one. Everything below this point may await freely; this
  // may not, so it comes before the first await that is not part of the prompt.
  for (const radio of USB_RADIOS) {
    const problem = await radio.prepare(insts);
    if (!problem) continue;
    const message = typeof problem === 'string' ? problem : problem.message;
    log(`cannot run: ${message}`);
    if (typeof problem !== 'string') showUsbPreparationProblem(problem);
    const block = insts.find(i => radio.owns(i) && i.enabled && !i.bypassed);
    if (block) select(block.uid);
    return null;
  }

  // Where a SigMF Sink writes, for the same reason: showDirectoryPicker() needs
  // a user gesture, and the runner has none. Only for a sink with no folder
  // bound yet -- a reader who chose one in the block's own Properties dialog is
  // never asked twice, and where the browser has no such API there is nothing to
  // ask for and the recording is downloaded at the end instead.
  for (const block of insts) {
    if (block.id !== SIGMF_SINK_ID || !block.enabled || block.bypassed) continue;
    if (!canPickOutputDirectory()) continue;
    const bound = block.localFileToken
      ? sigmfOutputDirsByToken.get(block.localFileToken) : undefined;
    if (bound) {
      // A handle from earlier in the session can have lost its permission.
      const state = await (bound as any).queryPermission?.({ mode: 'readwrite' });
      if (state === 'granted') continue;
      const granted = await (bound as any).requestPermission?.({ mode: 'readwrite' });
      if (granted === 'granted') continue;
      sigmfOutputDirsByToken.delete(block.localFileToken!);
    }
    try {
      const dir = await pickOutputDirectory();
      const token = block.localFileToken || newLocalFileToken();
      block.localFileToken = token;
      sigmfOutputDirsByToken.set(token, dir);
    } catch {
      // Dismissed; a blocked folder chosen and then dismissed, which throws
      // identically; or -- with a WebUSB prompt already having spent this
      // click's transient activation -- refused outright. The block's own dialog
      // has a folder button carrying its own gesture, which covers the last.
      log(`cannot run: choose a folder for "${block.name}". ` +
          `${SIGMF_OUTPUT_PICKER_HELP} You can also set it ahead of time in the ` +
          `block's properties with "Choose folder…".`);
      select(block.uid);
      return null;
    }
  }

  // Microphone permission for Audio Source, for the same reason and under the
  // same click, though with more slack than WebUSB: getUserMedia() does not
  // consume the transient activation the prompt above may already have spent,
  // it only wants the prompt to belong to something the reader did.
  const audioProblem = await prepareAudioCapture(insts);
  if (audioProblem) {
    log(`cannot run: ${audioProblem}`);
    const block = insts.find(i => i.id === AUDIO_SOURCE_ID && i.enabled && !i.bypassed);
    if (block) select(block.uid);
    return null;
  }

  // Consent for JavaScript that did not come from this session. It sits here,
  // after the USB prompt (which must be first: it needs the user gesture) and
  // before anything is fetched or bound, so a "no" costs nothing.
  const pendingJs = unacceptedJsSources();
  if (pendingJs.length && !await askToRunJavaScript(pendingJs)) {
    log('cancelled: the flowgraph’s JavaScript was not accepted');
    select(pendingJs[0].block.uid);
    return null;
  }

  const recordingFiles: RunnerInputFile[] = [];
  const fileOverrides = new Map<string, string>();
  const addedPaths = new Set<string>();
  for (const block of insts) {
    if (!block.enabled || block.bypassed) continue;

    // A hosted recording: the runner's factory derives '/recordings/<key>.sigmf-data'
    // from the block's own parameter, so all the editor owes it is the URL and
    // size to read that path through. Nothing is rewritten in the .grc.
    if (block.id === RECORDING_ID) {
      const key = String(block.params[RECORDING_PARAM] || '');
      const recording = key ? await resolveRemoteRecording(recordingDataPath(key)) : undefined;
      if (!recording) {
        log(key
          ? `cannot run: recording "${key}" for "${block.name}" is unavailable`
          : `cannot run: choose a recording for "${block.name}"`);
        select(block.uid);
        return null;
      }
      const path = recordingDataPath(key);
      if (!addedPaths.has(path)) {
        recordingFiles.push({
          kind: 'http', path, url: recording.downloadUrl, size: recording.byteLength,
        });
        addedPaths.add(path);
      }
      continue;
    }

    // A file on another origin: the browser reads it directly, so its size —
    // and with it whether the host answers ranges to this origin at all — is
    // settled here rather than in the reader worker.
    if (block.id === HTTP_RECORDING_ID) {
      const url = String(block.params[HTTP_RECORDING_PARAM] || '').trim();
      const size = url ? await publicHttpFileSize(url) : null;
      if (size === null) {
        log(url
          ? `cannot run: "${url}" for "${block.name}" is not a readable public ` +
            `HTTP(S) file (it must answer range requests and allow this origin)`
          : `cannot run: give "${block.name}" a URL`);
        select(block.uid);
        return null;
      }
      const path = HTTP_RECORDING_PREFIX + encodeURIComponent(url);
      fileOverrides.set(block.name, path);
      if (!addedPaths.has(path)) {
        recordingFiles.push({ kind: 'http', path, url, size });
        addedPaths.add(path);
      }
      continue;
    }

    // A SigMF recording on this computer: the .sigmf-data reads through the same
    // /local-files/... path a File Source's file does, with the .sigmf-meta text
    // riding alongside it so the runner can turn the recording's captures and
    // annotations into stream tags.
    if (block.id === SIGMF_SOURCE_ID) {
      const bound = block.localFileToken
        ? sigmfBindingsByToken.get(block.localFileToken) : undefined;
      if (!bound) {
        const saved = String(block.params[SIGMF_FILE_PARAM] || '');
        log(saved
          ? `cannot run: "${saved}" is not open in this session; open "${block.name}" ` +
            `and choose ${saved}${SIGMF_DATA_SUFFIX} and ${saved}${SIGMF_META_SUFFIX} ` +
            `again with Browse`
          : `cannot run: choose a recording for "${block.name}" with Browse`);
        select(block.uid);
        return null;
      }
      const path = `/local-files/${block.localFileToken}/` +
        `${encodeURIComponent(bound.base)}${SIGMF_DATA_SUFFIX}`;
      fileOverrides.set(block.name, path);
      if (!addedPaths.has(path)) {
        recordingFiles.push({
          kind: 'local', path, file: bound.data, meta: bound.metaText,
        });
        addedPaths.add(path);
      }
      continue;
    }

    // Writing a recording. The destination is a folder handle where the browser
    // has one and nothing at all where it does not; the runner's writer worker
    // buffers and downloads in the second case, which is why an unbound sink is
    // not an error here the way an unbound source is.
    if (block.id === SIGMF_SINK_ID) {
      const base = sanitizeSigmfBase(String(block.params[SIGMF_FILE_PARAM] || ''));
      if (!base) {
        log(`cannot run: give "${block.name}" a recording name`);
        select(block.uid);
        return null;
      }
      const token = block.localFileToken || block.uid;
      const dir = block.localFileToken
        ? sigmfOutputDirsByToken.get(block.localFileToken) ?? null : null;
      const path = `${SIGMF_OUTPUT_PREFIX}${token}/${encodeURIComponent(base)}`;
      fileOverrides.set(block.name, path);
      if (!addedPaths.has(path)) {
        recordingFiles.push({ kind: 'output', path, base, dir });
        addedPaths.add(path);
      }
      if (!dir)
        log(`note: "${block.name}" will download ${sigmfSinkFileNames(base).join(' and ')} ` +
            `when the flowgraph stops; the recording is held in memory until then`);
      continue;
    }

    const fileParam = LOCAL_FILE_PARAMS[block.id];
    if (!fileParam) continue;
    const savedPath = String(block.params[fileParam] || '');
    if (block.localFileToken) {
      const file = localFilesByToken.get(block.localFileToken);
      if (!file) {
        log(`cannot run: choose the local file for "${block.name}" again`);
        select(block.uid);
        return null;
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
        return null;
      }
      continue;
    }

    // File Source opens a file on this computer and nothing else, exactly as
    // native GNU Radio's does; a .grc keeps only the file's name, so a session
    // that has not picked it has nothing to open. Hosted recordings are GR
    // World Recording's job.
    if (!savedPath) {
      log(`cannot run: choose a file for "${block.name}" with Browse`);
    } else {
      log(`cannot run: no local file is bound to "${block.name}"; ` +
          `open its properties and choose "${savedPath}" with Browse, ` +
          `or use GR World Recording for a hosted recording`);
    }
    select(block.uid);
    return null;
  }
  for (const file of recordingFiles) {
    if (file.kind === 'local' && file.file.size === 0) {
      const block = insts.find(item => fileOverrides.get(item.name) === file.path);
      log(`cannot run: local file for "${block?.name || 'File Source'}" is empty`);
      if (block) select(block.uid);
      return null;
    }
    if (file.kind === 'http' && file.size === 0) {
      const block = insts.find(item => item.id === RECORDING_ID &&
        recordingSourceFor(item)?.path === file.path);
      log(`cannot run: recording for "${block?.name || 'GR World Recording'}" is empty`);
      if (block) select(block.uid);
      return null;
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
  // Claims the frame: a previous stop() still finishing a recording will see
  // this and leave the new run alone.
  ++runGeneration;
  frame.src = url;
  const doc = buildGrcDoc();
  log('▶ running ' + doc.blocks.length + ' blocks, ' + doc.connections.length + ' connections');
  runningGraphSnapshot = JSON.stringify(snapshot());
  return token;
}

// A flowgraph that writes a recording has to be brought down before its frame
// is unloaded. Unloading kills the writer worker with the tail of the capture
// still in shared memory -- and, where the browser buffers rather than streams,
// with the whole of it -- so the runner is asked to stop the flowgraph properly
// and given a bounded time to say it has. Everything else stops the way it
// always has, instantly.
const SHUTDOWN_TIMEOUT_MS = 20000;

function runnerNeedsGracefulStop(): boolean {
  return insts.some(i => i.id === SIGMF_SINK_ID && i.enabled && !i.bypassed);
}

function requestRunnerShutdown(frame: HTMLIFrameElement): Promise<void> {
  const target = frame.contentWindow;
  if (!target) return Promise.resolve();
  return new Promise<void>(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.removeEventListener('message', onMessage);
      clearTimeout(timer);
      resolve();
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== target || event.origin !== location.origin) return;
      if (event.data?.type === 'gr-shutdown-done') finish();
    };
    window.addEventListener('message', onMessage);
    const timer = setTimeout(() => {
      log('note: the flowgraph did not stop cleanly; the recording may be truncated');
      finish();
    }, SHUTDOWN_TIMEOUT_MS);
    target.postMessage({ type: 'gr-shutdown' }, location.origin);
  });
}

// Which run the frame is showing. Only the deferred unload below needs it: a
// reader who presses Run again while a recording is still being finished must
// not have the *new* run's frame blanked out from under them.
let runGeneration = 0;

function stop() {
  const frame = el('runFrame') as HTMLIFrameElement;
  // Started before anything else, because it reads `insts` -- and one caller
  // (loadFlowgraphAnimated) replaces the canvas the moment this returns.
  const finishing = runnerNeedsGracefulStop() ? requestRunnerShutdown(frame) : null;
  const generation = runGeneration;

  if (pendingRunnerToken) {
    pendingRunnerRecordings.delete(pendingRunnerToken);
    pendingRunnerToken = null;
  }
  // The UI returns to the editor at once either way. loadFlowgraphAnimated
  // depends on that being synchronous: its fly-in cannot measure a hidden canvas.
  frame.hidden = true;
  el('runEmpty').hidden = false;
  setRunnerRunning(false);
  activateWorkspaceTab('editor');

  const unload = () => {
    // Only if this is still the run we were asked to stop.
    if (generation !== runGeneration) return;
    frame.src = 'about:blank';   // unloading the iframe stops its WASM workers
    log('■ flowgraph stopped');
  };
  if (finishing) {
    // Hidden, but still running: the writer worker needs the frame alive to
    // flush the tail of the recording and write the .sigmf-meta.
    log('■ finishing the recording…');
    void finishing.then(unload);
  } else {
    unload();
  }
}

// ---- Palette ----
// ---- GRC-style block tree (collapsible categories + search) ----
interface LibraryBlock {
  id: string; label: string; runnable: boolean; unavailableReason?: string; module: string;
  // Its work() is JavaScript rather than C++ — a repo block carrying `flags: [js]`,
  // the inline JS Block, or one saved into this browser's library. The palette
  // badges these, because "I could read and change this one" is a real difference
  // to a user and nothing else on the row conveys it.
  js?: boolean;
  // A JS block saved in this browser (editor/src/js-block.ts). Its instances are
  // ordinary wasm_js_block instances carrying the source inline, so a flowgraph
  // shared as a link works for someone who does not have this library.
  localJs?: LocalJsBlock;
}
// Blocks whose factory builds a QWidget, and so take a tile in the runner
// window's GUI Layout grid. Filled from the generated library's `gui` flag,
// which each block declares as `gui: true` in its overlay (or, for a runner-only
// block, its own yml) -- the C++ decides this, and the editor has no way to work
// it out for itself.
const GUI_BLOCK_IDS = new Set<string>();
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
      localJs: b.localJs,
      js: !!b.localJs || b.id === JS_BLOCK_ID || blockFlags(b.flags).includes('js'),
    });
  }
  return root;
}
const matchesQ = (b: { id: string; label: string }, q: string) => !q || (b.label + ' ' + b.id).toLowerCase().includes(q);
function catMatches(node: Cat, q: string): boolean {
  return !q || node.blocks.some(b => matchesQ(b, q)) || [...node.subs.values()].some(s => catMatches(s, q));
}

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
// One level of block-tree indent, and the extra a leaf carries so it lines up
// past its category's `.tri` (22px wide plus the row's 4px gap).
const TREE_INDENT = 16;
const TOP_PALETTE_CATEGORY = 'Supported SDRs';
function comparePaletteCategories(a: Cat, b: Cat, depth: number): number {
  if (depth === 0) {
    if (a.name === TOP_PALETTE_CATEGORY) return -1;
    if (b.name === TOP_PALETTE_CATEGORY) return 1;
  }
  return a.name.localeCompare(b.name);
}
function renderTree(node: Cat, container: HTMLElement, depth: number, q: string) {
  for (const s of [...node.subs.values()].sort(
    (a, b) => comparePaletteCategories(a, b, depth))) {
    if (!catMatches(s, q)) continue;
    const kids = makeCatRow(s.name, container, !!q || (depth === 0 && s.name === 'Core'),
                            false, 6 + depth * TREE_INDENT);
    renderTree(s, kids, depth + 1, q);
  }
  for (const b of [...node.blocks].filter(b => matchesQ(b, q)).sort((a, b) => a.label.localeCompare(b.label)))
    container.appendChild(makeBlockItem(b, 6 + depth * TREE_INDENT + 20));
}

let LIB: any = { blocks: [] };
let activatePaletteTab: ((which: 'blocks' | 'examples' | 'recordings') => void) | null = null;

// Every palette tab's search box: the input plus the sticky bar that keeps it
// pinned to the top of the panel while the list under it scrolls. The bar is a
// separate element rather than a sticky input because it has to carry the panel
// background — an input's own margin is transparent, so rows would scroll
// through the gap around it. `.paltab-panel` is the scroll container, so
// `top:0` is measured against the tab's own viewport.
function makePaletteSearch(placeholder: string, ariaLabel: string):
    { bar: HTMLElement; input: HTMLInputElement } {
  const bar = document.createElement('div'); bar.className = 'palsearch-bar';
  const input = document.createElement('input');
  input.className = 'palsearch'; input.placeholder = placeholder;
  input.setAttribute('aria-label', ariaLabel);
  bar.append(input);
  return { bar, input };
}
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
    tree.textContent = '';
    // The browser-local JS blocks join the generated library rather than living
    // in a tab of their own: a block someone wrote should be findable exactly
    // where every other block is.
    renderTree(buildTree([...(LIB.blocks || []), ...localJsPaletteEntries()]), tree, 0, q);
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
  const { bar: searchBar, input: search } =
    makePaletteSearch('Search examples…', 'Search example flowgraphs');
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

  status.remove(); panel.append(searchBar, bar, list, noMatch);
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
          closePaletteDrawer();
          trustExampleJavaScript(fg);
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
    conns.push({ from: block.uid, fp: 0, to: converter.uid, tp: 0 });
    selectedBlocks = new Set([block.uid, converter.uid]);
    selected = converter.uid;
    selectedConnection = null;
    render();
    recordHistory();
    log(`added streaming GR World Recording and IShort To Complex for "${recording.name}"`);
    return;
  }

  render();
  recordHistory();
  log(`added streaming GR World Recording for "${recording.name}"`);
}

function makeRecordingItem(recording: ExampleRecording): HTMLElement {
  const item = document.createElement('article'); item.className = 'rec-item';
  item.tabIndex = 0; item.setAttribute('role', 'button');
  const head = document.createElement('div'); head.className = 'rec-head';
  const title = document.createElement('div'); title.className = 'rec-title';
  // The containing directory rows already show the relative path. Keep the
  // card itself to the recording's basename instead of repeating that path.
  title.textContent = recording.name.split('/').filter(Boolean).pop() || recording.name;
  // View and the copy-link button open the recording view without touching the
  // canvas, so they are offered even for a datatype GR World Recording cannot
  // represent — that recording is otherwise not viewable here at all. Both stop
  // propagation: clicking one must not also drop a block on the canvas.
  const view = document.createElement('button'); view.className = 'rec-view';
  view.type = 'button'; view.textContent = 'View';
  view.title = `Open the recording view of "${recording.name}" without adding it to the flowgraph`;
  view.setAttribute('aria-label', `View recording ${recording.name}`);
  view.onclick = event => { event.stopPropagation(); openRecordingPreview(recording); };
  // A word rather than the examples tab's 🔗: a color emoji ignores `color`, and
  // these two read as a pair only if they are the same blue.
  const link = document.createElement('button'); link.className = 'rec-link';
  link.type = 'button'; link.textContent = 'Link';
  link.title = `Copy a link to this recording (${recordingUrl(recording.name)})`;
  link.setAttribute('aria-label', `Copy a link to recording ${recording.name}`);
  link.onclick = event => { event.stopPropagation(); void copyRecordingUrl(recording.name); };
  head.append(title, view, link);
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
    // Clicking a link must not also drop a block on the canvas.
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
    // The only badge left: what the card cannot do. That clicking it adds the
    // recording to the flowgraph needs no label.
    const badge = document.createElement('span'); badge.className = 'rec-badge';
    badge.textContent = 'Unsupported';
    head.append(badge);
    item.setAttribute('aria-disabled', 'true');
    item.title = `GR World Recording cannot directly represent ${recording.datatype || 'this datatype'}`;
    return item;
  }

  const useRecording = async () => {
    try {
      closePaletteDrawer();
      await addRecordingBlock(recording, format);
    } catch (error) {
      log(`recording "${recording.name}" could not be added: ${error}`);
    }
  };
  item.onclick = () => { void useRecording(); };
  item.onkeydown = event => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    // The download links and the View / copy-link buttons act for themselves.
    if ((event.target as HTMLElement)?.closest('a,button')) return;
    event.preventDefault(); void useRecording();
  };
  return item;
}


// One searchable row of the recordings tab. `text` is everything the search box
// matches against, lowercased: the full key (so a collection prefix such as
// "estevez/" narrows by itself), plus the author and datatype shown on the card.
// Unlike an example, all of it is known from the index up front — nothing here
// has to wait on a fetch.
interface RecordingEntry { item: HTMLElement; text: string }

function recordingSearchText(recording: ExampleRecording): string {
  return [recording.name, recording.author, recording.datatype]
    .filter(Boolean).join(' ').toLowerCase();
}

function renderRecordingTree(directory: RecordingDirectory, container: HTMLElement,
                             entries: RecordingEntry[]) {
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
    renderRecordingTree(child, contents, entries);
    details.append(summary, contents);
    container.append(details);
  }
  for (const recording of [...directory.recordings].sort((a, b) => byName(a.name, b.name))) {
    const item = makeRecordingItem(recording);
    container.append(item);
    entries.push({ item, text: recordingSearchText(recording) });
  }
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

  // Search box, matching the Blocks and Example Flowgraphs tabs: every
  // whitespace-separated term has to be found, so "estevez ci16" narrows by
  // collection and datatype at once.
  const { bar: searchBar, input: search } =
    makePaletteSearch('Search recordings…', 'Search SigMF recordings');
  const noMatch = document.createElement('div'); noMatch.className = 'ex-empty'; noMatch.hidden = true;
  const entries: RecordingEntry[] = [];
  let terms: string[] = [];

  const refresh = () => {
    const q = terms.join(' ');
    let shown = 0;
    for (const entry of entries) {
      const hit = terms.every(t => entry.text.includes(t));
      entry.item.hidden = !hit;
      if (hit) shown++;
    }
    // A directory stays visible when any descendant is visible, and a search
    // opens the matching paths so a hit is never buried in a collapsed one.
    // Innermost first, so an outer directory sees its children's final state.
    const directories = [...list.querySelectorAll<HTMLDetailsElement>('.rec-directory')].reverse();
    for (const details of directories) {
      const contents = details.querySelector<HTMLElement>(':scope > .rec-directory-contents');
      const hasVisibleChild = !!contents && [...contents.children]
        .some(child => !(child as HTMLElement).hidden);
      details.hidden = !hasVisibleChild;
      if (q && hasVisibleChild) details.open = true;
    }
    if (q) noMatch.textContent = `No SigMF recording matches “${q}”.`;
    noMatch.hidden = !q || shown > 0;
  };
  const onQuery = () => {
    terms = search.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    refresh();
  };
  search.oninput = onQuery;
  search.onkeydown = e => {
    if (e.key === 'Escape' && search.value) { e.stopPropagation(); search.value = ''; onQuery(); }
  };

  status.remove(); panel.append(searchBar, list, noMatch);
  renderRecordingTree(buildRecordingTree(recordings), list, entries);
  refresh();
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
    const hidden = new Set(insts.filter(inst => VARIABLE_IDS.has(inst.id)).map(inst => inst.uid));
    selectedBlocks = new Set([...selectedBlocks].filter(uid => !hidden.has(uid)));
    if (selected && hidden.has(selected)) selected = [...selectedBlocks].pop() || null;
    if (selectedConnection && (hidden.has(selectedConnection.from) || hidden.has(selectedConnection.to)))
      selectedConnection = null;
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
  hoveredPortKey = null;
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
let openAiWhenReady = false;
function toggleAiPanel() {
  if (aiPanel) aiPanel.toggle();
  else openAiWhenReady = true;
}

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
      enabled?: () => boolean; check?: () => boolean; danger?: boolean };
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
    { label: 'Flowgraph Copilot', run: toggleAiPanel },
    'sep',
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
    { label: 'About', run: showAboutDialog },
  ] },
];

function buildMenuDrop(items: (MenuItem | 'sep')[]): HTMLElement {
  const drop = document.createElement('div');
  drop.className = 'menu-drop';
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
    const key = document.createElement('span'); key.className = 'mi-key'; key.textContent = it.key || '';
    row.appendChild(key);
    if (it.reason) { row.classList.add('disabled'); attachTip(row, it.reason); }
    else if (it.enabled && !it.enabled()) { row.classList.add('disabled'); }
    else row.addEventListener('click', e => { e.stopPropagation(); closeMenus(); it.run && it.run(); });
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
document.addEventListener('pointerdown', e => {
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
  { icon: '🔍+', label: 'Zoom In', key: 'Ctrl++', run: () => setZoom(zoom * ZOOM_STEP) },
  { icon: '🔍−', label: 'Zoom Out', key: 'Ctrl+-', run: () => setZoom(zoom / ZOOM_STEP) },
  { icon: '✨', label: 'Flowgraph Copilot', run: toggleAiPanel },
];
function buildToolbar() {
  const bar = el('toolbar'); bar.textContent = '';
  for (const t of TOOLBAR) {
    if (t === 'sep') { bar.appendChild(Object.assign(document.createElement('div'), { className: 'tsep' })); continue; }
    const b = document.createElement('button'); b.className = 'tbtn'; b.textContent = t.icon;
    b.setAttribute('aria-label', t.label);
    // What the narrow layout orders the bar by: too many tools to fit a phone,
    // so editor.css pulls Execute and Kill to the front of the scroll.
    b.dataset.tool = t.label;
    if (t.reason) { b.classList.add('disabled'); b.setAttribute('aria-disabled', 'true'); attachTip(b, t.reason); }
    else { b.title = t.label + (t.key ? ` (${t.key})` : ''); b.onclick = () => t.run && t.run(); }
    bar.appendChild(b);
  }
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
    });
  }
  for (const [id, def] of Object.entries(RUNNABLE)) {
    if (PALETTE_HIDDEN.has(id) || generated.has(id)) continue;
    generated.set(id, { id, label: def.label, category: 'Core / Editor' });
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
  const block = insts.find(item => item.name === name);
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

function restoreAiSnapshot(state: GraphSnapshot, record: boolean): void {
  insts = clone(state.insts);
  conns = clone(state.conns);
  counter = state.counter;
  selected = null; selectedBlocks.clear(); selectedConnection = null; cancelConnect();
  render();
  if (record) recordHistory();
}

function aiAuthorization(): Promise<RunAuthorization | null> {
  const tx = insts.find(block => block.enabled && !block.bypassed &&
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
      if (!await radio.needsGesture(insts)) continue;
      return {
        title: `This flowgraph opens a ${radio.name}.`,
        detail: 'The browser needs a hardware permission click before the visible run can start.',
        button: 'Allow & Run',
      };
    }
    return null;
  })();
}

function aiToolDependencies(): Omit<AiToolDeps, 'runFlowgraph'> {
  return {
    blocks: () => insts,
    connections: () => conns,
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
        if (insts.some(item => item !== block && item.name === requestedName)) {
          insts = insts.filter(item => item !== block);
          throw new Error(`a block named "${requestedName}" already exists`);
        }
        block.name = requestedName;
      }
      render();
      return block;
    },
    removeBlock: name => {
      const block = aiBlock(name);
      if (block.id === OPTIONS_ID || block.id === LAYOUT_ID)
        throw new Error(`${block.name} is a required singleton and cannot be removed`);
      deleteBlocks(new Set([block.uid]), false);
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
      conns = conns.filter(connection => !(connection.to === to.uid && connection.tp === tp));
      conns.push({ from: from.uid, fp, to: to.uid, tp });
      render();
    },
    disconnect: (fromName, output, toName, input) => {
      const from = aiBlock(fromName), to = aiBlock(toName);
      const fp = aiPortIndex(from, 'out', output), tp = aiPortIndex(to, 'in', input);
      const length = conns.length;
      conns = conns.filter(connection => !(connection.from === from.uid &&
        connection.fp === fp && connection.to === to.uid && connection.tp === tp));
      if (conns.length === length) throw new Error('that connection does not exist');
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
    listExamples: async () => {
      const response = await fetch('/example_flowgraphs');
      if (!response.ok) throw new Error(`example listing failed (${response.status})`);
      const files = await response.json();
      return Array.isArray(files) ? files.map(String).sort() : [];
    },
    readExample: async path => {
      const response = await fetch('/example_flowgraphs/' + encodeExamplePath(path));
      if (!response.ok) throw new Error(`example "${path}" could not be read (${response.status})`);
      return response.text();
    },
  };
}

function initializeAiPanel(): void {
  const harness: Omit<HarnessDeps, 'requestAuthorization'> = {
    run,
    frame: () => el('runFrame') as HTMLIFrameElement,
    blocks: () => insts,
    authorization: aiAuthorization,
    subscribeLogs: subscriber => {
      logSubscribers.add(subscriber);
      return () => logSubscribers.delete(subscriber);
    },
  };
  aiPanel = createAiPanel({
    openDialog, log, systemPrompt: aiSystemPrompt, entries: aiCatalogEntries,
    toolDeps: aiToolDependencies(), harness,
    snapshot,
    commitHistory: recordHistory,
    restoreSnapshot: restoreAiSnapshot,
  });
  if (openAiWhenReady) { openAiWhenReady = false; aiPanel.open(); }
}

buildMenuBar();
buildToolbar();
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
