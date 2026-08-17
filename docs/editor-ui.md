# Editor UI conventions

The editor started as a 1:1 port of `gnuradio/grc/gui_qt` and still follows it
where it can. If an edit asks that some behavior match the native version, that
directory is the reference.

## Block IDs

A block's instance name is its GRC `id`, and both halves of how it behaves come
from native GRC:

- **Generated, not authored.** `uniqueBlockName()` in `main.ts` is native's
  `_get_unique_id` (`grc/gui_qt/components/canvas/flowgraph.py`): the first free
  `<base>_<n>` counting from 0, where the base is the block key when placing a
  block (`analog_sig_source_x_0`) and the name being copied on paste or duplicate
  (`analog_sig_source_x_0_0`). Deriving it from the names in use rather than from
  a running counter is the point — undo, paste and a loaded flowgraph all feed
  the same set, so a collision cannot arise.
- **Hidden for most blocks.** Native builds the implicit `id` parameter as
  `hide: none` when the block's yaml carries the `show_id` flag and `hide: all`
  otherwise (`grc/core/blocks/_build.py` `build_params`), so only Variable, the
  QT GUI controls, Probe Signal and the ~60 other flagged blocks — the ones whose
  ID is what another block references — put an ID row on the block face and an ID
  field in the Properties dialog. `blockFlags()` in `block-library.ts` carries the
  flag out of `blocks.json` into `RunnableDef.showId`; the hand-written `variable`
  schema sets it directly, because the runner inlines variables and so
  `blocks.json` marks that block unsupported and the merge skips it. View ▸ Show
  All Block IDs is native's `grc/show_block_ids` override and forces both on for
  every block.
- **Validated as an identifier.** `^[A-Za-z]\w*$` plus uniqueness among enabled
  blocks, as in native's `validate_block_id` (`grc/core/params/dtypes.py`) —
  every ID becomes a Python identifier in generated code.

The **Options** block is the one deliberate divergence from native. Upstream it
holds the *flowgraph* id — always visible, serialized under `parameters:` rather
than as the block's `name:` — because native generates a top block class and
`.py` file from it. Nothing here does: the runner drops the options block while
lowering, and the only reader of that id in this repo is the Example Flowgraphs
palette, as a label fallback for a flowgraph with no title. So the block exposes
no ID at all (`blockIdVisible()` returns false for it, override included), and
`flowgraphId()` derives one from the Title on the way out — non-identifier
characters to underscores, an `fg_` prefix when the result would not start with a
letter, `default` when the Title is empty. That keeps the `.grc` valid for desktop
GRC without an extra field to maintain. `editor/test/grc.test.mjs` re-implements
the derivation and asserts every example's title still yields a legal id.

## Auto-arrange (Edit ▸ Auto-Arrange Blocks)

Rewrites every block coordinate so the flowgraph reads as a left-to-right
flowchart. The engine is [`editor/src/layout.ts`](../editor/src/layout.ts), which
takes measured boxes and returns coordinates and touches neither the DOM nor the
editor's own types; `autoArrangeBlocks()` in `main.ts` does the measuring (box
size from `geom()`, port tab overhang from `portWidth()`, port offsets from
`portPos()`), applies the result, and records one history entry so the whole
arrangement undoes in a single Ctrl+Z. Nothing about it reaches the `.grc` beyond
the coordinates GRC already stores.

There is no automated test for it: whether an arrangement reads well is a
judgement for the eye, so check a change here by arranging a few of the busier
examples (`rds/rds_receiver.grc`, `ofdm/ofdm.grc`,
`gr-satellites/satellites_ax25_afsk.grc`) in the editor and looking at them.

## Narrow screens and touch

The editor is one responsive layout, not a separate mobile build. Four things
carry it, and each has a reason it is where it is:

- **One breakpoint, written twice.** `@media (max-width:820px), (max-width:1000px)
  and (max-height:500px)` in `editor.css` and the identical `NARROW_LAYOUT`
  `matchMedia` in `main.ts` — the CSS lays the palette out as a drawer, and the
  JS has to know the same thing to decide whether closing it after a tap makes
  sense. The second half of the query is a phone held sideways, which clears the
  width bound but has no room for a 460px palette either. Nothing else in the
  editor may add a breakpoint of its own; the recording viewer has one more, at
  tailwind's `md` (768px), for the same reason — see
  [recording-viewer.md](recording-viewer.md).
