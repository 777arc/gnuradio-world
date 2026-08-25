import { boundsBetween, boundsIntersect, type Point } from './selection';
import { constrainBlockPosition } from './grid';
import type { Inst } from './graph-model';
import type { EditorGraphState } from './editor-state';
import type { TrainingSession } from './training';
import type { CanvasConnectionController } from './canvas-connections';

interface Drag {
  inst: Inst;
  ox: number;
  oy: number;
  starts: Map<string, { x: number; y: number }>;
  natural: { x: number; y: number };
  moved: boolean;
}

interface Marquee {
  start: Point;
  initial: Set<string>;
  initialPrimary: string | null;
  rect: SVGRectElement;
  moved: boolean;
}

export interface CanvasGestureDeps {
  state: EditorGraphState;
  svg: SVGSVGElement;
  selectionLayer: HTMLElement;
  connections: CanvasConnectionController;
  zoom(): number;
  snapToGrid(): boolean;
  trainingSession(): TrainingSession | null;
  svgPoint(event: MouseEvent): Point;
  canvasBlockHidden(inst: Inst): boolean;
  geom(inst: Inst): { w: number; h: number };
  render(): void;
  select(uid: string | null, additive?: boolean): void;
  showProperties(inst: Inst): void;
  adoptTrainingTarget(actual: Inst, target: Inst): void;
  recordHistory(): void;
}

export class CanvasGestureController {
  private drag: Drag | null = null;
  private marquee: Marquee | null = null;
  private lastMouseDown: { uid: string; time: number } | null = null;
  private readonly marqueeSlop = 3;

