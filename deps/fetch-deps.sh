#!/usr/bin/env bash
# Fetch the dependency sources that build-deps.sh compiles, into deps/src/.
#
# Versions are pinned here and nowhere else -- bump them in this file. Idempotent:
# anything already unpacked is left alone, so re-running is nearly free and a
# partially populated deps/src is fine.
#
#   bash deps/fetch-deps.sh
#   bash deps/fetch-deps.sh --runner-only  # turbofec + CRCpp only
#
# Upstream hosts (SourceForge, ftp.gnu.org) rate-limit and drop CI runners, so
# every tarball below lists alternate mirrors that are tried in turn. Set
# DEPS_MIRROR=https://host/path to bypass all of them and pull the tarballs from
# somewhere you control; files must keep their upstream basenames.
set -euo pipefail

MODE="${1:-all}"
case "$MODE" in
    all|--runner-only) ;;
    *)
        echo "usage: $0 [--runner-only]" >&2
        exit 2
        ;;
esac

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

# fetch_tar <unpacked-dir> <url> <tar-flags> [fallback-url...]
# The first URL is the preferred source; any extra ones are alternate mirrors of
# the same tarball, tried in order. Every host here has gone down or throttled CI
# at least once, so none of them is allowed to be the only way in. DEPS_MIRROR,
# when set, replaces the whole list. The retry budget per URL is deliberately
# small -- an unreachable host has to give up in well under a minute so the next
# mirror gets its turn, which is the opposite of what you want with one URL.
fetch_tar() {
    local dir="$1" url="$2" flags="$3" file="${2##*/}"
    shift 3
    if [ -d "$dir" ]; then
        echo "[fetch] $dir (already present)"
        return
    fi
    local urls=("$url" "$@")
    [ -n "$MIRROR" ] && urls=("$MIRROR/$file")
    for url in "${urls[@]}"; do
        echo "[fetch] $dir <- $url"
        if curl -fL --connect-timeout 10 --retry 2 --retry-delay 3 "$url" | tar "$flags"; then
            return
        fi
        # A failure part-way through leaves a partial unpack behind, which the
        # -d check above would mistake for a good tree on the next run.
        rm -rf "$dir"
        echo "[fetch] $url failed" >&2
    done
    echo "[fetch] every source for $dir failed; set DEPS_MIRROR to fetch it from your own host" >&2
    return 1
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

# clone_commit <dir> <commit> <url>
# Used for small dependencies that publish no stable tag. Fetch the one pinned
# commit rather than allowing their default branch to move underneath CI.
clone_commit() {
    local dir="$1" commit="$2" url="$3"
    if [ -d "$dir" ]; then
        echo "[fetch] $dir (already present)"
        return
    fi
    echo "[fetch] $dir <- $url @ $commit"
    local tmp
    tmp="$(mktemp -d "./.${dir}.XXXXXX")"
    if ! git -C "$tmp" init -q ||
       ! git -C "$tmp" remote add origin "$url" ||
       ! git -C "$tmp" fetch -q --depth 1 origin "$commit" ||
       ! git -C "$tmp" checkout -q --detach FETCH_HEAD; then
        rm -rf "$tmp"
        return 1
    fi
    mv "$tmp" "$dir"
}

# These two are compiled directly into the DroneID side module, rather than
# installed into the cached sysroot. CI therefore fetches them on every run,
# including runs that restore the sysroot and skip the full dependency build.
clone CRCpp release-1.2.2.0 https://github.com/d-bahr/CRCpp.git
clone_commit turbofec 6de1f4604933d6c21a0ff0c75401cffa7debf3cd \
    https://github.com/ttsou/turbofec.git

if [ "$MODE" = "--runner-only" ]; then
    echo "=== runner sources ready in $SRC ==="
    exit 0
fi

clone spdlog v1.12.0 https://github.com/gabime/spdlog.git
clone volk   v3.1.2  https://github.com/gnuradio/volk.git --recursive
clone libosmocore 1.14.2 https://gitea.osmocom.org/osmocom/libosmocore.git

fetch_tar boost_1_83_0 https://archives.boost.io/release/1.83.0/source/boost_1_83_0.tar.bz2 xj \
    https://sourceforge.net/projects/boost/files/boost/1.83.0/boost_1_83_0.tar.bz2
fetch_tar fftw-3.3.10  https://www.fftw.org/fftw-3.3.10.tar.gz                              xz
# ftpmirror.gnu.org is GNU's own redirector to a nearby mirror, and is what they
# ask automated downloads to use; ftp.gnu.org itself refuses connections from CI
# often enough that it cannot be the primary.
fetch_tar gmp-6.3.0    https://ftpmirror.gnu.org/gnu/gmp/gmp-6.3.0.tar.xz                   xJ \
    https://gmplib.org/download/gmp/gmp-6.3.0.tar.xz \
    https://ftp.gnu.org/gnu/gmp/gmp-6.3.0.tar.xz
fetch_tar qwt-6.3.0    https://sourceforge.net/projects/qwt/files/qwt/6.3.0/qwt-6.3.0.tar.bz2 xj \
    https://downloads.sourceforge.net/project/qwt/qwt/6.3.0/qwt-6.3.0.tar.bz2

# Local fixes that upstream does not carry. This is NOT optional: without the
# VOLK patch every flowgraph dies during construction (see the patch header)
# -- the failure only appears at run time, long after everything has built and
# linked cleanly. Applied here so a fresh checkout and CI get it too.
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
apply_patch "$SRC/libosmocore" "$PATCHES/libosmocore-pseudotalloc-realloc.patch"

echo "=== sources ready in $SRC ==="
