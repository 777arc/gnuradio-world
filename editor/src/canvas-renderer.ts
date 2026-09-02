import type { Conn, Inst, ValidationIssue } from './graph-model';
import type { EditorGraphState } from './editor-state';
import type { TrainingSession } from './training';
import { fieldIssue } from './validation-ui';
import { NOTE_ID, NOTE_BG_PARAM, normalizeNoteColor, isDarkNoteColor } from './note';

interface LayoutThumbTile {
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface BlockGeometry {
  d: { label: string };
  rows: { id: string; l: string; v: string; expression?: string }[];
  h: number;
  w: number;
  subtitle?: string;
  headH: number;
  thumb?: LayoutThumbTile[];
  thumbH?: number;
  thumbTop?: number;
}

const SVGNS = 'http://www.w3.org/2000/svg';
const svgEl = <K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string>,
): SVGElementTagNameMap[K] => {
  const element = document.createElementNS(SVGNS, tag);
  for (const key in attrs) element.setAttribute(key, attrs[key]);
  return element;
};

export interface CanvasRenderDeps {
  state: EditorGraphState;
  zoom: number;
  trainingSession: TrainingSession | null;
  trainingNodesG: HTMLElement;
  trainingWiresG: HTMLElement;
  nodesG: HTMLElement;
  wiresG: HTMLElement;
  selectionG: HTMLElement;
  rebuildScope(): void;
  validateGraph(): ValidationIssue[];
  canvasBlockHidden(inst: Inst): boolean;
  portMeta(inst: Inst, kind: 'in' | 'out', index: number): { hidden?: boolean };
  connectionPath(from: Inst, fromPort: number, to: Inst, toPort: number): string;
  cancelConnect(): boolean;
  selectConnection(conn: Conn): void;
  showConnectionMenu(x: number, y: number, conn: Conn): void;
  geom(inst: Inst): BlockGeometry;
  rowsTop(height: number, rows: number, headHeight?: number): number;
  blockCommentGeometry(inst: Inst): { lines: string[]; width: number; height: number };
  wrapValidationMessage(message: string, maxCharacters: number): string[];
  truncateToWidth(text: string, maxWidth: number, fontSize: number): string;
  startDrag(event: PointerEvent, inst: Inst): void;
  select(uid: string | null, additive?: boolean): void;
  showMenu(x: number, y: number, inst: Inst): void;
  visiblePortIndices(inst: Inst, kind: 'in' | 'out'): number[];
  addTrainingPort(group: SVGGElement, inst: Inst, kind: 'in' | 'out', index: number): void;
  addPort(group: SVGGElement, inst: Inst, kind: 'in' | 'out', index: number, color: string): void;
  portColor(inst: Inst, kind: 'in' | 'out', index: number): string;
  updateCanvasExtent(): void;
  syncRecordingTabs(): void;
  TITLE_BASELINE: number;
  SUBTITLE_H: number;
  TITLE_H: number;
  SUBTITLE_GAP: number;
  ROW_H: number;
  ROW_BASELINE: number;
  TEXT_PAD_L: number;
  MORE_ROW_ID: string;
  LAYOUT_THUMB_W: number;
  LAYOUT_THUMB_FONT: number;
  COMMENT_GAP: number;
  COMMENT_BASELINE: number;
  COMMENT_LINE_H: number;
  ERROR_LINE_H: number;
  ERROR_CHAR_W: number;
}