- **The drawer is the existing `hide-palette` state.** It is not a second mode:
  `setPaletteOpen()` toggles the same class View ▸ Show Block Tree Panel and
  Ctrl+B always toggled, so all three paths and the ☰ button stay in step. The
  palette becomes an absolutely positioned grid item pinned to its own grid area
  (row 2 / column 1), which is what leaves the header above it tappable without
  anyone measuring the header's height. Anything that puts something on the
  canvas — a block, an example, a recording — calls `closePaletteDrawer()`,
  because otherwise the drawer is covering the thing it just added.
- **Canvas gestures are pointer events**, so one set of handlers serves a mouse
  and a finger. Two consequences worth knowing before touching them: a drag is
  captured on the `<svg>` root, because `render()` replaces a dragged block's own
  node on every frame and events aimed at a detached node reach no window
  listener; and a press on empty canvas arms a rubber band only for a mouse,
  since that same drag is how a finger pans the canvas.
- **A block cancels `touchmove`, and that is what makes dragging work at all.**
  `touch-action:none` is the declarative form and does nothing here — Blink
  applies the property to CSS boxes, and an SVG child element is not one, so the
  browser takes the gesture for a scroll and the block stops two frames in with a
  `pointercancel`. Cancelling the move rather than the touch start is deliberate:
  it leaves a long-press free to raise the block's context menu. It is bound per
  block rather than once on the canvas because touch events keep targeting the
  node the gesture began on even after `render()` has replaced it.
- **The console gets a collapse bar in place of its splitter.** The 7px
  `#consoleSplitter` is a drag target no finger can hit, so the narrow layout
  hides it and shows `#consoleToggle` — a full-width bar above the pane — which
  toggles the same `console-hidden` class View ▸ Show Console Panel and Ctrl+R
  always toggled (hence `toggleConsole()` rather than a class flip inline in the
  key handler, exactly as with the palette drawer). The bar is deliberately *not*
  hidden by that class: collapsed, it is the only thing left on screen that can
  bring the pane back, so it also takes over the console's safe-area inset. A
  console that is closed is a console whose runner errors go unseen, so
  `logLines()` marks the workspace `console-unread` while it is collapsed and the
  bar carries a dot until it is opened again.

## Embedding a flowgraph in another page (`?embed=1`)

`https://gnuradioworld.com/?embed=1#example=digital/welcome_example` in an
`<iframe>` is the whole interface: another site gets the flowgraph and its QT
GUI, and none of the application around them.

```html
<iframe src="https://gnuradioworld.com/?embed=1#example=ofdm/ofdm"
        allow="cross-origin-isolated" width="960" height="560"></iframe>
```

A **query** parameter, not a fragment key, because the fragment already says
*which* flowgraph to show (`#example=`, `#fg=`, `#recording=`) and is rewritten as
the reader works, while this is a property of the host page's `src` that nothing
in the app may touch — which is also what makes dropping the whole query the
right way to *leave* one, as `#embedOpen` does below. Any value but `0`/`false`
turns it on, bare `?embed` included. It composes with every existing fragment, so
an embed can carry a shared `#fg=` flowgraph just as well as a named example.

Add `click_to_load=1` when the host should pay almost none of the application's
startup cost until its reader asks for it:

```html
<iframe src="https://gnuradioworld.com/?embed=1&click_to_load=1#example=ofdm/ofdm"
        allow="cross-origin-isolated" width="960" height="560"></iframe>
```

This flag has no effect without `embed`. With both flags enabled, the initial
document fills the frame with `blurry_flowgraph.png` and centres the **Load**
button over it. The tiny `bootstrap.ts` entry does not import application code;
pressing the button dynamically imports `main.ts`, whose chunk owns
`editor.css`, then loads the application header logo. That keeps the editor
bundle, stylesheet, block catalog, example, recording index and runner out of
the host page's initial waterfall. Like `embed`, any value but `0`/`false`
enables `click_to_load`, including the bare flag.

