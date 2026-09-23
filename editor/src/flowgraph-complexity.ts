import type { Conn, Inst } from './graph-model';

export interface ComplexityPort {
  optional: boolean;
}

export type ComplexityPortResolver =
  (block: Inst, kind: 'in' | 'out') => readonly ComplexityPort[];

/**
 * Native GRC's structural flowgraph-complexity heuristic, measured in Bálints.
 *
 * This deliberately preserves upstream's less obvious details: Options is
 * omitted from the per-block sum and block count but remains in the enabled
 * count, disabled blocks still contribute before the disabled multipliers are
 * applied, bypassed blocks count as enabled, and output fan-out includes
 * optional ports even though optional ports are absent from the port totals.
 */
export function calculateFlowgraphComplexity(
  blocks: readonly Inst[],
  connections: readonly Conn[],
  resolvePorts: ComplexityPortResolver,
): number | '<Error>' {
  try {
    const fanout = new Map<string, number>();
    for (const connection of connections) {
      const key = `${connection.from}:${connection.fp}`;
      fanout.set(key, (fanout.get(key) ?? 0) + 1);
    }

    let dbal = 0;
    for (const block of blocks) {
      if (block.id === 'options') continue;

      const sinkPorts = resolvePorts(block, 'in');
      const sourcePorts = resolvePorts(block, 'out');
      const sinks = sinkPorts.reduce((count, port) => count + Number(!port.optional), 0);
      const sources = sourcePorts.reduce((count, port) => count + Number(!port.optional), 0);
      const base = Math.max(Math.min(sinks, sources), 1);

      let blockConnections = 0;
      for (let index = 0; index < sourcePorts.length; ++index)
        blockConnections += fanout.get(`${block.uid}:${index}`) ?? 0;
      const sourceMultiplier = Math.max(blockConnections / Math.max(sources, 1), 1);

      let portRatioMultiplier = 1;
      if (Math.min(sinks, sources) > 0) {
        portRatioMultiplier = sinks / sources;
        if (portRatioMultiplier > 1) portRatioMultiplier = 1 / portRatioMultiplier;
      }

      dbal += base * portRatioMultiplier * sourceMultiplier;
    }

    // Native subtracts one for the Options block, while get_enabled_blocks()
    // below still includes it. Keep that asymmetry for calculation parity.
    const blockCount = blocks.length - 1;
    const connectionCount = connections.length;
    const enabledCount = blocks.reduce((count, block) => count + Number(block.enabled), 0);
    const byUid = new Map(blocks.map(block => [block.uid, block]));
    const enabledConnectionCount = connections.reduce((count, connection) => {
      const source = byUid.get(connection.from);
      const sink = byUid.get(connection.to);
      return count + Number(!!source?.enabled && !!sink?.enabled);
    }, 0);
    const disabledConnectionCount = connectionCount - enabledConnectionCount;

    const disabledMultiplier = enabledCount > 0
      ? 1 / Math.max(1 - ((blockCount - enabledCount) / Math.max(blockCount, 1)), 0.05)
      : 1;
    const connectionMultiplier = enabledConnectionCount > 0
      ? 1 / Math.max(1 - (disabledConnectionCount / Math.max(connectionCount, 1)), 0.05)
      : 1;

    const value = Math.max(
      (dbal - 1) * disabledMultiplier * connectionMultiplier * connectionCount,
      0,
    ) / 1_000_000;
    // For these non-negative values, toFixed(6) follows the same binary-float
    // boundary behavior as Python's round(value, 6); scaling first and calling
    // Math.round would incorrectly turn native's round(0.0000035, 6) == 0.000003
    // into 0.000004. Normalize -0 because JavaScript otherwise preserves it.
    const rounded = Number(value.toFixed(6));
    return Object.is(rounded, -0) ? 0 : rounded;
  } catch {
    return '<Error>';
  }
}
