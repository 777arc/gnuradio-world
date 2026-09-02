# Writing `.grc` files: examples, fixtures, and parameters

Everything that bites when a `.grc` is written or edited by hand rather than
drawn in the editor — how a flowgraph reaches the runner, which parameters are
evaluated on the way, and how to test an example properly.

Two destinations, two sets of rules, because they reach the runner by different
paths:

- **`example_flowgraphs/`** is loaded *through the editor* (palette tab → Run
  button), so it keeps upstream's expression form and is subject to editor
  schemas and validation.
- **`test/fixtures/`** is handed *straight to `runner.html`* by the headless
  harnesses, which perform none of the editor's passes, so it stays
  expression-free.

## Example flowgraphs: test them through the editor

**When you add or edit anything in `example_flowgraphs/`, run it through the
actual editor before calling it done.** Those files are opened from the editor's
Example Flowgraphs tab and reach the runner via its Run button, and none of the
headless harnesses take that path — `scripts/run.mjs` and `test/test_smoke.mjs`
both hand the .grc straight to `runner.html`, skipping every step the editor
performs on the way. Two classes of bug live in that gap, and both are silent:

- **Parameter ids.** A hand-written `RUNNABLE` schema in
  `editor/src/block-defs.ts` supersedes the generated one, and parameters it does
  not declare are dropped without a word, leaving the schema default in place. A
  file that trips this is *correct* fed directly to `runner.html` and *wrong*
  through the editor — it still runs, every block still moves samples, it just
  quietly computes something else. Take parameter ids from the hand-written
  schema for any block that has one.

  The hand-written schemas spell every parameter as upstream's yaml does, so
  the block's `.block.yml` is the authority: every hand-written schema uses the
  ids that yaml uses, so there is no table of alternate spellings to consult.
  Upstream is not self-consistent about the sinks' rate — the Time and Eye Sinks
  call it `srate`, the Frequency and Waterfall Sinks call it `bw` and label it
  Bandwidth, the Time Raster Sink really does call it `samp_rate` — and the
  schemas follow it block by block rather than smoothing it over. What *does*
  differ from native is a default, not an id: the FFT window is rectangular here.
  A case in `editor/test/example-flowgraphs.test.mjs` asserts that no file under
  `example_flowgraphs/` sets a parameter its block's schema would drop, with an
  explicit allowlist for the few GRC writes that nothing here models —
  add to that list only deliberately.
- **Editor-side validation.** Connection type checks, required-parameter checks,
  port connectivity and expression resolution all happen in the editor. A
  flowgraph the runner would execute happily can still be refused before it ever
  gets there. Connectivity is the one that most often catches a hand-written
  file: as in native GRC, every port that is neither `optional` nor hidden needs
  a connection, so a dangling message output — gr-satellites' Message Counter
  emits both `out` and `count`, and upstream marks neither optional — turns its
  block title red and blocks the Run button. Terminate it (Message Debug's
  `store` port swallows a stream of PDUs silently) rather than leaving it open.

One command does it:

```bash
node server.mjs 8090 "$PWD" &                 # the editor has to be served
(cd editor && npm run build)                  # and built
node scripts/run_example.mjs satellites_ax25_afsk.grc
# → RESULT: EXAMPLE_PASS
```

It loads the example from the palette tab, presses Run, and fails on any of: the
editor refusing the flowgraph, `RUNNER_FAIL`, a block sitting at zero items, or a
flowgraph that contains a printing block (Message Debug and friends) yet printed
nothing — that last one being what catches the mis-parameterised case above,
which otherwise looks perfectly healthy. Add `--expect='<substring>'` to assert
specific console output, e.g. the hex of a frame you expect to decode.

`editor/test/example-flowgraphs.test.mjs` covers the cheap half of this in CI
(every example parses, and every arithmetic parameter is one `expr.ts` can
evaluate), but it does not run a browser, so it cannot see either failure above.

Graham's `list_examples` reads these same files and exposes their
native Options metadata together with block and connection counts. Its summary
uses `description`, falling back to the Options `comment` used by some upstream
files, and uses the filename only when neither title nor flowgraph id is set.
It also carries `file_format` and `grc_version` from the top-level metadata.
`read_example` returns that summary again with the complete `.grc`.

