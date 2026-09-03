// The challenge evaluator: what a Challenge block states, whether each criterion
// is met, and what the browser remembers about it. challenge.ts is deliberately
// DOM-free so all of this runs under plain node.
import assert from 'node:assert/strict';
import { bundleModule } from './bundle-module.mjs';
import { editorSource } from './editor-contract-source.mjs';

const {
  CHALLENGE_ID,
  allMet,
  challengeFromGrc,
  challengeProblems,
  challengeStatus,
  evaluateLive,
  evaluateStatic,
  isUnlocked,
  latchLive,
  mergeStates,
  metCount,
  parseChallenge,
  passedIds,
  readProgress,
  recordPass,
  resetProgress,
  unresolvedReferences,
  CHALLENGE_PROGRESS_KEY,
} = await bundleModule('../src/challenge.ts');

const block = (uid, id, name, params = {}) => ({
  uid, id, name, x: 0, y: 0, params, enabled: true, rotation: 0, bypassed: false,
});

const challengeOf = (criteria, extra = {}) => block('c0', CHALLENGE_ID, 'wasm_challenge_0', {
  challenge_id: 'challenge_0', title: 'First Light', requires: '',
  criteria: JSON.stringify(criteria), ...extra,
});

// ---- parsing ---------------------------------------------------------------

assert.equal(parseChallenge([block('b0', 'options', 'options')]), null,
  'a flowgraph with no Challenge block states no challenge');

{
  const spec = parseChallenge([challengeOf([
    { kind: 'param', block: 'src', param: 'freq', equals: 200, goal: 'Set the tone to 200 Hz' },
  ])]);
  assert.equal(spec.id, 'challenge_0');
  assert.equal(spec.title, 'First Light');
  assert.equal(spec.requires, '');
  assert.equal(spec.criteria.length, 1);
  assert.deepEqual(spec.errors, [], 'a well-formed challenge has no errors');
}

// A disabled Challenge block is not the flowgraph's challenge.
{
  const disabled = { ...challengeOf([]), enabled: false };
  assert.equal(parseChallenge([disabled]), null, 'a disabled Challenge block is ignored');
}

// Malformed JSON, a non-array, and a non-object entry are all errors, never a
// silently empty checklist.
{
  const bad = parseChallenge([challengeOf([], { criteria: '{not json' })]);
  assert.equal(bad.criteria.length, 0);
  assert.match(bad.errors[0], /not valid JSON/);

  const notArray = parseChallenge([challengeOf([], { criteria: '{"kind":"ran"}' })]);
  assert.match(notArray.errors[0], /must be a JSON array/);

  const notObject = parseChallenge([challengeOf([], { criteria: '["ran"]' })]);
  assert.match(notObject.errors[0], /must be a JSON object/);
}

// An unknown kind, a missing goal, and each kind's own missing fields.
{
  const spec = parseChallenge([challengeOf([
    { kind: 'teleport', goal: 'Do the impossible' },
    { kind: 'ran' },
    { kind: 'param', block: 'src', goal: 'no param, no comparison' },
    { kind: 'detected_signal', center_freq: 200, goal: 'no tolerance' },
    { kind: 'detected_signal', center_freq: 200, center_tol: 20, bandwidth: 50,
      goal: 'a bandwidth with no slop' },
  ])]);
  const joined = spec.errors.join('\n');
  assert.match(joined, /unknown kind "teleport"/);
  assert.match(joined, /has no "goal"/);
  assert.match(joined, /needs "param"/);
  assert.match(joined, /needs one of "equals"/);
  assert.match(joined, /non-negative "center_tol"/);
  assert.match(joined, /no "bandwidth_tol"/);
  assert.equal(spec.criteria.length, 4, 'only the unknown kind is dropped outright');
}

// An empty Challenge ID is an error: it is the key progress is stored under.
assert.match(
  parseChallenge([challengeOf([], { challenge_id: '' })]).errors.join('\n'),
  /Challenge ID is required/);

// A criterion naming a block that is not in the flowgraph — the mistake made by
// renaming a block in a challenge .grc.
{
  const source = block('b1', 'analog_sig_source_x', 'src', { freq: '200' });
  const spec = parseChallenge([challengeOf([
    { kind: 'param', block: 'renamed', param: 'freq', equals: 200, goal: 'g' },
    { kind: 'connected', from: 'src', to: 'gone', goal: 'g' },
  ])]);
  const problems = unresolvedReferences(spec, [source]);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /names block "renamed", which is not in this flowgraph/);
  assert.match(problems[1], /names block "gone"/);
  assert.equal(challengeProblems(spec, [source]).length, 2,
    'challengeProblems joins the authoring errors and the unresolved names');
}

