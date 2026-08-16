# Instructions for the Copilot coding agent

`AGENTS.md` at the repository root is the guide — architecture, build workflow,
and the non-obvious constraints that make the WASM build work. Read it, and read
whichever `docs/` file its table points at for the kind of change you are making,
before editing. This file adds only what is specific to working here without a
cross-compiler.

## Run these before you propose a change

Your environment is provisioned by `.github/workflows/copilot-setup-steps.yml`:
Node 20, Python with mako + pyyaml, the submodules, and both `node_modules`
trees. Every check below runs in it, in minutes. **Run the ones your change
touches, and do not open a PR with one of them failing.**

```bash
# 1. Editor: type checks, the editor/test suite, and the Vite build.
#    Run after ANY change under editor/, and after any change to example_flowgraphs/
#    (example-flowgraphs.test.mjs parses every example and evaluates its parameters).
(cd editor && npm run check)

# 2. Generated artifacts are committed. If you touched block metadata, a
#    .block.yml, an overlay, or either generator, regenerate and commit the result.
python3 runner/gen_registry.py
python3 editor/gen/gen_blocklib.py editor/public/blocks.json
git diff --stat          # expected to be empty unless you changed block metadata

# 3. The runner's .grc parser and lowering, host-compiled — no Emscripten.
#    Run after any change to runner/src/grc_yaml.hpp or grc_lower.hpp.
(cd runner/test && g++ -std=c++17 -I../src -I../third_party grc_test.cpp -o grc_test && ./grc_test)
```

Never hand-edit `runner/src/generated_registry*.cpp`, `runner/generated_blocks.json`
or `editor/public/blocks.json`. They are build outputs that happen to be tracked;
change the source metadata or the generator and regenerate.

## What you cannot run here, and what covers it

`test/test_smoke.mjs`, `test/test_lazy_scenarios.mjs` and `scripts/run_example.mjs`
all need a built `runner/build/runner.wasm`, which means emsdk, Qt for
WebAssembly and a full GNU Radio cross-build — hours from cold, far past this
environment's budget. Do not try to build it, and do not delete or weaken a test
because it will not run for you.

Those suites run on your pull request, in `.github/workflows/build.yml` via
`pr-preview-build.yml`. Treat that run as the real verdict: watch your PR's
checks, and if the smoke test, the editor suite or the type checks fail there,
push a fix rather than leaving it for the reviewer.

Because you cannot execute a flowgraph, be correspondingly careful with changes
that only fail at run time — anything under `blocks/`, `runner/src/registry.cpp`,
or `example_flowgraphs/`. AGENTS.md's "Runtime gotchas" and
[docs/flowgraph-files.md](../docs/flowgraph-files.md) list the failures that are
silent by construction: an editor schema that drops undeclared parameter ids, an
inline YAML flow mapping the runner ignores, a `blocks_throttle` that stalls.
Re-read them for that kind of change; a green build proves nothing about any of
them.

## Scope

Keep a PR to what the issue asked for. Do not add a new `*.test.mjs` for a small
change — put the assertion in the suite that already covers the code, per
AGENTS.md's "The other suites".
