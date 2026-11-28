#!/usr/bin/env bash
set -euo pipefail

version="${1:-1.0.0}"
out_dir="${2:-dist}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "$root"
mkdir -p "$out_dir"

export GOTOOLCHAIN=local
export CGO_ENABLED=0

targets=(
  "windows amd64 .exe"
  "windows arm64 .exe"
  "linux amd64 "
  "linux arm64 "
  "darwin amd64 "
  "darwin arm64 "
)

for target in "${targets[@]}"; do
  read -r goos goarch ext <<<"$target"
  name="codex-remote-${goos}-${goarch}${ext}"
  echo "building $name"
  GOOS="$goos" GOARCH="$goarch" go build \
    -trimpath -buildvcs=false \
    -ldflags "-s -w -X main.version=${version}" \
    -o "${out_dir}/${name}" ./cmd/codex-remote
done
