#!/usr/bin/env bash
# Fetch Pyodide (CPython for WebAssembly) into the git-ignored pyodide/ at the
# repository root, where both the editor and the runner serve it from.
#
#   bash deps/fetch-pyodide.sh
#
# This is what makes the Embedded Python Block work; see docs/embedded-python.md.
# Nothing else in the build needs it, so it is a separate script from
# fetch-deps.sh -- a tree without it builds and runs fine, and only a flowgraph
# containing a Python Block notices. About 30 MB installed, most of it the two
# package wheels; see WHEELS below for what each is for.
#
# Why vendored rather than loaded from the Pyodide CDN: the site is served
# cross-origin-isolated (COOP/COEP, required for SharedArrayBuffer and Emscripten
# pthreads), and a cross-origin-isolated page cannot load a cross-origin script
# that does not opt in with CORP. Same-origin is the only option.
#
# Idempotent: re-running with the pinned version already installed does nothing.
# Versions and hashes are pinned here and nowhere else.
set -euo pipefail

# Pyodide moved to CPython-aligned versioning: 314.x.y ships Python 3.14.
PYODIDE_VERSION="314.0.4"

# The wheels to install beside the interpreter, "<file name> <sha256>" from
# pyodide-lock.json in the release above. Pinning the file name as well as the
# hash keeps the fetch reproducible when a later Pyodide rebuilds a package.
#
# numpy is not optional: the block base classes describe their ports with numpy
# dtypes, so every Python Block imports it and the worker loads it at start-up.
# scipy is, and is by far the larger of the two (~14 MB against ~3 MB) -- it is
# here because scipy.signal is what a desktop GRC Python Block reaches for, and
# because the Benchmark Tool measures one against the C++ FFT Filter. Nothing
# loads it until a block's source actually imports it (loadPackagesFromImports
# in gr_pyodide_worker.js), so a flowgraph that does not is unaffected.
WHEELS=(
    "numpy-2.4.3-cp314-cp314-pyemscripten_2026_0_wasm32.whl 0cad9c1b91f0082e4f959bc0e0bf5835a2efbba6ab3b1e9d1fe6e7e564cca98e"
    "scipy-1.18.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl 4ef1569eac793bec84a92fa2eaf24eafb4529ff10c5ed87d1e335063f26142f3"
)

CORE_TARBALL="pyodide-core-${PYODIDE_VERSION}.tar.bz2"
CORE_URL="https://github.com/pyodide/pyodide/releases/download/${PYODIDE_VERSION}/${CORE_TARBALL}"
# Package wheels are not release assets; they live on the CDN beside the release.
WHEEL_BASE="https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full"

# The browser needs exactly these out of the core distribution. Everything else
# in it (the node CLI entry points, python.exe, the TypeScript declarations) is
# for using Pyodide from a shell or a bundler, which this repo does not do.
CORE_FILES=(
    pyodide.mjs          # loadPyodide(), imported by the module worker
    pyodide.asm.mjs      # the Emscripten glue
    pyodide.asm.wasm     # the interpreter itself
    python_stdlib.zip    # the standard library
    pyodide-lock.json    # package index loadPackage() resolves against
)

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"
SRC="${DEPS_SRC:-$HERE/src}"
DEST="${PYODIDE_DIR:-$ROOT/pyodide}"
# One stamp for the whole install: the version and every pinned file name, so
# bumping any of them re-installs rather than leaving a half-old tree.
STAMP="$DEST/.pinned"
WANT="pyodide ${PYODIDE_VERSION} $(printf '%s ' "${WHEELS[@]%% *}")"

if [ -f "$STAMP" ] && [ "$(cat "$STAMP")" = "$WANT" ]; then
    echo "[pyodide] $DEST is already at $PYODIDE_VERSION"
    exit 0
fi

mkdir -p "$SRC" "$DEST"

if [ ! -f "$SRC/$CORE_TARBALL" ]; then
    echo "[pyodide] fetching $CORE_TARBALL"
    curl -fL --retry 3 --retry-delay 5 -o "$SRC/$CORE_TARBALL.part" "$CORE_URL"
    mv "$SRC/$CORE_TARBALL.part" "$SRC/$CORE_TARBALL"
fi

echo "[pyodide] installing into $DEST"
# The tarball's entries are all under a pyodide/ prefix; --strip-components drops
# it so the files land directly in $DEST.
tar xjf "$SRC/$CORE_TARBALL" -C "$DEST" --strip-components=1 \
    "${CORE_FILES[@]/#/pyodide/}"

for entry in "${WHEELS[@]}"; do
    wheel="${entry%% *}"
    sha256="${entry##* }"
    if [ ! -f "$DEST/$wheel" ]; then
        echo "[pyodide] fetching $wheel"
        curl -fL --retry 3 --retry-delay 5 -o "$DEST/$wheel.part" "$WHEEL_BASE/$wheel"
        mv "$DEST/$wheel.part" "$DEST/$wheel"
    fi
    echo "$sha256  $DEST/$wheel" | sha256sum --check --quiet
done

echo "$WANT" > "$STAMP"
echo "[pyodide] $PYODIDE_VERSION ready ($(du -sh "$DEST" | cut -f1))"
