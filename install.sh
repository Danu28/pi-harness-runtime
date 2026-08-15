#!/usr/bin/env bash
# install-harness.sh — install/update the pi-harness runtime extension into the live agent dir.
# Repo (source of truth): https://github.com/Danu28/pi-harness-runtime
#
# Model: repos are the source of truth; ~/.pi/agent/extensions is a pure installed
# state. Develop + test in the repo, run this to install/update. Idempotent.
#
# The harness needs pi's MIRROR LAYOUT — paths resolve via getAgentDir():
#   skill cards  → ~/.pi/agent/extensions/core/skillcards/
#   protocol     → ~/.pi/agent/prompts/run.md
# so the files must land exactly where the repo lays them out. A subdir clone
# (extensions/<repo>/) would break resolution — never do that for the harness.
set -euo pipefail

REPO=https://github.com/Danu28/pi-harness-runtime
CACHE="$HOME/.pi/agent/.extension-src/pi-harness-runtime"
EXT="$HOME/.pi/agent/extensions"
PROMPTS="$HOME/.pi/agent/prompts"

mkdir -p "$(dirname "$CACHE")"
if [ -d "$CACHE/.git" ]; then
  git -C "$CACHE" pull --ff-only
else
  git clone --depth 1 "$REPO" "$CACHE"
fi
test -f "$CACHE/harness.ts" || { echo "clone failed — aborting"; exit 1; }

mkdir -p "$EXT/core/skillcards" "$PROMPTS"
cp "$CACHE/harness.ts" "$EXT/harness.ts"
cp "$CACHE/core/harness-core.mjs" "$CACHE/core/harness-core.test.mjs" "$CACHE/core/compile-skills.mjs" "$EXT/core/"
cp "$CACHE/core/skillcards/"*.md "$EXT/core/skillcards/"
cp "$CACHE/prompts/run.md" "$PROMPTS/run.md"

echo "✓ harness installed (repo $(git -C "$CACHE" rev-parse --short HEAD))."
echo "  Run /reload in pi to activate."