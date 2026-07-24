#!/usr/bin/env bash
# Pack the prebuilt WASM build dependencies into a tarball for CI.
#
# CI cannot cheaply rebuild boost/fftw/gnuradio-core/etc., so we ship them as a
# versioned artifact that the deploy workflow downloads and extracts into wasm/.
# Only regenerate this when the deps change (gnuradio core C++, a dependency
# version, or the sysroot) -- NOT on every runner.wasm change.
#
# Contents (all paths relative to wasm/ so CI can `tar -x -C wasm/`):
#   sysroot/            VOLK/Boost/spdlog/GMP/FFTW/Qwt  (lib + headers)
#   gr/build-gr/        gnuradio C++ libs (*.a) + generated includes  (no *.o)
#   qtgui/build/        gr-qtgui sink wrapper lib                      (no *.o)
#
# Usage:
#   bash wasm/scripts/pack-deps.sh                # -> ./wasm-deps.tar.zst
#   bash wasm/scripts/pack-deps.sh /tmp/out.tzst  # custom output path
#
# Then publish it and bump DEPS_TAG in .github/workflows/deploy-wasm.yml:
#   gh release create deps-v1 wasm-deps.tar.zst -t "wasm deps v1" -n "prebuilt sysroot+gr+qtgui"
#   # or upload to an existing release:  gh release upload deps-v1 wasm-deps.tar.zst --clobber
set -euo pipefail

# Resolve the wasm/ dir regardless of where the script is invoked from.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WASM_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
OUT="${1:-$(pwd)/wasm-deps.tar.zst}"

cd "$WASM_DIR"

# Sanity-check that the prebuilt inputs exist before we tar nothing.
for p in sysroot/lib gr/build-gr qtgui/build/libgr_qtgui_ts.a; do
  if [ ! -e "$p" ]; then
    echo "error: expected prebuilt input missing: wasm/$p" >&2
    echo "       build the deps first (see wasm/README.md) before packing." >&2
    exit 1
  fi
done

echo "Packing prebuilt deps from $WASM_DIR -> $OUT"

# Exclude object files and build-system scratch; keep .a, headers, and the
# generated *.cmake / include trees the runner build needs.
tar --use-compress-program='zstd -19 -T0' -cf "$OUT" \
  --exclude='*.o' \
  --exclude='CMakeFiles' \
  --exclude='*.ninja' \
  --exclude='.ninja_deps' \
  --exclude='.ninja_log' \
  sysroot \
  gr/build-gr \
  qtgui/build

SIZE="$(du -h "$OUT" | cut -f1)"
echo "Done: $OUT ($SIZE)"
echo
echo "Next:"
echo "  gh release create deps-v1 \"$OUT\" -t 'wasm deps v1' -n 'prebuilt sysroot+gr+qtgui'"
echo "  # then set DEPS_TAG: deps-v1 in .github/workflows/deploy-wasm.yml"
