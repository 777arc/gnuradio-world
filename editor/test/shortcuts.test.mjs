import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');

const bindings = {
  'new/open/save': /key === 'n'.*clearFlowgraph[\s\S]*key === 'o'.*fileOpen[\s\S]*key === 's'.*saveFlowgraph/,
  'undo/redo/select all': /key === 'z'.*undo[\s\S]*key === 'y'.*redo[\s\S]*key === 'a'/,
  'cut/copy/paste': /key === 'c'.*copyBlocks[\s\S]*key === 'x'.*copyBlocks.*deleteBlocks[\s\S]*key === 'v'.*pasteBlock/,
  'rotate/type': /ArrowRight.*rotateSelected\(90\)[\s\S]*ArrowLeft.*rotateSelected\(-90\)[\s\S]*ArrowUp.*cycleBlockType\(-1\)[\s\S]*ArrowDown.*cycleBlockType\(1\)/,
  'enable/disable/bypass': /key === 'e'.*setSelectedEnabled\(true\)[\s\S]*key === 'd'.*setSelectedEnabled\(false\)[\s\S]*key === 'b'.*bypassSelected/,
  'alignment': /alignSelected\('top'\)[\s\S]*alignSelected\('middle'\)[\s\S]*alignSelected\('bottom'\)[\s\S]*alignSelected\('left'\)[\s\S]*alignSelected\('center'\)[\s\S]*alignSelected\('right'\)/,
  'zoom': /NumpadAdd.*setZoom[\s\S]*NumpadSubtract.*setZoom[\s\S]*key === '0'.*setZoom\(1\)/,
  'panels/search/grid': /key === 'e'[\s\S]*showVariableEditor[\s\S]*key === 'r'[\s\S]*console-hidden[\s\S]*key === 'b'[\s\S]*hide-palette[\s\S]*key === 'f'[\s\S]*paletteSearch[\s\S]*key === 'g'[\s\S]*grid-hidden/,
  'generate/run/stop': /e\.key === 'F5'[\s\S]*e\.key === 'F6'.*run[\s\S]*e\.key === 'F7'.*stop/,
  'capture/console': /key === 'p'.*saveConsole[\s\S]*key === 'p'.*saveScreenshot[\s\S]*key === 'l'.*textContent = ''/,
};

for (const [name, pattern] of Object.entries(bindings))
  assert.match(source, pattern, `missing native shortcut group: ${name}`);

assert.match(source, /Ctrl\+K or F1/);
assert.match(source, /hierarchical blocks are not supported in WebAssembly/);
// The keyboard-shortcut help now lives in the Help menu (the old top-right button was removed).
assert.match(source, /label: 'Keyboard Shortcuts', key: 'Ctrl\+K', run: showShortcutHelp/);
assert.match(html, /id="menus"/);
console.log(`checked ${Object.keys(bindings).length} native shortcut groups`);
