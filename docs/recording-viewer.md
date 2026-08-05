# Recordings: File Source, R2, and the recording viewer

Three connected things: the browser-backed File Source that reads bytes, the R2
bucket those bytes come from, and the recording tabs that display them.

`editor/src/recording/` is a focused viewer adapted from IQEngine — the SigMF
URL/blob reader, spectrogram, Time/Frequency/IQ plots, settings, annotations and
the metadata summary bar, and nothing else. IQEngine's plugins, Cyclostationary
view, backends/authentication and Pyodide path are not included, and neither are
its Global Properties and Raw Metadata editors: nothing here writes a
`.sigmf-meta` back. It is a second entry of the editor's own Vite build, emitted
at `/recording/` — there is no separate IQEngine checkout or build step.

`editor/test/recording-tabs.test.mjs` and `editor/test/real-recordings.test.mjs`
pin most of what follows. Neither runs a browser, so a change here also wants the
manual pass described in AGENTS.md's "Run and test".

## Browser-backed File Source

The WASM registry replaces GNU Radio's POSIX-backed `blocks_file_source` with
`blocks/src/browser_file_source.cpp`. A File Source can be bound either to a
local `File` selected with the editor's Properties → Browse control or to a
recording URL from R2. The binding is session-only: `.grc` files keep the
human-readable filename or `/recordings/...` path and never serialize a browser
file handle.

Each running source owns a `browser_file_reader.js` worker. It reads local files
with bounded `File.slice()` calls and remote recordings with required HTTP Range
requests, then feeds a fixed 16 MiB ring in shared WASM memory. Individual reads
are capped at 2 MiB, so source memory is independent of recording size. Servers
must return `206` with a matching `Content-Range`; a `200` response is rejected
before its body is consumed. Keep R2's CORS policy in `scripts/r2-cors.json`
configured to allow the `Range` request header and expose `Content-Range`.

`test/test_smoke.mjs` covers both backends. Its local-file case selects a sparse
file larger than 4 GiB through the actual editor and reads beyond the 32-bit
boundary; its HTTP endpoint refuses non-Range requests and verifies the exact
range consumed.

## R2 recording source of truth

Production recordings live only in the Cloudflare R2 bucket
`gnuradio-wasm-recordings`, whose public custom domain is
`https://recordings.gnuradioworld.com`. The browser cannot address an R2 bucket
by its bucket name; it uses that HTTPS domain. The editor defaults to this base,
with `VITE_RECORDINGS_R2_BASE` available as a build-time override.

[`workers/sigmf-indexer/`](../workers/sigmf-indexer/) is bound to the bucket as
`RECORDINGS`. R2 object-create notifications for `.sigmf-data` and `.sigmf-meta`
enter `gnuradio-world-sigmf-events`; its consumer batches up to 100 notifications
for up to 60 seconds and performs one rebuild per batch. The rebuild lists every
object, pairs keys with the same base and SigMF suffixes, reads the metadata,
derives byte and sample counts, and replaces the bucket's `index.json`. A 09:00
UTC daily cron provides a fallback, and its authenticated `POST /rebuild`
endpoint performs the same job on demand.

The editor fetches that live index with `cache: no-store`, then constructs both
object URLs from each base key. Each card in the palette offers three things: the
card itself drops a File Source (plus an IShort To Complex for `ci16`) on the
canvas, **View** opens the recording view alone, and 🔗 copies
`#recording=<base key>` — the same base key the index calls `base_filename`, so a
link is readable and survives a re-index. View and 🔗 are offered even when the
datatype has no File Source representation, since that recording is otherwise not
viewable here at all. `server.mjs`, `scripts/assemble-site.mjs`, and Cloudflare
Pages never build or serve a recording manifest, and no recording is ever checked
into this repository.

To publish a recording, upload both matching objects directly to R2 using the
dashboard, the S3-compatible API, rclone, or another R2 client. The event batch
normally refreshes the index within about one minute; the daily and manual paths
remain fallbacks. Collection prefixes are part of the base key:
`estevez/ao73.sigmf-data` pairs with `estevez/ao73.sigmf-meta`. No checkout,
commit, editor rebuild, or Pages deploy is part of this workflow.

### CORS is a manual step

Keep [`scripts/r2-cors.json`](../scripts/r2-cors.json) applied to the bucket.
Committing the file changes nothing, and no workflow applies it:

