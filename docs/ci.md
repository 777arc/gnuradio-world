# Continuous integration and deployment

`.github/workflows/deploy-wasm.yml` builds the whole stack from source and
deploys to Cloudflare Pages on every merge to `main`. Nothing is prebuilt, so the
deployed artifacts can never disagree with the source tree. The build itself
lives in `.github/workflows/build.yml`, a `workflow_call` reusable workflow that
the PR preview (below) also calls, so a preview and production are compiled by
exactly the same steps; `deploy-wasm.yml` is only the trigger, the inputs and
`secrets: inherit`. Two caches keep that affordable:

- **`sysroot`** — Boost/FFTW/GMP/Qwt/VOLK/spdlog, cached as an *output* keyed on
  `deps/env.sh` + `fetch-deps.sh` + `build-deps.sh` and the emsdk/Qt versions.
  Rebuilt only when one of those changes (~25 min), a hit otherwise.
- **`ccache`** — GNU Radio, qtgui and the runner are recompiled every run, with
  ccache absorbing the cost. Caching `gr/build-gr` instead does *not* work:
  `actions/checkout` stamps every source file with a fresh mtime, so a restored
  ninja build dir rebuilds all ~520 objects anyway. ccache keys on preprocessed
  content, so a one-file GR change recompiles one file.

Before deploying, CI runs `test/test_smoke.mjs` and `test/test_lazy_scenarios.mjs`
in headless Chromium. This is a gate, not a formality: a cleanly linked runner can
still be dead on arrival (an unpatched VOLK once made `volk_malloc()` return NULL,
so every flowgraph threw `std::bad_alloc` while CI stayed green). The smoke test
requires every block in the runner's diagnostics snapshot to have moved items, so
a graph that starts but stalls fails too. Changes should leave both tests
passing; a successful link alone is not adequate validation.

Other triggers: `workflow_dispatch` builds without deploying unless you tick
`deploy`, and `rebuild_sysroot` forces the cold path (~1 h) to test the dep
scripts end to end. A weekly `schedule` run exists purely to keep the caches
alive — GitHub evicts anything unused for 7 days, and it never deploys.

## Runner version-locking

`assemble-site.mjs` version-locks the runner: `runner.js`, `runner.wasm` and the
category side modules are one indivisible build (emcc bakes that link's `EM_ASM`
string addresses into `runner.js`'s `ASM_CONSTS` table), but none of the names
carry a version. A browser that reuses a cached `runner.js` from the previous
deploy while fetching this deploy's `runner.wasm` dies in `main()` with
`ASM_CONSTS[code] is not a function` — the 1.2 MB script is small enough to come
back from the in-memory cache, the 19.5 MB wasm is not. So the assembler hashes
the runner build and stamps `?v=<hash>` onto the `<script>` srcs in `runner.html`,
whose `locateFile` hook passes the same stamp to `runner.wasm` and every
`dlopen`'d side module. `runner.html` itself is always fetched fresh (the editor
appends a unique `recordingToken`), so it is the carrier. Served unstamped — dev
server, smoke tests — the hook is inert.

Because those URLs now change with their content, `_headers` gives them
`Cache-Control: public, max-age=86400`, replacing the `max-age=0,
must-revalidate` Pages defaults. That is worth doing: the runner iframe reloads on
every Run, and revalidating costs 9 conditional requests per repeat visit (the
pthread workers re-request `runner.js` too) where a warm cache costs zero. It is a
day rather than `immutable` because `_headers` matches paths, not query strings,
so the rules also cover the *unstamped* URLs that `/runner/build/runner.html`
requests when opened directly instead of through the editor — freezing those for a
year would let that one hand-debugging path pin a stale `runner.js` across deploys
and recreate the crash the stamp prevents.

## Preview deployments for pull requests

Every pull request, including one from a fork, is built and published to its own
URL — `https://pr-<n>.gnuradio-world-previews.pages.dev`, linked from a comment
on the PR that is rewritten in place on each push. It takes three workflows
because of one GitHub rule: **a workflow triggered by `pull_request` from a fork
gets a read-only `GITHUB_TOKEN` and nothing else.** No repository secrets, no
environment secrets, and no way to opt back in — gating a job behind an
environment with required reviewers does not change it (that is a mitigation for
`pull_request_target`, not a route around the fork rule). So the job that
compiles a contributor's code cannot be the job that holds the Cloudflare token:

