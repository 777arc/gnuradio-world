import { RUNNABLE, type ResolvedPort, type RunnableDef } from './block-defs';
import { buildScope, evaluate as evalExpr, type Scope } from './expr';
import type { Conn, Inst, ValidationIssue } from './graph-model';

export interface GraphPortAccess {
  portCount(block: Inst, kind: 'in' | 'out'): number;
  portMeta(block: Inst, kind: 'in' | 'out', index: number): ResolvedPort;
  portType(block: Inst, kind: 'in' | 'out', index: number): string;
  // A block's definition, which for the Embedded Python Block is synthesized per
  // instance from its own source rather than looked up by block id. Everything
  // else here is already per instance, so the parameter checks below must be too.
  def(block: Inst): RunnableDef | undefined;
}

export const NAME_FIELD = '__name';
export const BLOCK_FIELD = '__block';

// Variable controls have no stream ports; they publish a numeric value that
// other blocks' numeric fields may reference by the control's block ID. The
// three qtgui controls run as live blocks in the runner; the plain `variable`
// block is inlined away by the runner's lowering step, so its value may itself
// reference another variable.
export const VARIABLE_CONTROL_IDS = new Set([
  'variable_qtgui_range', 'variable_qtgui_chooser', 'variable_qtgui_push_button',
  'variable_qtgui_check_box', 'variable_qtgui_entry',
]);
// Every block ID that can be the target of a numeric variable reference.
export const VARIABLE_IDS = new Set([...VARIABLE_CONTROL_IDS, 'variable']);