function renderTrainingGuides(deps: CanvasRenderDeps): void {
  const {
    state, trainingSession, trainingNodesG, trainingWiresG, portMeta,
    connectionPath, geom, visiblePortIndices, addTrainingPort,
  } = deps;
  const status = document.getElementById('trainingStatus')!;
  if (!trainingSession) {
    status.hidden = true;
    status.classList.remove('complete');
    document.querySelectorAll<HTMLButtonElement>('[data-tool="Execute"]')
      .forEach(button => button.disabled = false);
    return;
  }

  for (const guide of trainingSession.connectionGuides(state.insts, state.conns)) {
    if (portMeta(guide.from, 'out', guide.connection.fp).hidden ||
        portMeta(guide.to, 'in', guide.connection.tp).hidden) continue;
    trainingWiresG.appendChild(svgEl('path', { class: 'training-wire',
      d: connectionPath(guide.from, guide.connection.fp, guide.to, guide.connection.tp) }));
  }

  for (const target of trainingSession.unfilledBlocks(state.insts)) {
    const { d, h, w } = geom(target);
    const g = svgEl('g', { class: 'training-ghost',
      transform: `translate(${target.x},${target.y})` });
    g.appendChild(svgEl('rect', { class: 'body', width: String(w), height: String(h), rx: '2' }));
    const title = svgEl('text', { class: 'title', x: String(w / 2), y: String(h / 2),
      'text-anchor': 'middle', 'dominant-baseline': 'central' });
    title.textContent = d.label;
    g.appendChild(title);
    for (const i of visiblePortIndices(target, 'in')) addTrainingPort(g, target, 'in', i);
    for (const i of visiblePortIndices(target, 'out')) addTrainingPort(g, target, 'out', i);
    trainingNodesG.appendChild(g);
  }

  const counts = trainingSession.counts(state.insts, state.conns);
  const complete = trainingSession.complete(state.insts, state.conns);
  status.hidden = false;
  status.classList.toggle('complete', complete);
  status.textContent = complete
    ? `Training complete — ready to run`
    : `${counts.filledBlocks}/${counts.totalBlocks} blocks · ` +
      `${counts.filledConnections}/${counts.totalConnections} connections`;
  document.querySelectorAll<HTMLButtonElement>('[data-tool="Execute"]')
    .forEach(button => {
      button.disabled = !complete;
      button.title = complete ? 'Execute (F6)' : 'Complete the training flowgraph before running';
    });
}

