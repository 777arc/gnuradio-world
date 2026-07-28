#!/usr/bin/env bash
# Fetch the dependency sources that build-deps.sh compiles, into deps/src/.
#
# Versions are pinned here and nowhere else -- bump them in this file. Idempotent:
# anything already unpacked is left alone, so re-running is nearly free and a
# partially populated deps/src is fine.
#
#   bash deps/fetch-deps.sh
#
# Upstream hosts (SourceForge, ftp.gnu.org) rate-limit CI runners. Set
# DEPS_MIRROR=https://host/path to pull the tarballs from somewhere you control
# instead; files must keep their upstream basenames.
set -euo pipefail

# Resolve both paths before cd'ing anywhere: $0 is relative when the script is
# invoked as `bash deps/fetch-deps.sh`.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PATCHES="$HERE/patches"
# Same default (and override) as env.sh's DEPS_SRC, so a scratch tree can be
# populated without touching a working one.
SRC="${DEPS_SRC:-$HERE/src}"
MIRROR="${DEPS_MIRROR:-}"
mkdir -p "$SRC"
cd "$SRC"

# fetch_tar <unpacked-dir> <url> <tar-flags>
fetch_tar() {
    local dir="$1" url="$2" flags="$3" file="${2##*/}"
    if [ -d "$dir" ]; then
        echo "[fetch] $dir (already present)"
        return
    fi
    [ -n "$MIRROR" ] && url="$MIRROR/$file"
    echo "[fetch] $dir <- $url"
    curl -fL --retry 3 --retry-delay 5 "$url" | tar "$flags"
}

# clone <dir> <tag> <url> [extra git args...]
clone() {
    local dir="$1" tag="$2" url="$3"
    shift 3
    if [ -d "$dir" ]; then
        echo "[fetch] $dir (already present)"
        return
    fi
    echo "[fetch] $dir <- $url @ $tag"
    git clone --branch "$tag" --depth 1 "$@" "$url" "$dir"
}

clone spdlog v1.12.0 https://github.com/gabime/spdlog.git
clone volk   v3.1.2  https://github.com/gnuradio/volk.git --recursive

fetch_tar boost_1_83_0 https://archives.boost.io/release/1.83.0/source/boost_1_83_0.tar.bz2 xj
fetch_tar fftw-3.3.10  https://www.fftw.org/fftw-3.3.10.tar.gz                              xz
fetch_tar gmp-6.3.0    https://ftp.gnu.org/gnu/gmp/gmp-6.3.0.tar.xz                         xJ
fetch_tar qwt-6.2.0    https://sourceforge.net/projects/qwt/files/qwt/6.2.0/qwt-6.2.0.tar.bz2 xj

# Local fixes that upstream does not carry. These are NOT optional: without the
# VOLK patch every flowgraph dies during construction (see the patch header), and
# the failure only appears at run time, long after everything has built and
# linked cleanly. Applied here so a fresh checkout and CI get them too.
apply_patch() {  # <git-repo-dir> <patch-file>
    local dir="$1" patch="$2"
    if git -C "$dir" apply --reverse --check "$patch" >/dev/null 2>&1; then
        echo "[patch] $(basename "$patch") (already applied)"
        return
    fi
    echo "[patch] $(basename "$patch") -> $dir"
    git -C "$dir" apply "$patch"
}

apply_patch "$SRC/volk" "$PATCHES/volk-generic-machine.patch"

echo "=== sources ready in $SRC ==="
