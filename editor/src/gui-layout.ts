// The GUI Layout block's grid: where each QT GUI widget goes in the runner
// window, as a dashboard-style tile map.
//
// The runner window is `columns` columns wide and every row is `rowHeight` tall.
// A widget occupies a tile at (col, row) spanning (w, h) of those units, columns
// and rows share the window equally, and tiles never overlap. That is the
// react-grid-layout / Grafana model rather than GRC's `gui_hint`, which this
// build ignores entirely -- see blocks/grc/wasm_gui_layout.block.yml.
//
// This module is the *only* implementation of the packing rules. The runner
// (runner/src/gui_layout.hpp) renders a spec and never edits one, and both
// editing surfaces -- the Properties-dialog designer and the Arrange overlay
// over a running flowgraph -- go through the functions here. So there is one
// definition of what a drag does, and it is the one with tests.
//
// DOM-free by design, like note.ts, so editor/test/gui-layout.test.mjs can
// exercise it under node. The designer's DOM lives in gui-layout-designer.ts.

import { isVariableControl } from './validation';

export interface Tile { col: number; row: number; w: number; h: number }
/** Tiles by block ID -- the same keying the .grc parameter uses. */
export type TileMap = Record<string, Tile>;
/** One widget-bearing block in the flowgraph: its ID and its block id. */
export interface WidgetRef { name: string; id: string }

export const DEFAULT_COLUMNS = 12;
export const DEFAULT_ROW_HEIGHT = 60;
// Matches kMaxColumns in runner/src/gui_layout.hpp: past this a column is under
// a pixel wide in any real window.
export const MAX_COLUMNS = 48;

// Default heights for a widget that has never been placed. A control is one row
// (it is a slider or a button); a plot needs enough rows to be readable at all.
export const CONTROL_ROWS = 1;
export const SINK_ROWS = 4;

const clampInt = (value: unknown, low: number, high: number, fallback: number): number => {
  // An empty parameter is an unset one, not a zero: `Number('')` is 0, which
  // would silently clamp a blank Columns field to a one-column window.
  if (value === '' || value === null || value === undefined) return fallback;
  const n = Math.round(Number(value));
  if (!Number.isFinite(n)) return fallback;
  return Math.max(low, Math.min(high, n));
};

/**
 * Whether this block is a QT GUI *control* rather than a plot, which is what
 * picks CONTROL_ROWS over SINK_ROWS for a widget nobody has placed yet.
 *
 * The same `is_variable_control()` rule the runner applies at
 * runner/src/runner.cpp's apply_gui_layout(), deliberately: this decides the
 * editor's preview and that decides the window, and the two disagreeing shows
 * up as a preview that does not match what runs.
 */
export const isControlWidget = (id: string): boolean => isVariableControl(id);

/** Fit a tile inside a `columns`-wide grid, narrowing rather than moving it. */
export function clampTile(tile: Tile, columns: number): Tile {
  const w = Math.max(1, Math.min(Math.round(tile.w), columns));
  const h = Math.max(1, Math.round(tile.h));
  return {
    w, h,
    col: Math.max(0, Math.min(Math.round(tile.col), columns - w)),
    row: Math.max(0, Math.round(tile.row)),
  };
}

