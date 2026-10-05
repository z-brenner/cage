#!/usr/bin/env bash
# CI's name for scripts/install-msb.sh (the pinned microsandbox installer cage itself uses).
exec "$(dirname "$0")/../scripts/install-msb.sh" "$@"