// The same challenge read straight out of a parsed .grc, which is what the
// Example Flowgraphs list has.
{
  const spec = challengeFromGrc({
    blocks: [
      { name: 'x', id: 'analog_sig_source_x', parameters: { freq: '200' } },
      { name: 'ch', id: CHALLENGE_ID, parameters: {
        challenge_id: 'challenge_1', title: 'Second', requires: 'challenge_0',
        criteria: '[]' } },
    ],
  });
  assert.equal(spec.id, 'challenge_1');
  assert.equal(spec.requires, 'challenge_0');
  assert.equal(challengeFromGrc({ blocks: [] }), null);
  assert.equal(challengeFromGrc(null), null);
}

// ---- static criteria -------------------------------------------------------

const source = block('b1', 'analog_sig_source_x', 'src', { freq: '200', type: 'float' });
const sink = block('b2', 'qtgui_time_sink_x', 'scope', {});
const conns = [{ from: 'b1', fp: 0, to: 'b2', tp: 0 }];
const graph = [source, sink];

const statesOf = (criteria, blocks = graph, connections = conns, scope = {}) =>
  evaluateStatic(parseChallenge([challengeOf(criteria)]), blocks, connections, scope);

assert.deepEqual(
  statesOf([{ kind: 'param', block: 'src', param: 'freq', equals: 200, goal: 'g' }]),
  ['met'], 'a literal matches');
assert.deepEqual(
  statesOf([{ kind: 'param', block: 'src', param: 'freq', equals: 70, goal: 'g' }]),
  ['unmet']);

// Expression-valued and variable-valued parameters both compare as numbers:
// the criterion is about the value, not about what the reader typed.
{
  const expression = block('b1', 'analog_sig_source_x', 'src', { freq: '2*100' });
  assert.deepEqual(
    statesOf([{ kind: 'param', block: 'src', param: 'freq', equals: 200, goal: 'g' }],
      [expression, sink]),
    ['met'], '2*100 satisfies equals: 200');
  const named = block('b1', 'analog_sig_source_x', 'src', { freq: 'tone_freq' });
  assert.deepEqual(
    statesOf([{ kind: 'param', block: 'src', param: 'freq', equals: 200, goal: 'g' }],
      [named, sink], conns, { tone_freq: 200 }),
    ['met'], 'a variable holding 200 satisfies equals: 200');
  assert.deepEqual(
    statesOf([{ kind: 'param', block: 'src', param: 'freq', equals: 200, goal: 'g' }],
      [named, sink], conns, { tone_freq: 70 }),
    ['unmet']);
}

// Tolerance edges are inclusive on both sides.
for (const [freq, expected] of [['205', 'met'], ['195', 'met'], ['206', 'unmet'], ['194', 'unmet']]) {
  assert.deepEqual(
    statesOf([{ kind: 'param', block: 'src', param: 'freq', equals: 200, tolerance: 5, goal: 'g' }],
      [block('b1', 'analog_sig_source_x', 'src', { freq }), sink]),
    [expected], `freq ${freq} with tolerance 5`);
}

// min/max, together and apart.
assert.deepEqual(
  statesOf([{ kind: 'param', block: 'src', param: 'freq', min: 100, max: 300, goal: 'g' }]),
  ['met']);
assert.deepEqual(
  statesOf([{ kind: 'param', block: 'src', param: 'freq', min: 300, goal: 'g' }]),
  ['unmet']);
assert.deepEqual(
  statesOf([{ kind: 'param', block: 'src', param: 'freq', max: 100, goal: 'g' }]),
  ['unmet']);

// A non-numeric value falls back to an exact string compare, and `matches` is
// the way to state a pattern over one.
assert.deepEqual(
  statesOf([{ kind: 'param', block: 'src', param: 'type', equals: 'float', goal: 'g' }]),
  ['met'], 'an enum value compares as a string');
assert.deepEqual(
  statesOf([{ kind: 'param', block: 'src', param: 'type', matches: '^(float|complex)$', goal: 'g' }]),
  ['met']);
assert.deepEqual(
  statesOf([{ kind: 'param', block: 'src', param: 'type', matches: '^complex$', goal: 'g' }]),
  ['unmet']);
assert.deepEqual(
  statesOf([{ kind: 'param', block: 'src', param: 'nosuch', equals: 1, goal: 'g' }]),
  ['unmet'], 'a parameter the block does not have is unmet, not an exception');

