import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { editorSource as source, markupSource as html } from './editor-contract-source.mjs';

const about = await readFile(new URL('../src/about.html', import.meta.url), 'utf8');

const bindings = {
  'new/open/save': /key === 'n'.*clearFlowgraph[\s\S]*key === 'o'.*fileOpen[\s\S]*key === 's'.*saveFlowgraph/,
  'undo/redo/select all': /key === 'z'.*undo[\s\S]*key === 'y'.*redo[\s\S]*key === 'a'/,
  'cut/copy/paste': /key === 'c'.*copyBlocks[\s\S]*key === 'x'.*copyBlocks.*deleteBlocks[\s\S]*key === 'v'.*pasteBlock/,
  'rotate/type': /ArrowRight.*rotateSelected\(90\)[\s\S]*ArrowLeft.*rotateSelected\(-90\)[\s\S]*ArrowUp.*cycleBlockType\(-1\)[\s\S]*ArrowDown.*cycleBlockType\(1\)/,
  'enable/disable/bypass': /key === 'e'.*setSelectedEnabled\(true\)[\s\S]*key === 'd'.*setSelectedEnabled\(false\)[\s\S]*key === 'b'.*bypassSelected/,
  'alignment': /alignSelected\('top'\)[\s\S]*alignSelected\('middle'\)[\s\S]*alignSelected\('bottom'\)[\s\S]*alignSelected\('left'\)[\s\S]*alignSelected\('center'\)[\s\S]*alignSelected\('right'\)/,
  'zoom': /NumpadAdd.*setZoom[\s\S]*NumpadSubtract.*setZoom[\s\S]*key === '0'.*setZoom\(1\)/,
  // Ctrl+B goes through togglePalette() rather than toggling the class inline,
  // because the narrow layout's drawer keeps a button's label and state in step
  // with it.
  'panels/grid': /key === 'e'[\s\S]*showVariableEditor[\s\S]*key === 'r'[\s\S]*console-hidden[\s\S]*key === 'b'[\s\S]*togglePalette\(\)[\s\S]*key === 'g'[\s\S]*grid-hidden/,
  'run/stop': /e\.key === 'F6'.*run[\s\S]*e\.key === 'F7'.*stop/,
  'capture/console': /key === 'p'.*saveConsole[\s\S]*key === 'p'.*saveScreenshot[\s\S]*key === 'l'.*textContent = ''/,
};

for (const [name, pattern] of Object.entries(bindings))
  assert.match(source, pattern, `missing native shortcut group: ${name}`);

assert.match(source, /Ctrl\+K or F1/);
assert.match(source, /hierarchical blocks are not supported in WebAssembly/);
// The keyboard-shortcut help now lives in the Help menu (the old top-right button was removed).
assert.match(source, /label: 'Keyboard Shortcuts', key: 'Ctrl\+K', run: showShortcutHelp/);
assert.match(source,
  /\{ label: 'File', items: \[\s*\{ label: 'About GNU Radio World', run: showAboutDialog \}/,
  '"About GNU Radio World" must be the first item in the File menu');
assert.match(source,
  /import aboutHtml from '\.\/about\.html\?raw'[\s\S]*?openDialog\('About GNU Radio World'[\s\S]*?body\.innerHTML = aboutHtml/,
  'the GNU Radio World dialog must render its separately editable HTML file');
assert.match(about,
  /only the WebAssembly modules corresponding[\s\S]*?limitless collection of out-of-tree modules[\s\S]*?downloaded only when you use them[\s\S]*?IQEngine[\s\S]*?real[\s\S]*?recordings of the corresponding signals/,
  'the GNU Radio World dialog must explain on-demand modules, OOTs, and RF recordings');
assert.doesNotMatch(source, /label: 'Generate'/);
assert.doesNotMatch(source, /label: 'Find Blocks'/);
assert.doesNotMatch(source, /label: 'Reload Blocks'/);
assert.doesNotMatch(source, /label: 'Tools'/);
assert.doesNotMatch(source, /label: 'Filter Design Tool'/);
assert.doesNotMatch(source, /label: 'Set Default QT GUI Theme'/);
assert.doesNotMatch(source, /label: 'Show Flowgraph Complexity'/);
assert.doesNotMatch(source, /label: 'Open Recent'/);
assert.doesNotMatch(source, /label: 'Move Variable Editor to Sidebar'/);
assert.doesNotMatch(source, /label: 'Generated Code Preview'/);
assert.doesNotMatch(source, /e\.key === 'F5'/);
assert.doesNotMatch(source, /ctrl && key === 'f'/);
assert.doesNotMatch(source, /e\.key === '\/'/);
assert.match(html, /id="menus"/);
console.log(`checked ${Object.keys(bindings).length} native shortcut groups`);