### Arrange every new example before committing it

Open it in the editor, run Edit ▸ Auto-Arrange Blocks, and save. Hand-placed
coordinates — and especially the ones an upstream GNU Radio example ships with —
leave the flowgraph reading as whatever its author's canvas looked like;
arranging makes the whole palette consistently left-to-right, and it is the one
thing a reader sees before anything else. Nothing but the coordinates changes, so
it can never affect what the flowgraph computes.

One script does exactly that, for a file or a batch:

```bash
node scripts/arrange_example.mjs analog/sampling_aliasing.grc digital/psk_constellation.grc
# → RESULT: ARRANGE_PASS (2)
```

It drives the same editor and the same Save the manual route does, so the result
is byte-identical to arranging by hand, and re-running it changes nothing. Two
things it does that are easy to get wrong doing this by hand in bulk:

- **It refuses to write a file it did not load.** The editor names the Save after
  the flowgraph on the canvas, and the script checks that name against the file
  it is about to overwrite. Without that check any stale canvas — a load that
  quietly failed, an example slow enough to miss the wait — silently replaces one
  example with another, and a `.grc` full of the wrong flowgraph looks entirely
  normal.
- **It waits for `document.fonts.ready`.** Auto-arrange packs by drawn size, and a
  block's height comes from measured text — a Note's wrapped line count above
  all. Arrange before the web fonts land and the layout shifts by a line next
  time, so a re-run churns coordinates for no reason.

The bulk caveat below still applies: the script adopts the saved file wholesale,
which is right for a flowgraph authored here and wrong for one carried in from
upstream.

**Save is a lossy round-trip; auto-arrange is not.** The editor drops what its
schema does not declare, so saving a file returns it without `import` blocks,
without GRC's `affinity`/`alias`/`comment`/`maxoutbuf`/`minoutbuf`, without
`gui_hint` (desktop GRC's widget placement, which this build does not implement —
see [gui-layout.md](gui-layout.md)), and without most of the options block.
Saving also *adds* one block, the GUI Layout singleton. That is fine for a
flowgraph you authored in the editor and destructive for one adapted from
upstream. When arranging in bulk, take the `states.coordinate`/`states.rotation`
out of the saved file and merge those into the original rather than adopting the
saved file wholesale.

**Delete `import` blocks rather than carrying them.** There is no Python in this
build, so an `import` is pure dead weight: the editor skips it on load (one
"skipped unsupported block" line per import, in the console pane where real
output belongs), and it is never placed by auto-arrange. Nothing needs it, either
— [`expr.ts`](../editor/src/expr.ts) resolves `math.*` and `numpy.*` from its own
registry, with no import statement involved. The one thing you give up is
round-tripping that file back into desktop GRC, whose generated Python *does*
need the import for those same expressions; for an example that exists to be run
in a browser, that is the right trade.

## Hand-written `.grc` fixtures

- A block's `parameters:` mapping is **never empty**. Native GRC writes every
  block's implicit parameters whether or not they hold anything — `comment` on
  all of them, `affinity`/`alias` alongside it on a block with ports, and
  `maxoutbuf`/`minoutbuf` where the block's definition declares an output — so a
  bare `parameters:` key never occurs in a file GRC wrote. A bare one parses as
  YAML **null**, and native GRC then fails at `parameters.items()` while loading,
  which is what `withImplicitParams()` in `editor/src/main.ts` exists to prevent
  on the editor's Save path. Write at least `comment: ''` by hand.
- An expression parameter may only reference names the flowgraph **defines**.
  Native GRC evaluates parameters against a namespace built from the flowgraph's
  own `import` and variable blocks, so a value of `samp_rate` with no `samp_rate`
  variable is a hard error there — and the editor now reports the same thing
  rather than passing the text through to the runner, which would coerce it to
  zero silently.
- **The options block is the top-level `options:` key, never an entry under
  `blocks:`.** Stating it in both places is the natural mistake when writing a
  `.grc` from memory, and it used to load as *two* Options blocks — a state that
  failed validation on the duplicate id and, because the editor refuses to
  delete a required singleton, could not be repaired. `loadFlowgraph()` now
  reconciles the two shapes (top-level wins; a `blocks:` entry is adopted only
  when there is no top-level key), but write it once regardless. A second GUI
  Layout is dropped with a log line for the same reason; that one does belong
  under `blocks:`.