/** Parse the block's `layout` parameter: `{"block ID": [col, row, w, h]}`. */
export function parseTiles(text: string): TileMap {
  let parsed: any;
  try {
    parsed = JSON.parse(String(text || '{}'));
  } catch {
    return {};                       // a spec is cosmetic; never fail a load over one
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const tiles: TileMap = {};
  for (const [name, value] of Object.entries(parsed)) {
    if (!Array.isArray(value) || value.length !== 4) continue;
    if (!value.every(n => Number.isFinite(Number(n)))) continue;
    tiles[name] = {
      col: Number(value[0]), row: Number(value[1]),
      w: Number(value[2]), h: Number(value[3]),
    };
  }
  return tiles;
}

// Sorted keys and no spaces, so re-serializing an unchanged layout gives back a
// byte-identical .grc -- the same reason the Python Block sorts its io cache.
export function serializeTiles(tiles: TileMap): string {
  const entries = Object.keys(tiles).sort()
    .map(name => `${JSON.stringify(name)}:[${tiles[name].col},${tiles[name].row},` +
                 `${tiles[name].w},${tiles[name].h}]`);
  return `{${entries.join(',')}}`;
}

const overlaps = (a: Tile, b: Tile): boolean =>
  a.col < b.col + b.w && b.col < a.col + a.w &&
  a.row < b.row + b.h && b.row < a.row + a.h;

/**
 * Settle a set of tiles: resolve every overlap and close every vertical gap.
 *
 * Tiles are placed in reading order, each dropping into the topmost row where it
 * fits above nothing already placed. That single rule does both jobs -- a tile
 * overlapping one above it lands below that one, and a tile with empty rows
 * above it rises into them -- which is what makes a drag feel like a dashboard
 * rather than like free-floating boxes, and what guarantees the runner's grid
 * has no empty rows to stretch.
 *
 * `first` is the block being dragged: it is placed before anything it collides
 * with, so the widget under the cursor keeps the row the user dropped it on and
 * the others move out of its way.
 */
export function settle(tiles: TileMap, columns: number, first?: string): TileMap {
  const order = Object.keys(tiles).sort((a, b) => {
    // A half-row bias, so the dragged tile sorts ahead of anything sharing its
    // row without being able to jump a tile that is genuinely above it.
    const rowA = tiles[a].row - (a === first ? 0.5 : 0);
    const rowB = tiles[b].row - (b === first ? 0.5 : 0);
    return rowA - rowB || tiles[a].col - tiles[b].col || (a < b ? -1 : 1);
  });
  const settled: TileMap = {};
  for (const name of order) {
    const tile = clampTile(tiles[name], columns);
    let row = 0;
    // Scan down for the first row this tile fits in. Bounded by construction:
    // below every placed tile there is always room.
    for (;;) {
      const candidate = { ...tile, row };
      if (!Object.values(settled).some(other => overlaps(candidate, other))) break;
      ++row;
    }
    settled[name] = { ...tile, row };
  }
  return settled;
}

/** One past the last row any tile occupies. */
export function rowsUsed(tiles: TileMap): number {
  return Object.values(tiles).reduce((rows, t) => Math.max(rows, t.row + t.h), 0);
}

/**
 * The complete arrangement for exactly `widgets`: stored tiles for the ones that
 * have them, a full-width row each for the ones that do not.
 *
 * A widget with no tile is a sink added since the flowgraph was last arranged,
 * and it goes underneath everything already placed rather than on top of it --
 * the same rule apply_gui_layout() follows in the runner, so the editor's
 * preview and the running window agree about a flowgraph nobody has arranged.
 * Tiles for blocks that are no longer here are dropped.
 */
export function packLayout(widgets: WidgetRef[], stored: TileMap,
                           columns = DEFAULT_COLUMNS): TileMap {
  const cols = clampInt(columns, 1, MAX_COLUMNS, DEFAULT_COLUMNS);
  const tiles: TileMap = {};
  let next = rowsUsed(stored);
  for (const widget of widgets) {
    const tile = stored[widget.name];
    if (tile) {
      tiles[widget.name] = clampTile(tile, cols);
      continue;
    }
    const h = isControlWidget(widget.id) ? CONTROL_ROWS : SINK_ROWS;
    tiles[widget.name] = { col: 0, row: next, w: cols, h };
    next += h;
  }
  return settle(tiles, cols);
}

/**
 * Apply one drag or resize and settle the result. `next` is where the user put
 * the tile, in grid units; everything else moves around it.
 */
export function placeTile(tiles: TileMap, name: string, next: Tile,
                          columns = DEFAULT_COLUMNS): TileMap {
  const cols = clampInt(columns, 1, MAX_COLUMNS, DEFAULT_COLUMNS);
  if (!(name in tiles)) return tiles;
  return settle({ ...tiles, [name]: clampTile(next, cols) }, cols, name);
}

/** The block's `columns` parameter, as a number the grid can actually use. */
export const layoutColumns = (value: unknown): number =>
  clampInt(value, 1, MAX_COLUMNS, DEFAULT_COLUMNS);
/** The block's `row_height` parameter, in px. */
export const layoutRowHeight = (value: unknown): number =>
  clampInt(value, 8, 1000, DEFAULT_ROW_HEIGHT);
