# USRP B2xx feasibility spike

The harness that answered "can UHD and libusb reach a USRP from a browser tab at
all", before any of it existed as a block. Every measurement in
[docs/usrp-b2xx.md](../../../docs/usrp-b2xx.md) — the rate ladder, the two-grant
cold start, the unplug behaviour — came from here.

It is kept because the rate ladder still needs re-measuring properly (each figure
there is a single three-second sample) and this is the code that measured it. It
is **not** wired into any build:

- `usrp_probe.cpp` — the probe itself. Enumerates, brings a device up, walks a
  ladder of sample rates counting delivered samples against overruns, and reports
  each gate to the page. `report()` calls are what `run_probe.mjs` scrapes.
- `wordexp_shim.c` — Emscripten declares `wordexp()` and implements neither, so
  linking UHD leaves it undefined. The block folds the same shim into
  `blocks/src/usrp_b2xx_source.cpp`; this is the standalone copy.
- `usrp_hw.html`, `spike-server.mjs` — the page and a COOP/COEP server for it.
- `grant_usrp.mjs`, `check_grant.mjs` — one-time WebUSB grant into a persistent
  Chrome profile, and a check that it stuck. Same approach as
  `test/hw/grant.mjs`, which does not yet know about the B2xx.
- `run_probe.mjs`, `dlopen_drive.mjs` — drive the page and print the gates.

**Rebuilding it takes work that is not committed.** It was compiled as a target
in UHD's own `host/utils/CMakeLists.txt` inside a scratch copy of the UHD source
tree, linked against the wasm sysroot with `--whole-archive` on `libuhd.a` (see
"the two patches" and the build invariants in the doc). Whoever needs it next
should expect to re-derive that, or to promote the probe into a proper
`test/hw/usrp_hw.*` pair alongside the other hardware harnesses, which is the
obvious home for it.

Built output is deliberately not committed: it is ~13 MB of `.wasm` and `.data`.
