# Challenge flowgraphs: locked progression with a criteria block

**Status: plan, not yet implemented.** This is an implementation brief for an
agent with no other context. Read [AGENTS.md](../AGENTS.md) first for the build,
and [docs/flowgraph-files.md](flowgraph-files.md) before touching any `.grc`.
When the work is done, this file should be replaced by a real `docs/challenges.md`
describing what exists (and given a row in the AGENTS.md doc table).

## Goal

`example_flowgraphs/_gnuradio-world-challenges/` will hold a series of challenge
flowgraphs in increasing difficulty. Each is **locked until the previous one is
passed**, except the first. Pass/fail is decided by success criteria — a block
parameter set to a particular value, a Spectrum Analyzer detecting a signal at a
target center frequency and bandwidth (with slop), and so on — and those criteria
are **authored inside the flowgraph itself**, in one new block that every
challenge carries. Locked/unlocked/passed shows as an icon beside the challenge
in the editor's Example Flowgraphs list.

Today the directory holds one file, `challenge_0.grc`, whose instructions live in
`note` blocks ("change the frequency of the tone to 200 Hz"). Nothing checks it.

## Decisions already made (do not relitigate)

1. **Criteria are one JSON array in a single block parameter**, not a fixed set of
   typed dialog fields and not a JavaScript predicate. It scales to any number of
   checks per challenge, needs no schema change per new challenge, and can be
   rendered as a human-readable checklist.
2. **The lock is soft: palette only.** A locked challenge is dimmed with a lock
   icon in the Example Flowgraphs list and clicking it refuses with "finish X
   first". A direct `#example=` link or a generated `/examples/…` page still
   loads it — sharing, bookmarks and search indexing keep working.
3. **The Challenge block is hidden from the block palette** (like
   `blocks_throttle` is today) but loads, runs, saves and round-trips normally.
   Authoring challenges is a repo activity; users never drop one by accident.

## How the existing code makes this cheap

Verify each anchor before relying on it — line numbers drift.

