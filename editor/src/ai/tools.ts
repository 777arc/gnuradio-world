import type { RunnableDef, ResolvedPort } from '../block-defs';
import { summarizeExampleFlowgraph, type ExampleFlowgraphSummary } from '../example-catalog';
import type { Conn, Inst, ValidationIssue } from '../graph-model';
import type { ExampleRecording } from '../recording-catalog';
import { parseGrc } from '../grc';
import {
  briefBlock, describeBlock, nonDefaultParams, searchCatalog,
  type CatalogDeps, type CatalogEntry,
} from './catalog';
import type { PlotCapture } from './capture';
import type { ToolDefinition } from './client';

export interface AiToolDeps {
  blocks(): Inst[];
  connections(): Conn[];
  entries(): CatalogEntry[];
  definition(instOrId: Inst | string): RunnableDef | undefined;
  ports(instOrId: Inst | string, kind: 'in' | 'out'): ResolvedPort[];
  validate(): ValidationIssue[];
  addBlock(id: string, name?: string): Inst;
  removeBlock(name: string): { removed: boolean; reason?: string };
  setParams(name: string, params: Record<string, unknown>): void;
  connect(from: string, output: string | number, to: string, input: string | number): void;
  disconnect(from: string, output: string | number, to: string, input: string | number): void;
  setEnabled(name: string, state: 'enabled' | 'disabled' | 'bypassed'): void;
  autoArrange(): void;
  replaceFlowgraph(grc: string): void;
  clearFlowgraph(): void;
  /**
   * Whose flowgraph is on the canvas: the example the editor opened by itself,
   * or something the user opened, built or edited. Optional so a harness need
   * not answer it; unanswered reads as the user's, which is the safe way for
   * `new_flowgraph` to be wrong.
   */
  canvasOrigin?(): 'default-example' | 'user';
  listExamples(): Promise<string[]>;
  readExample(path: string): Promise<string>;
  listRecordings(): Promise<ExampleRecording[]>;
  readRecordingMetadata(name: string): Promise<{
    recording: ExampleRecording;
    metadata: Record<string, unknown>;
  }>;
  inspectJsBlock(name: string): Promise<Record<string, unknown>>;
  createJsBlock(name: string | undefined, source: string): Promise<Record<string, unknown>>;
  setJsBlockSource(name: string, source: string): Promise<Record<string, unknown>>;
  forkJsBlock(name: string): Promise<Record<string, unknown>>;
  exerciseJsBlock(args: Record<string, unknown>): Promise<Record<string, unknown>>;
  saveJsBlock(name: string, id: string, label?: string, category?: string): Promise<Record<string, unknown>>;
  runFlowgraph(seconds: number, signal?: AbortSignal): Promise<Record<string, unknown>>;
  capturePlots(
    options: { block?: string; settleSeconds?: number }, signal?: AbortSignal,
  ): Promise<PlotCapture>;
  readPlotData(
    options: { block?: string; points?: number; settleSeconds?: number }, signal?: AbortSignal,
  ): Promise<Record<string, unknown>>;
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
    const result = deps.removeBlock(String(args.name));
    // A required singleton is refused, not removed. Reported rather than
    // thrown so the rest of the batch still runs -- see removeBlock in main.ts.
    return result.removed ? { removed: args.name }
      : { skipped: args.name, reason: result.reason };
  },
  set_params(deps, args) {
    const block = deps.blocks().find(item => item.name === String(args.name));
    if (!block) throw new Error(`no block named "${args.name}"`);
    const def = deps.definition(block)!;
    const valid = def.params.map(param => param.id);
    const unknown = Object.keys(args.params || {}).filter(id => !valid.includes(id));
    if (unknown.length)
      throw new Error(`no such parameter ${unknown.map(id => `"${id}"`).join(', ')} on "${block.name}"; valid ids are ${valid.join(', ')}`);
    const jsInternals = Object.keys(args.params || {}).filter(id =>
      id === '_source_code' || id === '_js_io' || id === '_js_source');
    if (block.id === 'wasm_js_block' && jsInternals.length)
      throw new Error(`use set_js_block_source for "${block.name}"; generic set_params cannot keep ${jsInternals.join(', ')} and the derived ports synchronized`);
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
const pmtValue = { anyOf: [
  { type: 'boolean' }, { type: 'number' }, { type: 'string' },
  { type: 'array', items: {} }, { type: 'object', additionalProperties: true },
], description: 'A plain JSON value converted to a PMT (strings become symbols, arrays vectors, and objects symbol-key dictionaries).' };

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
  tool('list_examples', 'List example flowgraphs available in this site with native Options/file metadata and structural counts. Supports bounded search and pagination; use read_example for the full .grc.', object({
    query: { type: 'string', description: 'Optional case-insensitive search across path, id, title, author, copyright, description, file format, and GNU Radio version. Every whitespace-separated term must match.' },
    offset: { type: 'integer', minimum: 0, default: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
  })),
  tool('read_example', 'Read one example .grc file by its listed path, together with its Options metadata and block/connection counts.', object({ path: text }, ['path'])),
  tool('list_recordings', 'List hosted example SigMF recordings from GNU Radio World\'s live recording index. Returns catalog metadata and the exact recording key used by GR World Recording; use get_recording_metadata for the complete SigMF global object and capture/annotation pages.', object({
    query: { type: 'string', description: 'Optional case-insensitive search across the recording key and catalog metadata. Every whitespace-separated term must match.' },
    offset: { type: 'integer', minimum: 0, default: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
  })),
  tool('get_recording_metadata', 'Fetch the SigMF metadata associated with one hosted recording key. The global object and other top-level fields are returned in full; captures and annotations default to the first 10 and are paged independently because either array can be unlimited.', object({
    recording: { type: 'string', description: 'Exact recording key returned by list_recordings (the .sigmf-data or .sigmf-meta suffix is also accepted).' },
    capture_offset: { type: 'integer', minimum: 0, default: 0 },
    capture_limit: { type: 'integer', minimum: 0, maximum: 100, default: 10 },
    annotation_offset: { type: 'integer', minimum: 0, default: 0 },
    annotation_limit: { type: 'integer', minimum: 0, maximum: 100, default: 10 },
  }, ['recording'])),
  tool('get_js_block_help', 'Return the browser JS Block authoring contract or one focused topic. Use this before writing an unfamiliar work/generalWork block; inspect_js_block is for a particular instance.', object({
    topic: { type: 'string', enum: ['overview', 'ports', 'scheduling', 'state', 'tags', 'messages', 'pmt', 'debugging', 'examples'], default: 'overview' },
  })),
  tool('inspect_js_block', 'Read one JavaScript-backed block instance: complete source, implementation kind, derived descriptor, current declared parameters and ports, source hash, and JS-specific warnings. Use this instead of reading _source_code through generic graph parameters.', object({ name: text }, ['name'])),
  tool('create_js_block', 'Create an inline JS Block from source. The source is sandbox-introspected before the canvas changes, so syntax or descriptor failures leave no half-created block.', object({
    name: { type: 'string', description: 'Optional unused instance name.' }, source: text,
  }, ['source'])),
  tool('set_js_block_source', 'Atomically replace an inline or browser-local JS Block source. Re-derives _js_io, parameters and ports, preserves matching parameter values and compatible wiring, and rejects invalid source without changing the graph. Repository JS blocks must first be forked.', object({ name: text, source: text }, ['name', 'source'])),
  tool('fork_js_block', 'Turn a shipped repository JavaScript block into an editable inline JS Block, preserving its name, current declared parameter values and compatible connections.', object({ name: text }, ['name'])),
  tool('exercise_js_block', 'Run bounded deterministic calls against a JS Block in a disposable Worker using the real JS runtime contract. Use before a visible run, especially for new or repaired code: unlike a live scheduler thread, this worker is terminated on a hang.', object({
    name: { type: 'string', description: 'Existing JS-backed block instance. Supply name or source.' },
    source: { type: 'string', description: 'Candidate source to exercise without applying it. Supply name or source.' },
    params: { type: 'object', additionalProperties: true, description: 'Construction-time parameter overrides.' },
    forecast_nout: { type: 'integer', minimum: 1, maximum: 4096 },
    messages: { type: 'array', maxItems: 16,
      description: 'Input messages delivered to registered handlers before work calls.',
      items: object({ port: text, value: pmtValue }, ['port', 'value']) },
    calls: { type: 'array', minItems: 0, maxItems: 8,
      description: 'Work calls to run; use an empty array when exercising a message-only block.',
      items: object({
        nout: { type: 'integer', minimum: 1, maximum: 4096, default: 8 },
        inputs: { type: 'array', description: 'One finite-number array per input port. Omitted values are zero-filled.', items: { type: 'array', items: { type: 'number' } } },
        set_params: { type: 'object', additionalProperties: { type: 'number' }, description: 'Numeric live updates applied immediately before this call.' },
        tags: { type: 'array', maxItems: 64,
          description: 'Absolute-offset input stream tags visible during this work call.',
          items: object({
            port: { type: 'integer', minimum: 0 },
            offset: { type: 'integer', minimum: 0 },
            key: pmtValue, value: pmtValue, srcid: pmtValue,
          }, ['port', 'offset', 'key', 'value']) },
      }) },
  })),
  tool('save_js_block', 'Install an inline or browser-local JS Block into the browser-local library and return the generated repository file pair. This writes IndexedDB but does not bypass the human JavaScript review required for a run.', object({
    name: text, id: text, label: text,
    category: { type: 'string', description: 'GRC category, for example [Custom JS Blocks]/Filters.' },
  }, ['name', 'id'])),
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
  tool('new_flowgraph', 'Discard the whole flowgraph on the canvas, leaving a blank one (Options, GUI Layout and samp_rate only). Only for a request for a whole new flowgraph that does not refer to what is open, and then before the first edit. Never to make room for something being added: adding, changing, fixing, explaining or running anything on the canvas is an edit to it, and clearing the user\'s own flowgraph destroys work they did not offer up.', object({})),
  tool('replace_flowgraph', 'Replace the entire canvas from native .grc YAML. Prefer granular edits unless building from scratch. Do not include the options block under `blocks:` -- it is the top-level `options:` key.', object({ grc: text }, ['grc'])),
  tool('validate', 'Return all current blocking and non-blocking validation issues.', object({})),
  tool('run_flowgraph', 'Run the current canvas visibly and observe diagnostics for 0.5–15 seconds. The graph remains running.', object({ seconds: { type: 'number', minimum: 0.5, maximum: 15, default: 3 } })),
  tool('read_plot_data', 'Read what the running flowgraph\'s GUI sinks are plotting, as numbers: each plot\'s axis titles and displayed range, and per trace its peak (x and y), min/max/mean and a decimated set of points. Spectrum Analyzer results also include each detected signal\'s exact center and peak frequencies, occupied bandwidth, ENBW-corrected total_power with power_unit, and peak level, without display formatting or rounding. This is the precise and cheap way to answer "where is the peak", "what is the total signal power", "is the tone at the right frequency" — prefer it over a screenshot for anything measurable. Needs a flowgraph that is still running.', object({
    block: { type: 'string', description: 'One GUI block by name; omit for every plot in the window.' },
    points: { type: 'integer', minimum: 4, maximum: 256, default: 32, description: 'Points sampled per trace.' },
    settle_seconds: { type: 'number', minimum: 0, maximum: 5, default: 0 },
  })),
  tool('capture_plots', 'Look at the running flowgraph: returns a screenshot of the GUI window as an image you can actually see. Use it for questions about shape that numbers answer badly — is the constellation tight, is the demodulator locked, does the waterfall show a signal, does the plot look wrong. It costs far more than read_plot_data, so use that one for anything measurable, and do not take a screenshot when the run report already answers the question. Needs a flowgraph that is still running.', object({
    block: { type: 'string', description: 'Crop to one GUI block by name; omit for the whole window.' },
    settle_seconds: { type: 'number', minimum: 0, maximum: 5, default: 1, description: 'Let the plots draw before looking; a waterfall needs a second or two.' },
  })),
];

/** Tools that answer with an image, and so need a model that can see one. */
const VISION_TOOLS = new Set(['capture_plots']);

/**
 * The tools to offer this provider and model. A model that cannot take an image
 * must not be handed a tool whose whole result is one: it would call it, and the
 * request carrying the answer would be refused by the endpoint.
 */
export const aiTools = (vision: boolean): ToolDefinition[] =>
  vision ? AI_TOOLS : AI_TOOLS.filter(entry => !VISION_TOOLS.has(entry.function.name));

/**
 * What reading the canvas needs, which is everything except the run harness —
 * so the panel can seed a message from the same dependency bundle it hands the
 * tools, without owning a runner to do it.
 */
export type AiReadDeps = Omit<AiToolDeps, 'runFlowgraph' | 'capturePlots' | 'readPlotData'>;

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
 * A screenshot, reported as a result plus an image. The result says what was
 * captured and names every widget in the window, because the picture alone does
 * not say which plot belongs to which block; the image arrives in the message
 * the agent loop appends after this one.
 */
const capture = (shot: PlotCapture): DispatchResult => ({
  mutated: false,
  value: {
    captured: `${shot.width}x${shot.height}`,
    ...(shot.block ? { cropped_to: shot.block } : {}),
    widgets: shot.widgets,
    ...(shot.notes.length ? { notes: shot.notes } : {}),
    image: 'attached to the next message',
  },
  images: [{
    dataUrl: shot.dataUrl,
    alt: shot.block
      ? `the running flowgraph's "${shot.block}" widget`
      : "the running flowgraph's GUI window",
  }],
});

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

export interface DispatchResult {
  mutated: boolean;
  value: unknown;
  /**
   * Images this call produced, kept out of `value` because a tool result is a
   * string on the wire: the agent loop attaches these as a separate message
   * carrying image parts. See `capture_plots` in agent.ts.
   */
  images?: { dataUrl: string; alt: string }[];
}

function exactExamplePath(paths: string[], requested: string): string {
  const normalized = requested.replace(/^\/+|\.grc$/g, '');
  const match = paths.find(path => path.replace(/\.grc$/, '') === normalized);
  if (!match) throw new Error(`no example named "${requested}"; call list_examples first`);
  return match;
}

const boundedInteger = (
  value: unknown, fallback: number, minimum: number, maximum: number, name: string,
): number => {
  if (value === undefined || value === null) return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < minimum || number > maximum)
    throw new Error(`${name} must be an integer from ${minimum} to ${maximum}`);
  return number;
};

const exampleSummary = (summary: ExampleFlowgraphSummary): Record<string, unknown> => ({
  path: summary.path,
  id: summary.id,
  title: summary.title,
  author: summary.author,
  copyright: summary.copyright,
  description: summary.description,
  file_format: summary.fileFormat,
  grc_version: summary.grcVersion,
  number_of_blocks: summary.blockCount,
  number_of_connections: summary.connectionCount,
});

async function loadExampleSummaries(
  deps: AiToolDeps, paths: string[],
): Promise<ExampleFlowgraphSummary[]> {
  return Promise.all(paths.map(async path => {
    try {
      return summarizeExampleFlowgraph(path, parseGrc(await deps.readExample(path)));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`example "${path}" could not be summarized: ${message}`);
    }
  }));
}

