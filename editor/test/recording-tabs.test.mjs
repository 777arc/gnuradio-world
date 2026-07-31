// Recording tabs: one workspace tab per File Source, each holding the IQEngine
// recording view for whatever that block reads. The properties worth pinning are
// the ones a browser test would take minutes to notice and a reader would take
// even longer: that drawing the tabs never touches the network, that the iframe
// is built only when the tab is opened, and that a tab going away takes its blob
// URLs with it.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');

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
assert.match(sources, /block\.id !== 'blocks_file_source'/,
  'recording tabs come from File Source blocks');
assert.match(sources, /seen\.has\(source\.key\)/,
  'two File Sources reading the same recording share one tab');

const sourceFor = between('function recordingSourceFor', '\nfunction recordingSources');
assert.match(sourceFor, /if \(!file\) return null;/,
  'a local file lost with the session (its File is gone) gets no tab');
assert.match(sourceFor, /if \(!savedPath\.startsWith\('\/recordings\/'\)\) return null;/,
  'a File Source with no recording behind it gets no tab');
assert.match(sourceFor, /replace\(\/\\\.sigmf-data\$\/, ''\)/,
  "a remote tab is labelled from its path, so drawing it needs no manifest fetch");

// ---- nothing is fetched until a recording tab is opened ---------------------
// Comments explain the rule; the code has to follow it.
const code = text => text.replace(/^\s*\/\/.*$/gm, '');
const sync = between('function syncRecordingTabs()', '\n// A local file is a bare stream');
for (const forbidden of ['fetch(', 'iframe', 'createObjectURL', 'await']) {
  assert.ok(!code(sync).includes(forbidden),
    `syncRecordingTabs() must stay synchronous and offline (found "${forbidden}")`);
}
const create = between('function createRecordingTab', '\nfunction destroyRecordingTab');
assert.ok(!code(create).includes('iframe'),
  'creating a tab must not create its iframe: that is what defers the IQEngine download');
assert.match(source, /if \(isRecordingTabId\(tab\)\) void openRecordingPane\(recordingTabKey\(tab\)\)/,
  'the iframe is built when the tab is activated, not before');

const open = between('async function openRecordingPane', '\n// ---- Vertical splitter');
assert.match(open, /if \(!tab \|\| tab\.frame \|\| tab\.opening\) return;/,
  'a tab already open (or opening) is never loaded a second time, so revisiting refetches nothing');
assert.match(open, /frame\.src = iqengineUrl\(metaUrl, dataUrl, tab\.source\.name\)/,
  'the pane frames the same IQEngine url data source route the recordings palette links to');
assert.match(open, /recordingTabs\.get\(key\) !== tab\) return;/,
  'a File Source deleted mid-load must not leave an orphaned frame or blob URL behind');
assert.match(open, /fetch\('\/iqengine\/', \{ method: 'HEAD' \}\)/,
  'a site built without the optional IQEngine client says so instead of framing a 404');

// ---- local files: synthesized SigMF over blob: URLs -------------------------
assert.match(open, /dataUrl = URL\.createObjectURL\(file\)/,
  'a local file is read through a blob URL, which IQEngine range-requests like any other');
const meta = between('function synthesizedSigmfMeta', '\nfunction recordingPaneMessage');
assert.match(meta, /'core:datatype': datatype/);
assert.match(meta, /'traceability:sample_length'/,
  'supplying the sample count spares IQEngine a HEAD request a blob URL cannot answer');
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
const destroy = between('function destroyRecordingTab', '\n// Called from render()');
assert.match(destroy, /for \(const url of tab\.blobUrls\) URL\.revokeObjectURL\(url\)/,
  'a removed tab releases the blob URLs holding its local file');
assert.match(destroy, /tab\.entry\.panel\.remove\(\)/,
  'removing the panel drops the iframe, and with it IQEngine and its workers');
assert.match(sync, /if \(!workspaceTabs\.some\(entry => entry\.id === activeWorkspaceTab\)\)\s*\n?\s*activateWorkspaceTab\('editor'\)/,
  'deleting the File Source of the tab in view falls back to the Editor');
assert.match(sync, /Only the buttons are reordered/,
  'panels are never re-inserted: moving an iframe in the DOM reloads the document inside it');

// ---- presentation -----------------------------------------------------------
assert.match(html, /\.recording-pane:not\(\.active\) \{ visibility:hidden; \}/,
  'inactive recording panes hide with visibility, not display:none, which would resize IQEngine to nothing');
assert.match(html, /\.workspace-tab-label \{[^}]*text-overflow:ellipsis/,
  'a long recording name is ellipsized rather than stretching the tab bar');
assert.match(html, /#workspaceTabs \{[^}]*overflow-x:auto/,
  'many recordings scroll the tab bar instead of squeezing the fixed tabs');

console.log('checked per-File-Source recording tabs and their lazy IQEngine panes');
