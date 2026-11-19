#!/bin/sh
# scripts/run-tests.sh [T1 T5 ...] — automated regression suite for the Merlion
# fraud line (Telnyx Assistant Tests over web_chat + deterministic log asserts).
# Resets demo state before and after the run via scripts/reset-demo.sh.
set -eu
# shellcheck disable=SC1091
. "$HOME/.config/merlion/admin.env" 2>/dev/null || true
: "${ADMIN_TOKEN:?ADMIN_TOKEN required (source ~/.config/merlion/admin.env)}"
DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
"$DIR/scripts/reset-demo.sh"
node "$DIR/tests/run.mjs" "$@"
