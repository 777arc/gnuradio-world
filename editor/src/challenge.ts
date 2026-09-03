// Challenge flowgraphs: the criteria a challenge states, and whether they are
// met. A challenge is an ordinary .grc carrying one Challenge block, whose
// `criteria` parameter is a JSON array of checks; passing one unlocks the next.
//
// Deliberately DOM-free and free of editor state, so it unit-tests under plain
// node the way training.ts does — see editor/test/challenge.test.mjs. Everything
// that needs the browser (the poll loop over a running flowgraph, the canvas
// checklist, the palette icons) lives in challenge-session.ts and main.ts.

import { evaluate as evalExpr, type Scope } from './expr';
import type { Conn, Inst } from './graph-model';

export const CHALLENGE_ID = 'wasm_challenge';
export const CHALLENGE_ID_PARAM = 'challenge_id';
export const CHALLENGE_TITLE_PARAM = 'title';
export const CHALLENGE_REQUIRES_PARAM = 'requires';
export const CHALLENGE_CRITERIA_PARAM = 'criteria';

/** One check. The per-kind fields are validated by parseChallenge(). */
export interface Criterion {
  kind: string;
  goal: string;
  [field: string]: unknown;
}

export interface ChallengeSpec {
  /** The progress key. Not the file name: renaming a challenge must not reset it. */
  id: string;
  title: string;
  /** `id` of the challenge that has to be passed first; empty for the first. */
  requires: string;
  criteria: Criterion[];
  /** Everything wrong with the authoring, as sentences. Never silently ignored. */
  errors: string[];
}

/** `pending` is a live criterion the current run has not shown yet. */
export type CriterionState = 'met' | 'unmet' | 'pending';

/** Criteria that need a running flowgraph, so a static pass cannot decide them. */
export const LIVE_KINDS: ReadonlySet<string> = new Set(['detected_signal', 'ran']);
const STATIC_KINDS: ReadonlySet<string> = new Set(['param', 'block_present', 'connected']);
export const isLiveKind = (kind: string): boolean => LIVE_KINDS.has(kind);

const DEFAULT_RAN_SECONDS = 2;

const active = (block: Inst): boolean => block.enabled && !block.bypassed;
const blockName = (block: Inst): string => String(block.name || '').trim();

// ---- parsing ---------------------------------------------------------------

const asString = (value: unknown): string => String(value ?? '').trim();
const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value);

/** The (single) Challenge block of a flowgraph, or undefined. */
export function challengeBlock(insts: readonly Inst[]): Inst | undefined {
  return insts.find(block => block.id === CHALLENGE_ID && active(block));
}

/**
 * The challenge a flowgraph states, or null when it states none. Never throws:
 * a criteria list that will not parse becomes an error on the spec, so the
 * editor can report it on the block rather than showing an empty checklist.
 */
export function parseChallenge(insts: readonly Inst[]): ChallengeSpec | null {
  const block = challengeBlock(insts);
  return block ? specFromParams(block.params ?? {}) : null;
}

/**
 * The same thing straight out of a parsed .grc, for the Example Flowgraphs
 * list: it fetches and parses every example already, and never turns one into
 * editor `Inst`s until the reader loads it.
 */
export function challengeFromGrc(flowgraph: unknown): ChallengeSpec | null {
  const blocks = (flowgraph as { blocks?: unknown })?.blocks;
  if (!Array.isArray(blocks)) return null;
  const block = blocks.find(entry =>
    entry && typeof entry === 'object' && String((entry as any).id) === CHALLENGE_ID);
  if (!block) return null;
  const params = (block as any).parameters;
  return specFromParams(params && typeof params === 'object' ? params : {});
}

function specFromParams(params: Record<string, unknown>): ChallengeSpec {
  const errors: string[] = [];
  const id = asString(params[CHALLENGE_ID_PARAM]);
  if (!id) errors.push('Challenge ID is required: it is the key this challenge’s progress is stored under.');
  const criteria: Criterion[] = [];
  const raw = asString(params[CHALLENGE_CRITERIA_PARAM]) || '[]';
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (error) {
    errors.push(`Success Criteria is not valid JSON: ${
      error instanceof Error ? error.message : String(error)}`);
    parsed = null;
  }
  if (parsed !== null) {
    if (!Array.isArray(parsed)) errors.push('Success Criteria must be a JSON array of criteria.');
    else parsed.forEach((entry, index) => {
      const where = `Criterion ${index + 1}`;
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        errors.push(`${where} must be a JSON object.`);
        return;
      }
      const criterion = entry as Criterion;
      const kind = asString(criterion.kind);
      if (!kind) { errors.push(`${where} has no "kind".`); return; }
      if (!STATIC_KINDS.has(kind) && !LIVE_KINDS.has(kind)) {
        errors.push(`${where} has unknown kind "${kind}"; expected one of ${
          [...STATIC_KINDS, ...LIVE_KINDS].join(', ')}.`);
        return;
      }
      if (!asString(criterion.goal))
        errors.push(`${where} ("${kind}") has no "goal" — every criterion needs the sentence the reader sees.`);
      errors.push(...fieldProblems(where, kind, criterion));
      criteria.push({ ...criterion, kind, goal: asString(criterion.goal) });
    });
  }
  return {
    id,
    title: asString(params[CHALLENGE_TITLE_PARAM]),
    requires: asString(params[CHALLENGE_REQUIRES_PARAM]),
    criteria,
    errors,
  };
}

