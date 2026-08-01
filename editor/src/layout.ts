// Auto-arrange: rewrite every block coordinate so the flowgraph reads as a
// left-to-right flowchart.
//
// Kept free of DOM and of the editor's own types so it can be unit tested: the
// caller measures each block (box size, how far its port tabs stick out, and the
// y offset of every port) and gets back one coordinate per block.
//
// The shape of the result:
//   * the Options block sits in the top-left corner, and the blocks with no
//     connections at all (variables, notes, GUI widgets) flow after it;
//   * every connected chain then starts again at the left, one row group each;
//   * inside a row, blocks advance left to right by column, one column per step
//     away from the source, so a block always sits right of everything feeding it;
//   * a chain wider than MAX_ROW_WIDTH wraps to a fresh row underneath;
//   * a block is aligned on the wire into its first connected input, so that
//     wire comes out perfectly straight, and the blocks feeding one sink stack
//     vertically in port order.
//
// Blocks never overlap, and that falls out of the structure rather than from a
// separate pass: columns own disjoint horizontal bands (port tabs included), so
// keeping each column's blocks apart vertically is enough.

export interface LayoutNode {
  uid: string;
  w: number;
  h: number;
  /** How far the input port tabs stick out to the left of the box (0 if none). */
  leftPad: number;
  /** How far the output port tabs stick out to the right of the box (0 if none). */
  rightPad: number;
  /** y offset of each input port, relative to the block's top edge. */
  in: number[];
  /** y offset of each output port, relative to the block's top edge. */
  out: number[];
  /** The Options block: parked in the corner ahead of everything else. */
  pinned?: boolean;
}
export interface LayoutEdge { from: string; fp: number; to: string; tp: number }
export interface LayoutPosition { uid: string; x: number; y: number }

export const LAYOUT = {
  /** Padding between the canvas corner and the first block. */
  MARGIN: 10,
  // Left margin of a row a chain has *wrapped* into. The wire arriving from the
  // end of the previous row doubles back on itself and turns around to the left
  // of the port it comes into, which at the plain margin is drawn off the left
  // edge of the canvas, where nothing can scroll to it. The turnaround is much
  // narrower than wireShape()'s CTRL_MAX suggests — its bow is perpendicular, so
  // the loop is mostly vertical and measures ~31px wide on a full-width wrap —
  // so this only has to clear that, not the whole control-point distance.
  WRAP_MARGIN: 50,
  // Gap between one block's output tabs and the next block's input tabs. A wire
  // runs 15px straight out of its port and 15px straight into the next one
  // (render() in main.ts), and the arrowhead is 14px long at the 2px wire
  // stroke, so 30 is exactly the arrowhead plus a little line either side of it.
  WIRE_GAP: 30,
  /** Vertical gap between blocks stacked in the same column. */
  STACK_GAP: 20,
  /** Vertical gap between row groups, which is where wrap wires loop around. */
  ROW_GAP: 40,
  // Gap under the Options/variables row. Nothing is wired out of it, so it needs
  // no room for a wire and sits closer to the flowgraph than a row gap.
  HEADER_GAP: 20,
  /** A chain wider than this wraps back to the left on a new row. */
  MAX_ROW_WIDTH: 1700,
};
export type LayoutConfig = typeof LAYOUT;

const portOffset = (offsets: number[], index: number) => offsets[index] ?? offsets[0] ?? 0;
const push = <T>(map: Map<string, T[]>, key: string, value: T) => {
  const list = map.get(key); if (list) list.push(value); else map.set(key, [value]);
};

