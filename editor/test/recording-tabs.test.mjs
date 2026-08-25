// Recording tabs: one workspace tab per block with a recording behind it -- a GR
// World Recording, a SigMF Source, or a File Source bound to a local file -- each holding the
// built-in recording view for whatever that block reads. The properties worth pinning are
// the ones a browser test would take minutes to notice and a reader would take
// even longer: that drawing the tabs never touches the network, that the iframe
// is built only when the tab is opened, and that a tab going away takes its blob
// URLs with it.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  mainSource,
  recordingTabsSource,
  canvasRendererSource,
  workspaceTabsSource,
  markupSource as html,
} from './editor-contract-source.mjs';

// Put the controller first so the ordered `between()` checks stay scoped to
// its implementation; append the integration modules for cross-boundary wiring.
const recordingController = recordingTabsSource.replace(/^  /gm, '');
const source = [recordingController, mainSource, canvasRendererSource, workspaceTabsSource].join('\n');

const timeSelector = await readFile(new URL(
  '../src/recording/pages/recording-view/components/time-selector.tsx', import.meta.url), 'utf8');
const recordingView = await readFile(new URL(
  '../src/recording/pages/recording-view/recording-view.tsx', import.meta.url), 'utf8');

const between = (from, to) => {
  const start = source.indexOf(from);
  assert.notEqual(start, -1, `${from} not found in main.ts`);
  const end = source.indexOf(to, start);
  assert.notEqual(end, -1, `${to} not found after ${from}`);
  return source.slice(start, end);
};

// ---- the tab set is derived from the canvas, on every render ----------------
assert.match(source, /updateCanvasExtent\(\);\s*\n\s*syncRecordingTabs\(\);/,
  'render() rebuilds the recording tabs, so every mutation path keeps them current');

const sources = between('function recordingSources()', '\nfunction createRecordingTab');
assert.match(sources, /!RECORDING_BLOCK_IDS\.has\(block\.id\)/,
  'recording tabs come from the blocks that can have a recording behind them');
assert.match(source,
  /const RECORDING_BLOCK_IDS = new Set\(\['blocks_file_source', SIGMF_SOURCE_ID, RECORDING_ID\]\)/,
  'those blocks are File Source (raw local samples), SigMF Source (a local SigMF ' +
  'recording) and GR World Recording (a hosted one)');
assert.match(sources, /seen\.has\(source\.key\)/,
  'two blocks reading the same recording share one tab');

const sourceFor = between('function recordingSourceFor', '\nfunction recordingSources');
assert.match(sourceFor, /if \(!file\) return null;/,
  'a local file lost with the session (its File is gone) gets no tab');
assert.match(sourceFor, /if \(!block\.localFileToken\) return null;/,
  'a File Source that has picked no file gets no tab: a .grc keeps only a name');
assert.match(sourceFor, /path = recordingDataPath\(String\(block\.params\[RECORDING_PARAM\] \|\| ''\)\)/,
  "a remote tab is keyed from the block's own recording key, so drawing it needs no index fetch");
assert.match(sourceFor, /catch \{ return null; \}/,
  'a GR World Recording with no recording chosen yet gets no tab');

