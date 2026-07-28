#!/usr/bin/env python3
"""Emit wasm-ld --export-if-defined flags for every symbol the category side
modules import via the GOT.

Under MAIN_MODULE=2, EXPORT_ALL exports the main module's own (and whole-archived)
code symbols, but NOT the libc++abi / compiler-rt symbols that side modules pull
in (e.g. __cxa_pure_virtual, std type-info vtables, the thread_local exception
globals). Each side module lists exactly what it needs as GOT.func / GOT.mem
imports; we export all of them from main with --export-if-defined so the present
ones are exported and the side modules' own symbols (absent from main) are simply
skipped. Written to a response file consumed by the runner link via -Wl,@file.
"""
import os
import re
import shutil
import subprocess
import sys


def find_wasm_dis() -> str:
    exe = shutil.which("wasm-dis")
    if exe:
        return exe
    emcc = shutil.which("emcc")
    if emcc:
        # emcc lives in .../upstream/emscripten, wasm-dis in .../upstream/bin
        cand = os.path.join(os.path.dirname(os.path.dirname(emcc)), "bin", "wasm-dis")
        if os.path.exists(cand):
            return cand
    raise SystemExit("gen_side_exports: wasm-dis not found on PATH or near emcc")


# Side modules import from three places we must satisfy from main: GOT.func /
# GOT.mem (address-taken symbols) and "env" (direct calls). Special dylink imports
# (memory base/table/stack) are provided by the loader, not exported from main.
IMPORT_RE = re.compile(r'\(import "(?:env|GOT\.func|GOT\.mem)" "([^"]+)"')
SKIP = {"memory", "__indirect_function_table", "__memory_base", "__table_base",
        "__stack_pointer", "__stack_high", "__stack_low"}


def main(out_path: str, wasms: list[str]) -> int:
    wasm_dis = find_wasm_dis()
    syms: set[str] = set()
    for w in wasms:
        text = subprocess.run([wasm_dis, w], capture_output=True, text=True).stdout
        syms.update(IMPORT_RE.findall(text))
    syms -= SKIP
    with open(out_path, "w") as f:
        for s in sorted(syms):
            f.write(f"--export-if-defined={s}\n")
    print(f"gen_side_exports: {len(syms)} symbols -> {out_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1], sys.argv[2:]))
