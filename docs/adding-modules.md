# Adding a module of blocks

Two recipes: an **in-tree** GNU Radio component library (`gr-<m>` built by the
`gr/build-gr` umbrella build), and a **third-party out-of-tree module** vendored
as a submodule and compiled straight into a side module. Read
[blocks.md](blocks.md) — "Where a block's source lives" and "Registry and module
conventions" — first; this file assumes them. [building.md](building.md) covers
the toolchain and the side-module mechanism itself.

## In-tree: adding a category

A "category" here is one GNU Radio component library exposed as either part of
the always-loaded core or an on-demand side module. To add one (say `gr-foo`):

1. **Build the GR library** with `-fPIC`. Add `-DENABLE_GR_FOO=ON` to the
   `gr/build-gr` configure line and rebuild, producing
   `gr/build-gr/gr-foo/lib/libgnuradio-foo.a`. Every object must be `-fPIC`
   (the shared flags already ensure this); a non-PIC object fails the dynamic
   link with `relocation R_WASM_MEMORY_ADDR_* … recompile with -fPIC`.

2. **Register it** in [`runner/modules.json`](../runner/modules.json), which is
   the single source of truth both generators and `runner/CMakeLists.txt` read —
   there is no module list to edit in `gen_registry.py`. Add the short name
   `"foo"` to:
   - **`core`** if it should always be linked into the main module; **or**
   - **`deferred`** *and* **`in_tree_deferred`** if it should be fetched on
     demand. `deferred` is the full set of side modules; `in_tree_deferred` is
     the subset CMake builds by linking a `gr/build-gr` `.a`, which an OOT module
     has not got (see the OOT recipe below).

   `MODULES` (the list of `gr-<m>` directories whose `.block.yml` files are
   parsed) is derived from those two, so nothing else needs adding. If a
   *deferred* module needs symbols from *another deferred* module, add the edge
   to `module_deps` (e.g. `{"foo": ["bar"]}`) so the loader fetches them in
   order; depending only on core modules needs no entry.

3. **Wire the build** in [`runner/CMakeLists.txt`](../runner/CMakeLists.txt):
   - make sure `gr-foo/include` is in `GR_INCLUDE_DIRS` (add it if new);
   - **deferred:** nothing further — the `in_tree_deferred` loop builds
     `foo.wasm` as a `SIDE_MODULE`, folds its imports into `side_exports.rsp`, and
     the editor/loader do the rest.
   - **core:** add `libgnuradio-foo.a` to the whole-archived block in
     `target_link_libraries` (the `$<LINK_LIBRARY:WHOLE_ARCHIVE,…>` list) so its
     full symbol set is present for `EXPORT_ALL`.

   A configure-time check fails if `modules.json` names a deferred category that
   no rule actually produces a side module for, so a half-done registration does
   not reach a build.

4. **Regenerate and rebuild:**
   ```bash
   python3 runner/gen_registry.py
   python3 editor/gen/gen_blocklib.py editor/public/blocks.json
   (cd runner && cmake --build build)   # builds side modules + main + patch
   (cd editor && npm run build)
   ```
   The editor palette picks up the new blocks automatically: `gen_blocklib.py`
   stamps each block with its `module`.

5. **Test lazy loading** with `node test/test_lazy_scenarios.mjs`.

## Out-of-tree: adding a vendored OOT module

The recipe above assumes an in-tree `gr-<m>` built by `gr/build-gr`. A
third-party OOT module (already done for [`gr-rds/`](../gr-rds), [`gr-foo/`](../gr-foo),
[`gr-dvbs2/`](../gr-dvbs2), [`gr-dvbs2rx/`](../gr-dvbs2rx), [`gr-satellites/`](../gr-satellites),
[`gr-paint/`](../gr-paint), [`gr-fosphor/`](../gr-fosphor),
[`gr-droneid/`](../gr-droneid), [`gr-ham/`](../gr-ham), and
[`gr-ieee802_11/`](../gr-ieee802_11)) is **not** part of that
umbrella build, so there is no `libgnuradio-<m>.a`; instead its own `lib/*.cc` are
compiled straight into an on-demand `<m>.wasm` side module. This is a
**self-contained checklist** — following it needs no investigation beyond the
module itself. Copy an existing OOT module (gr-foo is the simplest, gr-dvbs2 the
most complex) as a working reference for every step.

