// Drag-and-drop editor for the GUI Layout block's grid, shown in place of a
// text field in its Properties dialog (main.ts binds it to the `gui_layout`
// dtype, the same way the Embedded Python Block's source gets a code editor).
//
// Every rule about what a drag *means* -- collision, compaction, clamping --
// lives in gui-layout.ts and is shared with the Arrange overlay over a running
// flowgraph. This file is only the surface: it turns pointer movement into grid
// cells, hands those to placeTile(), and redraws.
//
// Loaded on demand, so the editor's first paint does not carry it.

import {
  packLayout, placeTile, rowsUsed, isControlWidget,
  type Tile, type TileMap, type WidgetRef,
} from './gui-layout';

export interface DesignerOptions {
  widgets: WidgetRef[];
  tiles: TileMap;
  columns: number;
  rowHeight: number;
  /** Called on every completed drag or resize with the settled arrangement. */
  onChange: (tiles: TileMap) => void;
}
export interface DesignerHandle {
  /** Current arrangement, for a caller that did not track onChange. */
  tiles(): TileMap;
  destroy(): void;
}

// The designer is a schematic, not a screenshot, but its cells keep the aspect
// ratio a real window would give them: a row is `rowHeight` px against columns
// that each get a twelfth (or whatever) of a typical window. Without this a tall
// narrow tile looks square here and nothing like it does in the runner.
const NOMINAL_WINDOW_W = 1000;
const MIN_ROW_PX = 16;
const MAX_ROW_PX = 64;
// Always leave room to drop something below the last tile, so a one-tile layout
// is still rearrangeable.
const SPARE_ROWS = 2;

const clamp = (value: number, low: number, high: number) =>
  Math.max(low, Math.min(high, value));