```bash
# Node 20 cannot run wrangler v4. Needs a token with Workers R2 Storage: Edit,
# which the CI Pages token deliberately does not have -- `wrangler login` is the
# easy path. `set` REPLACES the whole policy, so diff `list` against the file
# first: an origin added through the dashboard and never committed back is
# dropped silently.
npx wrangler@3 r2 bucket cors list gnuradio-wasm-recordings
npx wrangler@3 r2 bucket cors set  gnuradio-wasm-recordings --file scripts/r2-cors.json
```

It allows the production origins, `https://*.gnuradio-world-previews.pages.dev`
(every PR preview) and `http://localhost:8090`, permits GET/HEAD and Range
requests, and exposes `Content-Length`/`Content-Range`. Local testing must use
`http://localhost:8090/`, matching that exact allowed origin. An origin missing
from this list is the one failure that looks like a working build: the editor
loads and flowgraphs run, and only the Recordings palette, File Source range
reads and recording tabs fail, as CORS errors in the console pane.

## Recording tabs

Every File Source with something to show gets its own workspace tab holding the
recording view for it — added when a recording is clicked in the palette, when an
example that references one is opened, or when a file is picked with Properties →
Browse. A recording can also be viewed *without* being put on the canvas at all,
which is the one kind of tab no block owns. Each tab is an `<iframe>` on the
viewer at `/recording/`, driven through its base64url URL route
(`recordingViewUrl()` in `editor/src/main.ts` builds it). The rules that keep it
working:

- **The tab set is derived state.** `syncRecordingTabs()` rebuilds it from
  `insts` at the end of every `render()`, so no mutation path has to remember to
  update it, and nothing about a tab reaches the `.grc`. It must stay synchronous
  and network-free: a remote tab's label comes from the `/recordings/...` path,
  not from the R2 recording index.
- **A pinned tab is the exception**, and the only one. The Recordings palette's
  **View** control and the `#recording=<base key>` link both open a recording
  view for a recording nothing on the canvas refers to, so `openRecordingPreview()`
  sets `pinned` and the sync destroys only unpinned tabs it no longer wants. Such
  a tab carries a `×`, shown exactly while no File Source owns its recording —
  the tab bar is `.workspace-tab-group`, a tab button plus that sibling button,
  because a `<button>` cannot contain one. Both origins key the tab by the same
  `/recordings/...` path `recordingSourceFor()` derives from a File Source, so
  adding the block for a previewed recording *adopts* its tab (the `×` disappears)
  rather than opening a second one, and deleting the block hands it back.
- **`#recording=` composes with `#example=` rather than replacing it.** The
  fragment names two independent things — the flowgraph on the canvas and a
  recording open beside it — so `setUrlFragment()` rewrites one key at a time over
  a whitelist (the one-shot `#fg=`/`#duplicate=` keys are consumed and dropped
  before it runs), and `openRecordingFromUrl()` runs after `loadFlowgraphFromUrl()`
  and reports separately whether it opened anything. A link naming only a
  recording therefore leaves the canvas empty instead of loading the default
  example. Recording keys keep their `/` literal (`encodeRecordingPath`, not
  `URLSearchParams.toString()`) so a copied link stays readable.
- **The iframe is created on first activation, never at sync time.** That defers
  both the viewer bundle (later tabs hit the HTTP cache) and the recording's
  samples. Once created it is kept, so revisiting a tab refetches nothing.
- **Inactive recording panes hide with `visibility:hidden`, not the `hidden`
  attribute.** `display:none` collapses an iframe to zero size, and the viewer sizes
  its spectrogram off the window it is in; it would come back sized for nothing.
  Panels are also never re-inserted into the DOM when tabs reorder — moving an
  iframe reloads the document inside it — so only the buttons are reordered.
- **A local file has no SigMF metadata**, so `synthesizedSigmfMeta()` writes a
  minimal one from the File Source: datatype from its `type` param (a `short`
  or `byte` source whose only sink is an interleaved-to-complex converter is
  `ci16_le`/`ci8`, the chain the recordings tab builds), sample rate from the
  flowgraph's `samp_rate` when it is numeric, and the sample count from the
  file size. Both it and the file itself are handed over as `blob:` URLs, which
  Chrome answers with `206`/`Content-Range` exactly like an HTTP recording, so a
  multi-gigabyte local file is still read in bounded pieces. The pane labels the
  metadata as inferred.