export function arrangeFlowgraph(
  nodes: LayoutNode[], edges: LayoutEdge[], config: Partial<LayoutConfig> = {},
): LayoutPosition[] {
  const cfg = { ...LAYOUT, ...config };
  const byUid = new Map(nodes.map(n => [n.uid, n]));
  const order = new Map(nodes.map((n, i) => [n.uid, i]));
  const rank = (uid: string) => order.get(uid) ?? 0;
  const links = edges.filter(e => byUid.has(e.from) && byUid.has(e.to) && e.from !== e.to);

  const incoming = new Map<string, LayoutEdge[]>();
  const neighbours = new Map<string, string[]>();
  for (const e of links) {
    push(incoming, e.to, e);
    push(neighbours, e.from, e.to);
    push(neighbours, e.to, e.from);
  }

  const placed = new Map<string, { x: number; y: number }>();
  let top = cfg.MARGIN;

  // ---- the Options block and every unconnected block: one plain flowing row ----
  const wired = new Set(links.flatMap(e => [e.from, e.to]));
  const loose = nodes.filter(n => !wired.has(n.uid))
    .sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || rank(a.uid) - rank(b.uid));
  if (loose.length) {
    let x = cfg.MARGIN, rowTop = top, rowH = 0;
    for (const n of loose) {
      const span = n.leftPad + n.w + n.rightPad;
      if (x > cfg.MARGIN && x - cfg.MARGIN + span > cfg.MAX_ROW_WIDTH) {
        rowTop += rowH + cfg.ROW_GAP; x = cfg.MARGIN; rowH = 0;
      }
      placed.set(n.uid, { x: x + n.leftPad, y: rowTop });
      x += span + cfg.WIRE_GAP;
      rowH = Math.max(rowH, n.h);
    }
    top = rowTop + rowH + cfg.HEADER_GAP;
  }

  // ---- every connected chain: its own row group, starting again at the left ----
  for (const component of components(nodes.filter(n => wired.has(n.uid)), neighbours, rank)) {
    const column = columnsOf(component, incoming, rank);
    const grouped: LayoutNode[][] = [];
    for (const n of component) (grouped[column.get(n.uid)!] ??= []).push(n);

    packRows(grouped, cfg).forEach((band, row) => {
      const bandOf = new Set(band.columns.flat().map(n => n.uid));
      // Rows the chain has wrapped into are indented, to leave the wire coming
      // back from the end of the row above somewhere to turn around.
      const x = columnOrigins(band.columns, row ? cfg.WRAP_MARGIN : cfg.MARGIN, cfg);
      const y = stackRow(band.columns, { incoming, byUid, column, bandOf, rank, cfg });
      const minY = Math.min(...[...y.values()]);
      let bottom = top;
      band.columns.forEach((group, c) => {
        for (const n of group) {
          const at = top + y.get(n.uid)! - minY;
          placed.set(n.uid, { x: x[c], y: at });
          bottom = Math.max(bottom, at + n.h);
        }
      });
      top = bottom + cfg.ROW_GAP;
    });
  }

  return nodes.map(n => ({ uid: n.uid, ...(placed.get(n.uid) ?? { x: cfg.MARGIN, y: cfg.MARGIN }) }));
}

/** Weakly connected components, each in the caller's block order. */
function components(nodes: LayoutNode[], neighbours: Map<string, string[]>,
                    rank: (uid: string) => number): LayoutNode[][] {
  const byUid = new Map(nodes.map(n => [n.uid, n]));
  const seen = new Set<string>();
  const out: LayoutNode[][] = [];
  for (const start of nodes) {
    if (seen.has(start.uid)) continue;
    const group: LayoutNode[] = [];
    const queue = [start.uid];
    seen.add(start.uid);
    while (queue.length) {
      const uid = queue.shift()!;
      group.push(byUid.get(uid)!);
      for (const next of neighbours.get(uid) ?? [])
        if (byUid.has(next) && !seen.has(next)) { seen.add(next); queue.push(next); }
    }
    out.push(group.sort((a, b) => rank(a.uid) - rank(b.uid)));
  }
  return out;
}

// One column per step away from the sources: a block sits one past the furthest
// block feeding it, so it is always drawn to the right of all of them. Feedback
// loops are broken by ignoring any edge that closes back onto the depth-first
// stack, which is also what keeps this terminating on a cyclic flowgraph.
function columnsOf(component: LayoutNode[], incoming: Map<string, LayoutEdge[]>,
                   rank: (uid: string) => number): Map<string, number> {
  const inComponent = new Set(component.map(n => n.uid));
  const feeders = (uid: string) => (incoming.get(uid) ?? [])
    .filter(e => inComponent.has(e.from))
    .sort((a, b) => a.tp - b.tp || a.fp - b.fp || rank(a.from) - rank(b.from));
  const column = new Map<string, number>();
  const onStack = new Set<string>();
  const depth = (uid: string): number => {
    const known = column.get(uid);
    if (known !== undefined) return known;
    if (onStack.has(uid)) return 0;                 // back edge: not a constraint
    onStack.add(uid);
    let c = 0;
    for (const e of feeders(uid))
      if (!onStack.has(e.from)) c = Math.max(c, depth(e.from) + 1);
    onStack.delete(uid);
    column.set(uid, c);
    return c;
  };
  for (const n of component) depth(n.uid);

  // Then pull every block as far right as its consumers allow. Left as it is
  // above, a source feeding a merge partway down a chain sits in the first
  // column with its wire running the whole width of the row past everything in
  // between; one column short of the block it feeds, it lands in the same column
  // as that block's other feeder, and the port-order stacking below then puts it
  // directly above or below it with no wires crossing.
  //
  // This can only move a block right, never left, so it keeps every block drawn
  // left of what it feeds: a block's column is already at least one less than
  // every column it feeds, and consumers are settled first (they sit in higher
  // columns, and the loop walks columns downwards).
  const consumers = new Map<string, string[]>();
  for (const uid of inComponent)
    for (const e of feeders(uid))
      if (column.get(e.from)! < column.get(uid)!) push(consumers, e.from, uid);
  for (const uid of [...inComponent].sort((a, b) => column.get(b)! - column.get(a)!)) {
    const fed = consumers.get(uid);
    if (fed?.length) column.set(uid, Math.min(...fed.map(c => column.get(c)!)) - 1);
  }
  return column;
}