Four things make it an embed, and each is one place:

- **The layout is a class.** `EMBEDDED` in `main.ts` adds `embedded` to `#app`
  and `editor.css` does the rest: header, palette and its splitter, the tab
  strip, the run bar and the console are `display:none`, so their grid tracks
  collapse and `#workspaceContent` — the editor canvas and the QT GUI pane, the
  two panels the tabs would switch between — fills the frame. `display`, not
  `visibility`, for that reason. The rules outrank the narrow-layout media query,
  which otherwise brings ☰ and the console collapse bar back on a phone-sized
  frame; an embed has neither a palette nor a console to reach.
- **One button is both Run and Stop.** `#embedRun` floats in the top centre of
  the panels, with `#embedOpen` in the corner of the same row (a bar of their own
  would eat the height the host page gave the frame; the row spans the frame and
  passes pointer events through, so it is not a strip of dead canvas across the
  top). Nothing new happens when it is pressed: `run()` already
  selects the QT GUI pane and `stop()` already returns to the canvas, so the pane
  on screen follows the run state and the two actions are never both available.
  Run is nearly the only control left, so it also has to report a **refusal** —
  `run()` explains a flowgraph that fails validation in the console pane, which
  an embed does not show, hence the three-second `⚠ Cannot run` on the button.
- **The way out is a link, and it follows the canvas.** `#embedOpen` opens the
  flowgraph in the full application in a tab of its own — an `<a>` rather than a
  button, so middle-click and "copy link address" behave; below the narrow
  breakpoint it drops to "Open ↗", which is the only room a phone-sized frame has
  left beside a centred Run. Leaving the embed is
  just dropping the query the host page framed it with, and while the reader has
  changed nothing that leaves the clean, bookmarkable `#example=` link. After an
  edit that URL would open a *different* flowgraph than the one on screen, so
  `refreshEmbedOpen()` swaps in the frozen `#fg=` payload that File ▸ Copy
  Flowgraph URL hands out. It is *kept* current rather than computed on click
  because gzipping is async and a link has to know where it points beforehand,
  which is why the three history functions call it: they are where the canvas
  changes as a whole.
- **The canvas is still the editor.** Blocks can be moved, opened and rewired;
  what is missing is everything that acts on the *application* — no menus, no
  palette to add a block from, and no welcome modal (`showWelcomePopup()` is
  skipped, since an embed's reader did not come for it).

**Running one off-site needs a cross-origin isolated host page.** The runner is
Emscripten pthreads, so it needs `SharedArrayBuffer`, and cross-origin isolation
is inherited from the top-level document — a framed page cannot earn it alone. So
the host page must send `Cross-Origin-Opener-Policy: same-origin` and
`Cross-Origin-Embedder-Policy: require-corp` and mark the frame
`allow="cross-origin-isolated"`. This is also why this site serves
`Cross-Origin-Resource-Policy: cross-origin` (`scripts/http-support.mjs`, and the
`_headers` block in `scripts/assemble-site.mjs` that deploys it): a COEP host may
only frame a document whose CORP admits it, and with the stricter value the
iframe does not load at all — `ERR_BLOCKED_BY_RESPONSE`, before any of the above
matters. Nothing here is private, so that is a cheap price; keep the two copies
of the header in step.

A host page that is *not* isolated still gets a working embed of everything but
Run: the flowgraph renders and can be explored, and pressing Run fails in the
runner. Same-origin embedding — a page on this site framing another — needs none
of it.

`editor/test/workspace-tabs.test.mjs` covers the embedded layout alongside the
tabs it stands in for. What it cannot check is that a real host page can frame
it, which is a browser-level property: to verify a change here by hand, serve a
page with those two headers, frame `?embed=1`, and confirm `crossOriginIsolated`
inside the frame before pressing Run.

`editor/test/selection.test.mjs` pins the pointer-event wiring. Everything else
about the layout is a judgement for the eye, like auto-arrange: check a change by
loading the editor at a phone viewport, opening the drawer, the Properties dialog
and a recording tab, and dragging a block with touch emulation on.