/** Whatever a single criterion is missing, given its kind. */
function fieldProblems(where: string, kind: string, criterion: Criterion): string[] {
  const problems: string[] = [];
  const need = (field: string) => {
    if (!asString(criterion[field])) problems.push(`${where} ("${kind}") needs "${field}".`);
  };
  if (kind === 'param') {
    need('block'); need('param');
    const comparisons = ['equals', 'min', 'max', 'matches']
      .filter(field => criterion[field] !== undefined);
    if (!comparisons.length)
      problems.push(`${where} ("param") needs one of "equals", "min", "max" or "matches".`);
    if (criterion.matches !== undefined) {
      try { new RegExp(String(criterion.matches)); }
      catch (error) {
        problems.push(`${where} ("param") has an invalid "matches" pattern: ${
          error instanceof Error ? error.message : String(error)}`);
      }
    }
  } else if (kind === 'block_present') {
    need('id');
    if (criterion.count !== undefined && !(isNumber(criterion.count) && criterion.count >= 1))
      problems.push(`${where} ("block_present") has a "count" that is not a positive number.`);
  } else if (kind === 'connected') {
    need('from'); need('to');
  } else if (kind === 'detected_signal') {
    if (!isNumber(criterion.center_freq))
      problems.push(`${where} ("detected_signal") needs a numeric "center_freq".`);
    if (!isNumber(criterion.center_tol) || (criterion.center_tol as number) < 0)
      problems.push(`${where} ("detected_signal") needs a non-negative "center_tol".`);
    if (criterion.bandwidth !== undefined && !isNumber(criterion.bandwidth_tol))
      problems.push(`${where} ("detected_signal") states a "bandwidth" but no "bandwidth_tol"; a bandwidth with no slop can never match.`);
  } else if (kind === 'ran') {
    if (criterion.seconds !== undefined && !(isNumber(criterion.seconds) && criterion.seconds > 0))
      problems.push(`${where} ("ran") has a "seconds" that is not a positive number.`);
  }
  return problems;
}

/**
 * Criteria that name something the flowgraph does not contain. Separate from
 * parseChallenge() because it needs the graph, and it is the check that catches
 * the commonest authoring mistake of all: renaming a block the criteria address.
 */
export function unresolvedReferences(
  spec: ChallengeSpec, insts: readonly Inst[],
): string[] {
  const names = new Set(insts.filter(active).map(blockName));
  const problems: string[] = [];
  spec.criteria.forEach((criterion, index) => {
    const where = `Criterion ${index + 1}`;
    for (const field of ['block', 'from', 'to', 'sink']) {
      const name = asString(criterion[field]);
      if (!name || names.has(name)) continue;
      // A sink is optional and only pins one analyzer of several, but a name
      // that matches nothing still means the criterion can never pass.
      problems.push(`${where} ("${criterion.kind}") names block "${name}", which is not in this flowgraph.`);
    }
  });
  return problems;
}

/** Everything wrong with a challenge, authoring and references together. */
export function challengeProblems(spec: ChallengeSpec, insts: readonly Inst[]): string[] {
  return [...spec.errors, ...unresolvedReferences(spec, insts)];
}

// ---- static evaluation -----------------------------------------------------

/**
 * The concrete number a parameter holds, evaluating expressions against the
 * flowgraph's variables so `200`, `2*100` and a variable all agree. null when
 * the value is not numeric at all, which falls back to a string comparison.
 */
function numericValue(raw: unknown, scope: Scope): number | null {
  if (isNumber(raw)) return raw;
  const text = asString(raw);
  if (!text) return null;
  const result = evalExpr(text, scope);
  return result.ok && isNumber(result.value) ? result.value : null;
}

