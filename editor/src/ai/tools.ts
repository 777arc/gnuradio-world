import type { RunnableDef, ResolvedPort } from '../block-defs';
import type { Conn, Inst, ValidationIssue } from '../graph-model';
import {
  briefBlock, describeBlock, nonDefaultParams, searchCatalog,
  type CatalogDeps, type CatalogEntry,
} from './catalog';
import type { ToolDefinition } from './client';

export interface AiToolDeps {
  blocks(): Inst[];
  connections(): Conn[];
  entries(): CatalogEntry[];
  definition(instOrId: Inst | string): RunnableDef | undefined;
  ports(instOrId: Inst | string, kind: 'in' | 'out'): ResolvedPort[];
  validate(): ValidationIssue[];
  addBlock(id: string, name?: string): Inst;
  removeBlock(name: string): void;
  setParams(name: string, params: Record<string, unknown>): void;
  connect(from: string, output: string | number, to: string, input: string | number): void;
  disconnect(from: string, output: string | number, to: string, input: string | number): void;
  setEnabled(name: string, state: 'enabled' | 'disabled' | 'bypassed'): void;
  autoArrange(): void;
  replaceFlowgraph(grc: string): void;
  listExamples(): Promise<string[]>;
  readExample(path: string): Promise<string>;
  runFlowgraph(seconds: number, signal?: AbortSignal): Promise<Record<string, unknown>>;
}

/**
 * The edits themselves, apart from how they are reported. One tool call per
 * edit and one carrying a whole batch run exactly this code; what the batch
 * saves is a round-trip and a validation pass per edit, and a turn's cost is
 * set by its round count because every round resends the transcript.
 */
const EDITS: Record<string, (deps: AiToolDeps, args: any) => unknown> = {
  add_block(deps, args) {
    const block = deps.addBlock(String(args.id), args.name === undefined ? undefined : String(args.name));
    return { name: block.name, id: block.id };
  },
  remove_block(deps, args) {
    deps.removeBlock(String(args.name));
    return { removed: args.name };
  },
  set_params(deps, args) {
    const block = deps.blocks().find(item => item.name === String(args.name));
    if (!block) throw new Error(`no block named "${args.name}"`);
    const def = deps.definition(block)!;
    const valid = def.params.map(param => param.id);
    const unknown = Object.keys(args.params || {}).filter(id => !valid.includes(id));
    if (unknown.length)
      throw new Error(`no such parameter ${unknown.map(id => `"${id}"`).join(', ')} on "${block.name}"; valid ids are ${valid.join(', ')}`);
    deps.setParams(block.name, args.params || {});
    return { name: block.name, params: args.params || {} };
  },
  connect(deps, args) {
    deps.connect(String(args.from), args.output, String(args.to), args.input);
    return { connected: args };
  },
  disconnect(deps, args) {
    deps.disconnect(String(args.from), args.output, String(args.to), args.input);
    return { disconnected: args };
  },
  set_enabled(deps, args) {
    deps.setEnabled(String(args.name), args.state);
    return { name: args.name, state: args.state };
  },
  auto_arrange(deps) {
    deps.autoArrange();
    return { arranged: deps.blocks().length };
  },
};

export const EDIT_OPS = Object.keys(EDITS);

const object = (properties: Record<string, unknown>, required: string[] = []) => ({
  type: 'object', properties, required, additionalProperties: false,
});
const text = { type: 'string' };
const port = { anyOf: [{ type: 'string' }, { type: 'integer', minimum: 0 }] };

const tool = (name: string, description: string, parameters: Record<string, unknown>): ToolDefinition => ({
  type: 'function', function: { name, description, parameters },
});