interface RowBand { columns: LayoutNode[][] }
/** Cut the column sequence into rows no wider than MAX_ROW_WIDTH. */
function packRows(grouped: LayoutNode[][], cfg: LayoutConfig): RowBand[] {
  const rows: RowBand[] = [];
  let current: LayoutNode[][] = [], width = 0;
  for (const group of grouped) {
    if (!group?.length) continue;
    const span = extent(group);
    const added = current.length ? width + cfg.WIRE_GAP + span : span;
    if (current.length && added > cfg.MAX_ROW_WIDTH) {
      rows.push({ columns: current }); current = []; width = span;
    } else {
      width = added;
    }
    current.push(group);
  }
  if (current.length) rows.push({ columns: current });
  return rows;
}
const extent = (group: LayoutNode[]) =>
  Math.max(...group.map(n => n.leftPad)) + Math.max(...group.map(n => n.w)) +
  Math.max(...group.map(n => n.rightPad));

/** Left edge of each column's boxes; port tabs live in the gaps between them. */
function columnOrigins(columns: LayoutNode[][], margin: number, cfg: LayoutConfig): number[] {
  const origins: number[] = [];
  let x = margin;
  columns.forEach((group, c) => {
    x += Math.max(...group.map(n => n.leftPad));
    origins[c] = x;
    x += Math.max(...group.map(n => n.w)) + Math.max(...group.map(n => n.rightPad)) + cfg.WIRE_GAP;
  });
  return origins;
}

interface StackContext {
  incoming: Map<string, LayoutEdge[]>;
  byUid: Map<string, LayoutNode>;
  column: Map<string, number>;
  bandOf: Set<string>;
  rank: (uid: string) => number;
  cfg: LayoutConfig;
}
// Vertical placement inside one row, in coordinates that are normalized to the
// row's top afterwards. Walking backwards from the last column means a block's
// feeders are placed by the recursion, in input-port order, so several blocks
// feeding one sink come out stacked in that order. Each block then aligns on the
// wire into its first connected input — pushed down only when its column is
// already occupied, which is what keeps blocks off each other.
function stackRow(columns: LayoutNode[][], ctx: StackContext): Map<string, number> {
  const { incoming, byUid, column, bandOf, rank, cfg } = ctx;
  const y = new Map<string, number>();
  const cursor = new Map<number, number>();
  const busy = new Set<string>();
  const FREE = -1e9;
  const feeders = (n: LayoutNode) => (incoming.get(n.uid) ?? [])
    .filter(e => bandOf.has(e.from) && column.get(e.from)! < column.get(n.uid)!)
    .sort((a, b) => a.tp - b.tp || a.fp - b.fp || rank(a.from) - rank(b.from));
  const place = (n: LayoutNode) => {
    if (y.has(n.uid) || busy.has(n.uid)) return;
    busy.add(n.uid);
    const feeds = feeders(n);
    for (const e of feeds) place(byUid.get(e.from)!);
    busy.delete(n.uid);
    let wanted = 0;
    for (const e of feeds) {
      const src = byUid.get(e.from)!, at = y.get(src.uid);
      if (at === undefined) continue;
      wanted = at + portOffset(src.out, e.fp) - portOffset(n.in, e.tp);
      break;
    }
    const c = column.get(n.uid)!;
    const at = Math.max(wanted, cursor.get(c) ?? FREE);
    y.set(n.uid, at);
    cursor.set(c, at + n.h + cfg.STACK_GAP);
  };
  const firstFeed = (n: LayoutNode) => feeders(n)[0]?.fp ?? -1;
  const seeds = columns.flat().sort((a, b) =>
    column.get(b.uid)! - column.get(a.uid)! || firstFeed(a) - firstFeed(b) ||
    rank(a.uid) - rank(b.uid));
  for (const n of seeds) place(n);
  return y;
}
