import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { editorSource as source } from './editor-contract-source.mjs';

const out = join(tmpdir(), `grid-test-${process.pid}.mjs`);
await build({
  entryPoints: [new URL('../src/grid.ts', import.meta.url).pathname],
  bundle: true, format: 'esm', outfile: out, logLevel: 'silent',
});
const {
  SNAP_GRID_SIZE,
  ceilToGrid,
  centeredPortSlot,
  constrainBlockPosition,
} = await import(pathToFileURL(out));

assert.equal(SNAP_GRID_SIZE, 10, 'snap spacing matches native GRC');
assert.deepEqual(constrainBlockPosition(14, 26, true), { x: 10, y: 30 },
  'enabled snapping rounds both coordinates to the nearest grid point');
assert.deepEqual(constrainBlockPosition(-6, -4, true), { x: 0, y: 0 },
  'snapped blocks cannot move above or left of the canvas');
assert.deepEqual(constrainBlockPosition(14.4, 26.4, false), { x: 14, y: 26 },
  'disabling snapping preserves the existing whole-coordinate movement');
assert.deepEqual(constrainBlockPosition(-1, 12, false), { x: 0, y: 12 },
  'native top/left bounds still apply while snapping is disabled');
assert.equal(ceilToGrid(104), 110,
  'block and port widths round outward to the grid');
assert.equal(ceilToGrid(61, SNAP_GRID_SIZE * 2), 80,
  'block heights round outward to two grid cells');
assert.deepEqual(
  [0, 1, 2, 3].map(index => centeredPortSlot(100, 4, index)),
  [20, 40, 60, 80],
  'an even centered port group stays on the grid');
assert.deepEqual(
  [0, 1, 2].map(index => centeredPortSlot(100, 3, index)),
  [30, 50, 70],
  'an odd centered port group stays on the grid');

assert.match(source, /let snapToGrid = true;/,
  'snap to grid is enabled by default');
assert.match(source, /label: 'Snap to Grid', run: toggleSnapToGrid, check: \(\) => snapToGrid/,
  'the View menu exposes a checked snap-to-grid toggle');
assert.match(source, /constrainBlockPosition\(p\.x - drag\.ox, p\.y - drag\.oy, snapToGrid\)/,
  'block dragging applies the snap preference');
assert.match(source,
  /function addBlock[\s\S]*?const position = constrainBlockPosition\(x, y, snapToGrid\)/,
  'new blocks start on the grid when snapping is enabled');

console.log('checked grid snapping, canvas bounds, and grid-aligned port geometry');
