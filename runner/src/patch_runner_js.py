#!/usr/bin/env python3
"""Post-build patch for the MAIN_MODULE runner.js.

Qt-for-WASM takes the address of JS-library asyncify probe functions
(jsHaveJspi, jsHaveAsyncify, qt_asyncify_*). Under Emscripten dynamic linking
(MAIN_MODULE) these are placed in the function table by updateGOT via
addFunction(value) with NO signature, tripping an assertion:
  Aborted(Assertion failed: Missing signature argument to addFunction)

There is no build flag to supply the signature (it is Qt-internal glue), so we
patch addFunction to synthesise one from the JS arity when the caller omits it:
i32 return + i32 params. This is correct for the 0-arg probes that Qt actually
calls at startup, and harmless for the suspend/resume shims (never called by the
runner, which uses no nested Qt event loops).
"""
import sys

MARKER = "// [gr] addFunction default-signature patch"
OLD = ('    assert(typeof sig != "undefined", "Missing signature argument to addFunction: " + func);\n'
       '    var wrapped = convertJsFunctionToWasm(func, sig);')
NEW = ('    ' + MARKER + '\n'
       '    if (typeof sig == "undefined") { sig = "i" + "i".repeat(func.length); }\n'
       '    var wrapped = convertJsFunctionToWasm(func, sig);')


def main(path: str) -> int:
    text = open(path).read()
    if MARKER in text:
        print(f"patch_runner_js: already patched {path}")
        return 0
    if OLD not in text:
        print(f"patch_runner_js: ERROR anchor not found in {path}", file=sys.stderr)
        return 1
    open(path, "w").write(text.replace(OLD, NEW, 1))
    print(f"patch_runner_js: patched addFunction in {path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
