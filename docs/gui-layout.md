# The GUI Layout block

Where a flowgraph's QT GUI widgets go in the runner window. This build ignores
GRC's per-block `gui_hint` entirely and arranges the window from one block
instead, on a dashboard-style grid that can be dragged into shape — in the
Properties dialog, or over the running flowgraph.

Read this before touching `blocks/grc/wasm_gui_layout.block.yml`,
`editor/src/gui-layout*.ts`, `runner/src/gui_layout.hpp`, or the layout pass in
`runner/src/runner.cpp`.

## The model

The window is a grid: `columns` wide (12 by default), every row `row_height` px
tall (60). Each widget occupies a **tile** at `(col, row)` spanning `(w, h)` of
those units. Columns share the window width equally and rows share its height,
so the whole arrangement stretches with the browser tab rather than being pinned
to pixels. Tiles never overlap, and vertical gaps are always closed.

That is the react-grid-layout / Grafana model, and it is deliberately *not*
`gui_hint`: a hint is a per-block property that says nothing about the blocks
around it, which is why upstream flowgraphs so often ship with widgets that
overlap or leave a column empty. Nothing in this repo parses `gui_hint`, and the
editor drops it on load like any parameter its schema does not declare.

## Where it lives

| what | where |
|------|-------|
| block metadata | `blocks/grc/wasm_gui_layout.block.yml` |
| the packing rules — **the only implementation** | `editor/src/gui-layout.ts` |
| the Properties-dialog designer | `editor/src/gui-layout-designer.ts` (loaded on demand) |
| the singleton, the block face, the Arrange overlay | `editor/src/main.ts` |
| the spec as the runtime sees it | `runner/src/gui_layout.hpp` |
| the factory that files it | `runner/src/registry.cpp` (`wasm_gui_layout`) |
| the `QGridLayout` pass | `runner/src/runner.cpp` (`apply_gui_layout`) |
| tests | `editor/test/gui-layout.test.mjs` |

**The runner renders a spec and never edits one.** Collision, compaction and
clamping are in `gui-layout.ts`, shared by both editing surfaces, so there is one
definition of what a drag does and it is the one with tests. A spec arriving in
C++ is assumed packed; the only correction made there is clamping a tile into
the grid, so a hand-edited `.grc` cannot put a widget somewhere no resize will
reveal. Overlap is left alone — it is visible, self-explanatory, and undone by
dragging.

## It is a singleton, like Options

`ensureLayoutBlock()` places one in every flowgraph, including every `.grc`
written before the block existed, and it cannot be deleted, copied or
duplicated. So every flowgraph is arrangeable without the reader having to know
the block exists. Its tiles start empty, which renders as the full-width
vertical stack such a flowgraph has always had.

Two consequences worth knowing:

- **Saving adds the block to the file.** That is the point — the arrangement is
  part of the flowgraph — but it means a saved `.grc` no longer opens in desktop
  GNU Radio, which has no such block. Nothing else in the file changes.
- **It is not a `gr::block`.** `is_runtime_object()` in `runner.cpp` lists it
  beside the constellation and tag-object variables, so run_now()'s pre-pass
  constructs it before any widget exists and the scheduler never sees it. A
  block a flowgraph cannot connect to also never appears in `__grstats`, so the
  smoke test's "every block moved items" rule does not apply to it.

## Which blocks take a tile

Whether a block has a widget is decided in C++ — it is whether its `BuiltBlock`
carries a `QWidget` — and every one of those is a hand-written factory in
`registry.cpp`. The editor cannot work this out for itself, so the answer is
carried across:

```
GUI_IDS (runner/gen_registry.py)
  → "gui" in runner/generated_blocks.json
    → each block's `gui` flag in editor/public/blocks.json
      → GUI_BLOCK_IDS in editor/src/main.ts
```

`GUI_IDS` is therefore a copy of a fact that lives elsewhere, and a stale copy
costs a widget its tile with no other symptom. Two things guard it: the
generator refuses an id that is not a hand-written factory (a generated factory
never builds a widget), and **the runner reports the widgets it actually built
on every run**, so the editor names anything missing from the set in the console.
If you add a widget-bearing factory, add it to `GUI_IDS` and regenerate.

## The two editing surfaces

**The Properties dialog** binds the `gui_layout` dtype to a drag-and-drop grid,
the same hook the Embedded Python Block's `code` dtype uses for CodeMirror. It
works with nothing running. Its cells keep the aspect ratio a real window would
give them, so a tall narrow tile does not look square here and quite different
in the runner.

**Arrange mode** rearranges a *running* flowgraph. The runner posts
`gr-widgets` — the tiles as placed, plus the grid's rectangle in the iframe's
own CSS pixels, which is what Qt's global coordinates are there — and the editor
draws handles over the live plots **in its own DOM**, on top of the iframe. A
drag goes through the same `placeTile()`, is written into the block's parameter,
and is posted back down as `gr-set-layout`; `gr_apply_gui_layout` rebuilds the
`QGridLayout` in place. Nothing restarts: the plots keep plotting while they
move.

Keeping the overlay in the editor rather than building a Qt one is what keeps
every interactive line in TypeScript, where it is testable under node, and keeps
the C++ a renderer.

Three things about the C++ side that are not guessable:

- **The window has a fixed outer layout.** `g_container` holds an error banner
  and `g_gui_area`; only the latter's layout is replaced per run. A flowgraph
  that fails to build has no widgets and therefore no grid to put a banner in.
- **`apply_gui_layout()` must be idempotent.** It runs once per run and again on
  every live edit, and it builds a fresh layout object each time rather than
  mutating one — which is also the only way to change a `QGridLayout`'s spans.
- **Widgets are held as `QPointer`.** A new run `deleteLater()`s the previous
  run's widgets, so a stale entry nulls itself rather than dangling.

## A widget with no tile

It gets a full-width row *underneath* everything that has one, so a sink added
to an already-arranged flowgraph is never invisible. Both ends implement this,
because both need it — the editor to draw the preview, the runner to lay out the
window — and both give a control one row and a plot four
(`CONTROL_ROWS`/`SINK_ROWS`, `kControlRows`/`kSinkRows`). Those two pairs of
numbers have to stay equal, or an unarranged flowgraph is previewed as something
other than what it runs as; `gui-layout.test.mjs` asserts it.

Tiles are keyed by block ID, so renaming a block starts it over at the bottom,
and a tile whose block is gone is dropped on the next edit.