export function mountLayoutDesigner(host: HTMLElement,
                                    options: DesignerOptions): DesignerHandle {
  const columns = options.columns;
  let tiles = packLayout(options.widgets, options.tiles, columns);
  const kindOf = new Map(options.widgets.map(w => [w.name, w.id]));

  const root = document.createElement('div');
  root.className = 'gui-designer';
  // The grid is as tall as the arrangement needs, which for a flowgraph with ten
  // widgets and nothing placed yet is taller than any dialog. It scrolls inside
  // a fixed viewport rather than stretching the dialog past the screen.
  const scroller = document.createElement('div');
  scroller.className = 'gui-designer-scroll';
  const grid = document.createElement('div');
  grid.className = 'gui-designer-grid';
  scroller.appendChild(grid);
  const hint = document.createElement('p');
  hint.className = 'gui-designer-hint';
  const actions = document.createElement('div');
  actions.className = 'gui-designer-actions';
  const stack = document.createElement('button');
  stack.type = 'button'; stack.textContent = 'Stack full width';
  stack.title = 'Give every widget a full-width row, in flowgraph order';
  actions.append(stack);
  root.append(scroller, actions, hint);
  host.appendChild(root);

  const rowPx = () => clamp(
    (options.rowHeight / (NOMINAL_WINDOW_W / columns)) * (grid.clientWidth / columns),
    MIN_ROW_PX, MAX_ROW_PX);
  const gridRows = () => Math.max(1, rowsUsed(tiles)) + SPARE_ROWS;

  function describe(): string {
    const count = Object.keys(tiles).length;
    if (!count) return 'This flowgraph has no QT GUI blocks to arrange yet.';
    return `${count} widget${count === 1 ? '' : 's'} · ${columns} columns · ` +
      `rows ${options.rowHeight}px tall in the runner. ` +
      'Drag to move, drag the bottom-right corner to resize. ' +
      'Arrow keys move a selected tile; hold Shift to resize.';
  }

  function draw() {
    const cellH = rowPx();
    grid.style.height = `${gridRows() * cellH}px`;
    // The backdrop is the grid itself, drawn as two repeating gradients so the
    // cell size is always exactly what a drag snaps to.
    grid.style.backgroundSize = `${100 / columns}% ${cellH}px`;
    grid.textContent = '';
    const cellW = grid.clientWidth / columns;
    for (const [name, tile] of Object.entries(tiles)) {
      const el = document.createElement('div');
      el.className = 'gui-tile' + (isControlWidget(kindOf.get(name) || '') ? ' control' : '');
      el.style.left = `${tile.col * cellW}px`;
      el.style.top = `${tile.row * cellH}px`;
      el.style.width = `${tile.w * cellW}px`;
      el.style.height = `${tile.h * cellH}px`;
      el.tabIndex = 0;
      el.dataset.name = name;
      const label = document.createElement('span');
      label.className = 'gui-tile-name'; label.textContent = name;
      const size = document.createElement('span');
      size.className = 'gui-tile-size'; size.textContent = `${tile.w}×${tile.h}`;
      const handle = document.createElement('div');
      handle.className = 'gui-tile-resize';
      handle.setAttribute('aria-hidden', 'true');
      el.append(label, size, handle);
      grid.appendChild(el);
    }
    hint.textContent = describe();
  }

  function commit(next: TileMap) {
    tiles = next;
    draw();
    options.onChange(tiles);
  }

  // ---- pointer drag: move from anywhere on a tile, resize from its corner ----
  let drag: {
    name: string; mode: 'move' | 'resize'; startX: number; startY: number;
    origin: Tile; cellW: number; cellH: number; pointer: number; target: HTMLElement;
  } | null = null;

  grid.addEventListener('pointerdown', event => {
    const target = (event.target as HTMLElement).closest('.gui-tile') as HTMLElement | null;
    if (!target || event.button !== 0) return;
    const name = target.dataset.name!;
    const tile = tiles[name];
    if (!tile) return;
    event.preventDefault();
    target.focus();
    drag = {
      name,
      mode: (event.target as HTMLElement).classList.contains('gui-tile-resize')
        ? 'resize' : 'move',
      startX: event.clientX, startY: event.clientY, origin: { ...tile },
      cellW: grid.clientWidth / columns, cellH: rowPx(),
      pointer: event.pointerId, target,
    };
    target.classList.add('dragging');
    grid.setPointerCapture(event.pointerId);
  });

  grid.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.pointer) return;
    const dx = Math.round((event.clientX - drag.startX) / drag.cellW);
    const dy = Math.round((event.clientY - drag.startY) / drag.cellH);
    const next: Tile = drag.mode === 'move'
      ? { ...drag.origin, col: drag.origin.col + dx, row: drag.origin.row + dy }
      : { ...drag.origin, w: drag.origin.w + dx, h: drag.origin.h + dy };
    const settled = placeTile(tiles, drag.name, next, columns);
    // Redrawing on every move is what makes the other tiles visibly get out of
    // the way, which is the whole point of a packed grid.
    if (JSON.stringify(settled) !== JSON.stringify(tiles)) {
      tiles = settled;
      draw();
      const again = grid.querySelector<HTMLElement>(`[data-name="${CSS.escape(drag.name)}"]`);
      again?.classList.add('dragging');
      if (again) drag.target = again;
    }
  });

  const endDrag = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointer) return;
    drag.target.classList.remove('dragging');
    drag = null;
    options.onChange(tiles);
  };
  grid.addEventListener('pointerup', endDrag);
  grid.addEventListener('pointercancel', endDrag);

  // ---- keyboard: the same edits without a pointer ----
  grid.addEventListener('keydown', event => {
    const target = (event.target as HTMLElement).closest('.gui-tile') as HTMLElement | null;
    if (!target) return;
    const name = target.dataset.name!;
    const tile = tiles[name];
    if (!tile) return;
    const step = { ArrowLeft: [-1, 0], ArrowRight: [1, 0],
                   ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (!step) return;
    event.preventDefault();
    const next: Tile = event.shiftKey
      ? { ...tile, w: tile.w + step[0], h: tile.h + step[1] }
      : { ...tile, col: tile.col + step[0], row: tile.row + step[1] };
    commit(placeTile(tiles, name, next, columns));
    grid.querySelector<HTMLElement>(`[data-name="${CSS.escape(name)}"]`)?.focus();
  });

  stack.addEventListener('click', () => {
    // Start over: with no stored tiles, packLayout gives every widget a
    // full-width row in flowgraph order, which is the runner's own fallback.
    commit(packLayout(options.widgets, {}, columns));
  });

  // The grid's cell width is a fraction of its rendered width, so it has to be
  // redrawn when the dialog is resized -- including the first time it is shown,
  // when clientWidth was still 0 as the tiles were positioned.
  const observer = new ResizeObserver(() => { if (!drag) draw(); });
  observer.observe(grid);
  draw();

  return {
    tiles: () => tiles,
    destroy: () => { observer.disconnect(); root.remove(); },
  };
}
