#!/usr/bin/env bash
# Fetch the USRP B2xx firmware and FPGA images the USRP B2xx Source loads at run
# time, into deps/usrp-images/.
#
#   bash deps/fetch-usrp-images.sh
#
# These are runtime assets, not build inputs: nothing links them, and the browser
# fetches them only when a flowgraph actually contains a real (non-fake) B2xx
# block. They are kept out of git -- the FPGA images alone are several megabytes
# each -- and copied into the assembled site by scripts/assemble-site.mjs.
#
# Every archive is verified against the SHA-256 in UHD's own images/manifest.txt,
# so the pins below must match the UHD release pinned in fetch-deps.sh. The
# manifest ships inside the UHD tarball; after bumping UHD, re-read it with
#
#   grep -A9 '^# B200-Series' deps/src/uhd-*/images/manifest.txt
#
# and update the four lines below. Note the FPGA images and the firmware are
# versioned independently of UHD itself and of each other.
#
# Both the FX3 firmware and the FPGA bitstreams are GPLv3, as is this repository,
# so redistribution is fine; the matching sources are Ettus's fpga and fx3_firmware
# trees at the tags named in the manifest.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT="${USRP_IMAGES_DIR:-$HERE/usrp-images}"
BASE="${USRP_IMAGES_MIRROR:-https://files.ettus.com/binaries/cache}"

# <path under the cache>  <sha256>
# B206mini deliberately shares the B205mini image; that is UHD's own mapping.
ARCHIVES=(
  "b2xx/uhd-c37b318/b2xx_b200_fpga_default-gc37b318.zip      35542b8a2b6a6dfd3aa155c35364af85c2599cfb692b0cf94013c5342c945448"
  "b2xx/uhd-c37b318/b2xx_b210_fpga_default-gc37b318.zip      ab1cdbe93090fdcf590a79cbe938749f8a5fbd7b45422b7833b8c841aa2106b4"
  "b2xx/uhd-c37b318/b2xx_b200mini_fpga_default-gc37b318.zip  c1865c6e574cf453a688c6bfb8fe5e3646cd53458ae403cf11d3eeb7dc6a9918"
  "b2xx/uhd-c37b318/b2xx_b205mini_fpga_default-gc37b318.zip  dce96120e3512d6e21bb061811c4021cbc90ac4d787248ad821337b7389ff3c4"
  "b2xx/uhd-7f7d016/b2xx_common_fw_default-g7f7d016.zip      22ac0e54cc90d53d8494d481439447a0c89b9bbaced6fabe24df260eda3ce3a3"
)

# The files the runner actually reads, so a partial or rearranged upstream
# archive is caught here rather than as a failed device bring-up in a browser.
EXPECTED=(
  usrp_b200_fw.hex
  usrp_b200_fpga.bin
  usrp_b210_fpga.bin
  usrp_b200mini_fpga.bin
  usrp_b205mini_fpga.bin
)

mkdir -p "$OUT/archives"
cd "$OUT/archives"

for entry in "${ARCHIVES[@]}"; do
    read -r path want <<<"$entry"
    file="${path##*/}"
    if [ -f "$file" ] && echo "$want  $file" | sha256sum -c --status 2>/dev/null; then
        echo "[images] $file (already present, checksum ok)"
        continue
    fi
    echo "[images] $file <- $BASE/$path"
    curl -fL --connect-timeout 15 --retry 3 --retry-delay 3 -o "$file" "$BASE/$path"
    if ! echo "$want  $file" | sha256sum -c --status; then
        echo "[images] CHECKSUM MISMATCH for $file" >&2
        echo "[images] expected $want" >&2
        echo "[images] got      $(sha256sum "$file" | cut -d' ' -f1)" >&2
        rm -f "$file"
        exit 1
    fi
done

# Unpack into a flat directory; this is the layout UHD_IMAGES_DIR expects and the
# one mirrored into the runner's MEMFS at /uhd-images.
cd "$OUT"
rm -rf images && mkdir images
for f in archives/*.zip; do
    unzip -oq "$f" -d images
done
# The archives nest the files one directory deep; flatten and drop the rest.
find images -mindepth 2 -type f -exec mv -f {} images/ \; 2>/dev/null || true
find images -mindepth 1 -type d -exec rm -rf {} + 2>/dev/null || true
find images -type f ! -name '*.bin' ! -name '*.hex' -delete

missing=0
for name in "${EXPECTED[@]}"; do
    if [ ! -f "images/$name" ]; then
        echo "[images] MISSING after extraction: $name" >&2
        missing=1
    fi
done
[ "$missing" -eq 0 ] || exit 1

echo "=== USRP B2xx images ready in $OUT/images ==="
ls -la images
