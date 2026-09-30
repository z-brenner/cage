#!/usr/bin/env bash
# Download the Firecracker binary and a matching guest kernel (from Firecracker's CI bucket) into
# $CAGE_HOME/fc (default ~/.cage/fc). No root needed.
#   FC_VERSION=v1.15.0 images/fetch-firecracker.sh
set -euo pipefail

FC_VERSION="${FC_VERSION:-v1.15.0}"
KERNEL_SERIES="${KERNEL_SERIES:-6.1}"
ARCH="$(uname -m)"
DEST="${CAGE_HOME:-$HOME/.cage}/fc"
CI="firecracker-ci/${FC_VERSION%.*}"          # v1.15.0 -> firecracker-ci/v1.15
BUCKET="https://s3.amazonaws.com/spec.ccfc.min"

case "$ARCH" in x86_64|aarch64) ;; *) echo "unsupported arch $ARCH" >&2; exit 1 ;; esac
mkdir -p "$DEST/bin"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

echo "==> firecracker $FC_VERSION ($ARCH)"
curl -fsSL "https://github.com/firecracker-microvm/firecracker/releases/download/$FC_VERSION/firecracker-$FC_VERSION-$ARCH.tgz" \
  | tar -xz -C "$tmp"
install -m 0755 "$tmp/release-$FC_VERSION-$ARCH/firecracker-$FC_VERSION-$ARCH" "$DEST/bin/firecracker"
install -m 0755 "$tmp/release-$FC_VERSION-$ARCH/jailer-$FC_VERSION-$ARCH" "$DEST/bin/jailer"

echo "==> guest kernel ($KERNEL_SERIES series from $CI)"
key="$(curl -fsSL "$BUCKET?list-type=2&prefix=$CI/$ARCH/vmlinux-$KERNEL_SERIES." \
  | grep -oE "<Key>$CI/$ARCH/vmlinux-$KERNEL_SERIES\.[0-9]+</Key>" \
  | sed -E 's#</?Key>##g' | sort -V | tail -1)"
[ -n "$key" ] || { echo "no $KERNEL_SERIES kernel found under $CI/$ARCH (try KERNEL_SERIES=5.10 or another FC_VERSION)" >&2; exit 1; }
curl -fsSL -o "$DEST/vmlinux.tmp" "$BUCKET/$key"
mv "$DEST/vmlinux.tmp" "$DEST/vmlinux"

"$DEST/bin/firecracker" --version | head -1
echo "==> kernel: $key -> $DEST/vmlinux"
