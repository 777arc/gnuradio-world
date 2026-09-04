# Challenge flowgraphs

`example_flowgraphs/_gnuradio-world-challenges/` holds a series of flowgraphs in
increasing difficulty. Each one states what the reader has to achieve and how the
editor decides they achieved it, and each is locked until the previous one is
passed. Everything that makes a flowgraph a challenge is **inside the `.grc`**:
adding challenge 7 is writing a `.grc`, with no code change anywhere.

Read [flowgraph-files.md](flowgraph-files.md) before hand-editing any `.grc`.

## What a challenge is

One Challenge block (`wasm_challenge`), carrying four parameters:

| parameter | what it is |
|-----------|------------|
| `challenge_id` | the progress key — a stable slug like `challenge_0`. Deliberately **not** derived from the file name, so a challenge can be renamed or reordered without resetting anyone's progress |
| `title` | shown on the block face, in the progress chip, in the completion banner, and as the name a locked challenge's tooltip gives for its prerequisite. Falls back to the Options title |
| `requires` | the `challenge_id` of the prerequisite; empty for the first. An explicit chain, so inserting or branching a challenge is one field rather than a renumbering |
| `criteria` | a JSON array of success criteria — the whole of §"Criteria" below |

The block is metadata only. It has no GNU Radio block behind it: the runner drops
it while lowering, exactly as it drops `note` and `variable`
([runner/src/grc_lower.hpp](../runner/src/grc_lower.hpp)), so it never reaches
the factory registry and costs a running flowgraph nothing. Its `.block.yml`
([blocks/grc/wasm_challenge.block.yml](../blocks/grc/wasm_challenge.block.yml))
carries no `flags: [cpp]` and no `cpp_templates`, which is what makes
`gen_registry.py` skip it — no factory, no C++, no relink.

It is also in `PALETTE_HIDDEN` ([editor/src/main.ts](../editor/src/main.ts)):
authoring a challenge is a repository activity, and a reader who dropped one onto
their own flowgraph would get a checklist with nothing behind it. A `.grc` that
already contains one loads, runs, saves and round-trips normally.

Its face on the canvas is the **live checklist**, one row per criterion:

```
              Challenge
             Tune the tone
    ✓ Run the flowgraph and find the tone
    ○ Move the tone to 100.25 MHz
```

`✓` met, `○` unmet, `◌` a live criterion the current run has not shown yet.

## Criteria

`criteria` is a JSON array. Every entry carries a `kind`, a `goal` — the sentence
the reader sees in the checklist, so a challenge is described once rather than
twice — and that kind's own fields.

```json
[
 {"kind": "ran", "seconds": 2, "goal": "Run the flowgraph and watch the scope"},
 {"kind": "param", "block": "analog_sig_source_x_0", "param": "freq",
  "equals": 200, "goal": "Set the Signal Source frequency to 200 Hz"}
]
```

### Checked against the canvas, as the reader edits

| kind | fields |
|------|--------|
| `param` | `block` (a block ID, e.g. `analog_sig_source_x_0`), `param` (a GRC parameter id), and one of: `equals`; `equals` + `tolerance`; `min` and/or `max`; `matches` (a regular expression, for strings and enums) |
| `block_present` | `id` (a block *type*, e.g. `qtgui_freq_sink_x`), optional `count` (default 1) |
| `connected` | `from` and `to` (block IDs), optional `from_port` / `to_port` (stream indices) |

Only enabled, non-bypassed blocks count, for all three.

Numeric comparisons go through the editor's own expression evaluator
([expr.ts](../editor/src/expr.ts)) with the flowgraph's variable scope, so `200`,
`2*100` and a variable holding 200 all satisfy `"equals": 200`. A value that does
not evaluate to a number falls back to an exact string compare, which is what
makes `{"param": "type", "equals": "float"}` work on an enum.

### Checked against the running flowgraph

| kind | fields |
|------|--------|
| `detected_signal` | `center_freq` + `center_tol`, optional `bandwidth` + `bandwidth_tol` (matched against `occupied_bandwidth_99`), optional `min_peak_level`, `min_total_power`, and `sink` to pin one analyzer by block ID when a flowgraph has several |
| `ran` | optional `seconds` (default 2): the flowgraph ran that long with no runner error |