async function listExamples(deps: AiToolDeps, args: any): Promise<Record<string, unknown>> {
  const paths = await deps.listExamples();
  const summaries = await loadExampleSummaries(deps, paths);
  const query = String(args.query || '').trim().toLowerCase();
  const terms = query.split(/\s+/).filter(Boolean);
  const matching = terms.length ? summaries.filter(summary => {
    const haystack = JSON.stringify(exampleSummary(summary)).toLowerCase();
    return terms.every(term => haystack.includes(term));
  }) : summaries;
  const offset = boundedInteger(args.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
  const limit = boundedInteger(args.limit, 50, 1, 100, 'limit');
  const page = matching.slice(offset, offset + limit).map(exampleSummary);
  return {
    total: summaries.length,
    matched: matching.length,
    offset,
    returned: page.length,
    ...(offset + page.length < matching.length ? { next_offset: offset + page.length } : {}),
    examples: page,
  };
}

/** The useful index fields, named the way the SigMF index and block do. */
function recordingSummary(recording: ExampleRecording): Record<string, unknown> {
  return {
    recording: recording.name,
    title: recording.title,
    datatype: recording.datatype,
    sample_rate: recording.sampleRate,
    frequency: recording.frequency,
    capture_datetime: recording.captureDatetime,
    author: recording.author,
    description: recording.description,
    category: recording.category,
    tags: recording.tags,
    number_of_samples: recording.sampleCount,
    byte_length: recording.byteLength,
    number_of_annotations: recording.annotationCount,
    annotation_labels: recording.annotationLabels,
  };
}

async function listRecordings(deps: AiToolDeps, args: any): Promise<Record<string, unknown>> {
  const recordings = await deps.listRecordings();
  const query = String(args.query || '').trim().toLowerCase();
  const terms = query.split(/\s+/).filter(Boolean);
  const matching = terms.length ? recordings.filter(recording => {
    const haystack = JSON.stringify(recordingSummary(recording)).toLowerCase();
    return terms.every(term => haystack.includes(term));
  }) : recordings;
  const offset = boundedInteger(args.offset, 0, 0, Number.MAX_SAFE_INTEGER, 'offset');
  const limit = boundedInteger(args.limit, 50, 1, 100, 'limit');
  const page = matching.slice(offset, offset + limit).map(recordingSummary);
  return {
    total: recordings.length,
    matched: matching.length,
    offset,
    returned: page.length,
    ...(offset + page.length < matching.length ? { next_offset: offset + page.length } : {}),
    recordings: page,
  };
}

const pageInfo = (total: number, offset: number, returned: number) => ({
  total,
  offset,
  returned,
  ...(returned > 0 && offset + returned < total ? { next_offset: offset + returned } : {}),
});

const JS_HELP: Record<string, string> = {
  overview: `A JS Block calls gr.export({...}) exactly once and the descriptor is the block itself: gr.export({label:'X', inputs:['complex'], outputs:['complex'], params:{gain:1}, init(){}, start(){}, work(nout,input,output){ /* input[0], output[0] */ return nout; }}). There is no class or constructor form and no key naming one; gr and pmt are injected, so never declare them. It needs at least one stream or message port. Stream ports are dtype strings in declaration order -- inputs:['complex'], outputs:['float'] -- or {dtype,vlen}; there is no {name,type} port object. A stream block defines exactly one of work(nout,input,output) or generalWork(nout,nin,input,output); a message-only block may omit both. Optional fields are label, doc, params, decimation, interpolation, history, outputMultiple, relativeRate, forecast, init, start and stop. init() declares message ports/handlers, tag propagation and scheduler settings with GNU Radio's native method names. Imports are not supported. Use the tags, messages and pmt help topics for those APIs, and use inspect_js_block, set_js_block_source and exercise_js_block rather than editing hidden cache parameters.`,
  ports: `Ports are 'complex', 'float', 'int', 'short', 'byte', or {dtype,vlen}. complex and float are Float32Array; complex is interleaved I/Q and therefore has 2*nout*vlen scalar elements. int, short and byte use Int32Array, Int16Array and Int8Array. Never keep an input/output view after the current call returns.`,
  scheduling: `work(nout,input,output) is sync-like, in that argument order. It receives nout plus nout*decimation/interpolation input items and returning r consumes r*decimation/interpolation. generalWork() receives per-port nin and consumes nothing automatically: call this.consume(port,n) on every progress path. Return the number of output items produced, from 0 through nout. forecast(nout,required) fills one required count per input.`,
  state: `The source is evaluated once on the main thread for its descriptor and again on the block's scheduler thread. Mutable per-instance state belongs on this, normally initialized in start(); mutable top-level state is wrong. Scalar params arrive on this. Numeric params can be updated between work calls by QT GUI Range controls.`,
  tags: `In init(), choose gr.TPP_DONT, gr.TPP_ALL_TO_ALL, gr.TPP_ONE_TO_ONE or gr.TPP_CUSTOM with this.set_tag_propagation_policy(...). In work/generalWork, this.get_tags_in_window(port,relativeStart,relativeEnd[,key]) takes offsets relative to this call -- 0 through nout -- while this.get_tags_in_range(port,absoluteStart,absoluteEnd[,key]) takes absolute ones; both return owned {offset,key,value,srcid} objects whose offsets are absolute. this.nitems_read(port) and this.nitems_written(port) are exact counters; add output tags with this.add_item_tag(port, absoluteOffset, key, value[,srcid]). For custom propagation, the usual offset is this.nitems_written(0) + tag.offset - this.nitems_read(0). exercise_js_block accepts absolute-offset tags per work call and returns tags_added.`,
  messages: `Declare ports in init() with this.message_port_register_in(pmt.intern('in')) and this.message_port_register_out(pmt.intern('out')); attach a descriptor method with this.set_msg_handler(pmt.intern('in'), this.handle_message). A handler receives one owned PMT value and publishes synchronously with this.message_port_pub(pmt.intern('out'), value). Handlers run on the same scheduler thread as work(), may retain their input, and a message-only block needs no work function. A message from a QT GUI control is usually a (key . value) pair -- the Message Edit Box's default is pair mode -- so read the number with pmt.to_double(pmt.cdr(msg)) rather than from the message itself, and a handler that throws stops the flowgraph. exercise_js_block accepts top-level messages [{port,value}] and returns messages_received and messages_published; pass calls:[] for a message-only block.`,
  pmt: `The injected pmt global supports symbols; bool, long, real, uint64 and complex scalars; pairs/proper lists; dictionaries; vectors and tuples; every uniform vector type; and blobs. Common PDU construction is pmt.cons(metadata, payload), with pmt.car/cdr to read it. Plain strings become symbols, integral numbers longs, non-integral numbers reals, BigInts uint64s, arrays vectors, typed arrays matching uniform vectors, and plain objects symbol-key dictionaries. Use pmt.from_double(1) to keep an integral-valued real and pmt.from_uint64(1n) outside wasm32 signed-long range.`,
  debugging: `Use this.log(...) for the editor console; console.log from a scheduler worker reaches only devtools. Exercise candidate code with small deterministic arrays, input tags and messages before a live run because a live callback that never returns cannot be interrupted. The result includes outputs, consumed counts, messages_published and tags_added. Throughput proves progress, not signal correctness: use known exercise outputs or a Probe in the visible graph.`,
  examples: `Gain loop: for (let i=0;i<nout*2;i++) y[i]=x[i]*this.gain for complex, but only nout for float. Stateful transforms initialize this.previous in start(). A decimator reads x[i*decimation]. A general block computes n=Math.min(nout,...nin), writes n items, calls this.consume(0,n), and returns n. Repository examples include js_clip_cc, js_phase_unwrap_ff, js_peak_hold_ff and the message-only js_pdu_length; example_flowgraphs/javascript/js_tags_and_messages.grc demonstrates custom stream-tag propagation plus a PDU handler. Inspect or fork an instance to read complete source.`,
};

function jsHelp(topic: unknown): Record<string, unknown> {
  const key = String(topic || 'overview');
  if (!JS_HELP[key]) throw new Error(`unknown JS help topic "${key}"`);
  return { topic: key, contract: JS_HELP[key],
    topics: Object.keys(JS_HELP).filter(item => item !== key) };
}

async function recordingMetadata(deps: AiToolDeps, args: any): Promise<Record<string, unknown>> {
  const captureOffset = boundedInteger(
    args.capture_offset, 0, 0, Number.MAX_SAFE_INTEGER, 'capture_offset');
  const captureLimit = boundedInteger(args.capture_limit, 10, 0, 100, 'capture_limit');
  const annotationOffset = boundedInteger(
    args.annotation_offset, 0, 0, Number.MAX_SAFE_INTEGER, 'annotation_offset');
  const annotationLimit = boundedInteger(args.annotation_limit, 10, 0, 100, 'annotation_limit');
  const { recording, metadata } = await deps.readRecordingMetadata(String(args.recording || ''));
  const captures = Array.isArray(metadata.captures) ? metadata.captures : [];
  const annotations = Array.isArray(metadata.annotations) ? metadata.annotations : [];
  const capturePage = captures.slice(captureOffset, captureOffset + captureLimit);
  const annotationPage = annotations.slice(annotationOffset, annotationOffset + annotationLimit);
  return {
    recording: recordingSummary(recording),
    metadata: { ...metadata, captures: capturePage, annotations: annotationPage },
    pages: {
      captures: pageInfo(captures.length, captureOffset, capturePage.length),
      annotations: pageInfo(annotations.length, annotationOffset, annotationPage.length),
    },
  };
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
      const params = def ? nonDefaultParams(block, def) : { ...block.params };
      let javascript: Record<string, unknown> | undefined;
      if (block.id === 'wasm_js_block') {
        const source = String(block.params._js_source || block.params._source_code || '');
        delete params._source_code;
        delete params._js_source;
        delete params._js_io;
        javascript = {
          source_bytes: source.length,
          source_hash: lightweightSourceHash(source),
          source_omitted: 'call inspect_js_block with this instance name',
        };
      }
      return {
        name: block.name,
        id: block.id,
        params,
        ...(javascript ? { javascript } : {}),
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

function lightweightSourceHash(source: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0') + ':' + source.length;
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

/**
 * Whose graph this is, stated in the message rather than left to be guessed
 * from the wording of the request. The editor opens on the welcome example and
 * never on nothing, which is the whole reason `new_flowgraph` exists — but the
 * moment the canvas is the user's own, clearing it destroys work they did not
 * offer up, and "add a slider to this" reads as a build request often enough
 * for that to have happened.
 */
function canvasOriginText(deps: AiReadDeps): string {
  return deps.canvasOrigin?.() === 'default-example'
    ? `[canvas provenance] the example the editor loaded by itself at startup; the user ` +
      `has not opened, built or edited it. Clearing it for a from-scratch build is free.\n`
    : `[canvas provenance] the user's own flowgraph — they opened, built or edited it. ` +
      `It is not yours to discard: edit it, and do not call new_flowgraph unless they asked ` +
      `to start over or to replace this graph with a different one.\n`;
}

function canvasText(deps: AiReadDeps): string {
  if (!deps.blocks().length)
    return '[canvas] empty. Nothing is placed yet.';

  const origin = canvasOriginText(deps);
  const graph = flowgraphJson(deps);
  const json = JSON.stringify(graph);
  const canvas = origin + (json.length <= SEED_GRAPH_LIMIT
    ? `[canvas at the time of this message — the get_flowgraph result, already read for you. ` +
      `Your own edit results supersede it; call get_flowgraph only to re-read it]
${json}`
    : `[canvas] ${graph.blocks.length} blocks, ${graph.connections.length} connections, ` +
      `too large to include here — call get_flowgraph to read it.`);

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
    case 'list_examples': return { mutated: false, value: await listExamples(deps, args) };
    case 'read_example': {
      const paths = await deps.listExamples();
      const path = exactExamplePath(paths, String(args.path));
      const grc = await deps.readExample(path);
      const summary = summarizeExampleFlowgraph(path, parseGrc(grc));
      return { mutated: false, value: { ...exampleSummary(summary), grc } };
    }
    case 'list_recordings': return { mutated: false, value: await listRecordings(deps, args) };
    case 'get_recording_metadata': return {
      mutated: false, value: await recordingMetadata(deps, args),
    };
    case 'get_js_block_help': return { mutated: false, value: jsHelp(args.topic) };
    case 'inspect_js_block': return { mutated: false,
      value: await deps.inspectJsBlock(String(args.name)) };
    case 'create_js_block': return mutation(deps,
      await deps.createJsBlock(args.name === undefined ? undefined : String(args.name), String(args.source)));
    case 'set_js_block_source': return mutation(deps,
      await deps.setJsBlockSource(String(args.name), String(args.source)));
    case 'fork_js_block': return mutation(deps, await deps.forkJsBlock(String(args.name)));
    case 'exercise_js_block': return { mutated: false,
      value: await deps.exerciseJsBlock(args as Record<string, unknown>) };
    case 'save_js_block': return { mutated: false, value: await deps.saveJsBlock(
      String(args.name), String(args.id), args.label === undefined ? undefined : String(args.label),
      args.category === undefined ? undefined : String(args.category)) };
    case 'apply_edits': return applyEdits(deps, args.edits);
    case 'new_flowgraph': deps.clearFlowgraph(); return mutation(deps, { cleared: true });
    case 'replace_flowgraph': deps.replaceFlowgraph(String(args.grc)); return mutation(deps, { replaced: true });
    case 'validate': return { mutated: false, value: issueJson(deps) };
    case 'run_flowgraph': return { mutated: false, value: await deps.runFlowgraph(Number(args.seconds || 3), signal) };
    case 'read_plot_data': return { mutated: false, value: await deps.readPlotData({
      block: args.block === undefined ? undefined : String(args.block),
      points: args.points === undefined ? undefined : Number(args.points),
      settleSeconds: args.settle_seconds === undefined ? undefined : Number(args.settle_seconds),
    }, signal) };
    case 'capture_plots': return capture(await deps.capturePlots({
      block: args.block === undefined ? undefined : String(args.block),
      settleSeconds: args.settle_seconds === undefined ? undefined : Number(args.settle_seconds),
    }, signal));
    default: {
      // The single-edit tools are `EDITS` reported one at a time; a batch is
      // the same functions with one validation pass at the end.
      const edit = EDITS[name];
      if (edit) return mutation(deps, edit(deps, args));
      throw new Error(`unknown tool "${name}"`);
    }
  }
}
