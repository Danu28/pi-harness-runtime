#!/usr/bin/env bash
# install-dev.sh — sync the LOCAL repo into the live agent dir WITHOUT pushing.
# Same target layout as install.sh, but copies the local working tree instead of
# cloning/pulling the remote — iterate → run → /reload, no push required.
#
# Model: repos are the source of truth; ~/.pi/agent/extensions is a pure installed
# state. For the mirror-layout rationale (skill cards → extensions/core/skillcards/,
# protocol → prompts/run.md) see install.sh. Idempotent.
set -euo pipefail

# Repo root = the directory containing this script, so it works from any cwd.
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT="$HOME/.pi/agent/extensions"
PROMPTS="$HOME/.pi/agent/prompts"

test -f "$HERE/index.ts" || { echo "install-dev.sh must live in the repo root (harness/) — aborting"; exit 1; }

mkdir -p "$EXT/core/skillcards" "$PROMPTS"
cp "$HERE/index.ts" "$EXT/harness.ts"
cp "$HERE/core/harness-core.mjs" "$HERE/core/harness-core.test.mjs" "$HERE/core/compile-skills.mjs" "$EXT/core/"
cp "$HERE/core/skillcards/"*.md "$EXT/core/skillcards/"
cp "$HERE/prompts/run.md" "$PROMPTS/run.md"

REV="$(git -C "$HERE" rev-parse --short HEAD 2>/dev/null || echo "no-git")"
echo "✓ harness synced from local repo ($REV) — remote untouched."
echo "  Run /reload in pi to activate."