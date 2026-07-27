#!/usr/bin/env bash
# Cross-build GNU Radio's C++ dependencies to WASM into $SYSROOT.
#
# Produces everything the runner links that is not GNU Radio itself:
#   spdlog, VOLK, Boost, FFTW (double + float), GMP, Qwt
#
# Sources must already be under deps/src -- run wasm/deps/fetch-deps.sh first.
# Qwt is cross-built with the host qmake pointed at the wasm Qt, so QT_HOST and
# QT_WASM must be set (see wasm/README.md).
#
#   bash wasm/deps/fetch-deps.sh && bash wasm/deps/build-deps.sh
#
# Idempotent-ish: rebuilds each dep. The install prefix is overridable ($SYSROOT)
# so a change to this script can be verified without touching a working tree.
set -euo pipefail
cd "$(dirname "$0")"
source ./env.sh

: "${QT_HOST:?set QT_HOST to the host Qt (e.g. ~/Qt/6.9.1/gcc_64)}"
: "${QT_WASM:?set QT_WASM to the wasm Qt (e.g. ~/Qt/6.9.1/wasm_multithread)}"

JOBS="$(nproc)"

# Scratch build trees for the CMake-based deps. Wiped per dep before configuring:
# a cache left from a different $DEPS_SRC or $SYSROOT makes cmake abort with
# "does not match the source used to generate cache", and these two builds are
# cheap enough that a clean configure costs nothing.
DEPS_BUILD="${DEPS_BUILD:-$WASM_ROOT/deps/build}"

# VOLK's kernel generator needs Mako. Prefer an interpreter that already has it
# (the system python on CI); otherwise fall back to a venv beside the sysroot.
pick_python() {
    local candidate
    for candidate in "${PYTHON:-}" python3; do
        if [ -n "$candidate" ] && command -v "$candidate" >/dev/null 2>&1 &&
            "$candidate" -c 'import mako' >/dev/null 2>&1; then
            command -v "$candidate"
            return
        fi
    done
    local venv="$WASM_ROOT/.venv"
    [ -x "$venv/bin/python" ] || python3 -m venv "$venv" >&2
    "$venv/bin/pip" install --quiet mako >&2
    echo "$venv/bin/python"
}
DEPS_PYTHON="$(pick_python)"
echo "[deps] python for VOLK codegen: $DEPS_PYTHON"

# --- spdlog (bundled fmt), static, threaded ---------------------------------
rm -rf "$DEPS_BUILD/spdlog"
emcmake cmake -S "$DEPS_SRC/spdlog" -B "$DEPS_BUILD/spdlog" "${WASM_CMAKE_ARGS[@]}" \
  -DSPDLOG_BUILD_SHARED=OFF -DSPDLOG_FMT_EXTERNAL=OFF \
  -DSPDLOG_BUILD_EXAMPLE=OFF -DSPDLOG_BUILD_TESTS=OFF -DSPDLOG_BUILD_BENCH=OFF
cmake --build "$DEPS_BUILD/spdlog" --target install

# --- VOLK (generic kernels only; neon probe forced off for wasm) ------------
rm -rf "$DEPS_BUILD/volk"
emcmake cmake -S "$DEPS_SRC/volk" -B "$DEPS_BUILD/volk" "${WASM_CMAKE_ARGS[@]}" -Wno-dev \
  -DPYTHON_EXECUTABLE="$DEPS_PYTHON" \
  -DENABLE_TESTING=OFF -DENABLE_PROFILING=OFF -DENABLE_MODTOOL=OFF \
  -Dneon_compile_result=FALSE
cmake --build "$DEPS_BUILD/volk" --target install

# --- Boost (custom clang-emscripten toolset; bundled emscripten.jam is the
#     obsolete fastcomp/bitcode flow and does not work with modern emsdk) -----
cd "$DEPS_SRC/boost_1_83_0"
cat > user-config.jam <<'JAM'
using clang : emscripten : em++ : <archiver>emar <ranlib>emranlib ;
JAM
[ -x ./b2 ] || ./bootstrap.sh
./b2 --user-config=./user-config.jam toolset=clang-emscripten \
  link=static variant=release threading=multi \
  --with-system --with-program_options --with-thread --with-regex --with-chrono \
  --with-atomic --with-date_time \
  cxxflags="$WASM_PTHREAD_FLAGS" cflags="$WASM_PTHREAD_FLAGS" \
  --prefix="$SYSROOT" -j"$JOBS" install

