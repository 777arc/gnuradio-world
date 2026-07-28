import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const out = join(tmpdir(), `grid-test-${process.pid}.mjs`);
await build({
  entryPoints: [new URL('../src/grid.ts', import.meta.url).pathname],
  bundle: true, format: 'esm', outfile: out, logLevel: 'silent',
});
const { SNAP_GRID_SIZE, constrainBlockPosition } = await import(pathToFileURL(out));

assert.equal(SNAP_GRID_SIZE, 10, 'snap spacing matches native GRC');
assert.deepEqual(constrainBlockPosition(14, 26, true), { x: 10, y: 30 },
  'enabled snapping rounds both coordinates to the nearest grid point');
assert.deepEqual(constrainBlockPosition(-6, -4, true), { x: 0, y: 0 },
  'snapped blocks cannot move above or left of the canvas');
assert.deepEqual(constrainBlockPosition(14.4, 26.4, false), { x: 14, y: 26 },
  'disabling snapping preserves the existing whole-coordinate movement');
assert.deepEqual(constrainBlockPosition(-1, 12, false), { x: 0, y: 12 },
  'native top/left bounds still apply while snapping is disabled');

const source = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8');
assert.match(source, /let snapToGrid = true;/,
  'snap to grid is enabled by default');
assert.match(source, /label: 'Snap to Grid', run: toggleSnapToGrid, check: \(\) => snapToGrid/,
  'the View menu exposes a checked snap-to-grid toggle');
assert.match(source, /constrainBlockPosition\(p\.x - drag\.ox, p\.y - drag\.oy, snapToGrid\)/,
  'block dragging applies the snap preference');

console.log('checked native snap-to-grid spacing, default, toggle, and canvas bounds');