export const AI_TOOLS: ToolDefinition[] = [
  tool('get_flowgraph', 'Return the current canvas as compact JSON, including validation issues.', object({})),
  tool('search_blocks', 'Fuzzy-search runnable WebAssembly blocks by id, label, or category.', object({ query: text }, ['query'])),
  tool('describe_block', 'Return the exact editor-enforced parameters, ports, defaults, options, and documentation for one runnable block. Long API documentation is truncated unless full_docs is set.', object({
    id: text,
    full_docs: { type: 'boolean', description: 'Return the complete API documentation instead of the truncated head.' },
  }, ['id'])),
  tool('list_examples', 'List example flowgraph paths available in this site.', object({})),
  tool('read_example', 'Read one example .grc file by its listed path.', object({ path: text }, ['path'])),
  tool('apply_edits', 'Apply an ordered batch of canvas edits in one call. Prefer this over the single-edit tools whenever a change needs more than one of them: the batch is one request instead of one per edit, and it runs in order, so an add_block that names its block explicitly can be followed by the set_params and connect entries using that name. Stops at the first failing edit and reports its index; everything before it stays applied.', object({
    edits: {
      type: 'array', minItems: 1, description: 'Edits applied in order.',
      items: object({
        op: { type: 'string', enum: EDIT_OPS },
        id: { type: 'string', description: 'add_block: the runnable block id.' },
        name: { type: 'string', description: 'add_block (optional), remove_block, set_params, set_enabled: the instance name.' },
        params: { type: 'object', additionalProperties: true, description: 'set_params: declared parameter ids only.' },
        from: { type: 'string', description: 'connect, disconnect: source instance name.' },
        output: { ...port, description: 'connect, disconnect: source port label/id or index.' },
        to: { type: 'string', description: 'connect, disconnect: destination instance name.' },
        input: { ...port, description: 'connect, disconnect: destination port label/id or index.' },
        state: { type: 'string', enum: ['enabled', 'disabled', 'bypassed'], description: 'set_enabled: the new state.' },
      }, ['op']),
    },
  }, ['edits'])),
  tool('add_block', 'Add one runnable block with a unique name. Optionally request a specific unused instance name.', object({ id: text, name: text }, ['id'])),
  tool('remove_block', 'Remove a block and all its connections by instance name.', object({ name: text }, ['name'])),
  tool('set_params', 'Set declared parameters on a named block. Unknown parameter ids are rejected with the valid ids.', object({ name: text, params: { type: 'object', additionalProperties: true } }, ['name', 'params'])),
  tool('connect', 'Connect an output to an input using a port label/id or zero-based editor port index.', object({ from: text, output: port, to: text, input: port }, ['from', 'output', 'to', 'input'])),
  tool('disconnect', 'Disconnect one exact connection using names and port labels/indices.', object({ from: text, output: port, to: text, input: port }, ['from', 'output', 'to', 'input'])),
  tool('set_enabled', 'Set a block to enabled, disabled, or bypassed.', object({ name: text, state: { type: 'string', enum: ['enabled', 'disabled', 'bypassed'] } }, ['name', 'state'])),
  tool('auto_arrange', 'Lay out all blocks left-to-right so the edited canvas is readable.', object({})),
  tool('replace_flowgraph', 'Replace the entire canvas from native .grc YAML. Prefer granular edits unless building from scratch.', object({ grc: text }, ['grc'])),
  tool('validate', 'Return all current blocking and non-blocking validation issues.', object({})),
  tool('run_flowgraph', 'Run the current canvas visibly and observe diagnostics for 0.5–15 seconds. The graph remains running.', object({ seconds: { type: 'number', minimum: 0.5, maximum: 15, default: 3 } })),
];

/**
 * What reading the canvas needs, which is everything except the run harness —
 * so the panel can seed a message from the same dependency bundle it hands the
 * tools, without owning a runner to do it.
 */
export type AiReadDeps = Omit<AiToolDeps, 'runFlowgraph'>;

const catalogDeps = (deps: AiReadDeps): CatalogDeps => ({
  entries: deps.entries,
  definition: id => deps.definition(id),
  ports: (id, kind) => deps.ports(id, kind),
});

const issueJson = (deps: AiReadDeps) => deps.validate().map(issue => {
  const block = deps.blocks().find(item => item.uid === issue.uid);
  return {
    block: block?.name || issue.uid,
    field: issue.field,
    message: issue.message,
    blocking: issue.blocking,
  };
});

/**
 * Every edit reports validation, and mid-build a graph can carry dozens of
 * non-blocking issues that would otherwise be restated after each of them and
 * then resent on every later round. Blocking issues are what an edit has to
 * act on, so those go back in full and the rest go back as a count; `validate`
 * still returns all of them.
 */
const mutation = (deps: AiToolDeps, result: unknown, mutated = true) => {
  const issues = issueJson(deps);
  const blocking = issues.filter(issue => issue.blocking)
    .map(issue => ({ block: issue.block, field: issue.field, message: issue.message }));
  const nonBlocking = issues.length - blocking.length;
  return {
    mutated,
    value: {
      result,
      validation: { blocking, ...(nonBlocking ? { non_blocking: nonBlocking } : {}) },
    },
  };
};

