import assert from 'node:assert/strict';
import { editorSource as source, markupSource as html } from './editor-contract-source.mjs';

assert.match(html, /<div id="canvasScroll">\s*<svg id="svg">/,
  'the canvas svg lives inside a dedicated scrolling container');
assert.match(html, /#canvasScroll \{[^}]*overflow:auto/,
  'the canvas scrolls both ways once blocks sit outside the viewport');
assert.match(html, /#canvasScroll \{[^}]*background-attachment:local, local;/s,
  'the drawn grid scrolls with the blocks instead of staying pinned to the viewport');
assert.match(html, /svg \{ width:100%; height:100%/,
  'the surface stays viewport-sized so one scrollbar cannot conjure up the other');
assert.match(html,
  /<div id="workspaceContent">[\s\S]*<\/svg>[\s\S]*<\/section>\s*<\/div>\s*<div id="consoleSplitter"[\s\S]*?<div id="log">/,
  'the console and its splitter stay outside the tabbed workspace content');

assert.match(source, /nodesG\.appendChild\(g\);\s*\}\s*updateCanvasExtent\(\);/,
  'render() refreshes the canvas extent after laying blocks out');
assert.match(source, /svg\.style\.minWidth = `\$\{Math\.ceil\(\(right \+ CANVAS_MARGIN\) \* zoom\)\}px`/,
  'the extent follows the right-most block and the current zoom');
assert.match(source, /svg\.style\.minHeight = `\$\{Math\.ceil\(\(bottom \+ CANVAS_MARGIN\) \* zoom\)\}px`/,
  'the extent follows the bottom-most block and the current zoom');
assert.doesNotMatch(source, /canvasScroll\.style\.bottom/,
  'the console occupies its own workspace row instead of overlapping the canvas');

console.log('checked canvas scrolling container, extent, and grid alignment');