export function validateFlowgraph(
  blocks: Inst[],
  connections: Conn[],
  ports: GraphPortAccess,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const active = (block: Inst) => block.enabled && !block.bypassed;
  const activeNames = new Map<string, number>();
  for (const block of blocks.filter(active)) {
    const name = String(block.name || '').trim();
    activeNames.set(name, (activeNames.get(name) || 0) + 1);
  }
  const activeVariables = new Set(blocks
    .filter(block => active(block) && VARIABLE_IDS.has(block.id) &&
      activeNames.get(String(block.name || '').trim()) === 1)
    .map(block => String(block.name || '').trim()));

  const add = (block: Inst, field: string, message: string, connection?: Conn) => {
    if (!issues.some(issue => issue.uid === block.uid && issue.field === field &&
      issue.message === message && issue.connection === connection))
      issues.push({ uid: block.uid, field, message, blocking: active(block), connection });
  };
  const finiteNumber = (value: any) => {
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value !== 'string' || !value.trim()) return false;
    return Number.isFinite(Number(value.trim()));
  };

  // A numeric parameter may also hold a Python-subset expression (`samp_rate/2`,
  // `2*pi*fc`, `firdes.low_pass(...)`), so it is valid when it evaluates against
  // the flowgraph's variables. `staticScope` holds the plain `variable` blocks
  // only — the values the Run path can bake in — while `fullScope` adds the live
  // controls, and is used solely to explain the "expression around a live
  // control" case below.
  const activeBlocks = blocks.filter(active);
  const staticScope = buildScope(activeBlocks.filter(block => block.id === 'variable'));
  const fullScope = buildScope(activeBlocks);
  const evaluates = (value: any, scope: Scope) =>
    typeof value === 'string' && !!value.trim() && evalExpr(value.trim(), scope).ok;
  // The concrete number an expression resolves to, or null when it isn't one.
  const resolvedNumber = (value: any, scope: Scope): number | null => {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value !== 'string' || !value.trim()) return null;
    const result = evalExpr(value.trim(), scope);
    return result.ok && typeof result.value === 'number' && Number.isFinite(result.value)
      ? result.value : null;
  };

  for (const block of blocks) {
    const def = ports.def(block);
    if (!def) { add(block, BLOCK_FIELD, `Unknown block type "${block.id}".`); continue; }
    const name = String(block.name || '').trim();
    if (!name) add(block, NAME_FIELD, 'Block ID is required.');
    // Native's `validate_block_id` (grc/core/params/dtypes.py): an ID becomes a
    // Python identifier in generated code — and for the Options block, the whole
    // flowgraph's class and file name — so it has to look like one.
    else if (!/^[A-Za-z]\w*$/.test(name))
      add(block, NAME_FIELD,
        'Block ID must begin with a letter and may contain letters, numbers, and underscores.');
    else if (active(block) && (activeNames.get(name) || 0) > 1)
      add(block, NAME_FIELD, `Block ID "${name}" is used more than once.`);

    for (const param of def.params) {
      const value = block.params?.[param.id];
      if (param.type === 'number') {
        const variableReference = !VARIABLE_CONTROL_IDS.has(block.id) && typeof value === 'string' &&
          activeVariables.has(value.trim());
        if (!finiteNumber(value) && !variableReference && !evaluates(value, staticScope)) {
          // An expression the live controls *could* satisfy is still rejected:
          // the runner wires a control into a parameter only when the parameter
          // is exactly the control's ID, so `freq/2` would never track the
          // slider. Say so rather than reporting a generic bad expression.
          const liveOnly = !VARIABLE_CONTROL_IDS.has(block.id) && evaluates(value, fullScope);
          add(block, param.id, liveOnly
            ? `${param.label} may reference a live control only on its own, not inside an expression.`
            : `${param.label} must be a number, a variable ID, or an expression of them.`);
        }
      } else if (param.type === 'enum' && param.options?.length && !param.options.includes(String(value))) {
        add(block, param.id, `${param.label} has unsupported value "${String(value)}".`);
      }
    }

    // Mirror the constraints enforced by the C++ Range widget constructor.
    if (block.id === 'variable_qtgui_range') {
      const start = resolvedNumber(block.params.start, staticScope);
      const stop = resolvedNumber(block.params.stop, staticScope);
      const step = resolvedNumber(block.params.step, staticScope);
      const minLength = resolvedNumber(block.params.min_len, staticScope);
      if (start !== null && stop !== null && start > stop)
        add(block, 'stop', 'Range Stop must be greater than or equal to Start.');
      if (step !== null && step <= 0) add(block, 'step', 'Range Step must be greater than zero.');
      if (minLength !== null && minLength < 1)
        add(block, 'min_len', 'Minimum Length must be at least 1.');
    }
    if (block.id === 'blocks_selector') {
      const numInputs = resolvedNumber(block.params.num_inputs, staticScope);
      const numOutputs = resolvedNumber(block.params.num_outputs, staticScope);
      const inputIndex = resolvedNumber(block.params.input_index, staticScope);
      const outputIndex = resolvedNumber(block.params.output_index, staticScope);
      const vlen = resolvedNumber(block.params.vlen, staticScope);
      const positiveInteger = (value: number | null) =>
        value !== null && Number.isInteger(value) && value >= 1;
      if (numInputs !== null && !positiveInteger(numInputs))
        add(block, 'num_inputs', 'Number of Inputs must be a positive integer.');
      if (numOutputs !== null && !positiveInteger(numOutputs))
        add(block, 'num_outputs', 'Number of Outputs must be a positive integer.');
      if (vlen !== null && !positiveInteger(vlen))
        add(block, 'vlen', 'Vector Length must be a positive integer.');
      if (inputIndex !== null && numInputs !== null &&
          (!Number.isInteger(inputIndex) || inputIndex < 0 || inputIndex >= numInputs))
        add(block, 'input_index', 'Input Index must select an available input port.');
      if (outputIndex !== null && numOutputs !== null &&
          (!Number.isInteger(outputIndex) || outputIndex < 0 || outputIndex >= numOutputs))
        add(block, 'output_index', 'Output Index must select an available output port.');
    }
  }

  const byUid = new Map(blocks.map(block => [block.uid, block]));
  const occupiedInputs = new Map<string, Conn>();
  for (const connection of connections) {
    const source = byUid.get(connection.from), sink = byUid.get(connection.to);
    if (!source && !sink) continue;
    if (!source) { add(sink!, BLOCK_FIELD, 'Connection refers to a missing source block.', connection); continue; }
    if (!sink) { add(source, BLOCK_FIELD, 'Connection refers to a missing destination block.', connection); continue; }
    if (!active(source) || !active(sink)) continue;
    const sourceDef = RUNNABLE[source.id], sinkDef = RUNNABLE[sink.id];
    if (!sourceDef || !sinkDef) continue;
    if (!Number.isInteger(connection.fp) || connection.fp < 0 || connection.fp >= ports.portCount(source, 'out')) {
      add(source, BLOCK_FIELD, `Connection uses invalid output port ${connection.fp}.`, connection); continue;
    }
    if (!Number.isInteger(connection.tp) || connection.tp < 0 || connection.tp >= ports.portCount(sink, 'in')) {
      add(sink, BLOCK_FIELD, `Connection uses invalid input port ${connection.tp}.`, connection); continue;
    }
    const sourcePort = ports.portMeta(source, 'out', connection.fp);
    const sinkPort = ports.portMeta(sink, 'in', connection.tp);
    const sourceDomain = sourcePort.domain;
    const sinkDomain = sinkPort.domain;
    if (sourceDomain !== sinkDomain) {
      add(sink, BLOCK_FIELD, `Cannot connect ${sourceDomain} output to ${sinkDomain} input.`, connection);
      continue;
    }
    if (sourceDomain === 'stream') {
      // Only a *stream* input takes exactly one connection. A message input is a
      // subscriber list, and GRC lets any number of publishers post to it — which
      // is how several Probe Rates report into one Message Debug.
      const inputKey = `${sink.uid}:${connection.tp}`;
      if (occupiedInputs.has(inputKey))
        add(sink, BLOCK_FIELD, `Input port ${connection.tp} has more than one connection.`, connection);
      else occupiedInputs.set(inputKey, connection);

      const sourceType = ports.portType(source, 'out', connection.fp);
      const sinkType = ports.portType(sink, 'in', connection.tp);
      if (sourceType && sinkType && sourceType !== sinkType)
        add(sink, BLOCK_FIELD, `Connection type mismatch: ${sourceType} output to ${sinkType} input.`, connection);
      else {
        const sourceVlen = Number(sourcePort.vlen);
        const sinkVlen = Number(sinkPort.vlen);
        if (Number.isFinite(sourceVlen) && Number.isFinite(sinkVlen) && sourceVlen !== sinkVlen)
          add(sink, BLOCK_FIELD,
            `Connection vector-length mismatch: ${sourceVlen} output to ${sinkVlen} input.`,
            connection);
      }
    }
  }
  // Every port that is neither optional nor hidden needs a connection, exactly
  // as native GRC requires (grc/core/ports/port.py: "Port is not connected.").
  // A port's clones count individually, which is what makes a Selector's
  // configured multiplicity part of its topology rather than a drawing hint.
  // Only *disabled* blocks break a connection — a bypassed one is still wired
  // through, so it keeps both of its neighbours' ports satisfied — and a
  // bypassed block's own ports are not checked, matching GRC's `is_valid()`.
  for (const block of blocks.filter(active)) {
    if (!RUNNABLE[block.id]) continue;
    for (const kind of ['in', 'out'] as const) {
      const count = ports.portCount(block, kind);
      for (let index = 0; index < count; ++index) {
        const port = ports.portMeta(block, kind, index);
        if (port.optional || port.hidden) continue;
        const connected = connections.some(connection => {
          const near = kind === 'in' ? connection.tp : connection.fp;
          const attached = kind === 'in' ? connection.to : connection.from;
          const other = byUid.get(kind === 'in' ? connection.from : connection.to);
          return attached === block.uid && near === index && !!other?.enabled;
        });
        if (!connected)
          add(block, BLOCK_FIELD,
            `${kind === 'in' ? 'Input' : 'Output'} port "${port.name}" is not connected.`);
      }
    }
  }
  return issues;
}