function paramMet(criterion: Criterion, insts: readonly Inst[], scope: Scope): boolean {
  const target = insts.find(block =>
    active(block) && blockName(block) === asString(criterion.block));
  if (!target) return false;
  const raw = target.params?.[asString(criterion.param)];
  if (raw === undefined) return false;
  if (criterion.matches !== undefined) {
    try { return new RegExp(String(criterion.matches)).test(String(raw)); }
    catch { return false; }
  }
  const actual = numericValue(raw, scope);
  if (criterion.equals !== undefined) {
    const wanted = numericValue(criterion.equals, scope);
    if (actual === null || wanted === null)
      return String(raw).trim() === String(criterion.equals).trim();
    const tolerance = isNumber(criterion.tolerance) ? Math.abs(criterion.tolerance) : 0;
    return Math.abs(actual - wanted) <= tolerance;
  }
  if (actual === null) return false;
  if (isNumber(criterion.min) && actual < criterion.min) return false;
  if (isNumber(criterion.max) && actual > criterion.max) return false;
  return true;
}

function blockPresentMet(criterion: Criterion, insts: readonly Inst[]): boolean {
  const wanted = isNumber(criterion.count) ? criterion.count : 1;
  const id = asString(criterion.id);
  return insts.filter(block => active(block) && block.id === id).length >= wanted;
}

function connectedMet(
  criterion: Criterion, insts: readonly Inst[], conns: readonly Conn[],
): boolean {
  const byUid = new Map(insts.map(block => [block.uid, block]));
  const from = asString(criterion.from), to = asString(criterion.to);
  return conns.some(conn => {
    const source = byUid.get(conn.from), sink = byUid.get(conn.to);
    if (!source || !sink || !active(source) || !active(sink)) return false;
    if (blockName(source) !== from || blockName(sink) !== to) return false;
    if (isNumber(criterion.from_port) && conn.fp !== criterion.from_port) return false;
    if (isNumber(criterion.to_port) && conn.tp !== criterion.to_port) return false;
    return true;
  });
}

/**
 * Where each criterion stands against the flowgraph as it is drawn. Live
 * criteria come back `pending`: nothing on the canvas can decide them, and the
 * run is what does — see evaluateLive().
 */
export function evaluateStatic(
  spec: ChallengeSpec,
  insts: readonly Inst[],
  conns: readonly Conn[],
  scope: Scope = {},
): CriterionState[] {
  return spec.criteria.map(criterion => {
    if (isLiveKind(criterion.kind)) return 'pending';
    const met =
      criterion.kind === 'param' ? paramMet(criterion, insts, scope) :
      criterion.kind === 'block_present' ? blockPresentMet(criterion, insts) :
      criterion.kind === 'connected' ? connectedMet(criterion, insts, conns) : false;
    return met ? 'met' : 'unmet';
  });
}

// ---- live evaluation -------------------------------------------------------

/** One entry of a Spectrum Analyzer's `detected_signals[]`. */
interface DetectedSignal {
  center_frequency?: number;
  peak_level?: number;
  total_power?: number;
  occupied_bandwidth_99?: number;
}
/** What readPlotData() returns: one entry per GUI sink that can report. */
export interface PlotData {
  widgets?: { name?: string; detected_signals?: DetectedSignal[] }[];
}

function detectedSignalMet(criterion: Criterion, plotData: PlotData | null): boolean {
  if (!plotData?.widgets?.length) return false;
  const sink = asString(criterion.sink);
  for (const widget of plotData.widgets) {
    if (sink && String(widget?.name ?? '') !== sink) continue;
    for (const signal of widget?.detected_signals || []) {
      const center = signal?.center_frequency;
      if (!isNumber(center) || !isNumber(criterion.center_freq) ||
          !isNumber(criterion.center_tol)) continue;
      if (Math.abs(center - criterion.center_freq) > criterion.center_tol) continue;
      if (isNumber(criterion.bandwidth)) {
        const width = signal?.occupied_bandwidth_99;
        const tolerance = isNumber(criterion.bandwidth_tol) ? criterion.bandwidth_tol : 0;
        if (!isNumber(width) || Math.abs(width - criterion.bandwidth) > tolerance) continue;
      }
      if (isNumber(criterion.min_peak_level) &&
          !(isNumber(signal?.peak_level) && signal.peak_level >= criterion.min_peak_level))
        continue;
      if (isNumber(criterion.min_total_power) &&
          !(isNumber(signal?.total_power) && signal.total_power >= criterion.min_total_power))
        continue;
      return true;
    }
  }
  return false;
}

/**
 * Where each live criterion stands right now, given the last plot-data snapshot
 * and how long this run has been going. Static criteria come back `pending`
 * here for the same reason live ones do in evaluateStatic(): this function is
 * not the one that decides them. Never returns `unmet` — a live criterion that
 * has not been seen yet is not the same as one that failed, and the reader is
 * still running the graph.
 */