// A disabled or bypassed block does not satisfy anything.
assert.deepEqual(
  statesOf([{ kind: 'param', block: 'src', param: 'freq', equals: 200, goal: 'g' }],
    [{ ...source, enabled: false }, sink]),
  ['unmet']);

// block_present counts only active blocks, and honours `count`.
assert.deepEqual(
  statesOf([{ kind: 'block_present', id: 'qtgui_time_sink_x', goal: 'g' }]), ['met']);
assert.deepEqual(
  statesOf([{ kind: 'block_present', id: 'qtgui_freq_sink_x', goal: 'g' }]), ['unmet']);
assert.deepEqual(
  statesOf([{ kind: 'block_present', id: 'analog_sig_source_x', count: 2, goal: 'g' }]),
  ['unmet']);
assert.deepEqual(
  statesOf([{ kind: 'block_present', id: 'analog_sig_source_x', count: 2, goal: 'g' }],
    [source, block('b3', 'analog_sig_source_x', 'src2', {}), sink]),
  ['met']);
assert.deepEqual(
  statesOf([{ kind: 'block_present', id: 'analog_sig_source_x', goal: 'g' }],
    [{ ...source, bypassed: true }, sink]),
  ['unmet'], 'a bypassed block does not count as present');

// connected addresses blocks by name, and can pin the ports.
assert.deepEqual(statesOf([{ kind: 'connected', from: 'src', to: 'scope', goal: 'g' }]), ['met']);
assert.deepEqual(statesOf([{ kind: 'connected', from: 'scope', to: 'src', goal: 'g' }]), ['unmet']);
assert.deepEqual(
  statesOf([{ kind: 'connected', from: 'src', to: 'scope', to_port: 1, goal: 'g' }]),
  ['unmet']);
assert.deepEqual(
  statesOf([{ kind: 'connected', from: 'src', to: 'scope', from_port: 0, to_port: 0, goal: 'g' }]),
  ['met']);

// Live criteria are pending on the canvas: nothing there can decide them.
assert.deepEqual(
  statesOf([
    { kind: 'ran', goal: 'g' },
    { kind: 'detected_signal', center_freq: 200, center_tol: 20, goal: 'g' },
  ]),
  ['pending', 'pending']);

// ---- live criteria ---------------------------------------------------------

const liveSpec = parseChallenge([challengeOf([
  { kind: 'param', block: 'src', param: 'freq', equals: 200, goal: 'static' },
  { kind: 'ran', seconds: 2, goal: 'run it' },
  { kind: 'detected_signal', center_freq: 200, center_tol: 20, bandwidth: 50,
    bandwidth_tol: 40, min_peak_level: -40, goal: 'see the tone' },
])]);

const plot = (signals, name = 'analyzer') => ({
  widgets: [{ name, detected_signals: signals }],
});
const seen = [{ center_frequency: 205, occupied_bandwidth_99: 60, peak_level: -20,
  total_power: -12 }];

assert.deepEqual(evaluateLive(liveSpec, null, 0),
  ['pending', 'pending', 'pending'], 'nothing is decided at the instant a run starts');
assert.deepEqual(evaluateLive(liveSpec, null, 2)[1], 'met', '`ran` ticks with no plot data');
assert.deepEqual(evaluateLive(liveSpec, null, 1.999)[1], 'pending');
assert.deepEqual(evaluateLive(liveSpec, plot(seen), 3),
  ['pending', 'met', 'met'], 'a matching signal meets the detection criterion');

// Every stated bound has to hold.
const misses = [
  [{ center_frequency: 260, occupied_bandwidth_99: 60, peak_level: -20 }, 'centre out of tolerance'],
  [{ center_frequency: 205, occupied_bandwidth_99: 200, peak_level: -20 }, 'bandwidth out of tolerance'],
  [{ center_frequency: 205, occupied_bandwidth_99: 60, peak_level: -80 }, 'too weak'],
];
for (const [signal, why] of misses)
  assert.equal(evaluateLive(liveSpec, plot([signal]), 3)[2], 'pending', why);

// `sink` pins one analyzer when a flowgraph has several.
{
  const pinned = parseChallenge([challengeOf([
    { kind: 'detected_signal', center_freq: 200, center_tol: 20, sink: 'other', goal: 'g' },
  ])]);
  assert.deepEqual(evaluateLive(pinned, plot(seen, 'analyzer'), 3), ['pending'],
    'a signal on the wrong analyzer does not count');
  assert.deepEqual(evaluateLive(pinned, plot(seen, 'other'), 3), ['met']);
}