// A SigMF Source is the one local block whose recording describes itself, so its
// tab is driven by the real .sigmf-meta instead of synthesizedSigmfMeta() --
// which is what puts the recording's own annotations on the spectrogram.
assert.match(sourceFor, /if \(block\.id === SIGMF_SOURCE_ID\) \{[\s\S]*?metaText: bound\.metaText,/,
  "a SigMF Source's tab carries the recording's own metadata");
assert.match(sourceFor, /const bound = sigmfBindingsByToken\.get\(block\.localFileToken\);\s*\n\s*if \(!bound\) return null;/,
  'a SigMF recording picked in a previous session gets no tab: the Files are gone');
assert.match(source,
  /\[tab\.source\.metaText \?\? synthesizedSigmfMeta\(tab\.source, file\)\]/,
  'real metadata wins over inferred metadata; everything else local still infers');
assert.match(source, /if \(tab\.source\.metaText === undefined\) \{[\s\S]*?Metadata inferred from the File Source/,
  'only an inferred tab says its metadata was inferred');

// ---- ...except a pinned tab, which no block on the canvas owns --------------
// The Recordings palette's View control and the #recording= link both open a
// recording view with nothing on the canvas behind it. Such a tab has to survive
// the sync that rebuilds every other one, and be closable by hand instead.
assert.match(source, /if \(!wanted\.has\(tab\.source\.key\) && !tab\.pinned\) destroyRecordingTab\(tab\)/,
  'only a tab the canvas owns is destroyed when its block goes away');
assert.match(source, /tab\.close\.hidden = !tab\.pinned \|\| wanted\.has\(tab\.source\.key\)/,
  'a tab is closable exactly while no block owns its recording');

const preview = between('function openRecordingPreview', '\n// A local file is a bare stream');
assert.match(preview, /const path = bindRemoteRecording\(recording\);[\s\S]*?recordingTabs\.get\(path\)/,
  'a preview keys its tab by the same /recordings/ path a GR World Recording would, so it is never duplicated');
assert.match(preview, /tab\.pinned = true;/, 'a previewed recording survives syncRecordingTabs()');
assert.match(preview, /setUrlFragment\(\{ recording: normalizeRecordingKey\(name\) \}\)/,
  'viewing a recording points the address bar at it, as loading an example does');

const close = between('function closeRecordingTab', '\n// Called from render()');
assert.match(close, /recordingSources\(\)\.some\(source => source\.key === tab\.source\.key\)/,
  'closing a tab a block has meanwhile claimed unpins it rather than destroying it');
assert.match(source, /function recordingKeyOf[\s\S]*?tab\.source\.kind === 'remote' \? tab\.source\.name : null/,
  'a locally picked file exists only for this session, so it is not linkable');

// A tab button cannot contain the close button: nesting one button inside
// another is invalid, and the × has to be clickable and hidable on its own.
assert.match(source, /class="workspace-tab-group"|className = 'workspace-tab-group'/,
  'a recording tab is a group of its button and a sibling close button');
assert.match(source, /export function tabContainer\(entry: WorkspaceTabEntry\): HTMLElement/,
  'the tab bar orders and removes containers, so a grouped tab moves with its close button');
assert.match(source, /if \(event\.key === 'Delete' \|\| event\.key === 'Backspace'\)[\s\S]*?this\.deps\.closeRecording\(this\.deps\.recordingKey\(entry\.id\)\)/,
  'the close button is out of the tab order, so Delete on the focused tab closes it');

// ---- deep link: #recording=<base key>, alongside #example= ------------------
assert.match(source, /const FRAGMENT_KEYS = \['example', 'recording'\] as const/,
  'the fragment names the flowgraph and the open recording independently');
const fragment = between('function setUrlFragment', '\nfunction setExampleHash');
assert.match(fragment, /const value = key in patch \? patch\[key\] : current\.get\(key\)/,
  'setting one fragment key preserves the other');
assert.match(fragment, /encodeRecordingPath\(value\) : encodeURIComponent\(value\)/,
  'a recording key keeps its readable separators, so a copied link stays legible');
assert.match(source, /async function openRecordingFromUrl[\s\S]*?loadExampleRecordings\(\)\)\.find\(entry => entry\.name === name\)/,
  '#recording= resolves against the live bucket index');
assert.match(source, /const loaded = await loadFlowgraphFromUrl\(\);\s*\n\s*const opened = await openRecordingFromUrl\(\);\s*\n\s*if \(!loaded && !opened\)/,
  'a link naming only a recording leaves the canvas empty instead of loading the default example');

// ---- nothing is fetched until a recording tab is opened ---------------------
// Comments explain the rule; the code has to follow it.
const code = text => text.replace(/^\s*\/\/.*$/gm, '');
const sync = between('function syncRecordingTabs()', '\n// Opens the recording view');
for (const forbidden of ['fetch(', 'iframe', 'createObjectURL', 'await']) {
  assert.ok(!code(sync).includes(forbidden),
    `syncRecordingTabs() must stay synchronous and offline (found "${forbidden}")`);
}
const create = between('function createRecordingTab', '\nfunction destroyRecordingTab');
assert.ok(!code(create).includes('iframe'),
  'creating a tab must not create its iframe: that is what defers the viewer download');
assert.match(source, /if \(this\.deps\.isRecordingTab\(tab\)\)\s*void this\.deps\.openRecording\(this\.deps\.recordingKey\(tab\)\)/,
  'the iframe is built when the tab is activated, not before');

const open = between('async function openRecordingPane', '\n// ---- Vertical splitter');
assert.match(open, /if \(!tab \|\| tab\.frame \|\| tab\.opening\) return;/,
  'a tab already open (or opening) is never loaded a second time, so revisiting refetches nothing');
assert.match(open, /frame\.src = recordingViewUrl\(metaUrl, dataUrl, tab\.source\.name\)/,
  "the pane frames the viewer's 'url' data source route, the same one the recordings palette builds");
assert.match(open, /recordingTabs\.get\(key\) !== tab\) return;/,
  'a recording block deleted mid-load must not leave an orphaned frame or blob URL behind');