- Stream connections are arrays: `[block, port, block, port]`.
- Message connections are objects with `src_blk_id`, `src_port_id`,
  `snk_blk_id`, and `snk_port_id` (see `grc_lower.hpp`) — written as a *block*
  mapping, not an inline `{...}` one. **The runner's YAML parser accepts flow
  *sequences* but not flow *mappings***, so a message connection written inline
  as `- {src_blk_id: a, src_port_id: out, ...}` is **silently dropped** — the
  graph builds and runs, and only the missing PDUs give it away. Use the
  block-mapping form GRC and the editor actually emit:
  ```yaml
  -   src_blk_id: a
      src_port_id: out
      snk_blk_id: b
      snk_port_id: in
  ```
- Parameter **expressions** depend on how the flowgraph reaches the runner. On
  the editor's Run path they are fine: `resolveParamsForRun()` in
  `editor/src/main.ts` evaluates every numeric/`raw` parameter through
  [`editor/src/expr.ts`](../editor/src/expr.ts) — a Python-subset evaluator covering
  arithmetic, `math`/`numpy`/`firdes`, list literals and repetition — and hands
  the runner a *resolved* .grc. **Its `firdes` and `window` shims are a
  transcription of `gr-filter/lib/firdes.cc` and `gr-fft/lib/window.cc`, not an
  approximation of them**, down to the `(int)(max_attenuation * fs / (22 * tw))`
  tap count and every window type `window::build()` implements. They have to be:
  a Low Pass Filter block has its taps designed by the *runner*, with the real
  `gr::filter::firdes`, so anything less than a faithful port makes two blocks
  given identical arguments disagree inside one flowgraph. A window this shim
  does not implement throws rather than falling back to Hamming, for the same
  reason. `example_flowgraphs/rds/rds_receiver.grc` relies on
  this (`2*math.pi/100`, `samp_rate/(2*math.pi*75e3)`).
  A .grc loaded **straight into `runner.html#<grc>`** gets no such pass: the C++
  side only inlines plain `variable` blocks and coerces numeric strings, so
  `1/8.0` or `255*8` fails there. That is the path `test_smoke.mjs` and
  `scripts/run.mjs` use, so any example added as a smoke case must have its
  arithmetic pre-computed (referencing a `variable` by name is still fine).
  `editor/test/example-flowgraphs.test.mjs` guards the editor half — it parses
  every example and asserts each arithmetic parameter evaluates against that
  flowgraph's own variable scope, which is the failure that otherwise only shows
  up as a dead Run button.
- Enum and string parameters are *not* evaluated on either path; they reach the
  factory as raw text (`gr.GR_MSB_FIRST`, `'"CCSDS"'`), which is what
  `wasm_registry::choice()` normalizes. **Enum params** whose `.block.yml` has
  `cpp_templates: translations` that rewrite option strings (e.g. `analog.cpm.` →
  `analog::cpm::`) just work: `wasm_registry::choice` matches with `::`/`.`
  normalized.