/**
 * Runs a batch in order, stopping at the first failure rather than pressing on
 * — a later edit usually depends on an earlier one, and finishing a batch
 * around a hole leaves a canvas nobody asked for. What already applied stays
 * applied and is reported, because the turn's snapshot is what Ctrl+Z reverses,
 * not each edit.
 *
 * The report is deliberately not one entry per edit: an edit that did exactly
 * what it was told adds nothing the model does not already know. Only names
 * assigned by the editor, and the one failure, come back.
 */
function applyEdits(deps: AiToolDeps, edits: any[]): DispatchResult {
  if (!Array.isArray(edits) || !edits.length)
    throw new Error('apply_edits needs a non-empty edits array');
  const added: Record<string, string> = {};
  let applied = 0;
  let failed: Record<string, unknown> | undefined;

  for (const [index, edit] of edits.entries()) {
    const op = String(edit?.op || '');
    try {
      const run = EDITS[op];
      if (!run) throw new Error(`unknown op "${op || '(missing)'}"; valid ops are ${EDIT_OPS.join(', ')}`);
      const result = run(deps, edit) as any;
      if (op === 'add_block') added[result.name] = result.id;
      applied++;
    } catch (error) {
      failed = {
        index,
        op: op || null,
        error: error instanceof Error ? error.message : String(error),
        not_applied: edits.length - index - 1,
      };
      break;
    }
  }

  return mutation(deps, {
    applied,
    ...(Object.keys(added).length ? { added } : {}),
    ...(failed ? { failed } : {}),
  }, applied > 0);
}

export interface DispatchResult { mutated: boolean; value: unknown }

function exactExamplePath(paths: string[], requested: string): string {
  const normalized = requested.replace(/^\/+|\.grc$/g, '');
  const match = paths.find(path => path.replace(/\.grc$/, '') === normalized);
  if (!match) throw new Error(`no example named "${requested}"; call list_examples first`);
  return match;
}

/**
 * The canvas as the model sees it — one shape, whether it arrives as the
 * `get_flowgraph` result or as the context seeded into a user message.
 */
function flowgraphJson(deps: AiReadDeps) {
  const byUid = new Map(deps.blocks().map(block => [block.uid, block]));
  return {
    blocks: deps.blocks().map(block => {
      // A block whose definition cannot be resolved — one whose ports and
      // parameters come from its own source, mid-edit — reports what it holds
      // rather than taking the canvas read down with it.
      const def = deps.definition(block);
      return {
        name: block.name,
        id: block.id,
        params: def ? nonDefaultParams(block, def) : { ...block.params },
        enabled: block.enabled,
        bypassed: block.bypassed,
      };
    }),
    connections: deps.connections().map(connection => {
      const from = byUid.get(connection.from)!;
      const to = byUid.get(connection.to)!;
      const output = deps.ports(from, 'out')[connection.fp];
      const input = deps.ports(to, 'in')[connection.tp];
      return {
        from: from.name, output: output?.name || output?.id || connection.fp,
        to: to.name, input: input?.name || input?.id || connection.tp,
      };
    }),
    validation: issueJson(deps),
  };
}

/** Distinct block types whose parameters are worth seeding into a message. */
export const SEED_DEFINITION_LIMIT = 24;
/**
 * Byte ceilings for the seeded definitions, per type and in total. Not
 * decoration: `qtgui_time_sink_x` alone describes ten traces in six styling
 * parameters each and runs to 7.7 KB, so two GUI sinks would put 13 KB into
 * every user message and then resend it on every round of the turn. GRC's own
 * parameter order puts what a block does first and per-trace styling last, so
 * a head is the useful part — and, as with `API_DOC_LIMIT`, the truncation
 * says how to read the rest. The totals are set so an ordinary canvas with two
 * QT GUI sinks still describes every type on it: dropping one back out to a
 * describe_block round is the cost this exists to avoid, so the per-type head
 * does the trimming and the total is only a backstop.
 */
export const SEED_TYPE_BYTES = 2200;
export const SEED_DEFINITION_BYTES = 10_000;
/** Above this the canvas is summarized instead, rather than resent per message. */
export const SEED_GRAPH_LIMIT = 12_000;

/**
 * The canvas, and the parameter contract of the block types on it, as text
 * prepended to a user message.
 *
 * Nearly every turn opened by asking for the canvas and then for the
 * definitions of what it found there — two round-trips before any thinking,
 * spent on things the editor already had in hand. Seeding them costs the same
 * tokens the tool results would have cost, one round earlier, and lands in the
 * appended part of the conversation rather than the cached prefix.
 *
 * It degrades rather than growing without bound: a canvas too large to resend
 * per message becomes a one-line summary, and too many distinct block types
 * become none, in both cases naming the tool that reads the rest.
 */
