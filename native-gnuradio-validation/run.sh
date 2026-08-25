#!/usr/bin/env bash
set -euo pipefail

readonly script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
readonly repository_dir="$(cd -- "${script_dir}/.." && pwd)"
readonly image_name="${GNURADIO_VALIDATOR_IMAGE:-gnuradio-world-native-validator}"

docker build --pull --tag "${image_name}" "${script_dir}"
docker run --rm \
    --init \
    --mount "type=bind,src=${repository_dir}/example_flowgraphs,dst=/flowgraphs,readonly" \
    "${image_name}" \
    /flowgraphs \
    "$@"