An upstream repository may wrap the actual OOT instead of placing `grc/`,
`include/`, and `lib/` at its root. `proto17/dji_droneid` is the worked example:
the submodule remains at `gr-droneid/`, while `runner/modules.json` maps its
module root to `gr-droneid/gnuradio/gr-droneid` through `source_roots`. Both
generators consume that shared mapping; do not add symlinks or edit the nested
upstream checkout to flatten it.

**1. Add it as a submodule** at the world-repo top level, beside the `gnuradio/`
submodule. Pin **upstream's own** GNU Radio-compatible default or maintenance
branch, not a fork:
```bash
git submodule add -b <branch> https://github.com/<upstream>/gr-<m>.git gr-<m>
```
The checkout path is yours to choose, and `<m>` is **not** free: it becomes a C
identifier (the `Registrar_<m>` in the generated registrar, the
`generated_registry_<m>.cpp` filename, the `<m>.wasm` side module), so it has to
be spelled the way the module's C++ namespace is. Both generators also discover a
module by globbing `gr-*/grc`, so the directory has to *be* `gr-<m>` rather than
be mapped to it — `source_roots` only relocates the module root *within* a
checkout, and pointing it at a differently named sibling would make the same
`grc/` scanned twice under two module names. Where upstream's repository name
disagrees, rename on checkout: `bastibl/gr-ieee802-11` is vendored at
`gr-ieee802_11/` because its namespace, and therefore its module name, is
`ieee802_11`.
Steps 3 and 5 exist so this stays possible: block metadata and generated headers
both live in this repository, so a normal OOT module needs no branch of its own
and bumping it is a plain `fetch` + `checkout` with nothing to rebase. Of all the
vendored modules only gr-dvbs2 is a fork, and it is upstream plus exactly one
commit: a WASM buffer-wrap fix that had to go in its `lib/`. Do not create a fork
to hold yaml or a generated header.