`detected_signal` is satisfied when **any** entry in **any** Spectrum Analyzer's
`detected_signals[]` matches every bound stated. Frequencies are absolute, as the
analyzer reports them: a tone 250 kHz above a 100 MHz center frequency is
`"center_freq": 100250000`, not `250000`. Levels are in the analyzer's own
`level_unit` (dBFS by default).

The poll loop exists **only while a challenge is running**: a flowgraph that
states no challenge gets no timer and no repaint out of the run path, which is
the overwhelming majority of runs. When there is one, the editor polls
`readPlotData()` over the runner frame about twice a second — the same reader
Graham's `read_plot_data` tool uses
([editor/src/ai/capture.ts](../editor/src/ai/capture.ts)). **Live results latch
for the duration of one run and are cleared when a new run starts**, so a signal
that came and went still counts, and a tone the *previous* run produced can never
pass a graph that no longer produces it.

### Authoring errors

Malformed JSON, a non-array, an entry that is not an object, an unknown `kind`, a
criterion with no `goal`, a kind missing one of its own required fields, and a
`block`/`from`/`to`/`sink` naming a block that is not in the flowgraph are **all
reported as errors on the Challenge block** — never as a goal that silently can
never pass. Renaming a block a criterion addresses therefore shows up
immediately, on the canvas and in Flowgraph Errors. They are non-blocking: a
broken challenge is still a flowgraph worth running.

## Progress, locking and unlocking

Progress lives in `localStorage` under `grworld.challenges.v1`:

```json
{"passed": {"challenge_0": "2026-09-02T14:58:00.000Z"}}
```

A challenge is unlocked when `!requires || passed[requires]`. Passing latches
permanently, and passing again keeps the original timestamp. The pass is
recorded on the **transition** into "every criterion met", not while it stays
met — which is what lets Reset Challenge Progress work with the solved
flowgraph still on the canvas, and what lets the pass be re-earned by breaking
the challenge and solving it again.

Every read and write is wrapped in `try`/`catch` — storage throws in private
mode and in some embedded contexts, and a challenge list that failed to draw
would be far worse than one that shows nothing passed.

**The lock is soft, and palette-only.** In the Example Flowgraphs list a
challenge row carries `✅` passed / `▶` unlocked / `🔒` locked, a locked row is
dimmed, and clicking it refuses with `finish "<prerequisite title>" first`
instead of loading. A direct `#example=` link and the generated `/examples/…`
page still open a locked challenge normally, so sharing, bookmarks and search
indexing keep working. The challenge folder's count line gains `· 2 of 6 passed`.

- **Help ▸ Reset Challenge Progress** clears the store, after a confirmation.
- **`?challenges=unlocked`** opens every challenge whatever this browser has
  passed — for development, and for `scripts/run_example.mjs`, which picks the
  example out of the palette and cannot play through a chain to reach one.

Progress is per browser. There is no account-backed progress, and clearing site
data resets it.

## Where the reader sees it

- The **Challenge block's face** is the checklist, updated on every graph mutation.
- A **chip in the workspace tab bar** — `🎯 Tune the tone · 1/2` — because the
  canvas is not on screen during a run, and the run is exactly when the live
  criteria tick.
- The **console pane** logs each criterion as it is first met, and the pass.
- A **completion banner** on a first pass, naming the challenge and pointing at
  the Example Flowgraphs list where the next one has just unlocked.

## The series so far

Each one teaches one thing about GNU Radio and one thing about DSP, and the
`requires` chain runs straight down this table — a new challenge continues it
from `challenge_4`.