# --- FFTW: gr-fft needs both precisions, so configure/build/install twice ----
cd "$DEPS_SRC/fftw-3.3.10"
fftw_build() {  # extra configure args (e.g. --enable-float)
    emconfigure ./configure --enable-threads --with-combined-threads \
      --disable-fortran --disable-shared --enable-static \
      --prefix="$SYSROOT" CFLAGS="$WASM_PTHREAD_FLAGS -O2" "$@"
    emmake make -j"$JOBS" install
}
emmake make clean >/dev/null 2>&1 || true
fftw_build                  # double precision -> libfftw3.a
emmake make clean
fftw_build --enable-float   # single precision -> libfftw3f.a

# --- GMP (no assembly under wasm; the C++ bindings are needed too) ----------
# `--host none` is load-bearing, not cosmetic: it selects GMP's generic C path
# and skips the assembler probes. Without it, configure feeds hand-written
# assembly to the compiler to discover the label suffix / 32-bit word directive,
# LLVM's wasm backend crashes writing that object, and configure dies with
# "Cannot determine label suffix" -- even though --disable-assembly means none of
# it is ever used.
cd "$DEPS_SRC/gmp-6.3.0"
make distclean >/dev/null 2>&1 || true
emconfigure ./configure --host none --disable-assembly --enable-cxx --disable-shared \
  --prefix="$SYSROOT" CFLAGS="$WASM_PTHREAD_FLAGS -O2" CXXFLAGS="$WASM_PTHREAD_FLAGS -O2"
emmake make -j"$JOBS" install

# --- Qwt (the qtgui plots): cross-built with the HOST qmake aimed at the wasm
#     Qt. qwt.pro is a subdirs project, so the install paths and -fPIC belong in
#     the shared config file, not on the qmake command line. The block is
#     delimited so re-running replaces it instead of stacking duplicates. ------
cd "$DEPS_SRC/qwt-6.2.0"
sed -i '/^# >>> gnuradio-wasm >>>$/,/^# <<< gnuradio-wasm <<<$/d' qwtconfig.pri
cat >> qwtconfig.pri <<CONF
# >>> gnuradio-wasm >>>
# Every QWT_INSTALL_* path is derived from the prefix EARLIER in this file, so
# appending a new prefix alone leaves the rest pointing at /usr/local and
# \`make install\` dies with EACCES on the doc/features targets -- after the
# library itself has installed fine. Override all of them.
QWT_INSTALL_PREFIX   = $SYSROOT
QWT_INSTALL_HEADERS  = $SYSROOT/include
QWT_INSTALL_LIBS     = $SYSROOT/lib
QWT_INSTALL_DOCS     = $SYSROOT/doc
QWT_INSTALL_PLUGINS  = $SYSROOT/plugins/designer
QWT_INSTALL_FEATURES = $SYSROOT/features
QMAKE_CXXFLAGS += -fPIC
QMAKE_CFLAGS += -fPIC
# QwtDll is the load-bearing one: stock qwtconfig.pri enables it, and a shared
# build ends in "wasm-ld: error: unknown file type: libqwt.so.6.2.0". The rest
# are components the runner does not link (and whose Qt modules are absent from
# the wasm Qt build) plus the sample apps and the .pc generator.
QWT_CONFIG -= QwtDll QwtDesigner QwtExamples QwtPlayground QwtTests QwtPolar QwtSvg QwtOpenGL QwtPkgConfig QwtDesignerSelfContained
# <<< gnuradio-wasm <<<
CONF
make distclean >/dev/null 2>&1 || true
"$QT_HOST/bin/qmake6" -qtconf "$QT_WASM/bin/target_qt.conf" qwt.pro
make -j"$JOBS"
make install

echo "=== deps installed into $SYSROOT ==="
ls "$SYSROOT"/lib/lib{spdlog,volk,boost_thread,boost_program_options,fftw3,fftw3f,gmp,gmpxx,qwt}.a
