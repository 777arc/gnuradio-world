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

## No Content-Security-Policy — keep it that way

[site/_headers](../site/_headers) sets `Cross-Origin-Opener-Policy`,
`Cross-Origin-Embedder-Policy` and `Cross-Origin-Resource-Policy`, plus
`Content-Type` and `Cache-Control` lines. There is deliberately **no CSP**, and
this is a build invariant rather than an oversight: the JavaScript Block compiles
a user's source with `new Function`, and the editor's introspection sandbox
evaluates the same runtime inside an `<iframe srcdoc>`. **If a CSP is ever added
it must keep `script-src 'unsafe-eval'`**, or every JS block stops working — in
the editor first, where ports would stop following the code, and then in the
runner. See [docs/js-blocks.md](js-blocks.md).

The same file must keep `Cache-Control` lines for `/runner/build/js_runtime.js`
and `/runner/build/js/*`, which are fetched at run time rather than linked in.
`scripts/assemble-site.mjs` writes the deployed copy of `_headers`; the two are
kept in step by hand.

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

## The pull request security gate

Every pull request is analyzed before anything of its is compiled or run. The
checks live in one reusable workflow, `security-analysis.yml`, and two workflows
call it — the point of the duplication being that neither placement is
sufficient alone:

- **`pr-preview-build.yml`** (`pull_request`) calls it as a job that `build`
  `needs:`, so a flagged PR never reaches the ~30–45 min compile, and a failure
  skips `build`, fails the run and so keeps `pr-preview-deploy.yml`'s
  `conclusion == 'success'` from ever publishing a preview. But on this event
  the workflow files come from the PR's own branch, so a contributor can delete
  the gate in the very PR it screens. **This copy is a fast-fail, not a
  boundary.**
- **`pr-security.yml`** (`pull_request_target`) runs `main`'s copy, which the PR
  cannot edit, and holds the two permissions a fork's token can never be
  granted: `security-events: write` to file CodeQL results, and
  `pull-requests: write` to leave the findings comment. **This is the check to
  require in the branch protection rule.**

`pull_request_target` is elsewhere the most dangerous trigger there is, and it
is safe here for one reason only: **nothing under it executes the PR's code.**
The diff scan never checks the PR out at all — it fetches `refs/pull/<n>/head`
into the object store and reads blobs with `git show`, leaving the working tree
on the base branch — and CodeQL extraction with `build-mode: none` parses source
without running it, with no dependencies installed for it to run. Adding an
`npm ci`, a build, or a test over PR sources to that workflow turns it into a
credential-theft primitive. Such work belongs in `pr-preview-build.yml`, which
holds no secret by design; this is the same rule `pr-preview-cleanup.yml`
carries.

Three checks run:

- **`scripts/pr-security-scan.mjs`** — this repository's own rules over the
  diff's *added lines only*, so existing code never re-flags and a rule can be
  strict without a repo-wide cleanup first. It looks for what a contributor
  could actually do here rather than what a generic taint analysis looks for:
  nothing processes user input at runtime (the editor is a static site, the
  runner a WASM sandbox), so the realistic attack is on the *build* — a workflow
  that leaks the Cloudflare token, a submodule pointer moved to a fork, an npm
  `postinstall`, a `curl | sh`, a `fetch()` to a host that appears nowhere in
  the base revision. That last rule derives its allowlist from the base tree
  rather than a hard-coded list, so it stays correct as the repo grows.
  Findings are `block` (fails) or `warn` (annotates). Suppress one with
  `pr-security-scan: allow <rule-id>` in a comment on the line or the line
  above, or an entry in `.github/pr-security-allow.txt` — and note that editing
  either that file or the scanner is *itself* a blocking finding, so a PR cannot
  quietly widen its own exemptions.
- **CodeQL** over `javascript-typescript`, `python` and `actions`, configured by
  `.github/codeql/config.yml`. C++ is deliberately absent: it only exists as a
  cross-compiled WASM target, so extraction would need the full three-hour
  Emscripten build to find bugs in a module with no host attack surface. CodeQL
  never fails a job on its own, so `scripts/sarif-gate.mjs` reduces the run to
  the alerts a PR is responsible for — `security-severity >= 7.0`, in a file
  that PR changed — and fails on those. Pre-existing debt stays an alert in the
  Security tab rather than blocking a contributor over something they did not
  write.
- **`actions/dependency-review-action`** for known-vulnerable dependencies,
  `fail-on-severity: high`. It requires the repository's **dependency graph** to
  be on (Settings ▸ Advanced Security); with it off the action does not report a
  clean result, it hard-errors with "Dependency review is not supported on this
  repository" — a repository setting failing every PR, and with it the `build`
  job that `needs` the gate, so no preview is ever published. The job therefore
  probes `repos/<repo>/dependency-graph/sbom` first and, on a 404, reports the
  check as `⏭️ unavailable` with a pointer to the setting instead of failing.
  Every other failure — a real vulnerability, an API outage — still blocks.

Two things to know before changing any of it. The reusable workflow declares
**no `permissions:` blocks at all** — a called workflow's job may only *narrow*
what the caller granted, so requesting `security-events: write` there would
hard-error the fork path where the caller cannot grant it; inheriting instead
lets one file serve both callers. And `test/test_pr_security_scan.mjs` runs
*before* the scan, from the base branch, because a scanner that has stopped
matching anything looks exactly like a clean PR.

A blocking finding is not an accusation. It is a change that needs a human to
say it was intended — adding a submodule or a new download host legitimately
trips it, which is the design working.

This replaced a prebuilt `sysroot` + GR libs + qtgui tarball attached to a
`deps-vX` GitHub release. That artifact had to be repacked by hand after any GNU
Radio C++ change; when someone forgot, CI silently linked stale libraries and the
deployed site behaved differently from every developer's machine.