**2. Triage the blocks** — which have a C++ path, and what they depend on:
```bash
ls gr-<m>/lib/*.cc                                   # C++ blocks have an impl here
ls gr-<m>/python/*.py                                # gr.hier_block2 / GUI = Python-only
grep -rHn 'static sptr make' gr-<m>/include/*/*.h    # constructor signatures
grep -rho '#include *<[a-z].*>' gr-<m>/lib/*.cc | sort -u   # spot host-only deps
```
A block is directly generator-buildable only if it has a C++ impl. **Python-only
blocks** — a `gr.hier_block2` (e.g. gr-foo's `selector`/`valve`) or a GUI QWidget
(e.g. `rds_panel` = `rds.rdsPanel`) — have no automatic C++ path, and without a
hand-written rebuild they show greyed-out in the palette. Three kinds of rebuild,
all landing in the module's own `blocks/overlays/gr-<m>/`:

- a **GUI panel** becomes a `QWidget` message sink — `rds_panel.hpp` is the
  worked example — needing *no* step 3 `cpp_templates`, since `registry.cpp`
  supplies the factory and `gen_registry.py` reads the custom ids back out of
  that table. Its overlay entry declares only `gui: true`, so the editor knows
  it takes a tile;
- a **hierarchy** becomes a C++ `hier_block2`. The ~60 gr-satellites rebuilds do
  keep a step 3 entry, whose `make` calls into `satellites_*.cpp` beside their
  `metadata.yml`;
- a block resting on a **host facility the browser also has** becomes a browser
  one: gr-paint's PIL-based `paint_image_source` decodes a locally picked `File`
  or a fetched URL with `createImageBitmap` instead, again with a hand-written
  factory in `registry.cpp` rather than a generated one.

A module can be **entirely** Python: gr-ham's `lib/` holds a CMakeLists.txt and
nothing else, so it has no vendored source to compile and its side module is the
generated factory table over
[`blocks/overlays/gr-ham/ham_blocks.cpp`](../blocks/overlays/gr-ham/ham_blocks.cpp)
alone. Nothing about steps 3, 6 and 7 changes — only step 6's source list is
shorter. Blocks worth rebuilding are the ones whose output can be *checked*:
gr-ham's varicode codec round-trips byte for byte and its CHU decoder prints a
time that has to match the recording's own timestamp, while its `dstar_rx` has
`# TODO` stubs where its Viterbi and Golay decoders should be and writes its real
output to a host file for a separate AMBE decoder — no browser equivalent, and
nothing to check a rebuild against, so it has no entry and stays greyed out.

**Host-only deps** not in the WASM sysroot (UHD, Boost.Asio networking,
Boost.Locale, libsndfile, …) must be dealt with in step 4.

**3. Add `cpp_templates` for each C++ block** in a new
`blocks/overlays/gr-<m>/metadata.yml`. This is what the generator turns into a
factory. **Never edit the submodule's own `.block.yml`** — every browser-only
addition goes in this one file, which is what lets the submodule stay pinned to a
pristine upstream commit instead of a fork you have to rebase and push:
```yaml
<m>_<block>:
    flags: [python, cpp]
    cpp_templates:
        includes: ['#include <<m>/<block>.h>']
        declarations: '<m>::<block>::sptr ${id};'
        make: 'this->${id} = <m>::<block>::make(${arg1}, ${arg2});'
        link: ['gnuradio-<m>']
```
The file is picked up by its name alone — no loader, generator, or build change.
[`tools/block_overrides.py`](../tools/block_overrides.py) documents every supported
key and is imported by *both* `runner/gen_registry.py` and
`editor/gen/gen_blocklib.py`, so the runtime factory and the palette entry
describing it always come from the same merge. Its in-tree counterpart is
[`blocks/overlays/gnuradio/metadata.yml`](../blocks/overlays/gnuradio/metadata.yml), for overlays on blocks
in the `gnuradio/` submodule itself.

Mirror the arg order of the existing Python `templates: make:`, resolved against
the C++ `make()` signature from step 2 — the two are no longer adjacent in one
file, so read the block's yaml alongside what you write. If the module has an
in-tree analogue, copy that block's `cpp_templates` verbatim (gr-dvbs2's blocks ≈
gr-dtv's `dtv_dvb*`). Three generator constraints, each with a standard fix:
  - **Foreign-namespace enum values.** When `${param.val}` expands to
    `<m>.SOMETHING`, add `translations: {<m>\.: '<m>::'}` under `cpp_templates`
    (the generated file has `using namespace gr;`, so `<m>::SOMETHING` resolves).
    This mirrors gr-dtv's `dtv\.: 'dtv::'`.
  - **`raw` params the generator can't type** make the whole block *skip* (watch
    for it in the `gen_registry.py` "skipped" output). Retype with
    `parameter_dtypes` / `parameter_defaults`: a PMT (`pmt.intern("x")`) →
    `dtype: string` default `x`, with the `make` wrapping it in `pmt::intern(...)`
    itself (gr-foo's `burst_tagger`); a bare numeric expression → `int`/`real`.
  - **Stale enum options (yaml vs. header drift).** If the generated code names an
    enumerator the vendored C++ enum lacks (`no member named '<m>::FOO'`), list
    that option under `prune_options: {<param id>: [FOO, ...]}`. It drops the
    matching entry from `options`, `option_labels` and every `option_attributes`
    list at once, so the three stay index-aligned (they pair positionally) without
    you editing them by hand. gr-dvbs2's `bbheader_bb` is the worked example.

A typo'd or misfiled block id is rejected rather than silently ignored:
`gen_registry.py` fails if an overlay matches no known block, names a block from a
different module, uses an unknown key, or duplicates an id in another file.

**4. Handle host-only deps** so the desktop build stays intact. Unlike step 3,
these can need a real source change, which is the only reason left to fork a
submodule at all (gr-dvbs2 is forked solely for a WASM buffer-wrap fix):
  - Prefer a runner-owned shim include directory over touching the source, which
    keeps the submodule pristine: gr-rds
    calls `boost::locale::conv::to_utf` once, to convert RadioText from
    ISO-8859-2, and Boost.Locale is not in the WASM sysroot, so
    [`blocks/overlays/gr-rds/shims/boost/locale.hpp`](../blocks/overlays/gr-rds/shims/boost/locale.hpp)
    implements exactly that one call inline and the rds side-module rule
    prepends `-I${RDS_WASM_SHIMS}` ahead of the normal include flags, **or**
  - if it's already behind a feature macro, just leave that undefined (gr-foo's
    UHD `tx_time` tagging under `#ifdef FOO_UHD`), **or**
  - if a whole block is unusable in the browser (host networking, etc.), drop its
    source from step 6 and simply give it no entry in step 3's file, which leaves
    it Python-only and greyed out (gr-dvbs2's `bbheader_source` = a Boost.Asio UDP
    source), **or**
  - only if none of those work, fork the submodule and guard the offending code
    with `#ifdef __EMSCRIPTEN__`.
  - **Header-only SIMD libraries** that dispatch on `__AVX2__` / `__SSE4_1__` /
    `__ARM_NEON__` (gr-dvbs2rx's LDPC/BCH decoder) need nothing: Emscripten defines
    none of those, so they fall back to their generic scalar path and compile as-is
    (slower, still correct). Don't add `-msimd128`/`-msse4.1`.

**5. Supply an empty `config.h`** if the impls include the file generated by the
module's own CMake. Put it in `blocks/overlays/gr-<m>/shims/`, the same place as
step 4, and point the module's `-I${<M>_WASM_SHIMS}` at it *ahead of*
`${SIDE_INCLUDE_FLAGS}` in its side-module rule. The impls include it as `"config.h"`, so
with no copy beside the sources it resolves from there; nothing else on the
include path defines one. Most vendored modules do this — no submodule holds a
`config.h` of its own; gr-paint and gr-fosphor guard their includes behind
`#ifdef HAVE_CONFIG_H`, which nothing defines, so they need no shim. Together
with step 3 this is what lets the submodules stay pinned to pristine upstream.
(Any real per-module constants header that ships in the repo, e.g.
`dvbs2_config.h`, is used as-is.)

**6. Register and wire the build:**
  - [`runner/modules.json`](../runner/modules.json): add the short name `"<m>"`
    to **`deferred` only**. **Do not** add it to `in_tree_deferred` — that list
    drives a CMake loop that links a `gr/build-gr` `.a` the OOT module doesn't
    have. If the upstream repo nests the module below its root, add its path to
    `source_roots` (as `gr-droneid` does) rather than flattening the checkout.
    The overlay loader needs nothing — it discovers `blocks/overlays/gr-<m>/` by
    name — and `GR_INCLUDE_DIRS` picks that directory up by glob, so a rebuilt
    block's header is already on the include path.
  - [`runner/CMakeLists.txt`](../runner/CMakeLists.txt): add `${WORLD}/gr-<m>/include`
    to `GR_INCLUDE_DIRS`, then copy an existing OOT `add_custom_command` (the
    `rds` / `foo` / `dvbs2` block) — list `generated_registry_<m>.cpp` plus the
    module's `lib/*.cc` (minus any source excluded in step 4) and append
    `<m>_out` to `SIDE_MODULE_OUTPUTS`. The configure-time check cross-references
    that against `modules.json`, so forgetting one half fails the configure
    rather than the build. `side_exports`/palette/on-demand fetch then work
    unchanged.

**7. Generate, compile-check, build, verify:**
```bash
python3 runner/gen_registry.py                      # expect "<m>=N" in the deferred list, and no new skips
source ~/emsdk/emsdk_env.sh                          # emsdk 3.1.70 on PATH
cmake --build runner/build --target side_modules    # FAST: builds <m>.wasm only, no main relink
python3 editor/gen/gen_blocklib.py editor/public/blocks.json
(cd runner && cmake --build build)                  # side modules + main relink (~2 min: wasm-opt)
(cd editor && npm run build)
```
The `side_modules` target is the fast inner loop for iterating on `cpp_templates`
/ source fixes; only do the full `cmake --build build` (which relinks the ~18 MB
main module) once the side module compiles clean.

`gen_registry.py` ends with one summary line — `generated core=N (+M custom);
deferred: digital=38, dtv=52, …; skipped K`. `skipped` is a *count*, not a list,
and it is never zero: the in-tree blocks needing a typed GRC companion object are
permanently skipped (see `generated_blocks.json`'s `skipped` map for the names and
reasons). What matters is that your module appears in the deferred list with the
block count you expect and that `K` does not grow.

**8. Smoke-test headless** — build a tiny `.grc` that forces the module to load
and construct a block, then expect `RESULT: RUNNER_PASS`:
```bash
node server.mjs 8090 "$PWD" &                        # COOP/COEP dev server
URL="/runner/build/runner.html#$(node -e 'process.stdout.write(encodeURIComponent(require("fs").readFileSync(process.argv[1],"utf8")))' my.grc)"
node scripts/run.mjs "$URL" RUNNER_PASS 8090 45000   # headless chrome; prints the RESULT line
```
`RUNNER_PASS` confirms the side module fetched + `dlopen`'d and every block
constructed and the graph started — it does **not** verify DSP correctness of the
chain.

## Symbols across the core/side-module boundary

`gen_side_exports.py` re-exports whatever a side module imports, so most
cross-module calls need no thought. Two cases do:

- If a **core** hand-written factory references a **deferred** module's symbols
  (as `digital_psk_mod` uses a few `gr-digital` blocks), link that module's `.a`
  *normally* (not whole-archive) into the main module too, so just those objects
  are pulled into core; the rest stay in the side module. See the `gr-digital`
  entry in `target_link_libraries` for the pattern.
- If a **deferred** module's factory references *another deferred* module's
  symbols, the `.a` trick does not help: `gen_side_exports.py` re-exports with
  `--export-if-defined`, so a symbol nothing in main references is never pulled
  in, never defined, never exported, and the side module fails at `dlopen` with
  `bad export type for '<mangled name>': undefined`. Add the edge to
  `module_deps` in [`runner/modules.json`](../runner/modules.json) instead —
  gr-satellites' rebuilt hierarchies use `gr::pdu`, hence
  `"module_deps": {"satellites": ["pdu"]}`.

## gr-satellites: the largest rebuild

Its hierarchies, demodulators and deframers are all Python with no C++ path
upstream, so they live in
[`blocks/overlays/gr-satellites/satellites_hier.cpp`](../blocks/overlays/gr-satellites/satellites_hier.cpp)
(`hier/` scramblers, `sync_to_pdu*`, `rms_agc`, `ccsds_viterbi`, and the AFSK /
FSK / BPSK demodulator components) and
[`blocks/overlays/gr-satellites/satellites_deframers.cpp`](../blocks/overlays/gr-satellites/satellites_deframers.cpp)
(`hdlc_deframer` plus ~29 deframer components). Each class mirrors the block set
and connection order of the Python file named in its comment, so the two stay
diffable; syncwords and packet lengths are copied verbatim. The GRC `options`
parameter is an argparse command line for the `gr_satellites` tool — nothing in
the browser supplies one, so the rebuilds hard-code the defaults those parsers
declare (collected as named constants at the top of the hier file).

The deframers still missing are the ones whose Python defines extra
protocol-specific helper blocks inline — a UART decoder, a packet cropper, a 4x4
interleaver and so on. Each needs its own C++ block before its deframer can be
assembled, which is why they are not simply compositions like the rest.

Two more gr-satellites specifics:

- It is **the only module with `grc/` subdirectories** (`components/deframers`,
  `components/demodulators`, `hier`, `ccsds`, `usp`, `core`, …), which is why
  `gen_registry.py` and `gen_blocklib.py` both walk `grc/` recursively. It ships
  no `.tree.yml`; every block carries an explicit `category: '[Satellites]/...'`,
  so the palette categories come for free.
- Its rebuilt hierarchies wrap their message ports with
  `gr::pdu::{pdu_to_tagged_stream,tagged_stream_to_pdu}`, hence
  `"module_deps": {"satellites": ["pdu"]}` in `runner/modules.json` — see
  "Symbols across the core/side-module boundary" above.
