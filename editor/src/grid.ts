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

// Centers a group of `count` ports on `span`, `pitch` apart, and puts every one
// of them on the grid — which is what makes a wire between two blocks straight,
// since block origins are snapped to the same grid. Centering alone does not:
// an even-sized group straddles the midpoint by half a pitch, so at the 3-cell
// port pitch its ports sit 5px off the grid and can never line up with the lone
// centered port of the block feeding them. So the *group* is snapped rather than
// its midpoint: round the first slot to the grid and step from there, which any
// pitch that is itself a multiple of a cell keeps grid-aligned throughout. The
// group moves by at most half a cell off true center, equally for every port in
// it, so two blocks with the same port count still agree.
export function centeredPortSlot(span: number, count: number, index: number,
                                 pitch = SNAP_GRID_SIZE * 2): number {
  const first = span / 2 - ((count - 1) / 2) * pitch;
  return Math.round(first / SNAP_GRID_SIZE) * SNAP_GRID_SIZE + index * pitch;
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

export interface CanvasViewport {
  scrollLeft: number;
  scrollTop: number;
  clientWidth: number;
  clientHeight: number;
}

/** The flowgraph coordinate in the middle of the currently visible canvas. */
export function canvasViewportCenter(viewport: CanvasViewport, zoom: number): Point {
  return {
    x: (viewport.scrollLeft + viewport.clientWidth / 2) / zoom,
    y: (viewport.scrollTop + viewport.clientHeight / 2) / zoom,
  };
}

/** Put a block's body around a canvas point while preserving normal placement rules. */
export function centeredBlockPosition(center: Point, size: { w: number; h: number },
                                      snapToGrid: boolean): Point {
  return constrainBlockPosition(center.x - size.w / 2, center.y - size.h / 2, snapToGrid);
}