- **`pr-preview-build.yml`** (`pull_request`) calls `build.yml` and passes **no**
  `secrets:` at all. It compiles the PR's code and whatever commits its submodule
  pointers name, runs the smoke tests, and uploads the assembled site plus the PR
  number as artifacts. There is no credential in the job to leak. On this event
  the *workflow files themselves* come from the PR's branch, so nothing it
  produces may be trusted downstream.
- **`pr-preview-deploy.yml`** (`workflow_run`) runs `main`'s copy of itself in
  this repository's context, so it has the token — and it never checks out the
  PR or executes anything from the artifact. It re-derives the PR from the API
  and refuses to continue unless that PR is open and its head repo and branch are
  the ones the build ran from, which is what makes the contributor-supplied PR
  number safe to use as a lookup key. (Matching head *repo + branch* rather than
  head SHA keeps it correct when the PR has been pushed to again since the build
  started. `github.event.workflow_run.pull_requests` is empty for fork runs,
  which is why the number has to be carried at all.)
- **`pr-preview-cleanup.yml`** (`pull_request_target: closed`) deletes the
  branch's deployments through the Cloudflare REST API — wrangler has no
  `pages deployment delete`, and `force=true` is needed for the one currently
  serving the alias — then retires the comment. `pull_request_target` is safe
  *only* because this workflow never checks out the PR, installs nothing, and
  runs no code from it. Adding a checkout step here would turn it into a
  credential-theft primitive; move such work to a `workflow_run` job instead.

Previews go to a **separate Pages project** (`gnuradio-world-previews`, no custom
domain) rather than preview branches of `gnuradio-wasm`. The site is
attacker-controlled HTML and JS — inherent to previews — so it must not share an
origin, cookie scope, or deployment history with production, and must not be
promotable to `gnuradioworld.com`.

Details worth keeping:

- **The preview host has to be Cloudflare Pages**, or something else that can set
  response headers. `_headers` carries the COOP/COEP pair that `SharedArrayBuffer`
  and the pthread runner depend on; GitHub Pages cannot set headers, so the
  editor would load there and the runner would die the moment anyone pressed Run.
  `pr-preview-deploy.yml` sanity-checks the artifact for those rules before
  publishing.
- **The smoke tests gate a preview exactly as they gate a deploy** — they run in
  the no-secrets build stage, so a reviewer is never sent to look at a runner
  that starts and stalls.
- **Caches work in your favour.** A fork PR can *read* the base branch's caches,
  so `sysroot` and `ccache` hit and a preview build starts warm; its *writes*
  would land in a PR-scoped scope that is isolated from `main`'s and evicted when
  the PR closes, so `save_ccache: false` skips them as pure noise. A fork can
  therefore neither poison nor benefit anyone else's cache.
- **Concurrency groups are per-ref**, not a fixed string, or a PR build would
  cancel an in-flight production deploy.
- **`build.yml` checks Pages' upload limits** after assembling the site: 25 MiB
  per file and 20,000 files. `runner.wasm` is ~20 MB and grows with every module
  added, so this fails with the file named rather than at `wrangler` after the
  whole build.
- **Preview origins must be in the bucket's CORS policy** or recordings break
  while everything else works — see [recording-viewer.md](recording-viewer.md).
- `vars.RECORDINGS_R2_BASE` may not resolve on a fork PR; `recording-catalog.ts`
  falls back to the production base, which is what a preview wants anyway.
- GitHub separately requires a maintainer to click "Approve and run" before a
  first-time contributor's workflows run at all — a free extra gate.

Standing this up needs a Pages project named `gnuradio-world-previews` in the
same account and a `CLOUDFLARE_API_TOKEN` with *Cloudflare Pages: Edit* (the
deploy token already has it; the cleanup job needs the same scope to delete).
If the ~30–45 min per push ever becomes the problem, gating the build on a
maintainer-applied label is one `if:` on `pr-preview-build.yml`'s `build` job
plus `labeled` in its `types:` — the rest of the chain is unchanged.

This replaced a prebuilt `sysroot` + GR libs + qtgui tarball attached to a
`deps-vX` GitHub release. That artifact had to be repacked by hand after any GNU
Radio C++ change; when someone forgot, CI silently linked stale libraries and the
deployed site behaved differently from every developer's machine.
