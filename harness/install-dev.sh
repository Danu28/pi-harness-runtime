#!/usr/bin/env bash
# install-dev.sh — sync the local harness/ dir into the live agent dir WITHOUT pushing.
# Same self-contained install as install.sh, but copies the local working tree
# instead of cloning/pulling the remote — iterate → run → /reload, no push.
# Idempotent (rm + copy = clean replace, no stale files layered on top).
set -euo pipefail

# This script ships inside harness/; the extension dir is its own parent.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT="$HOME/.pi/agent/extensions"
PROMPTS="$HOME/.pi/agent/prompts"

test -f "$HERE/index.ts" || { echo "install-dev.sh must live in the harness dir — aborting"; exit 1; }

# Clean replace — the harness is one self-contained dir (see install.sh).
mkdir -p "$EXT"
rm -rf "$EXT/harness"
cp -r "$HERE" "$EXT/harness"

# Legacy flat-layout cleanup: remove the old scattered entry + harness-owned
# core files so they can't double-load or shadow the self-contained install.
rm -f "$EXT/harness.ts" \
      "$EXT/core/harness-core.mjs" "$EXT/core/harness-core.test.mjs" "$EXT/core/compile-skills.mjs"
rm -rf "$EXT/core/skillcards"

# Best-effort, optional: mirror run.md into pi's prompts dir for prompt-template
# features (/run-as-template autocomplete). Not required to run.
mkdir -p "$PROMPTS"
cp "$HERE/prompts/run.md" "$PROMPTS/run.md"

REV="$(git -C "$HERE" rev-parse --short HEAD 2>/dev/null || echo "no-git")"
echo "✓ harness synced to $EXT/harness ($REV) — remote untouched."
echo "  Run /reload in pi to activate."