export function renderCanvas(deps: CanvasRenderDeps): void {
  const {
    state, zoom, trainingSession, trainingNodesG, trainingWiresG, nodesG, wiresG,
    selectionG, rebuildScope, validateGraph, canvasBlockHidden, portMeta,
    connectionPath, cancelConnect, selectConnection, showConnectionMenu, geom, rowsTop,
    blockCommentGeometry, wrapValidationMessage, truncateToWidth, startDrag,
    select, showMenu, visiblePortIndices, addPort, portColor, updateCanvasExtent,
    syncRecordingTabs, TITLE_BASELINE, SUBTITLE_H, TITLE_H, SUBTITLE_GAP,
    ROW_H, ROW_BASELINE, TEXT_PAD_L, MORE_ROW_ID, LAYOUT_THUMB_W,
    LAYOUT_THUMB_FONT, COMMENT_GAP, COMMENT_BASELINE, COMMENT_LINE_H,
    ERROR_LINE_H, ERROR_CHAR_W,
  } = deps;
  rebuildScope();
  trainingNodesG.textContent = ''; trainingWiresG.textContent = '';
  nodesG.textContent = ''; wiresG.textContent = '';
  trainingNodesG.setAttribute('transform', `scale(${zoom})`);
  trainingWiresG.setAttribute('transform', `scale(${zoom})`);
  nodesG.setAttribute('transform', `scale(${zoom})`);
  wiresG.setAttribute('transform', `scale(${zoom})`);
  selectionG.setAttribute('transform', `scale(${zoom})`);
  const validation = validateGraph();
  const invalidConnections = new Set(validation.flatMap(issue => issue.connection ? [issue.connection] : []));
  const G = (uid: string) => state.insts.find(i => i.uid === uid)!;
  renderTrainingGuides(deps);
  // wires (from output right-edge to input left-edge, GRC-style curves)
  for (const c of state.conns) {
    const a = G(c.from), b = G(c.to);
    if (!a || !b || canvasBlockHidden(a) || canvasBlockHidden(b)) continue;
    if (portMeta(a, 'out', c.fp).hidden || portMeta(b, 'in', c.tp).hidden) continue;
    // As in native GRC: a straight 15px run out of each port, a cubic bezier,
    // then a straight approach in. Control points 50px out, except on a wire
    // that has to double back on itself — see wireShape().
    const d = connectionPath(a, c.fp, b, c.tp);
    const isSelected = c === state.selectedConnection || (state.insts.length > 0 && state.selectedBlocks.size === state.insts.length);
    const isInvalid = invalidConnections.has(c);
    const wire = svgEl('g', { class: 'wire-group' });
    // The invalid stroke colour wins over the selected one (its CSS rule is later),
    // so the arrowhead follows it too.
    wire.appendChild(svgEl('path', { class: 'wire' + (isSelected ? ' sel' : '') +
      (isInvalid ? ' invalid' : ''), d,
      'marker-end': isInvalid ? 'url(#arrow-invalid)'
        : isSelected ? 'url(#arrow-selected)' : 'url(#arrow)' }));
    // Match the desktop GUI's forgiving line hit test without drawing a thick wire.
    wire.appendChild(svgEl('path', { class: 'wire-hit', d }));
    const activateConn = (e: MouseEvent) => {
      e.preventDefault(); e.stopPropagation();
      cancelConnect();
      selectConnection(c);
      showConnectionMenu(e.clientX, e.clientY, c);
    };
    wire.addEventListener('pointerdown', e => { if (e.button !== 0) return; activateConn(e); });
    wire.addEventListener('contextmenu', activateConn);
    wiresG.appendChild(wire);
  }
  // blocks
  for (const inst of state.insts) {
    if (canvasBlockHidden(inst)) continue;
    const { d, rows, h, w, subtitle, headH, thumb, thumbH, thumbTop } = geom(inst);
    const comment = blockCommentGeometry(inst);
    const blockIssues = validation.filter(issue => issue.uid === inst.uid);
    const g = svgEl('g', { class: 'blk' + (state.selectedBlocks.has(inst.uid) ? ' sel' : '') +
      (trainingSession?.snapTargetForActual(inst.uid) ? ' training-snap' : '') +
      (inst.enabled ? '' : ' disabled') + (inst.bypassed ? ' bypassed' : '') +
      (blockIssues.length ? ' invalid' : ''),
      transform: `translate(${inst.x},${inst.y})` });
    const rect = svgEl('rect', { class: 'body', width: String(w), height: String(h), rx: '2' });
    g.appendChild(rect);
    // A Note's own background colour, browser-only and unique to this block. It
    // arrives as a custom property rather than an inline `fill` so the cascade
    // still decides: the tint outranks the selected fill (a note has to keep
    // looking like the colour just picked for it, and the selection stroke says
    // enough), and the disabled/bypassed/invalid fills outrank the tint, since
    // those states have to stay legible whatever colour the note carries.
    const tint = inst.id === NOTE_ID ? normalizeNoteColor(inst.params[NOTE_BG_PARAM]) : '';
    if (tint) {
      g.classList.add('note-tinted');
      if (isDarkNoteColor(tint)) g.classList.add('note-dark');
      g.style.setProperty('--note-bg', tint);
    }
    // Native GRC has no title separator. With no face parameters, center the
    // title in the whole block instead of leaving it in an empty title row.
    // With a subtitle it is the pair that gets centered, so the title rises by
    // half the line the subtitle occupies.
    const titleY = (rows.length || thumb) ? TITLE_BASELINE
      : h / 2 - (subtitle ? SUBTITLE_H / 2 : 0);
    const titleAttrs: Record<string, string> = {
      class: 'title', x: String(w / 2), y: String(titleY), 'text-anchor': 'middle',
    };
    // A thumbnail is body content too: keep its title on the same alphabetic
    // baseline as a block with parameter rows. Only a truly bodyless block
    // centres its title vertically in the whole face.
    if (!rows.length && !thumb) titleAttrs['dominant-baseline'] = 'central';
    const t = svgEl('text', titleAttrs);
    t.textContent = d.label; g.appendChild(t);
    if (subtitle) {
      const s = svgEl('text', { ...titleAttrs, class: 'subtitle',
                                y: String(titleY + SUBTITLE_GAP) });
      s.textContent = subtitle; g.appendChild(s);
    }
    // parameter rows: "label: value"
    rows.forEach((r, i) => {
      const y = rowsTop(h, rows.length, headH) + i * ROW_H + ROW_BASELINE;
      const tx = svgEl('text', { class: 'param' + (fieldIssue(blockIssues, inst.uid, r.id) ? ' invalid' : '') +
        (r.id === MORE_ROW_ID ? ' pmore' : ''), x: String(TEXT_PAD_L), y: String(y) });
      const l = document.createElementNS(SVGNS, 'tspan'); l.setAttribute('class', 'plabel'); l.textContent = r.l;
      if (r.expression !== undefined) {
        const expression = document.createElementNS(SVGNS, 'tspan');
        expression.setAttribute('class', 'pexpr'); expression.textContent = r.expression;
        tx.appendChild(l); tx.appendChild(expression);
        if (r.v) {
          const equals = document.createElementNS(SVGNS, 'tspan'); equals.textContent = '=';
          tx.appendChild(equals);
        }
      } else tx.appendChild(l);
      const v = document.createElementNS(SVGNS, 'tspan'); v.setAttribute('class', 'pval'); v.textContent = r.v;
      tx.appendChild(v); g.appendChild(tx);
    });
    // The GUI Layout block's miniature runner window: the grid outline plus one
    // labelled rectangle per widget, in the position it will occupy.
    if (thumb) {
      const top = thumbTop ?? TITLE_H;
      g.appendChild(svgEl('rect', { class: 'gui-thumb-frame', x: String(TEXT_PAD_L),
        y: String(top), width: String(LAYOUT_THUMB_W), height: String(thumbH ?? 0) }));
      for (const tile of thumb) {
        g.appendChild(svgEl('rect', { class: 'gui-thumb-tile',
          x: String(TEXT_PAD_L + tile.x + 1), y: String(top + tile.y + 1),
          width: String(Math.max(1, tile.w - 2)), height: String(Math.max(1, tile.h - 2)),
          rx: '1' }));
        // Only label a tile with room for a legible word; a 1x1 control tile in
        // a 12-column grid is 20px wide, where any text is noise.
        if (tile.w < 34 || tile.h < 11) continue;
        const label = svgEl('text', { class: 'gui-thumb-label',
          x: String(TEXT_PAD_L + tile.x + tile.w / 2),
          y: String(top + tile.y + tile.h / 2), 'text-anchor': 'middle',
          'dominant-baseline': 'central' });
        label.textContent = truncateToWidth(tile.name, tile.w - 6, LAYOUT_THUMB_FONT);
        g.appendChild(label);
      }
    }
    // Native GRC draws the comment as a separate text item below the body, not
    // as another parameter row. It therefore neither changes the block/port
    // geometry nor participates in block selection or dragging.
    comment.lines.forEach((line, i) => {
      const text = svgEl('text', { class: 'comment', x: '0',
        y: String(h + COMMENT_GAP + COMMENT_BASELINE + i * COMMENT_LINE_H) });
      text.textContent = line;
      g.appendChild(text);
    });
    const messages = [...new Set(blockIssues.map(issue => issue.message))];
    const wrapped = messages.flatMap(message => wrapValidationMessage(message, Math.max(22, Math.floor(w / ERROR_CHAR_W))));
    wrapped.slice(0, 5).forEach((message, i) => {
      const error = svgEl('text', { class: 'validation-error', x: '0',
        y: String(h + comment.height + ERROR_LINE_H * (i + 1)) });
      error.textContent = message; g.appendChild(error);
    });
    if (wrapped.length > 5) {
      const more = svgEl('text', { class: 'validation-error', x: '0',
        y: String(h + comment.height + ERROR_LINE_H * 6) });
      more.textContent = `+${wrapped.length - 5} more lines`; g.appendChild(more);
    }
    // Drag from anywhere on the block; ports stopPropagation so they still connect.
    g.addEventListener('pointerdown', e => startDrag(e, inst));
    // Hold a touch that grabbed this block (or one of its ports, which are its
    // children) so it drags or wires instead of panning the canvas out from
    // under itself: without this the browser claims the gesture, the pointer
    // stream ends in `pointercancel`, and the block stops two frames in.
    // `touch-action:none` is the declarative form and cannot do the job — Blink
    // applies the property to CSS boxes, and an SVG child element is not one.
    // Cancelling the *move* rather than the touch start is what leaves a
    // long-press free to raise the block's context menu.
    // It has to be bound here, per block, rather than once on the canvas: touch
    // events keep targeting the node the gesture began on even after render()
    // has replaced it, and a detached node's events reach no ancestor.
    g.addEventListener('touchmove', e => e.preventDefault(), { passive: false });
    g.addEventListener('contextmenu', e => { e.preventDefault(); e.stopPropagation(); if (!state.selectedBlocks.has(inst.uid)) select(inst.uid); showMenu(e.clientX, e.clientY, inst); });
    for (const i of visiblePortIndices(inst, 'in'))
      addPort(g, inst, 'in', i, portColor(inst, 'in', i));
    for (const i of visiblePortIndices(inst, 'out'))
      addPort(g, inst, 'out', i, portColor(inst, 'out', i));
    nodesG.appendChild(g);
  }
  updateCanvasExtent();
  syncRecordingTabs();   // one workspace tab per block with a recording behind it
}