export function evaluateLive(
  spec: ChallengeSpec,
  plotData: PlotData | null,
  runSeconds: number,
): CriterionState[] {
  return spec.criteria.map(criterion => {
    if (criterion.kind === 'ran') {
      const wanted = isNumber(criterion.seconds) ? criterion.seconds : DEFAULT_RAN_SECONDS;
      return runSeconds >= wanted ? 'met' : 'pending';
    }
    if (criterion.kind === 'detected_signal')
      return detectedSignalMet(criterion, plotData) ? 'met' : 'pending';
    return 'pending';
  });
}

/**
 * The two halves as one checklist. A live criterion keeps whatever the run has
 * latched; a static one is decided by the canvas alone, so it can go back to
 * `unmet` the moment the reader undoes the change that met it.
 */
export function mergeStates(
  staticStates: readonly CriterionState[],
  liveStates: readonly CriterionState[],
): CriterionState[] {
  return staticStates.map((state, index) =>
    state === 'pending' ? (liveStates[index] ?? 'pending') : state);
}

/** Latch this run's live results: once seen, a signal stays seen until it ends. */
export function latchLive(
  latched: readonly CriterionState[],
  fresh: readonly CriterionState[],
): CriterionState[] {
  return fresh.map((state, index) =>
    latched[index] === 'met' ? 'met' : state);
}

export const allMet = (states: readonly CriterionState[]): boolean =>
  states.length > 0 && states.every(state => state === 'met');
export const metCount = (states: readonly CriterionState[]): number =>
  states.filter(state => state === 'met').length;

// ---- progress --------------------------------------------------------------

export const CHALLENGE_PROGRESS_KEY = 'grworld.challenges.v1';

export interface ChallengeProgress {
  /** challenge id -> ISO timestamp of the pass. */
  passed: Record<string, string>;
}

type ReadStorage = Pick<Storage, 'getItem'>;
type WriteStorage = Pick<Storage, 'setItem' | 'removeItem'>;

const emptyProgress = (): ChallengeProgress => ({ passed: {} });

/**
 * Progress is per browser and read defensively: every access can throw in
 * private mode or an embedded context, and a challenge list that fails to draw
 * would be far worse than one that shows nothing passed. Same rule as
 * run-pacing.ts.
 */
export function readProgress(storage?: ReadStorage): ChallengeProgress {
  try {
    const raw = (storage ?? localStorage).getItem(CHALLENGE_PROGRESS_KEY);
    if (!raw) return emptyProgress();
    const parsed = JSON.parse(raw);
    const passed = parsed?.passed;
    if (!passed || typeof passed !== 'object' || Array.isArray(passed))
      return emptyProgress();
    const out: Record<string, string> = {};
    for (const [id, at] of Object.entries(passed))
      if (id) out[id] = String(at);
    return { passed: out };
  } catch { return emptyProgress(); }
}

export function passedIds(storage?: ReadStorage): Set<string> {
  return new Set(Object.keys(readProgress(storage).passed));
}

/** Records a pass, permanently. Returns the progress as it now stands. */
export function recordPass(
  id: string,
  storage?: ReadStorage & WriteStorage,
  now: Date = new Date(),
): ChallengeProgress {
  const progress = readProgress(storage);
  if (!id) return progress;
  // Latching: an earlier pass keeps its own timestamp, so re-running a
  // challenge never rewrites when it was first solved.
  if (!progress.passed[id]) progress.passed[id] = now.toISOString();
  try {
    (storage ?? localStorage).setItem(CHALLENGE_PROGRESS_KEY, JSON.stringify(progress));
  } catch { /* Storage can be unavailable in private or embedded contexts. */ }
  return progress;
}

export function resetProgress(storage?: WriteStorage): void {
  try { (storage ?? localStorage).removeItem(CHALLENGE_PROGRESS_KEY); }
  catch { /* as above */ }
}

/** A challenge is open when it has no prerequisite, or its prerequisite passed. */
export function isUnlocked(
  spec: Pick<ChallengeSpec, 'requires'>, passed: ReadonlySet<string>,
): boolean {
  return !spec.requires || passed.has(spec.requires);
}

export type ChallengeStatus = 'passed' | 'unlocked' | 'locked';

export function challengeStatus(
  spec: Pick<ChallengeSpec, 'id' | 'requires'>, passed: ReadonlySet<string>,
): ChallengeStatus {
  if (spec.id && passed.has(spec.id)) return 'passed';
  return isUnlocked(spec, passed) ? 'unlocked' : 'locked';
}
