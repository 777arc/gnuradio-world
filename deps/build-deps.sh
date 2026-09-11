#!/usr/bin/env bash
# Cross-build GNU Radio's C++ dependencies to WASM into $SYSROOT.
#
# Installs the shared third-party libraries the runner links:
#   spdlog, VOLK, Boost, FFTW (double + float), GMP, libosmocore, Qwt
# OOT-local source dependencies such as turbofec and header-only CRCpp are
# fetched beside these but compiled directly by their runner side module.
#
# Sources must already be under deps/src -- run deps/fetch-deps.sh first.
# Qwt is cross-built with the host qmake pointed at the wasm Qt, so QT_HOST and
# QT_WASM must be set (see AGENTS.md).
#
#   bash deps/fetch-deps.sh && bash deps/build-deps.sh
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
  --with-atomic --with-date_time --with-filesystem --with-serialization \
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

# --- libosmocore (embedded profile + its bundled pseudotalloc) --------------
# gr-gsm uses the portable GSM coding/codec helpers. Upstream detects emcc and
# carries both an embedded profile and an allocator shim, so no host networking,
# PC/SC, USB, SCTP, GnuTLS, or systemd dependency is pulled into the browser.
# configure still probes pkg-config for talloc before it enables pseudotalloc;
# use its documented TALLOC_* override to point at the bundled compatible header.
cd "$DEPS_SRC/libosmocore"
autoreconf -fi
OSMO_BUILD="$DEPS_BUILD/libosmocore"
rm -rf "$OSMO_BUILD"
mkdir -p "$OSMO_BUILD"
cd "$OSMO_BUILD"
TALLOC_CFLAGS="-I$DEPS_SRC/libosmocore/src/pseudotalloc" TALLOC_LIBS="-lpseudotalloc" \
  emconfigure "$DEPS_SRC/libosmocore/configure" \
    --host=wasm32-unknown-emscripten \
    --prefix="$SYSROOT" --enable-static --disable-shared \
    --enable-embedded --enable-pseudotalloc \
    --disable-doxygen --disable-systemtap --disable-external-tests \
    --disable-simd --disable-neon --disable-werror \
    CFLAGS="$WASM_PTHREAD_FLAGS -O2"
emmake make -j"$JOBS" install

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
cd "$DEPS_SRC/qwt-6.3.0"
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

# --- libusb (Emscripten/WebUSB backend) and B200-only UHD -------------------
# Both exist only for the USRP B2xx Source. They are built last because nothing
# else depends on them, so a failure here leaves the rest of the sysroot usable.
#
# Two things about this pair are easy to get wrong and fail silently:
#
#   * UHD must be compiled with -fexceptions. Emscripten disables exception
#     catching by default, which leaves every try/catch inside UHD inert; a bad
#     device parameter then escapes as an opaque trap instead of a message.
#   * UHD registers its device finders through static initializers, so whatever
#     links libuhd.a must use --whole-archive. Without it the link succeeds and
#     find() simply reports no devices, for ever.
#
# ENABLE_STATIC_LIBS is deliberately OFF: it is a separate "also build
# uhd_static" path that is broken off-MSVC (it links Boost::system, which UHD
# never asks find_package for). BUILD_SHARED_LIBS=OFF already makes the normal
# uhd target static.
cd "$DEPS_SRC/libusb-1.0.30"
make distclean >/dev/null 2>&1 || true
emconfigure ./configure --host=wasm32-emscripten --prefix="$SYSROOT" \
  --enable-static --disable-shared --disable-udev \
  --disable-examples-build --disable-tests-build \
  CFLAGS="$WASM_PTHREAD_FLAGS -O2" CXXFLAGS="$WASM_PTHREAD_FLAGS -O2"
emmake make -j"$JOBS" install

rm -rf "$DEPS_BUILD/uhd"
emcmake cmake -S "$DEPS_SRC/uhd-4.10.0.0/host" -B "$DEPS_BUILD/uhd" -GNinja -Wno-dev \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_PREFIX="$SYSROOT" \
  -DCMAKE_PREFIX_PATH="$SYSROOT" -DCMAKE_FIND_ROOT_PATH="$SYSROOT" \
  -DBUILD_SHARED_LIBS=OFF -DENABLE_STATIC_LIBS=OFF \
  -DCMAKE_C_FLAGS="$WASM_PTHREAD_FLAGS" \
  -DCMAKE_CXX_FLAGS="$WASM_PTHREAD_FLAGS -fexceptions" \
  -DENABLE_LIBUHD=ON -DENABLE_USB=ON -DENABLE_B200=ON \
  -DENABLE_B100=OFF -DENABLE_USRP1=OFF -DENABLE_USRP2=OFF -DENABLE_X300=OFF \
  -DENABLE_MPMD=OFF -DENABLE_N300=OFF -DENABLE_N320=OFF -DENABLE_E320=OFF \
  -DENABLE_E300=OFF -DENABLE_X400=OFF -DENABLE_OCTOCLOCK=OFF -DENABLE_SIM=OFF \
  -DENABLE_PYTHON_API=OFF -DENABLE_C_API=OFF -DENABLE_EXAMPLES=OFF \
  -DENABLE_UTILS=OFF -DENABLE_TESTS=OFF -DENABLE_MANUAL=OFF -DENABLE_DOXYGEN=OFF \
  -DENABLE_MAN_PAGES=OFF -DENABLE_DPDK=OFF
cmake --build "$DEPS_BUILD/uhd" --target install
# UHD links a CMakeRC resource library (calibration data) into libuhd but does not
# install it, so anything linking libuhd.a statically is left with an undefined
# cmrc::rc::get_filesystem(). Install it alongside.
install -m 644 "$DEPS_BUILD/uhd/lib/rc/libuhd-resources.a" "$SYSROOT/lib/"

echo "=== deps installed into $SYSROOT ==="
ls "$SYSROOT"/lib/lib{spdlog,volk,boost_thread,boost_program_options,fftw3,fftw3f,gmp,gmpxx,osmocore,osmocodec,osmogsm,osmoisdn,osmocoding,pseudotalloc,qwt}.a
