import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const source = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');

assert.match(html, /<div id="canvasScroll">\s*<svg id="svg">/,
  'the canvas svg lives inside a dedicated scrolling container');
assert.match(html, /#canvasScroll \{[^}]*overflow:auto/,
  'the canvas scrolls both ways once blocks sit outside the viewport');
assert.match(html, /#canvasScroll \{[^}]*background-attachment:local, local;/s,
  'the drawn grid scrolls with the blocks instead of staying pinned to the viewport');
assert.match(html, /svg \{ width:100%; height:100%/,
  'the surface stays viewport-sized so one scrollbar cannot conjure up the other');
assert.match(html, /<\/svg>\s*<\/div>\s*<div id="log">/,
  'the console overlay stays outside the scrolling area');

assert.match(source, /nodesG\.appendChild\(g\);\s*\}\s*updateCanvasExtent\(\);/,
  'render() refreshes the canvas extent after laying blocks out');
assert.match(source, /svg\.style\.minWidth = `\$\{Math\.ceil\(\(right \+ CANVAS_MARGIN\) \* zoom\)\}px`/,
  'the extent follows the right-most block and the current zoom');
assert.match(source, /svg\.style\.minHeight = `\$\{Math\.ceil\(\(bottom \+ CANVAS_MARGIN\) \* zoom\)\}px`/,
  'the extent follows the bottom-most block and the current zoom');
assert.match(source, /new ResizeObserver\(\(\) => \{ canvasScroll\.style\.bottom = `\$\{el\('log'\)\.offsetHeight\}px`; \}\)\.observe\(el\('log'\)\)/,
  'the scrolling area ends above the console so the horizontal scrollbar stays visible');

console.log('checked canvas scrolling container, extent, and grid alignment');
