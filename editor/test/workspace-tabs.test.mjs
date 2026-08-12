import assert from 'node:assert/strict';
import { editorSource as source, markupSource as html } from './editor-contract-source.mjs';

assert.match(html,
  /id="workspaceTabs"[^>]*role="tablist"[\s\S]*id="tabEditor"[^>]*role="tab"[\s\S]*id="tabQtGui"[^>]*role="tab"/,
  'the right-side workspace exposes Editor and QT GUI tabs');
assert.match(html,
  /id="workspaceContent"[\s\S]*id="editorPane"[^>]*role="tabpanel"[\s\S]*id="runPane"[^>]*role="tabpanel"[\s\S]*<\/section>[\s\S]*?<\/div>\s*<div id="consoleSplitter"[\s\S]*?<div id="log">/,
  'the console is a persistent row below both tab panels');
assert.match(html, /#editorPane\[hidden\], #runPane\[hidden\] \{ display:none; \}/,
  'panel-specific display rules cannot override the inactive tab hidden state');
assert.match(html, /id="tabQtGui"[\s\S]*id="runIndicator"/,
  'the QT GUI tab includes a running-state indicator');
assert.match(html, /#workspace\.running #runIndicator \{[^}]*opacity:1/,
  'the running-state indicator is visible while a flowgraph runs');
assert.match(html, /\.workspace-tab \{[^}]*flex:none;[^}]*padding:9px 12px/,
  'workspace tabs must hug their text instead of filling the tab strip');
assert.doesNotMatch(html, /\.workspace-tab \{[^}]*min-width:/,
  'workspace tabs must not retain a fixed minimum width');
assert.match(html, /\.paltabs \{[^}]*background:#1b1e29;[^}]*overflow-x:auto/,
  'the palette tab strip must leave a blank background after its tabs and scroll when needed');
assert.match(html, /\.paltab \{[^}]*flex:none;[^}]*padding:9px 12px/,
  'palette tabs must hug their text instead of sharing the full pane width');

assert.match(source,
  /function activateWorkspaceTab[\s\S]*editorPane'\)\.hidden[\s\S]*runPane'\)\.hidden/,
  'workspace tab activation swaps the editor and QT GUI panels');
assert.match(source,
  /setRunnerRunning\(true\);\s*activateWorkspaceTab\('qtgui'\);/,
  'executing a flowgraph selects the QT GUI tab and marks it running');
assert.match(source, /qtTab\.setAttribute\('aria-label', qtLabel\)/,
  'the QT GUI running state is also exposed to assistive technology');
assert.match(source,
  /function stop\(\)[\s\S]*setRunnerRunning\(false\);\s*activateWorkspaceTab\('editor'\);/,
  'stopping a flowgraph clears the QT GUI running state and returns to the editor');
assert.match(source,
  /d\.type === 'gr-error'[\s\S]*setRunnerRunning\(false, 'Flowgraph failed'\)/,
  'a runner startup failure also clears the running indicator');

// ---- embedded layout (?embed=1) --------------------------------------------
// What another page frames is #workspaceContent and nothing else, with one
// button standing in for the toolbar's ▶ and the run bar's Stop at once.
assert.match(html, /id="embedControls"[^>]*class="embed-controls"[^>]*hidden/,
  'the embedded controls ship hidden and are turned on by the embed flag');
assert.match(html, /id="runPane"[\s\S]*id="embedControls"[\s\S]*<\/div>\s*<div id="consoleSplitter"/,
  'the embedded controls live inside #workspaceContent, over both panels');
assert.match(html, /<a id="embedOpen"[^>]*target="_blank"[^>]*rel="noopener noreferrer"/,
  'opening the flowgraph in the full editor is a link, in a tab of its own');
assert.match(html, /\.embed-run \{ grid-column:2; justify-self:center; \}/,
  'Run sits in the middle of the frame');
assert.match(html, /\.embed-open \{ grid-column:3; justify-self:end; \}/,
  'the way out sits in the corner, clear of it');
assert.match(html, /\.embed-controls \{[^}]*pointer-events:none/,
  'the row spanning the frame must not become a strip of dead canvas');
assert.match(html, /@media \(max-width:820px\)[\s\S]*\.embed-open-long \{ display:none; \}/,
  'a phone-sized frame gets the short label instead');
// display:none rather than visibility, so each dropped part's grid track collapses.
const embeddedHidden = html.match(/((?:#app\.embedded [^{,]+,\s*)*#app\.embedded [^{,]+)\{ display:none; \}/);
assert.ok(embeddedHidden, 'the embedded layout hides the application chrome with display:none');
for (const part of ['header', '#palette', '#paletteSplitter', '#paletteToggle', '#workspaceTabs',
                    '#consoleSplitter', '#consoleToggle', '#log', '#runBar'])
  assert.match(embeddedHidden[1], new RegExp(`#app\\.embedded ${part}[\\s,]`),
    `the embedded layout drops ${part}`);
assert.match(html, /\.embed-controls \{[^}]*position:absolute;[^}]*z-index:40/,
  'the embedded controls float over the panels rather than taking a bar of their own');

assert.match(source, /const EMBEDDED = \(\(\) => \{[\s\S]*URLSearchParams\(location\.search\)\.get\('embed'\)/,
  'embedded mode is a query parameter, leaving the fragment to name the flowgraph');
assert.match(source, /if \(EMBEDDED\) el\('app'\)\.classList\.add\('embedded'\)/,
  'embedded mode is applied as a class the stylesheet keys the whole layout off');
assert.match(source,
  /if \(runnerRunning\) \{ stop\(\); return; \}[\s\S]*await run\(\);/,
  'the one embedded button runs the flowgraph and stops it again');
assert.match(source, /if \(!runnerRunning\) \{\s*updateEmbedRun\(\/\* failed \*\/ true\)/,
  'a refused flowgraph reports on the button, since an embed has no console pane');
assert.match(source, /if \(!EMBEDDED\) showWelcomePopup\(\)/,
  'the welcome modal stays out of an embedded flowgraph');
assert.match(source,
  /embedOpen\.href = historyIndex > 0 \? await flowgraphToUrl\(\) : embedOpenUrl\(\)/,
  'the Open link carries the edited canvas, and the plain example link until then');
assert.match(source, /function embedOpenUrl\(\) \{ return location\.href\.split\('#'\)\[0\]\.split\('\?'\)\[0\] \+ location\.hash; \}/,
  'leaving the embed means dropping the query the host page framed it with');
for (const fn of ['resetHistory', 'recordHistory', 'restoreHistory'])
  assert.match(source, new RegExp(`function ${fn}\\([^)]*\\) \\{[\\s\\S]*?void refreshEmbedOpen\\(\\);`),
    `${fn}() keeps the Open link in step with the canvas`);

console.log('checked tabbed editor/QT GUI workspace, persistent console, and embedded layout');
