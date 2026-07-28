import type { Point } from './selection';

// Match grc/gui_qt/components/canvas/block.py. The native editor snaps block
// coordinates in 10-unit increments even though the drawn canvas grid has its
// own spacing.
export const SNAP_GRID_SIZE = 10;

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