- **Real-valued recordings** (SigMF's `r*` datatypes — an `rf32_le` File Source
  of type `float`, an `ri16_le` one of type `short`, and so on) are supported by
  widening each sample to the interleaved I/Q the rest of the viewer works on,
  with Q = 0, in `convertToFloat32()`. That is deliberately the *only* place the
  difference lives: the FFT of a signal with no imaginary part is
  Hermitian-symmetric, so the spectrogram and frequency plot show the negative
  half mirroring the positive one — which is exactly what a real recording should
  look like — with no changes to either. `dataTypeToBytesPerIQSample()` is the
  other half: a real sample is one component, not two, so `ri16_le` is 2 bytes
  where `ci16_le` is 4, and every byte offset, sample count and range read
  follows from it. The Time plot drops its Q trace and labels the remaining one
  "Real", and the IQ plot says why every point is on the I axis — unless the
  frequency shift is on, which mixes a real signal down to a genuinely complex
  one and makes both meaningful again.

## Viewer styling

- **Under 768px the settings stack below the plot instead of beside it.** That
  is tailwind's `md`, and it is written in two places that have to agree: the
  `md:` flex-direction variants in `recording-view.tsx` and `sidebar.tsx`, and
  `NARROW_LAYOUT_WIDTH` in `utils/constants.ts`, which the spectrogram sizing
  reads because it is computed in JS where a media query is out of reach.
  Stacked, the plot is no longer sharing width with a 256px settings column —
  subtracting the wide layout's 430px would leave it a *negative* width on a
  390px screen — and its 650px minimum height would push every control below the
  fold, so `MIN_STACKED_SPECTROGRAM_HEIGHT` applies instead. The order is
  `flex-col-reverse`: source order stays settings-first, so the plot chooser at
  the top of the settings pane still sits directly under the plot it chooses.
  This is the only breakpoint the viewer may have, as the editor has exactly one
  of its own.
- **The viewer has exactly one text size**: the editor's own chrome font,
  system-ui at 13px. The rules are the un-layered block at the top of
  [`editor/src/recording/features/ui/styles/tailwind_index.css`](../editor/src/recording/features/ui/styles/tailwind_index.css)
  — un-layered because daisyUI hard-codes a font-size on `.input`, `.label-text`,
  `.btn`, `.tab`, `.menu` and `.table` from the components layer, which any
  `@layer base` rule loses to. Size is set on `body` in px and never on `:root`,
  so tailwind's rem-based spacing and widths (the sidebar's `w-64`, and the px
  offsets in `recording-view.tsx` hand-tuned against it) stay put. Text drawn on
  a canvas inherits none of that, so the konva labels (rulers, selectors,
  annotations) and `CanvasPlot`'s axes read `APP_FONT_FAMILY`/`APP_FONT_SIZE`
  from [`editor/src/recording/utils/constants.ts`](../editor/src/recording/utils/constants.ts)
  instead. Prefer those over a new `text-*` utility.
- **The viewer's colors are the editor's, not IQEngine's.** The daisyUI theme in
  [`editor/tailwind.config.cjs`](../editor/tailwind.config.cjs) maps every token onto
  a color taken from `editor/index.html`, plus an `extend.colors` set — `field`,
  `line`, `raised`, `selected`, `muted` — for the chrome colors daisyUI has no
  token for. Style with those tokens rather than a literal hex, and if the
  editor's chrome changes, change them here too. Two places CSS cannot reach need
  the values spelled out: `CanvasPlot`'s theme constants and colorway, and the
  konva chrome (rulers, the minimap scrollbar) which reads `APP_TEXT_COLOR` and
  friends from `utils/constants.ts`. Konva overlays drawn *on the spectrogram* —
  annotation boxes, the freq/time cursors — keep their high-contrast
  white/red/blue instead, because they sit over an arbitrary colormap.
- **The Time/Frequency/IQ tabs draw on a plain 2D canvas, not plotly.** Upstream
  uses `react-plotly.js`, which is ~4.7 MB — several times the rest of the viewer
  — for one trace type, and its size is why upstream loads those three tabs
  lazily. [`editor/src/recording/features/ui/canvas-plot/CanvasPlot.tsx`](../editor/src/recording/features/ui/canvas-plot/CanvasPlot.tsx)
  replaces it: same theme, ticks, hover readout, mode bar, legend and range
  slider, plus pan/wheel-zoom/double-click-autoscale and plotly's `uirevision`
  rule (new data re-autoranges only while the reader has not zoomed). Dense
  traces use min/max decimation, one vertical segment per pixel column, which is
  what keeps the Time tab's ~650k points per trace at a few ms a frame. It is
  repo-owned code, so it is the one file under `src/recording/` that has no
  upstream counterpart to diff against.