| fact | where |
|------|-------|
| `note` is an editor-only block with no GNU Radio block behind it: hand-written schema, custom canvas body, dropped by the runner while lowering. **It is the precedent to copy.** | [editor/src/block-defs.ts:249](../editor/src/block-defs.ts#L249), [editor/src/main.ts:988](../editor/src/main.ts#L988) (`noteGeom`), [runner/src/grc_lower.hpp:240](../runner/src/grc_lower.hpp#L240) |
| A `blocks/grc/*.block.yml` **without** `flags: [cpp]` / `cpp_templates` is silently skipped by the registry generator — no factory, no C++, no relink | [runner/gen_registry.py:922](../runner/gen_registry.py#L922) |
| The palette treats a block as available when a hand-written `RUNNABLE` schema exists, regardless of the generated manifest (`note` is not in `generated_blocks.json`'s `supported`) | [editor/src/main.ts:3684](../editor/src/main.ts#L3684) (`makeBlockItem`) |
| Blocks that load and run but are not offered in the palette | `PALETTE_HIDDEN`, [editor/src/main.ts:3606](../editor/src/main.ts#L3606) |
| The examples palette already fetches and `parseGrc`s every example to show its title/author/description, and re-renders through one `refresh()` | [editor/src/example-palette.ts](../editor/src/example-palette.ts), `addExample` / `refresh` |
| Spectrum Analyzer already reports `detected_signals[]` with `center_frequency`, `peak_frequency`, `peak_level`, `total_power`, `occupied_bandwidth_99`, `low/high_frequency_99`, plus `detection.threshold` and `rbw_hz` | [runner/src/spectrum_analyzer.js](../runner/src/spectrum_analyzer.js), `plotData()` |
| The editor can read that synchronously from the same-origin runner frame — `readPlotData(deps, {block, points, settleSeconds})`, where `deps` is just `{ frame(), layout() }` | [editor/src/ai/capture.ts](../editor/src/ai/capture.ts) (`readPlotData`), wired in [editor/src/main.ts:4891](../editor/src/main.ts#L4891) |
| Run start/stop hook, and the runner-window layout report | `setRunnerRunning` [editor/src/main.ts:2763](../editor/src/main.ts#L2763), `runnerLayout` [editor/src/main.ts:2853](../editor/src/main.ts#L2853) |
| Parameter expressions are evaluated by the editor with the flowgraph's variable scope | [editor/src/expr.ts](../editor/src/expr.ts) — `evaluate()`, `buildScope()`; used the same way in [editor/src/validation.ts](../editor/src/validation.ts) |
| A pure, DOM-free session class unit-tested under node — the model for the evaluator's shape | [editor/src/training.ts](../editor/src/training.ts) + `editor/test/` |
| A multiline string parameter renders as a `<textarea>` in the Properties dialog | `multiline: true` in the param def; [editor/src/properties-dialog.ts:901](../editor/src/properties-dialog.ts#L901) |
| localStorage written defensively (private mode throws) | [editor/src/run-pacing.ts](../editor/src/run-pacing.ts) |

## Traps that will bite (from AGENTS.md — read the linked docs)

- **The editor silently drops parameters its schema does not declare.** Every
  parameter of the new block must exist in its hand-written `RUNNABLE` schema, or
  a `.grc` carrying it loads with the default and the challenge quietly never
  passes. See [docs/flowgraph-files.md](flowgraph-files.md).
- **Never hand-edit generated artifacts.** `editor/public/blocks.json` and
  `runner/generated_blocks.json` are build outputs; adding a `blocks/grc/*.yml`
  means running `npm run blocks` in `editor/` (which runs both generators).
- **Rebuild the editor before reporting done:** `(cd editor && npm run build)`
  (or `npm run check`, whose last step is that build). The dev server serves
  `editor/dist/`; it does not hot-reload `editor/src/`.
- **Keep the app running.** If port 8090 is already serving, reuse it; do not kill
  it. Otherwise `node server.mjs 8090 "$PWD"` and leave it up.
- **Anything under `example_flowgraphs/` must be run through the real editor**
  (`node scripts/run_example.mjs <file>.grc` → `EXAMPLE_PASS`) and auto-arranged
  (`node scripts/arrange_example.mjs <file>.grc`) before it is done.
- **Do not add a new test file per small change.** A new `editor/test/*.test.mjs`
  is justified here because the evaluator is a genuinely new subsystem;
  everything else goes in the suites that already cover the code touched.

## 1. The block — `wasm_challenge`

Create [blocks/grc/wasm_challenge.block.yml](../blocks/grc/wasm_challenge.block.yml).
Metadata and documentation only: **no `flags: [cpp]`, no `cpp_templates`, no
`gui: true`, no ports.** `category: '[GNU Radio World]'`. The `documentation:`
block is where the criteria reference lives for anyone reading the block.

Add the matching hand-written schema to `RUNNABLE` in
[editor/src/block-defs.ts](../editor/src/block-defs.ts), directly beside `note`,
with the same style of comment explaining that the runner drops it:

| param id | type | notes |
|----------|------|-------|
| `challenge_id` | string | stable slug (`challenge_0`), the progress key. Deliberately **not** derived from the file name, so a challenge can be renamed or reordered without resetting anyone's progress |
| `title` | string | shown in the checklist header, the completion banner and the palette tooltip. Falls back to the Options title when empty |
| `requires` | string | `challenge_id` of the prerequisite; empty for the first. An explicit chain, so inserting or branching a challenge is one field, not a renumbering |
| `criteria` | string, `multiline: true` | the JSON array below |

Runner side is one line: add `wasm_challenge` to the drop list beside `options`,
`variable` and `note` in [runner/src/grc_lower.hpp:240](../runner/src/grc_lower.hpp#L240),
so the block never reaches the registry. Add `wasm_challenge` to `PALETTE_HIDDEN`
in [editor/src/main.ts:3606](../editor/src/main.ts#L3606).

Then regenerate and confirm nothing chokes on a yml with no templates:

```bash
cd editor && npm run blocks     # gen_registry.py + gen_blocklib.py, in order
```

## 2. Criteria format

`criteria` holds a JSON array. Every criterion carries a `goal` — the sentence the
reader sees in the checklist, so a challenge is described once, not twice.

```json
[
  {"kind": "param", "block": "analog_sig_source_x_0", "param": "freq",
   "equals": 200, "goal": "Set the tone to 200 Hz"},
  {"kind": "detected_signal", "center_freq": 200, "center_tol": 20,
   "bandwidth": 50, "bandwidth_tol": 40, "min_peak_level": -40,
   "goal": "Produce a 200 Hz tone the analyzer can see"}
]
```

Kinds to implement:

- **`param`** — `block` (instance name, e.g. `analog_sig_source_x_0`), `param`,
  and one of `equals`, `equals` + `tolerance`, `min` and/or `max`, or `matches`
  (regex, for strings/enums). Numeric comparisons go through `evaluate()` from
  [expr.ts](../editor/src/expr.ts) with the flowgraph's variable scope built by
  `buildScope()`, so `200`, `2*100` and a variable `tone_freq = 200` all satisfy
  `equals: 200`. Fall back to exact string compare when the value does not
  evaluate to a number.
- **`block_present`** — `id` (block id, e.g. `qtgui_freq_sink_x`), optional
  `count` (default ≥ 1). Only enabled, non-bypassed blocks count.
- **`connected`** — `from` and `to` instance names, optional `from_port` /
  `to_port` indices.
- **`detected_signal`** *(live — needs a run)* — `center_freq` + `center_tol`,
  optional `bandwidth` + `bandwidth_tol` (matched against
  `occupied_bandwidth_99`), optional `min_peak_level` / `min_total_power`,
  optional `sink` to pin one analyzer by block name when a flowgraph has several.
  Satisfied when **any** entry in any Spectrum Analyzer's `detected_signals[]`
  matches every stated bound.
- **`ran`** *(live)* — `seconds` (default 2): the flowgraph ran that long with no
  runner error.

Unknown `kind`, malformed JSON, a `block`/`from`/`to` naming an instance that is
not in the flowgraph, and a criterion with no `goal` are all **validation errors
on the Challenge block** (add them in
[editor/src/validation.ts](../editor/src/validation.ts), non-blocking is fine) —
never a goal that silently can never pass. Renaming a block in a challenge `.grc`
must therefore surface immediately.

## 3. The evaluator — `editor/src/challenge.ts`

DOM-free and pure, so it unit-tests under plain node the way
[training.ts](../editor/src/training.ts) does. Suggested surface:

```ts
export interface Criterion { kind: string; goal: string; /* per-kind fields */ }
export interface ChallengeSpec {
  id: string; title: string; requires: string;
  criteria: Criterion[]; errors: string[];
}
export type CriterionState = 'met' | 'unmet' | 'pending';   // pending = live, not yet seen

export function parseChallenge(insts: Inst[]): ChallengeSpec | null;
export function evaluateStatic(spec, insts, conns, scope): CriterionState[];
export function evaluateLive(spec, plotData, runSeconds): CriterionState[];
export function isUnlocked(spec, passed: Set<string>): boolean;
```

Wiring (a `challenge-session.ts` controller beside
[run-session.ts](../editor/src/run-session.ts) is preferable to more code in
`main.ts`, which is already 5k lines):

- Static criteria re-evaluate on every graph mutation — the same hook validation
  already runs on.
- While the runner is running (`setRunnerRunning(true)`,
  [main.ts:2763](../editor/src/main.ts#L2763)), poll
  `readPlotData(captureDeps, { points: 4 })` about every 500 ms. Swallow the
  "window has not finished starting" / "no GUI sink to read" errors — they are
  normal for the first second and for a challenge with no analyzer.
  Reuse the exact capture deps object already built at
  [main.ts:4891](../editor/src/main.ts#L4891) (`{ frame, layout }`).
- **Live results latch for the duration of one run and are cleared when a new run
  starts.** A tone seen in the previous run must not pass a graph that no longer
  produces it.
- When every criterion is `met` at the same moment: record the pass, log it, and
  show a completion banner naming the challenge that just unlocked.

## 4. Progress and unlocking

One small module (or a section of `challenge.ts`) over `localStorage`, key
`grworld.challenges.v1`:

```json
{"passed": {"challenge_0": "2026-09-02T14:58:00.000Z"}}
```

- Unlocked ⇔ `!requires || passed[requires]`. Passing latches permanently.
- Every read and write in `try/catch` (private mode throws) — see
  [run-pacing.ts](../editor/src/run-pacing.ts).
- **Reset challenge progress** item in the Help menu.
- `?challenges=unlocked` unlocks everything, for development and for
  `scripts/run_example.mjs`.

## 5. Canvas and in-run feedback

- The Challenge block's canvas body is its **live checklist**: one row per
  criterion, `✓` / `○` before the `goal` text. Add `challengeGeom()` beside
  `noteGeom()` and `layoutGeom()` and a case in `geom()`
  ([main.ts:1058](../editor/src/main.ts#L1058)); reuse `wrapNoteText()` from
  [note.ts](../editor/src/note.ts) for the wrapping.
- The canvas is not on screen during a run (the runner has its own workspace
  tab), so also show a compact chip in the app chrome — `Challenge 1 · 2/3` —
  visible in both tabs. See [app-chrome.ts](../editor/src/app-chrome.ts).
- Log a line as each criterion is first met, and on completion.

## 6. Palette icons and gating

In `addExample` in
[editor/src/example-palette.ts](../editor/src/example-palette.ts), the `.grc` is
already fetched and parsed for its title. If the parsed flowgraph contains a
`wasm_challenge` block:

- Prepend a status glyph to the row: `✅` passed, `▶` unlocked-not-passed, `🔒`
  locked. Give it an `aria-label`, and put the same fact in the row's `title` in
  words — the palette's existing convention is that generated decoration always
  has a spoken equivalent.
- Locked rows get a class that dims them (mirror `.ex-item.disabled` in
  `editor/src/editor.css`), and the click handler refuses with
  `finish "<prerequisite title>" first` instead of loading.
- The challenge folder's count line gains `· 2 of 6 passed`.
- Progress changes must re-run the palette's existing `refresh()` so a pass
  repaints the list immediately.

Deep links stay open by decision 2 above: `#example=` and the generated
`/examples/…` pages load a locked challenge normally.

## 7. Content

Add a Challenge block to
[example_flowgraphs/_gnuradio-world-challenges/challenge_0.grc](../example_flowgraphs/_gnuradio-world-challenges/challenge_0.grc):
`challenge_id: challenge_0`, empty `requires`, a `param` criterion for the 200 Hz
change its note already asks for, and a `ran` criterion. Then:

```bash
node scripts/arrange_example.mjs example_flowgraphs/_gnuradio-world-challenges/challenge_0.grc
node scripts/run_example.mjs     example_flowgraphs/_gnuradio-world-challenges/challenge_0.grc   # EXAMPLE_PASS
```

Later challenges then need **no code change at all** — a `.grc` with
`requires: challenge_0` and its own criteria. That is the whole point of putting
the criteria in a block.

## 8. Tests and docs

- New `editor/test/challenge.test.mjs`: criteria parsing and its error cases,
  each criterion kind, expression-valued parameters (`2*100`, a variable),
  tolerance edges, the live latch, the unlock chain, and the progress store
  against a stub storage object.
- One assertion in the existing [runner/test/grc_test.cpp](../runner/test/grc_test.cpp)
  that `wasm_challenge` is dropped while lowering.
- Replace this file with `docs/challenges.md` (block schema, criterion reference,
  how to author a challenge, how progress is stored, how to reset it) and add a
  row for it to the doc table at the top of `AGENTS.md`.

## 9. Suggested order

1. Block yml + `RUNNABLE` schema + `PALETTE_HIDDEN` + lowering drop + regenerate;
   static evaluator + canvas checklist.
2. Progress store + palette icons/gating + completion banner. Challenge 0 is now
   fully playable without any live criterion.
3. Live criteria: the poll loop, `detected_signal` against Spectrum Analyzer,
   `ran`.
4. Docs, tests, and authoring challenges 1..n.

## 10. Verification checklist

```bash
cd editor && npm run blocks        # regenerate palette + manifest after the new yml
cd editor && npm run check         # type check, editor tests, production build
node editor/test/run.mjs           # (npm run check already runs these)
cd runner/test && g++ -std=c++17 -I../src -I../third_party grc_test.cpp -o grc_test && ./grc_test
node scripts/run_example.mjs example_flowgraphs/_gnuradio-world-challenges/challenge_0.grc
node test/test_smoke.mjs           # unchanged behaviour for everything else
```

Then, with `node server.mjs 8090 "$PWD"` running, open http://localhost:8090/ and
check by hand: challenge 0 loads from the palette, its checklist ticks when the
tone is set to 200 Hz, running it satisfies the live criterion, the pass is
recorded, challenge 1 (once written) flips from 🔒 to ▶ without a reload, and
Help ▸ Reset challenge progress puts it back.

## 11. Known limits worth stating in the final doc

- Criteria compare **evaluated** parameter values, so a challenge cannot require
  the reader to type a literal `200` rather than `2*100`. That is the intended
  behaviour.
- Criteria address blocks by instance name, so renaming a block in a challenge
  `.grc` breaks its criteria — hence the validation error in §2.
- Progress is per-browser (`localStorage`). There is no account-backed progress,
  and clearing site data resets it.
