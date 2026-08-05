import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { editorSource as source, markupSource as html } from './editor-contract-source.mjs';

const out = join(tmpdir(), `selection-test-${process.pid}.mjs`);
await build({
  entryPoints: [new URL('../src/selection.ts', import.meta.url).pathname],
  bundle: true, format: 'esm', outfile: out, logLevel: 'silent',
});
const { boundsBetween, boundsIntersect } = await import(pathToFileURL(out));

assert.deepEqual(boundsBetween({ x: 80, y: 70 }, { x: 20, y: 10 }),
  { x: 20, y: 10, width: 60, height: 60 }, 'dragging up and left normalizes the marquee');
assert.equal(boundsIntersect(
  { x: 20, y: 20, width: 50, height: 50 },
  { x: 60, y: 60, width: 30, height: 30 }), true, 'overlapping blocks are selected');
assert.equal(boundsIntersect(
  { x: 20, y: 20, width: 40, height: 40 },
  { x: 60, y: 60, width: 30, height: 30 }), true, 'touching the marquee edge selects a block');
assert.equal(boundsIntersect(
  { x: 20, y: 20, width: 39, height: 39 },
  { x: 60, y: 60, width: 30, height: 30 }), false, 'separate blocks are not selected');

// Pointer events, not mouse events: the same handlers have to serve a finger,
// which is also why the canvas press bails out before arming a marquee when the
// pointer is a touch (that gesture pans the canvas instead).
assert.match(source, /svg\.addEventListener\('pointerdown'[\s\S]*marquee = /,
  'canvas presses must begin marquee selection');
assert.match(source, /pointerType === 'touch'/,
  'a touch on empty canvas must pan rather than rubber-band');
assert.match(source, /window\.addEventListener\('pointermove'[\s\S]*updateMarquee/,
  'pointer movement must update marquee selection');
assert.match(source, /e\.shiftKey \|\| e\.ctrlKey \|\| e\.metaKey/,
  'modifier-drag must preserve the existing selection');
assert.match(html, /class: 'selection-box'|\.selection-box/,
  'the marquee must have a visible canvas style');
assert.match(html, /id="selectionOverlay"/,
  'the marquee overlay must render above blocks and wires');

console.log('checked marquee geometry, interaction wiring, and overlay');
