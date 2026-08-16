#!/usr/bin/env bash
# install-harness.sh — install/update the pi-harness runtime extension into the live agent dir.
# Repo (source of truth): https://github.com/Danu28/pi-harness-runtime
#
# Model: repos are the source of truth; ~/.pi/agent/extensions is a pure installed
# state. Develop + test in the repo, run this to install/update. Idempotent
# (clean replace of the harness dir — no stale files layered on top).
#
# The harness is SELF-CONTAINED: the whole extension — entry (index.ts), core/
# (logic, tests, skill cards) and prompts/ (run protocol) — lives in one dir,
# and the runtime resolves cards + protocol relative to its own location. So
# installation is simply copying harness/ into extensions/ (auto-discovered via
# extensions/*/index.ts). No flat mirror copies required.
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
test -f "$CACHE/harness/index.ts" || { echo "clone failed — aborting"; exit 1; }

mkdir -p "$EXT"
rm -rf "$EXT/harness"
cp -r "$CACHE/harness" "$EXT/harness"

# Legacy flat-layout cleanup: older installs scattered the entry + core/ under
# extensions/ and the protocol under ~/.pi/agent/prompts/. The self-contained
# dir makes these inert — and the stray harness.ts would otherwise double-load
# alongside the subdir entry. Only harness-owned names are removed.
rm -f "$EXT/harness.ts" \
      "$EXT/core/harness-core.mjs" "$EXT/core/harness-core.test.mjs" "$EXT/core/compile-skills.mjs"
rm -rf "$EXT/core/skillcards"

# Best-effort, optional: mirror run.md into pi's prompts dir so prompt-template
# features (/run-as-template autocomplete) can find it. The harness itself reads
# prompts/run.md from its own dir, so this is not required to run.
mkdir -p "$PROMPTS"
cp "$CACHE/harness/prompts/run.md" "$PROMPTS/run.md"

echo "✓ harness installed at $EXT/harness (repo $(git -C "$CACHE" rev-parse --short HEAD))."
echo "  Restart pi or run /reload to activate."