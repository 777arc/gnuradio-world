import type { Inst } from './graph-model';
import type { EditorGraphState } from './editor-state';

type PortKind = 'in' | 'out';
type Edge = 'L' | 'R' | 'T' | 'B';

export interface CanvasConnectionDeps {
  state: EditorGraphState;
  wires: HTMLElement;
  portPosition(inst: Inst, kind: PortKind, index: number):
    { x: number; y: number; edge: Edge };
  controlPoint(edge: Edge, x: number, y: number, distance: number): [number, number];
  svgPoint(event: MouseEvent): { x: number; y: number };
  autoHidePortLabels(): boolean;
  render(): void;
  recordHistory(): void;
  log(message: string): void;
}

export class CanvasConnectionController {
  private connecting: { uid: string; port: number; kind: PortKind } | null = null;
  private preview: SVGPathElement | null = null;
  private downPoint: { x: number; y: number } | null = null;
  private hoveredPortKey: string | null = null;
  private readonly clickSlop = 4;

  constructor(private readonly deps: CanvasConnectionDeps) {}

  get active(): boolean {
    return this.connecting !== null;
  }

  portLabelHidden(key: string): boolean {
    return this.deps.autoHidePortLabels() && this.hoveredPortKey !== key;
  }

  bindPort(rect: SVGRectElement, inst: Inst, kind: PortKind, index: number): void {
    const hoverKey = `${inst.uid}:${kind}:${index}`;
    rect.addEventListener('pointerenter', () => {
      if (!this.deps.autoHidePortLabels() || this.connecting || this.hoveredPortKey === hoverKey)
        return;
      this.hoveredPortKey = hoverKey;
      this.deps.render();
    });
    rect.addEventListener('pointerleave', () => {
      if (!this.deps.autoHidePortLabels() || this.connecting || this.hoveredPortKey !== hoverKey)
        return;
      this.hoveredPortKey = null;
      this.deps.render();
    });
    rect.addEventListener('pointerdown', event => {
      if (event.button !== 0) return;
      event.stopPropagation();
      event.preventDefault();
      if (rect.hasPointerCapture(event.pointerId)) rect.releasePointerCapture(event.pointerId);
      if (this.connecting && !this.isSamePort(inst, kind, index)) {
        this.complete(inst, kind, index);
        return;
      }
      this.connecting = { uid: inst.uid, port: index, kind };
      this.downPoint = { x: event.clientX, y: event.clientY };
      this.deps.log(`connect from ${inst.name}:${index} …`);
      this.updatePreview(this.deps.svgPoint(event));
    });
    rect.addEventListener('pointerup', event => {
      if (!this.connecting) return;
      event.stopPropagation();
      if (this.isSamePort(inst, kind, index)) {
        const point = this.downPoint;
        if (point && Math.hypot(event.clientX - point.x, event.clientY - point.y) > this.clickSlop &&
            this.cancel())
          this.deps.render();
        return;
      }
      this.complete(inst, kind, index);
    });
  }

  updatePreview(point: { x: number; y: number }): void {
    if (!this.connecting) return;
    const inst = this.deps.state.insts.find(item => item.uid === this.connecting!.uid);
    if (!inst) {
      if (this.cancel()) this.deps.render();
      return;
    }
    const port = this.deps.portPosition(inst, this.connecting.kind, this.connecting.port);
    const x = inst.x + port.x;
    const y = inst.y + port.y;
    const [cx, cy] = this.deps.controlPoint(port.edge, x, y, 42);
    const path = `M${x},${y} C${cx},${cy} ${point.x},${point.y} ${point.x},${point.y}`;
    if (!this.preview) {
      this.preview = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      this.preview.setAttribute('class', 'wire connecting');
      this.preview.setAttribute('d', path);
      this.deps.wires.appendChild(this.preview);
    } else {
      this.preview.setAttribute('d', path);
    }
  }

  cancel(): boolean {
    const collapsedPort = this.deps.autoHidePortLabels() && this.hoveredPortKey !== null;
    this.connecting = null;
    this.downPoint = null;
    this.hoveredPortKey = null;
    this.preview?.remove();
    this.preview = null;
    return collapsedPort;
  }

  resetHover(): void {
    this.hoveredPortKey = null;
  }

  private isSamePort(inst: Inst, kind: PortKind, index: number): boolean {
    return !!this.connecting && this.connecting.uid === inst.uid &&
      this.connecting.port === index && this.connecting.kind === kind;
  }

  private complete(inst: Inst, kind: PortKind, index: number): void {
    if (!this.connecting) return;
    let output: { uid: string; port: number };
    let input: { uid: string; port: number };
    if (this.connecting.kind === 'out' && kind === 'in') {
      output = { uid: this.connecting.uid, port: this.connecting.port };
      input = { uid: inst.uid, port: index };
    } else if (this.connecting.kind === 'in' && kind === 'out') {
      output = { uid: inst.uid, port: index };
      input = { uid: this.connecting.uid, port: this.connecting.port };
    } else {
      if (this.cancel()) this.deps.render();
      return;
    }
    if (output.uid === input.uid) {
      if (this.cancel()) this.deps.render();
      return;
    }
    const state = this.deps.state;
    if (state.selectedConnection?.to === input.uid && state.selectedConnection.tp === input.port)
      state.selectedConnection = null;
    state.conns = state.conns.filter(
      connection => connection.to !== input.uid || connection.tp !== input.port);
    state.conns.push({ from: output.uid, fp: output.port, to: input.uid, tp: input.port });
    const outputBlock = state.insts.find(item => item.uid === output.uid)!;
    const inputBlock = state.insts.find(item => item.uid === input.uid)!;
    this.deps.log(`  → ${outputBlock.name}:${output.port}  to  ${inputBlock.name}:${input.port}`);
    this.cancel();
    this.deps.render();
    this.deps.recordHistory();
  }
}