// ---- time selection updates the associated block ---------------------------
assert.match(timeSelector, /type: 'gr-recording-selection'[\s\S]*?offset:[\s\S]*?length:/,
  'the recording time selector must send its offset and length to the editor');
assert.match(timeSelector, /window\.parent\.postMessage\([\s\S]*?window\.location\.origin/,
  'selection updates must be restricted to the recording view origin');
const selection = between('function applyRecordingSelection', '\nasync function openRecordingPane');
assert.match(source, /function recordingTabForMessage[\s\S]*?event\.origin !== location\.origin/,
  'the editor must reject cross-origin selection messages');
assert.match(source, /function recordingTabForMessage[\s\S]*?candidate\.frame\?\.contentWindow === event\.source/,
  'the editor must associate a selection message with its sending recording tab');
assert.match(selection, /!RECORDING_BLOCK_IDS\.has\(block\.id\)/,
  'selection updates must only modify blocks that read a recording');
assert.match(selection, /recordingSourceFor\(block\)\?\.key !== tab\.source\.key/,
  'selection updates must only modify the blocks associated with that recording');
assert.match(selection, /block\.params\.offset = offset;[\s\S]*?block\.params\.length = length;/,
  'the associated block must receive both sample parameters');
assert.match(selection, /render\(\);\s*recordHistory\(\);/,
  'selection changes must redraw the block and participate in undo history');

assert.match(source, /type: 'gr-file-source-selection', offset, length/,
  'the editor must send File Source selection parameters into the recording view');
assert.match(source, /d\.type === 'gr-recording-ready'[\s\S]*?recordingTabsController\.handleReady/,
  'the editor must delegate recording-view readiness to the tab controller');
assert.match(source, /handleReady\(event: MessageEvent\)[\s\S]*?postFileSourceSelection\(tab\)/,
  'the editor must initialize the cursor after the recording view is ready');
assert.match(source, /tab\.viewerOffset !== source\.offset \|\| tab\.viewerLength !== source\.length/,
  'later File Source parameter edits must be synchronized into an open recording view');
assert.match(recordingView, /data\?\.type !== 'gr-file-source-selection'/,
  'the recording view must listen for File Source selection updates');
assert.match(recordingView, /const enabled = offset !== 0 \|\| length !== 0;/,
  'only a zero-offset, zero-length File Source may leave the time cursor disabled');
assert.match(recordingView, /const openEnded = offset !== 0 && length === 0;[\s\S]*?openEnded \? totalSamplesRef\.current : offset \+ length/,
  'a zero length at a nonzero offset must extend to the recording end');
assert.match(recordingView, /setCursorTimeFromFileSource\(\{ start: offset, end \}, openEnded\)/,
  'the cursor must retain whether its recording-end selection represents GNU Radio length zero');
assert.match(timeSelector, /length: cursorTimeOpenEnded \? 0 :/,
  'an open-ended cursor must preserve File Source length zero when synchronized back');
assert.match(recordingView, /if \(enabled\) setCurrentFFT\(Math\.floor\(offset \/ fftSizeRef\.current\)\)/,
  'an initialized selection must be scrolled into view');

// ---- local files: synthesized SigMF over blob: URLs -------------------------
assert.match(open, /dataUrl = URL\.createObjectURL\(file\)/,
  'a local file is read through a blob URL, which the viewer range-requests like any other');
const meta = between('function synthesizedSigmfMeta', '\nfunction recordingPaneMessage');
assert.match(meta, /'core:datatype': datatype/);
assert.match(meta, /'traceability:sample_length'/,
  'supplying the sample count spares the viewer a HEAD request a blob URL cannot answer');
assert.match(meta, /if \(source\.sampleRate\) global\['core:sample_rate'\]/,
  'the sample rate is omitted rather than guessed when the flowgraph has no samp_rate');
assert.match(open, /rec-pane-note/,
  'an inferred-metadata banner distinguishes a synthesized recording from a real one');

const datatypes = between('const FILE_SOURCE_DATATYPES', 'const SIGMF_SAMPLE_BYTES');
for (const [type, datatype] of [['complex', 'cf32_le'], ['float', 'rf32_le'], ['int', 'ri32_le'],
                                ['short', 'ri16_le'], ['byte', 'ri8']])
  assert.match(datatypes, new RegExp(`${type}: '${datatype}'`),
    `File Source type "${type}" maps to SigMF ${datatype}`);
assert.match(datatypes, /blocks_interleaved_short_to_complex: \{ from: 'short', datatype: 'ci16_le' \}/,
  'a short source feeding IShort To Complex is interleaved complex, as the recordings tab builds it');

// ---- teardown ---------------------------------------------------------------
const destroy = between('function destroyRecordingTab', '\n// The linkable form');
assert.match(destroy, /for \(const url of tab\.blobUrls\) URL\.revokeObjectURL\(url\)/,
  'a removed tab releases the blob URLs holding its local file');
assert.match(destroy, /tab\.entry\.panel\.remove\(\)/,
  'removing the panel drops the iframe, and with it the viewer and its fetches');
assert.match(destroy, /recordingHashKey\(\) === recordingKeyOf\(tab\)[\s\S]*?setUrlFragment\(\{ recording: null \}\)/,
  'the URL must stop naming a recording whose tab is gone');
assert.match(destroy, /if \(workspaceTabController\.active === tab\.entry\.id\) activateWorkspaceTab\('editor'\)/,
  'closing the tab in view falls back to the Editor');
assert.match(sync, /if \(!workspaceTabs\.some\(entry => entry\.id === workspaceTabController\.active\)\)\s*\n?\s*activateWorkspaceTab\('editor'\)/,
  'deleting the block of the tab in view falls back to the Editor');
assert.match(sync, /Only the tab buttons are reordered/,
  'panels are never re-inserted: moving an iframe in the DOM reloads the document inside it');

// ---- presentation -----------------------------------------------------------
assert.match(html, /\.recording-pane:not\(\.active\) \{ visibility:hidden; \}/,
  'inactive recording panes hide with visibility, not display:none, which would resize the viewer to nothing');
assert.match(html, /\.workspace-tab-label \{[^}]*text-overflow:ellipsis/,
  'a long recording name is ellipsized rather than stretching the tab bar');
assert.match(html, /#workspaceTabs \{[^}]*overflow-x:auto/,
  'many recordings scroll the tab bar instead of squeezing the fixed tabs');

console.log('checked per-block recording tabs and their lazy recording-view panes');
