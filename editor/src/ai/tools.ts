import type { RunnableDef, ResolvedPort } from '../block-defs';
import type { Conn, Inst, ValidationIssue } from '../graph-model';
import { describeBlock, nonDefaultParams, searchCatalog, type CatalogEntry } from './catalog';
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
  tool('add_block', 'Add a runnable block with a unique name. Optionally request a specific unused instance name.', object({ id: text, name: text }, ['id'])),
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

const issueJson = (deps: AiToolDeps) => deps.validate().map(issue => {
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
const mutation = (deps: AiToolDeps, result: unknown) => {
  const issues = issueJson(deps);
  const blocking = issues.filter(issue => issue.blocking)
    .map(issue => ({ block: issue.block, field: issue.field, message: issue.message }));
  const nonBlocking = issues.length - blocking.length;
  return {
    mutated: true,
    value: {
      result,
      validation: { blocking, ...(nonBlocking ? { non_blocking: nonBlocking } : {}) },
    },
  };
};

export interface DispatchResult { mutated: boolean; value: unknown }

function exactExamplePath(paths: string[], requested: string): string {
  const normalized = requested.replace(/^\/+|\.grc$/g, '');
  const match = paths.find(path => path.replace(/\.grc$/, '') === normalized);
  if (!match) throw new Error(`no example named "${requested}"; call list_examples first`);
  return match;
}

export async function dispatchAiTool(
  deps: AiToolDeps, name: string, args: any, signal?: AbortSignal,
): Promise<DispatchResult> {
  switch (name) {
    case 'get_flowgraph': {
      const byUid = new Map(deps.blocks().map(block => [block.uid, block]));
      return { mutated: false, value: {
        blocks: deps.blocks().map(block => ({
          name: block.name,
          id: block.id,
          params: nonDefaultParams(block, deps.definition(block)!),
          enabled: block.enabled,
          bypassed: block.bypassed,
        })),
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
      } };
    }
    case 'search_blocks': return { mutated: false, value: searchCatalog(deps.entries(), String(args.query || '')) };
    case 'describe_block': return { mutated: false, value: describeBlock({
      entries: deps.entries,
      definition: id => deps.definition(id),
      ports: (id, kind) => deps.ports(id, kind),
    }, String(args.id), !!args.full_docs) };
    case 'list_examples': return { mutated: false, value: await deps.listExamples() };
    case 'read_example': {
      const paths = await deps.listExamples();
      const path = exactExamplePath(paths, String(args.path));
      return { mutated: false, value: { path, grc: await deps.readExample(path) } };
    }
    case 'add_block': {
      const block = deps.addBlock(String(args.id), args.name === undefined ? undefined : String(args.name));
      return mutation(deps, { name: block.name, id: block.id });
    }
    case 'remove_block': deps.removeBlock(String(args.name)); return mutation(deps, { removed: args.name });
    case 'set_params': {
      const block = deps.blocks().find(item => item.name === String(args.name));
      if (!block) throw new Error(`no block named "${args.name}"`);
      const def = deps.definition(block)!;
      const valid = def.params.map(param => param.id);
      const unknown = Object.keys(args.params || {}).filter(id => !valid.includes(id));
      if (unknown.length)
        throw new Error(`no such parameter ${unknown.map(id => `"${id}"`).join(', ')} on "${block.name}"; valid ids are ${valid.join(', ')}`);
      deps.setParams(block.name, args.params || {});
      return mutation(deps, { name: block.name, params: args.params || {} });
    }
    case 'connect':
      deps.connect(String(args.from), args.output, String(args.to), args.input);
      return mutation(deps, { connected: args });
    case 'disconnect':
      deps.disconnect(String(args.from), args.output, String(args.to), args.input);
      return mutation(deps, { disconnected: args });
    case 'set_enabled':
      deps.setEnabled(String(args.name), args.state);
      return mutation(deps, { name: args.name, state: args.state });
    case 'auto_arrange': deps.autoArrange(); return mutation(deps, { arranged: deps.blocks().length });
    case 'replace_flowgraph': deps.replaceFlowgraph(String(args.grc)); return mutation(deps, { replaced: true });
    case 'validate': return { mutated: false, value: issueJson(deps) };
    case 'run_flowgraph': return { mutated: false, value: await deps.runFlowgraph(Number(args.seconds || 3), signal) };
    default: throw new Error(`unknown tool "${name}"`);
  }
}
