#!/usr/bin/env python3
"""Post-build patch for the MAIN_MODULE runner.js.

Qt-for-WASM takes the address of JS-library asyncify probe functions
(jsHaveJspi, jsHaveAsyncify, qt_asyncify_*). Under Emscripten dynamic linking
(MAIN_MODULE) these are placed in the function table by updateGOT via
addFunction(value) with NO signature, tripping:
  Aborted(Assertion failed: Missing signature argument to addFunction)   (dev)
or a convertJsFunctionToWasm failure once assertions are stripped (release).

There is no build flag to supply the signature (it is Qt-internal glue), so we
patch the one place that needs it: the addFunction slow path calls
`convertJsFunctionToWasm(func, sig)`. We wrap the `sig` argument so a missing
signature is synthesised from the JS arity (i32 return + i32 params). This is
correct for the 0-arg probes Qt calls at startup and harmless for the
suspend/resume shims (never called by the runner, which uses no nested Qt event
loops). Anchoring on the `convertJsFunctionToWasm(a, b)` call — whose name
Emscripten preserves — makes the patch survive -O2/-Oz JS minification (which
renames locals and drops the assertion line).
"""
import re
import sys

MARKER = "gr_addfunc_sig"
# convertJsFunctionToWasm(<func>, <sig>) with possibly-minified identifier args.
CALL_RE = re.compile(r"convertJsFunctionToWasm\(([A-Za-z_$][\w$]*),\s*([A-Za-z_$][\w$]*)\)")


def main(path: str) -> int:
    text = open(path).read()
    if MARKER in text:
        print(f"patch_runner_js: already patched {path}")
        return 0

    def repl(m: "re.Match") -> str:
        func, sig = m.group(1), m.group(2)
        # /*MARKER*/ default the signature from arity when the caller omitted it.
        return (f'convertJsFunctionToWasm({func},'
                f'(typeof {sig}=="undefined"?("i"+"i".repeat({func}.length)):{sig})'
                f'/*{MARKER}*/)')

    text, n = CALL_RE.subn(repl, text)
    if n == 0:
        print(f"patch_runner_js: ERROR convertJsFunctionToWasm anchor not found in {path}",
              file=sys.stderr)
        return 1
    open(path, "w").write(text)
    print(f"patch_runner_js: patched {n} convertJsFunctionToWasm call(s) in {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