- Which parameters get evaluated is `EVALUATED_DTYPES` in `main.ts`: the numeric
  dtypes, `raw`, and the vector dtypes. Vectors matter because GRC's commonest
  idiom of all — filter taps as `firdes.low_pass(...)` or `[1/sps] * sps` — is a
  `*_vector`, and a taps dtype is usually *templated* (`${ type.taps }` resolving
  through the `type` param's `option_attributes`), so `effectiveDtype()` has to
  resolve the template before the lookup. `editor/test/example-flowgraphs.test.mjs`
  re-implements both and asserts its copy of the set still matches main.ts.

## Parameters that are neither numbers nor text

- **A PMT parameter is parsed, not evaluated.** Native GRC renders Message
  Strobe's message or a Tag Object's key by running `pmt.intern("TEST")` as
  Python. There is none here, and [`expr.ts`](../editor/src/expr.ts) stops at
  numbers and vectors on purpose, so such a parameter is retyped to the
  browser-only `pmt` dtype in `blocks/overlays/<module>/metadata.yml` and reaches
  the runner as its own source text, which `wasm_registry::pmt_value()` parses
  (`intern`, `from_*`, `cons`, `dict_add`, the `init_*vector`s; anything else
  throws by name rather than being interned as its own text). The .grc keeps the
  Python spelling, so it still round-trips to desktop GRC. Note the parser is the
  *parameter* path only — a PMT crossing into the Embedded Python Block's worker
  is a separate, unbuilt bridge (see [embedded-python.md](embedded-python.md)).
- **A list of names is parsed, not evaluated, either.** gr-radar keys its
  estimate messages by symbol and takes the list of them as a Python sequence
  (`('range','velocity')`), which upstream types `raw`. `expr.ts` cannot
  evaluate that and `wasm_registry::vector<std::string>` cannot read it — it
  parses its input as JSON, which rejects both the single quotes and the
  trailing comma a one-element Python tuple needs. So such a parameter is
  retyped to the browser-only `string_vector` dtype in
  `blocks/overlays/<module>/metadata.yml` and reaches the runner as its own
  source text, which `wasm_registry::string_vector()` parses. As with `pmt`,
  the .grc keeps the Python spelling and still round-trips to desktop GRC.
- **Tag Object is a variable, not a block.** `variable_tag_object` builds one
  `gr::tag_t` into `wasm_registry::runtime_tag_objects()` before any block is
  constructed — the same pre-pass `variable_constellation` uses, listed in
  `is_runtime_object()` in `runner.cpp` — and Vector Source's `tags` parameter
  names it. A block that grows a tag-list parameter resolves it the same way,
  through `wasm_registry::tag_objects()`.
- **A QT GUI control referenced by ID** is a variable too, with its own
  construction-order rules — see "A QT GUI control is two objects" in
  [blocks.md](blocks.md#a-qt-gui-control-is-two-objects-not-one).
- **The Note block has a browser-only `bgcolor`.** Native GRC's Note takes one
  parameter, its text; here it also takes an `#rrggbb` fill, edited with the
  browser's colour picker and painted on the block face through the
  `--note-bg` custom property (`normalizeNoteColor` in
  [`note.ts`](../editor/src/note.ts), the tint in `canvas-renderer.ts`, the
  cascade in `editor.css`). Two rules keep it from leaking: an *unset* colour is
  omitted from the .grc entirely — `withoutUnsetNoteColor` in `main.ts`, the same
  reasoning as the Options block's default `scheduler` — so every file written
  before the parameter existed still saves byte-identically; and a colour that
  *is* set is an extra key desktop GRC warns about rather than one it refuses, so
  the file still opens there. An unparseable value reads as no tint rather than
  as an error: a note is an annotation, and a mistyped colour must never make the
  flowgraph invalid.

## Which block to reach for

- **Use `blocks_throttle2` ("Throttle"), never `blocks_throttle`.** Upstream
  deprecated the latter as "Throttle (old)"; both wrap the same
  `gr::blocks::throttle`, but only throttle2 exposes `limit`/`maximum`. Without
  that cap a throttle sleeps in proportion to the whole buffer it is handed, so a
  low rate on a wide stream stalls visibly: a 1200 B/s throttle in front of a
  65536-item buffer emits nothing for ~55 s. `limit: time` with `maximum: 0.1`
  bounds the sleep; `limit: auto` (the default) reproduces the old behavior
  exactly. Also put one throttle at the highest rate in the graph and let
  backpressure pace everything upstream, rather than throttling a slow payload
  stream. The old block is kept registered and loadable so a native .grc that
  still uses it opens — `PALETTE_HIDDEN` in `main.ts` keeps it out of the palette,
  and it loads with its generated schema, whose ids are upstream's
  (`samples_per_second`) — but nothing in the repo should use it.
- **`pdu_pdu_to_tagged_stream` has zero stream inputs** and in practice is not
  scheduled in this runtime, so a PDU chain terminated with it sits at zero
  items. Terminate with `pdu_pdu_to_stream_x` ("PDU To Stream", a plain
  `sync_block`) instead — that is also how the smoke fixtures make message-only
  chains observable to the item counters.
- **A block that prints text needs somewhere to print it** — `wasm_text_sink`
  ("Text Sink"), not a File Sink. See [blocks.md](blocks.md).
