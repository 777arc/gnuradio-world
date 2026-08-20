# js-block spike — phase 1 of JAVASCRIPT_BLOCKS_PLAN2.md

**Verdict: it works.** Every fact the plan's architecture rests on holds, in the
exact flag combination the runner uses, in both Node and headless Chrome, and in
the real runner with a genuine GNU Radio scheduler thread calling `work()`.

This is throwaway investigation code, kept only until the feature lands (or the
plan is dropped). It is not wired into any build or test suite.

## What was being asked

The plan proposes running a JS block's `work()` on the block's own Emscripten
pthread via a plain `EM_ASM`, reading GNU Radio's buffers as zero-copy typed
arrays. Its own risk section says the combination is untried here: `EM_JS` under
`-sMAIN_MODULE=2` is proven by `blocks/src/browser_file_source.cpp`, but nobody
had run that *plus a pthread plus a growable shared heap*.

## Results

### Leg 1 — standalone, the runner's link flags

`spike.cpp` + `js_runtime_spike.js`, built by `build.sh` with `-sMAIN_MODULE=2
-sEXPORT_ALL=1 -pthread -sALLOW_MEMORY_GROWTH=1 -fexceptions`, threads taken from
`PTHREAD_POOL_SIZE` exactly as GR scheduler threads are. 15/15 checks pass, both
plain and with `-sMODULARIZE=1` (the shape Qt links the real runner in).

| check | result |
|---|---|
| `EM_ASM` executes on the calling pthread | yes — `ENVIRONMENT_IS_PTHREAD` is 1 inside the body |
| `MAIN_THREAD_EM_ASM` still proxies from that same thread | yes — 0 inside the body, so the two macros stay distinguishable |
| `--pre-js` code exists in an em-pthread realm | yes |
| `new Function` compiles user source there | yes — no CSP, per `site/_headers` |
| `gr.export()` contract, params on `this`, `start()` | works |
| zero-copy: JS writes GR's buffers through `GROWABLE_HEAP_*` | works, byte-exact |
| a live parameter change lands between calls | works |
| a JS `throw` becomes a catchable `std::runtime_error` | works, `error.stack` preserved |
| four JS `work()` bodies run genuinely concurrently | 4/4 cleared a JS-side barrier |
| each pthread gets its own JS realm | 4/4 saw only their own compiled block |

### Leg 2 — the real runner

`runner_probe.hpp` (a `gr::sync_block` whose `work()` is an `EM_ASM`) was wired
in temporarily — one `#include` and one registry-table line in
`runner/src/registry.cpp`, one `--pre-js` line in `runner/CMakeLists.txt` — and
driven with `js_spike_probe.grc` through `run_runner_probe.mjs`. **Both edits
have been reverted and the runner relinked clean.** To repeat it, re-apply those
three lines.

```
runner verdict: RESULT: RUNNER_PASS blocks=3 sinks=0
  block src:   items=164557898
  block probe: items=164557898
  block sink:  items=164557898

JS_SPIKE pthread=1 main_proxied=0 pre_js=1 compiled=1 calls=2000
         items=8178794 wrong=0  84562 ns/call (20.7 ns/item)  JS_SPIKE_RUNNER_PASS
```

164 million complex samples through a JavaScript `work()`, zero incorrect
samples, with Qt on the main thread and side modules dlopen'd in the same
process. `pre_js=1` also confirms `--pre-js` survives Qt's regeneration of
`runner.html` and `patch_runner_js.py`.

## Cost

| | empty `EM_ASM` | full `work()`, nout=64 | per item |
|---|---|---|---|
| headless Chrome, `-O2` | 77–87 ns | ~1.0 µs | 15.0 ns |
| Node 20, `-O2` | ~136 ns | ~1.5 µs | 22.8 ns |
| real runner, `-O0`, nout≈4090 | — | 84.6 µs | 20.7 ns |

The fixed crossing cost is **under 100 ns**. At GR's few-thousand-`work()`-calls
a second that is noise, and it amortizes away entirely at realistic buffer sizes
— the real runner's 4090-item calls spend ~0.1% of the call on the crossing.
`outputMultiple` remains available as a lever but is not needed.

## Two corrections to the plans

**1. Growth does not detach a view — on a shared heap it never can.** Both plans
say a retained view "reads zeros or throws" (PLAN1) after
`ALLOW_MEMORY_GROWTH` replaces the backing buffer. Measured behaviour on the
`-pthread` shared heap is different and gentler:

- `wasmMemory.buffer` **is** a new object after growth (so identity checks work),
- but the old `SharedArrayBuffer` is **not detached**, and a view onto it keeps
  reading and writing the *same real memory* correctly,
- what a stale view cannot do is address memory that only exists after growth.

So the rule ("re-derive through `GROWABLE_HEAP_*` every call, never cache a
`subarray`") is still exactly right, but for a sharper reason: the failure it
prevents is not a crash or a zero-read, it is a *silent out-of-range* on
buffers allocated after a growth. That is a quieter bug than either plan
describes, which makes the rule more load-bearing, not less. Worth writing into
`docs/js-blocks.md` in those terms.

**2. `-O2` elides an allocation whose memory is never observed.** Not a finding
about the design — a trap that cost time here. The first version of the growth
probe called `malloc(96 MB)` and never read the result; LLVM deleted the
allocation, the heap never grew, and the check failed while looking like a real
platform limitation. `g_sink` is volatile for that reason.

## Reproducing

```bash
source deps/env.sh
bash tools/js-block-spike/build.sh                 # plain
bash tools/js-block-spike/build.sh --modularize    # Qt's shape

# Node (the module must be kept alive; running the file directly exits first)
node -e "require('./tools/js-block-spike/build/spike.js'); setTimeout(()=>{},9000);"

# Browser, against the repository server already on :8090
node scripts/run.mjs /tools/js-block-spike/spike.html     SPIKE_PASS 8090 60000
node scripts/run.mjs /tools/js-block-spike/spike_mod.html SPIKE_PASS 8090 60000
```

Expected: `SPIKE_PASS`.

## What this does not settle

- **Stream tags and message ports.** Out of scope for v1 anyway. The spike shows
  the calling thread is awake and on the stack, which is the property a
  synchronous PMT bridge would need, but no bridge was built.
- **`EM_ASM` from inside a dlopen'd side module.** Known-fragile in Emscripten
  and untested here. It does not matter for this design: `js_block.hpp` compiles
  into the main module, as `python_block.hpp` does. Keep it that way.
- **Anything above ~4 concurrent JS blocks.** Four threads is a concurrency
  proof, not a scaling curve.