export function canvasContext(deps: AiReadDeps): string {
  try {
    return canvasText(deps);
  } catch {
    // This runs on the submit path, where the tools do not: a seed that throws
    // would eat the user's message, and the model can still read the canvas
    // the way it always could.
    return '[canvas] could not be read here — call get_flowgraph.';
  }
}

function canvasText(deps: AiReadDeps): string {
  if (!deps.blocks().length)
    return '[canvas] empty. Nothing is placed yet.';

  const graph = flowgraphJson(deps);
  const json = JSON.stringify(graph);
  const canvas = json.length <= SEED_GRAPH_LIMIT
    ? `[canvas at the time of this message — the get_flowgraph result, already read for you. ` +
      `Your own edit results supersede it; call get_flowgraph only to re-read it]
${json}`
    : `[canvas] ${graph.blocks.length} blocks, ${graph.connections.length} connections, ` +
      `too large to include here — call get_flowgraph to read it.`;

  const ids = [...new Set(deps.blocks().map(block => block.id))];
  if (ids.length > SEED_DEFINITION_LIMIT)
    return `${canvas}

[block types] ${ids.length} distinct types on this canvas — ` +
      `call describe_block for the ones you need.`;

  const definitions: unknown[] = [];
  const omitted: string[] = [];
  let budget = SEED_DEFINITION_BYTES;
  for (const id of ids) {
    let brief;
    try { brief = seedDefinition(deps, id); } catch { omitted.push(id); continue; }
    const size = JSON.stringify(brief).length;
    if (size > budget) { omitted.push(id); continue; }
    budget -= size;
    definitions.push(brief);
  }

  return `${canvas}

[parameters and ports of the block types on this canvas — ` +
    `the describe_block results without documentation. Call describe_block for ` +
    `documentation, or for a type not listed here]
${JSON.stringify(definitions)}` +
    (omitted.length ? `\n[not included: ${omitted.join(', ')} — call describe_block]` : '');
}

/** One type's brief definition, with a head of its parameters if it is huge. */
function seedDefinition(deps: AiReadDeps, id: string): Record<string, unknown> {
  const brief = briefBlock(catalogDeps(deps), id);
  const params = brief.parameters as Record<string, unknown>[];
  let used = JSON.stringify({ ...brief, parameters: [] }).length;
  const kept: Record<string, unknown>[] = [];
  for (const param of params) {
    const size = JSON.stringify(param).length + 1;
    if (kept.length && used + size > SEED_TYPE_BYTES) break;
    used += size;
    kept.push(param);
  }
  if (kept.length === params.length) return brief;
  return {
    ...brief,
    parameters: kept,
    parameters_omitted: `${params.length - kept.length} further parameters; ` +
      `call describe_block with this id for the full list`,
  };
}

export async function dispatchAiTool(
  deps: AiToolDeps, name: string, args: any, signal?: AbortSignal,
): Promise<DispatchResult> {
  switch (name) {
    case 'get_flowgraph': return { mutated: false, value: flowgraphJson(deps) };
    case 'search_blocks': return { mutated: false, value: searchCatalog(deps.entries(), String(args.query || '')) };
    case 'describe_block': return { mutated: false, value:
      describeBlock(catalogDeps(deps), String(args.id), !!args.full_docs) };
    case 'list_examples': return { mutated: false, value: await deps.listExamples() };
    case 'read_example': {
      const paths = await deps.listExamples();
      const path = exactExamplePath(paths, String(args.path));
      return { mutated: false, value: { path, grc: await deps.readExample(path) } };
    }
    case 'apply_edits': return applyEdits(deps, args.edits);
    case 'replace_flowgraph': deps.replaceFlowgraph(String(args.grc)); return mutation(deps, { replaced: true });
    case 'validate': return { mutated: false, value: issueJson(deps) };
    case 'run_flowgraph': return { mutated: false, value: await deps.runFlowgraph(Number(args.seconds || 3), signal) };
    default: {
      // The single-edit tools are `EDITS` reported one at a time; a batch is
      // the same functions with one validation pass at the end.
      const edit = EDITS[name];
      if (edit) return mutation(deps, edit(deps, args));
      throw new Error(`unknown tool "${name}"`);
    }
  }
}
