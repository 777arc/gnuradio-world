import type { Point } from './selection';

// Match grc/gui_qt/components/canvas/block.py, which snaps block coordinates in
// 10-unit increments. Unlike the native editor (whose drawn grid uses a
// different spacing) the canvas here draws its grid at this same size.
export const SNAP_GRID_SIZE = 10;

// Round dimensions outward so geometry derived from a snapped block origin also
// lands on the grid. `multiple` is useful for centered features: a block height
// spanning two grid cells keeps both odd and even port groups grid-aligned.
export function ceilToGrid(value: number, multiple = SNAP_GRID_SIZE): number {
  return Math.ceil(value / multiple) * multiple;
}

// Centers a group of `count` ports on `span`, `pitch` apart. Keep `span` a
// multiple of two grid cells: that puts the group's midpoint on the grid, so
// every slot of an odd-sized group is a grid coordinate too. An even-sized
// group straddles the midpoint by half a pitch, which lands on the grid only
// when the pitch is an even number of cells.
export function centeredPortSlot(span: number, count: number, index: number,
                                 pitch = SNAP_GRID_SIZE * 2): number {
  return span / 2 + (index - (count - 1) / 2) * pitch;
}

export function constrainBlockPosition(x: number, y: number, snapToGrid: boolean): Point {
  if (snapToGrid) {
    x = Math.round(x / SNAP_GRID_SIZE) * SNAP_GRID_SIZE;
    y = Math.round(y / SNAP_GRID_SIZE) * SNAP_GRID_SIZE;
  } else {
    // Keep the WASM editor's existing whole-coordinate movement when snapping
    // is disabled.
    x = Math.round(x);
    y = Math.round(y);
  }

  // Native GRC does not allow a block to be dragged above or left of the canvas.
  return { x: Math.max(0, x), y: Math.max(0, y) };
}