  constructor(private readonly deps: CanvasGestureDeps) {
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.endPointerGesture);
    window.addEventListener('pointercancel', this.endPointerGesture);
    deps.svg.addEventListener('pointerdown', this.onCanvasPointerDown);
  }

  startDrag(event: PointerEvent, inst: Inst): void {
    event.stopPropagation();
    if (event.button !== 0) return;
    event.preventDefault();
    const now = Date.now();
    if (this.lastMouseDown?.uid === inst.uid && now - this.lastMouseDown.time < 350) {
      this.lastMouseDown = null;
      this.drag = null;
      this.deps.select(inst.uid);
      this.deps.showProperties(inst);
      return;
    }
    this.lastMouseDown = { uid: inst.uid, time: now };
    this.deps.select(inst.uid, event.shiftKey);
    if (!this.deps.state.selectedBlocks.has(inst.uid)) return;
    this.deps.trainingSession()?.clearSnapCandidate();
    this.capturePointer(event);
    const point = this.deps.svgPoint(event);
    this.drag = {
      inst,
      ox: point.x - inst.x,
      oy: point.y - inst.y,
      starts: new Map(this.deps.state.insts
        .filter(item => this.deps.state.selectedBlocks.has(item.uid))
        .map(item => [item.uid, { x: item.x, y: item.y }])),
      natural: { x: inst.x, y: inst.y },
      moved: false,
    };
  }

  private readonly onPointerMove = (event: PointerEvent): void => {
    if (this.deps.connections.active) {
      this.deps.connections.updatePreview(this.deps.svgPoint(event));
      return;
    }
    if (this.marquee) {
      this.updateMarquee(this.deps.svgPoint(event));
      return;
    }
    if (!this.drag) return;
    const point = this.deps.svgPoint(event);
    const primary = this.drag.starts.get(this.drag.inst.uid)!;
    const natural = constrainBlockPosition(
      point.x - this.drag.ox,
      point.y - this.drag.oy,
      this.deps.snapToGrid(),
    );
    this.drag.natural = natural;
    const training = this.deps.trainingSession();
    const state = this.deps.state;
    const snapTarget = state.selectedBlocks.size === 1
      ? training?.updateSnapCandidate(this.drag.inst, natural.x, natural.y, state.insts)
      : undefined;
    if (state.selectedBlocks.size !== 1) training?.clearSnapCandidate();
    const target = snapTarget ? { x: snapTarget.x, y: snapTarget.y } : natural;
    const dx = target.x - primary.x;
    const dy = target.y - primary.y;
    let moved = false;
    for (const inst of state.insts) {
      const start = this.drag.starts.get(inst.uid);
      if (!start) continue;
      const position = constrainBlockPosition(
        start.x + dx,
        start.y + dy,
        this.deps.snapToGrid(),
      );
      moved ||= position.x !== inst.x || position.y !== inst.y;
      inst.x = position.x;
      inst.y = position.y;
    }
    this.drag.moved ||= moved;
    this.deps.render();
  };

  private readonly endPointerGesture = (event: PointerEvent): void => {
    if (this.deps.svg.hasPointerCapture(event.pointerId))
      this.deps.svg.releasePointerCapture(event.pointerId);
    const collapsedPort = this.deps.connections.active
      ? this.deps.connections.cancel() : false;
    let redraw = false;
    const training = this.deps.trainingSession();
    if (this.drag) {
      const target = event.type === 'pointerup'
        ? training?.commitSnap(this.drag.inst.uid) : undefined;
      if (target) {
        this.deps.adoptTrainingTarget(this.drag.inst, target);
        redraw = true;
      } else if (training?.snapTargetForActual(this.drag.inst.uid)) {
        this.drag.inst.x = this.drag.natural.x;
        this.drag.inst.y = this.drag.natural.y;
        redraw = true;
      }
      training?.clearSnapCandidate();
      if (this.drag.moved || target) this.deps.recordHistory();
    }
    this.drag = null;
    this.marquee?.rect.remove();
    this.marquee = null;
    if (collapsedPort || redraw) this.deps.render();
  };

  private readonly onCanvasPointerDown = (event: PointerEvent): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    this.deps.connections.cancel();
    const additive = event.shiftKey || event.ctrlKey || event.metaKey;
    const state = this.deps.state;
    const initial = additive ? new Set(state.selectedBlocks) : new Set<string>();
    const initialPrimary = additive ? state.selected : null;
    if (!additive) {
      state.selectedBlocks.clear();
      state.selected = null;
    }
    state.selectedConnection = null;
    this.deps.render();
    if (event.pointerType === 'touch') return;
    this.capturePointer(event);
    const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
    rect.setAttribute('class', 'selection-box');
    rect.setAttribute('visibility', 'hidden');
    this.deps.selectionLayer.appendChild(rect);
    this.marquee = {
      start: this.deps.svgPoint(event), initial, initialPrimary, rect, moved: false,
    };
  };

  private updateMarquee(point: Point): void {
    if (!this.marquee) return;
    const box = boundsBetween(this.marquee.start, point);
    const { x, y, width, height } = box;
    if (!this.marquee.moved && Math.hypot(width, height) * this.deps.zoom() < this.marqueeSlop)
      return;
    this.marquee.moved = true;
    this.marquee.rect.setAttribute('x', String(x));
    this.marquee.rect.setAttribute('y', String(y));
    this.marquee.rect.setAttribute('width', String(width));
    this.marquee.rect.setAttribute('height', String(height));
    this.marquee.rect.removeAttribute('visibility');
    const next = new Set(this.marquee.initial);
    const hits: string[] = [];
    for (const inst of this.deps.state.insts) {
      if (this.deps.canvasBlockHidden(inst)) continue;
      const { w, h } = this.deps.geom(inst);
      if (boundsIntersect(box, { x: inst.x, y: inst.y, width: w, height: h })) {
        next.add(inst.uid);
        hits.push(inst.uid);
      }
    }
    if (sameSelection(next, this.deps.state.selectedBlocks)) return;
    this.deps.state.selectedBlocks = next;
    this.deps.state.selected = hits[hits.length - 1] ||
      (this.marquee.initialPrimary && next.has(this.marquee.initialPrimary)
        ? this.marquee.initialPrimary : ([...next].pop() || null));
    this.deps.state.selectedConnection = null;
    this.deps.render();
  }

  private capturePointer(event: PointerEvent): void {
    this.deps.svg.setPointerCapture(event.pointerId);
  }
}

function sameSelection(a: Set<string>, b: Set<string>): boolean {
  return a.size === b.size && [...a].every(uid => b.has(uid));
}
