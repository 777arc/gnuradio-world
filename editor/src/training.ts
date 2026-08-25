// Training mode is an immutable example flowgraph plus a small amount of
// progress: which real canvas block has filled each template slot. Ghosts are
// deliberately not Inst/Conn objects in the live graph, so they never leak into
// validation, Save, sharing, Copilot, or the runner.

import type { Conn, GraphSnapshot, Inst } from './graph-model';

export interface TrainingProgress {
  assignments: Record<string, string>;
}

export interface TrainingCounts {
  filledBlocks: number;
  totalBlocks: number;
  filledConnections: number;
  totalConnections: number;
}

export interface TrainingConnectionGuide {
  connection: Conn;
  from: Inst;
  to: Inst;
}

export const TRAINING_SNAP_ENTER = 50;
export const TRAINING_SNAP_EXIT = 70;

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value));

export class TrainingSession {
  readonly template: GraphSnapshot;
  private readonly targetByUid: Map<string, Inst>;
  private readonly requiredTargets: Inst[];
  private readonly systemIds: Set<string>;
  private assignments = new Map<string, string>();
  private candidate: { targetUid: string; actualUid: string } | null = null;

  constructor(template: GraphSnapshot, systemIds: Iterable<string>) {
    this.template = clone(template);
    this.systemIds = new Set(systemIds);
    this.targetByUid = new Map(this.template.insts.map(block => [block.uid, block]));
    this.requiredTargets = this.template.insts.filter(block => !this.systemIds.has(block.id));
  }

  capture(): TrainingProgress {
    return { assignments: Object.fromEntries(this.assignments) };
  }

  restore(progress?: TrainingProgress): void {
    this.assignments = new Map(Object.entries(progress?.assignments || {}));
    this.candidate = null;
  }

  private liveByUid(blocks: Inst[]): Map<string, Inst> {
    return new Map(blocks.map(block => [block.uid, block]));
  }

  private assignedActual(targetUid: string, blocks: Inst[]): Inst | undefined {
    const target = this.targetByUid.get(targetUid);
    if (target && this.systemIds.has(target.id))
      return blocks.find(block => block.uid === targetUid);
    const actualUid = this.assignments.get(targetUid);
    return actualUid ? blocks.find(block => block.uid === actualUid) : undefined;
  }

  targetForActual(actualUid: string): Inst | undefined {
    const targetUid = [...this.assignments].find(([, uid]) => uid === actualUid)?.[0];
    return targetUid ? this.targetByUid.get(targetUid) : undefined;
  }

  snapTargetForActual(actualUid: string): Inst | undefined {
    if (this.candidate?.actualUid !== actualUid) return undefined;
    return this.targetByUid.get(this.candidate.targetUid);
  }

  isSnapTarget(targetUid: string): boolean {
    return this.candidate?.targetUid === targetUid;
  }

  clearSnapCandidate(): void {
    this.candidate = null;
  }

  /**
   * Update the magnetic target for a freely dragged top-left position. The
   * wider exit radius keeps a block from flickering in and out at the boundary.
   */
  updateSnapCandidate(
    actual: Inst,
    x: number,
    y: number,
    blocks: Inst[],
    enterRadius = TRAINING_SNAP_ENTER,
    exitRadius = TRAINING_SNAP_EXIT,
  ): Inst | undefined {
    if (this.targetForActual(actual.uid)) {
      this.candidate = null;
      return undefined;
    }

    const distance = (target: Inst) => Math.hypot(x - target.x, y - target.y);
    if (this.candidate?.actualUid === actual.uid) {
      const current = this.targetByUid.get(this.candidate.targetUid);
      if (current && current.id === actual.id &&
          !this.assignedActual(current.uid, blocks) && distance(current) <= exitRadius)
        return current;
      this.candidate = null;
    }

    let closest: Inst | undefined;
    let closestDistance = Infinity;
    for (const target of this.requiredTargets) {
      if (target.id !== actual.id || this.assignedActual(target.uid, blocks)) continue;
      const d = distance(target);
      if (d <= enterRadius && d < closestDistance) {
        closest = target;
        closestDistance = d;
      }
    }
    this.candidate = closest ? { targetUid: closest.uid, actualUid: actual.uid } : null;
    return closest;
  }

  commitSnap(actualUid: string): Inst | undefined {
    if (this.candidate?.actualUid !== actualUid) return undefined;
    const target = this.targetByUid.get(this.candidate.targetUid);
    if (target) this.assignments.set(target.uid, actualUid);
    this.candidate = null;
    return target;
  }

  unfilledBlocks(blocks: Inst[]): Inst[] {
    return this.requiredTargets.filter(target =>
      !this.assignedActual(target.uid, blocks) && !this.isSnapTarget(target.uid));
  }

  reservedNames(blocks: Inst[]): Set<string> {
    return new Set(this.requiredTargets
      .filter(target => !this.assignedActual(target.uid, blocks))
      .map(target => target.name));
  }

  private actualUidForTarget(targetUid: string, blocks: Inst[]): string | undefined {
    return this.assignedActual(targetUid, blocks)?.uid;
  }

  private connectionSatisfied(connection: Conn, blocks: Inst[], connections: Conn[]): boolean {
    const from = this.actualUidForTarget(connection.from, blocks);
    const to = this.actualUidForTarget(connection.to, blocks);
    return !!from && !!to && connections.some(candidate =>
      candidate.from === from && candidate.fp === connection.fp &&
      candidate.to === to && candidate.tp === connection.tp);
  }

  connectionGuides(blocks: Inst[], connections: Conn[]): TrainingConnectionGuide[] {
    const live = this.liveByUid(blocks);
    const endpoint = (targetUid: string): Inst | undefined => {
      const actualUid = this.actualUidForTarget(targetUid, blocks);
      return actualUid ? live.get(actualUid) : this.targetByUid.get(targetUid);
    };
    const guides: TrainingConnectionGuide[] = [];
    for (const connection of this.template.conns) {
      if (this.connectionSatisfied(connection, blocks, connections)) continue;
      const from = endpoint(connection.from), to = endpoint(connection.to);
      if (from && to) guides.push({ connection, from, to });
    }
    return guides;
  }

  counts(blocks: Inst[], connections: Conn[]): TrainingCounts {
    const totalBlocks = this.requiredTargets.length;
    const remainingBlocks = this.requiredTargets.filter(target =>
      !this.assignedActual(target.uid, blocks)).length;
    const totalConnections = this.template.conns.length;
    const remainingConnections = this.template.conns.filter(connection =>
      !this.connectionSatisfied(connection, blocks, connections)).length;
    return {
      filledBlocks: totalBlocks - remainingBlocks,
      totalBlocks,
      filledConnections: totalConnections - remainingConnections,
      totalConnections,
    };
  }

  complete(blocks: Inst[], connections: Conn[]): boolean {
    const counts = this.counts(blocks, connections);
    return counts.filledBlocks === counts.totalBlocks &&
      counts.filledConnections === counts.totalConnections;
  }
}
