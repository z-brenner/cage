#!/usr/bin/env bash
# Build Firecracker rootfs images (ext4) for cage agents, using Docker. No root or loop mounts needed:
# the container filesystem is exported and packed with `mkfs.ext4 -d` inside a helper container.
#
#   images/build-rootfs.sh <claude|codex|gemini|cursor|all> [size, default 8G]
#
# Env:
#   CAGE_HOME        output goes to $CAGE_HOME/fc/images (default ~/.cage)
#   CAGE_EXTRA_CA    path to an extra CA certificate to trust (corporate TLS proxy)
#   CAGE_DOCKER_NET  docker build --network value (e.g. "host" when your proxy is on localhost)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${CAGE_HOME:-$HOME/.cage}/fc/images"
TARGET="${1:?usage: build-rootfs.sh <claude|codex|gemini|cursor|all> [size]}"
SIZE="${2:-8G}"

command -v docker >/dev/null || { echo "docker is required" >&2; exit 1; }
mkdir -p "$OUT"

build_one() {
  local kind="$1" tag="cage-rootfs-$1" cid
  local args=(build --build-arg "KIND=$kind" -t "$tag" -f "$ROOT/images/Dockerfile")
  [ -n "${CAGE_EXTRA_CA:-}" ] && args+=(--secret "id=extra_ca,src=$CAGE_EXTRA_CA")
  [ -n "${CAGE_DOCKER_NET:-}" ] && args+=(--network "$CAGE_DOCKER_NET")
  for v in HTTP_PROXY HTTPS_PROXY NO_PROXY http_proxy https_proxy no_proxy; do
    [ -n "${!v:-}" ] && args+=(--build-arg "$v=${!v}")
  done
  echo "==> building $tag"
  DOCKER_BUILDKIT=1 docker "${args[@]}" "$ROOT"

  echo "==> packing $OUT/$kind.ext4 ($SIZE, sparse)"
  cid="$(docker create "$tag")"
  # shellcheck disable=SC2064
  trap "docker rm -f $cid >/dev/null 2>&1 || true" RETURN
  docker export "$cid" | docker run --rm -i --network none -v "$OUT:/out" --entrypoint bash "$tag" -c "
    set -euo pipefail
    mkdir /r && tar -x -C /r
    rm -f /r/.dockerenv
    : > /r/etc/resolv.conf
    mkfs.ext4 -q -F -L cageroot -d /r /out/$kind.ext4.tmp $SIZE
    chown $(id -u):$(id -g) /out/$kind.ext4.tmp
    mv /out/$kind.ext4.tmp /out/$kind.ext4
  "
  echo "==> $OUT/$kind.ext4"
}

if [ "$TARGET" = all ]; then
  for k in claude codex gemini cursor; do build_one "$k"; done
else
  case "$TARGET" in claude|codex|gemini|cursor) build_one "$TARGET" ;; *) echo "unknown kind $TARGET" >&2; exit 2 ;; esac
fi