| file | `challenge_id` | title | the editor skill | the DSP |
|------|----------------|-------|------------------|---------|
| `challenge_0.grc` | `challenge_0` | Change the tone | run and stop a flowgraph, edit a block parameter | a tone, in the time domain |
| `challenge_1.grc` | `challenge_1` | Into the frequency domain | find a block in the palette, place it, set its port type, connect a second sink to one stream | the frequency domain, and a square wave's odd harmonics |
| `challenge_2.grc` | `challenge_2` | Turn the knob | a parameter that names a variable, and a QT GUI Range that moves while the graph runs | center frequency plus offset, read off the analyzer |
| `challenge_3.grc` | `challenge_3` | Filter and decimate | a rate-changing block does not tell the blocks after it — the display's own rate is a parameter | low-pass cutoff, decimation, and why the filter comes first |
| `challenge_4.grc` | `challenge_4` | Mix it down to baseband | reading a mixer's two inputs as signal and local oscillator | multiplying by a complex sine shifts the whole band, sign and all |

## Writing a new challenge

1. Copy an existing challenge in `example_flowgraphs/_gnuradio-world-challenges/`
   and build the flowgraph. Give it Note blocks explaining the situation and
   stating the challenge in prose, as challenges 0 and 1 do.
2. Add a Challenge block with a fresh `challenge_id`, a `title`, `requires` set
   to the previous challenge's `challenge_id`, and its `criteria`.
3. Set the *starting* state of the flowgraph to one that does **not** already
   satisfy the criteria. This is easy to get wrong: challenge 0's Signal Source
   has to start at 70 Hz for "set it to 200 Hz" to be a challenge at all.
4. Measure, do not guess, the bounds of any `detected_signal`: run the finished
   flowgraph and read the analyzer's own `detected_signals[]` (Graham's
   `read_plot_data`, or `__grReadPlotData('', 4)` in the runner frame), then set
   the tolerances around what it actually reports.
5. Arrange it and run it through the real editor:

```bash
node scripts/arrange_example.mjs example_flowgraphs/_gnuradio-world-challenges/<file>.grc
node scripts/run_example.mjs     _gnuradio-world-challenges/<file>.grc   # EXAMPLE_PASS
```

No code changes. That is the whole point of putting the criteria in a block.

## Where the code is

| what | where |
|------|-------|
| parsing, every criterion kind, the progress store, unlocking | [editor/src/challenge.ts](../editor/src/challenge.ts) — DOM-free and free of editor state, so it unit-tests under plain node |
| the poll loop, the chip, the banner, recording a pass | [editor/src/challenge-session.ts](../editor/src/challenge-session.ts) |
| the block schema | `RUNNABLE.wasm_challenge` in [editor/src/block-defs.ts](../editor/src/block-defs.ts), beside `note` |
| the canvas checklist | `challengeGeom()` in [editor/src/main.ts](../editor/src/main.ts), beside `noteGeom()` |
| palette icons and gating | `addExample` in [editor/src/example-palette.ts](../editor/src/example-palette.ts) |
| dropping the block before the registry | [runner/src/grc_lower.hpp](../runner/src/grc_lower.hpp) |
| tests | [editor/test/challenge.test.mjs](../editor/test/challenge.test.mjs), and the lowering assertion in [runner/test/grc_test.cpp](../runner/test/grc_test.cpp) |

## What it costs a flowgraph that is not a challenge

Most of the app is not this feature, so the common path was measured rather than
assumed. On a 21-block example with no Challenge block: **no poll timer, no
canvas repaint out of the run path, and no chip element**. Per render it is one
`insts.find()` that misses; per block, one id compare in `geom()` and one
short-circuited compare in `validateGraph()`. The Example Flowgraphs list scans
each `.grc` once for a Challenge block as it parses it, and folders holding no
challenge keep the count line written when they were drawn. The modules add
about 4 kB gzipped to the editor bundle.

Two things were deliberately *not* added, because measurement said they would be
complexity for nothing: a cache for `parseChallenge()` (2.7 µs per render — 0.02%
of a frame budget, even though `render()` runs on every pointermove of a drag)
and a cache for the progress store (1 µs a read; ~40 µs per keystroke even at ten
times the current number of challenges). Re-measure before adding either.

## Known limits

- Criteria compare **evaluated** parameter values, so a challenge cannot require
  the reader to type a literal `200` rather than `2*100`. That is intended.
- Criteria address blocks by block ID, so renaming a block in a challenge `.grc`
  breaks its criteria — hence the validation error above.
- Progress is per browser, in `localStorage`.
