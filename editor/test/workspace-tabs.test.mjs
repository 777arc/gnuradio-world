import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');

assert.match(html,
  /id="workspaceTabs"[^>]*role="tablist"[\s\S]*id="tabEditor"[^>]*role="tab"[\s\S]*id="tabQtGui"[^>]*role="tab"/,
  'the right-side workspace exposes Editor and QT GUI tabs');
assert.match(html,
  /id="workspaceContent"[\s\S]*id="editorPane"[^>]*role="tabpanel"[\s\S]*id="runPane"[^>]*role="tabpanel"[\s\S]*<\/div>\s*<div id="consoleSplitter"[\s\S]*?<div id="log">/,
  'the console is a persistent row below both tab panels');
assert.match(html, /#editorPane\[hidden\], #runPane\[hidden\] \{ display:none; \}/,
  'panel-specific display rules cannot override the inactive tab hidden state');
assert.match(html, /id="tabQtGui"[\s\S]*id="runIndicator"/,
  'the QT GUI tab includes a running-state indicator');
assert.match(html, /#workspace\.running #runIndicator \{[^}]*opacity:1/,
  'the running-state indicator is visible while a flowgraph runs');

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

console.log('checked tabbed editor/QT GUI workspace and persistent console');