// The latch: a signal seen once stays seen for the rest of the run, and merging
// leaves the static criteria to the canvas.
{
  let live = evaluateLive(liveSpec, plot(seen), 3);
  live = latchLive(live, evaluateLive(liveSpec, plot([]), 4));
  assert.deepEqual(live, ['pending', 'met', 'met'], 'a signal that came and went stays met');
  const merged = mergeStates(['met', 'pending', 'pending'], live);
  assert.deepEqual(merged, ['met', 'met', 'met']);
  assert.equal(allMet(merged), true);
  assert.equal(metCount(mergeStates(['unmet', 'pending', 'pending'], live)), 2);
  assert.equal(allMet([]), false, 'a challenge with no criteria is never complete');
}

// ---- unlocking and progress ------------------------------------------------

const first = { id: 'challenge_0', requires: '' };
const second = { id: 'challenge_1', requires: 'challenge_0' };
assert.equal(isUnlocked(first, new Set()), true, 'the first challenge is always open');
assert.equal(isUnlocked(second, new Set()), false);
assert.equal(isUnlocked(second, new Set(['challenge_0'])), true);
assert.equal(challengeStatus(first, new Set()), 'unlocked');
assert.equal(challengeStatus(first, new Set(['challenge_0'])), 'passed');
assert.equal(challengeStatus(second, new Set()), 'locked');
assert.equal(challengeStatus(second, new Set(['challenge_0'])), 'unlocked');
assert.equal(challengeStatus(second, new Set(['challenge_0', 'challenge_1'])), 'passed');

// The store, against a stub Storage.
function stubStorage(initial = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: key => (data.has(key) ? data.get(key) : null),
    setItem: (key, value) => { data.set(key, String(value)); },
    removeItem: key => { data.delete(key); },
  };
}
{
  const storage = stubStorage();
  assert.deepEqual(readProgress(storage), { passed: {} });
  recordPass('challenge_0', storage, new Date('2026-09-02T14:58:00.000Z'));
  assert.deepEqual(readProgress(storage).passed,
    { challenge_0: '2026-09-02T14:58:00.000Z' });
  assert.deepEqual([...passedIds(storage)], ['challenge_0']);
  // Passing again keeps the first timestamp: it records when it was solved.
  recordPass('challenge_0', storage, new Date('2026-09-09T00:00:00.000Z'));
  assert.equal(readProgress(storage).passed.challenge_0, '2026-09-02T14:58:00.000Z');
  recordPass('', storage);
  assert.deepEqual(Object.keys(readProgress(storage).passed), ['challenge_0']);
  assert.equal(storage.data.get(CHALLENGE_PROGRESS_KEY).includes('challenge_0'), true);
  resetProgress(storage);
  assert.deepEqual(readProgress(storage), { passed: {} });
}

// Anything unreadable in storage reads as "nothing passed" rather than throwing:
// a challenge list that failed to draw would be far worse.
for (const value of ['not json', '[]', '{"passed":[]}', 'null'])
  assert.deepEqual(readProgress(stubStorage({ [CHALLENGE_PROGRESS_KEY]: value })),
    { passed: {} }, `unreadable progress "${value}" reads as empty`);
{
  const throwing = {
    getItem() { throw new Error('private mode'); },
    setItem() { throw new Error('private mode'); },
    removeItem() { throw new Error('private mode'); },
  };
  assert.deepEqual(readProgress(throwing), { passed: {} });
  assert.doesNotThrow(() => recordPass('challenge_0', throwing));
  assert.doesNotThrow(() => resetProgress(throwing));
}

// ---- editor wiring ---------------------------------------------------------
// The traps the plan calls out, asserted against the source so they cannot be
// undone by accident.
assert.match(editorSource, /PALETTE_HIDDEN = new Set\(\[[^\]]*CHALLENGE_ID/s,
  'the Challenge block stays out of the block palette');
for (const symbol of ['CHALLENGE_ID_PARAM', 'CHALLENGE_TITLE_PARAM',
                      'CHALLENGE_REQUIRES_PARAM', 'CHALLENGE_CRITERIA_PARAM'])
  assert.match(editorSource, new RegExp(symbol),
    `${symbol} is declared in the hand-written schema, or the editor drops that parameter`);
assert.match(editorSource, /challenges['"]?\)/,
  '?challenges=unlocked is read from the query string');

console.log('challenge tests passed');
