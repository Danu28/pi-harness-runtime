# REFACTOR PLAN — pi-harness-runtime

**Source branch:** `release/1.12.0` → working branch `refactor/structure-proposal`
**Verify gate:** `npm run test` (currently `node --test harness/core/harness-core.test.mjs`)
**Model:** every batch below is **one clean commit**; the gate stays green at every step.

---

## 0. Goal & non-goals

**Goal:** Split the two monoliths into cohesion-focused modules behind a stable barrel, mirror the tests, and file the root analysis docs — without changing any behavior.

- `harness/core/harness-core.mjs` — **2454 lines**, ~70 exported symbols across ~17 unrelated domains.
- `harness/index.ts` — **1866 lines**; the `harness()` body alone is ~1000 lines of hook wiring.
- `harness/core/harness-core.test.mjs` — **1470 lines**, flat `test()` calls (no grouping).
- Root has 3 leftover analysis docs (`GAPS-EFFICIENCY.md`, `HARNESS-ANALYSIS.md`, `PLAN-GAPS.md`).

**Non-goals (do NOT do here):** no behavior/logic changes, no new dependencies, no moving `skillcards/`, no changing the `.mjs`-core vs `.ts`-entry language split, no altering `CORE_VERSION`/`EXPECTED_CORE_VERSION`.

---

## 1. Target structure (what we are building toward)

```
harness/
├── index.ts            # thin entry: import modules + wire, `export default harness`
├── state.ts            # RunState type + persistence (runPath, writeRun, flushRunSync,
│                       #   loadRun, fillLazyBaseline, lateSync, finishRun, maybeAutoCommit)
├── protocol.ts         # DEFAULT_PROTOCOL, readProtocol, loadHarnessConfig
├── thinking.ts         # planLevel, editLevel, startThinking, tierMeaning
├── cards.ts            # activeCardNames, skillCardNote
├── settle.ts           # waitForSettle, contentText, lastAssistantText
├── report.ts           # printReport
├── hooks.ts            # the ~1000-line harness() body (hook registration)
├── coach.ts            # maybeTruncateBashOutput, mergePlanTasks, editCoachForEvent
├── install.sh          # unchanged
├── install-dev.sh      # unchanged
├── prompts/run.md      # unchanged
└── core/
    ├── harness-core.mjs    # BARREL — re-exports everything (back-compat; consumers stay green)
    ├── compile-skills.mjs  # unchanged
    ├── skillcards/         # unchanged
    ├── constants.mjs       # CORE_VERSION, DEFAULT_CONFIG, THINK_LEVELS, AI_CAP, ACCEPT_VERDICTS,
    │                       #   PERSONA_TAXONOMY, LANES, PHASE_TAXONOMY, TEMP_DIR, LONGTERM_DIR,
    │                       #   USE_COLOR, color
    ├── safety.mjs          # dangerousBash, dangerTier, bashMutates, editRequiresGate,
    │                       #   normalizeRel, shq, insideProject, globToRegExp, isIgnored,
    │                       #   scopeAllowed, declareRequired
    ├── detect.mjs          # SCRIPT_NAMES, loadScripts, tscCommand, findFilesByExt,
    │                       #   findProjectJsFiles, repoRoot, detectVerify, nearestPackageDir,
    │                       #   testSelector, gateResult
    ├── parse.mjs           # parseRunArgs, parseThinkingPrediction, parseLanePrediction,
    │                       #   parsePhasePrediction, parsePersona, parsePlan, parseAcceptance,
    │                       #   stripAcceptanceBlocks, parseCandidates, parsePlanProgress,
    │                       #   parseCommitSubject, parseRemainingEstimate
    ├── thinking.mjs        # phaseThinking, tasklistEnabled, shouldEscalate, shouldStop,
    │                       #   extendBudget, discountEstimate, normalizeBudget,
    │                       #   loadEstimateBias, appendEstimateRecord, appendRunStats
    ├── stages.mjs          # stageSkillCard, stageLayerCard, verifyTier, classifyLane,
    │                       #   renderPersona, gate1Required, gate2Required
    ├── artifacts.mjs       # ensureArtifactDirs, clearTempDir, isHarnessPath,
    │                       #   isForbiddenArtifactPath, cleanupRunArtifacts
    ├── state.mjs           # gitHead, changedPaths, gate-cache (load/save/key/cached/record/
    │                       #   invalidate/lastGreen), gate-failures (rollbacks/record/failureTriage),
    │                       #   loadSkillCard, checkFailureMemory, suggestBudget, loadRunStats, statsRows
    ├── git.mjs             # autoCommit, gitDiff, gitNewFiles, changedFileHeads
    ├── output.mjs          # tail, estimateTokens, summarizeToolOutput, parseTestFailures,
    │                       #   extractFailures, EDIT_MISS_RE, editMismatchHint, mismatchedEditIndices
    └── report.mjs          # buildSnapshot, fmt, reportRows, buildTldr, reportColor, renderTable

docs/
├── gaps-efficiency.md      # ← GAPS-EFFICIENCY.md
├── harness-analysis.md     # ← HARNESS-ANALYSIS.md
└── plan-gaps.md            # ← PLAN-GAPS.md
```

**Core idea (barrel pattern):** `harness-core.mjs` becomes a pure re-export module. Both consumers — `index.ts` (its ~70-import block) and `harness-core.test.mjs` — keep importing from `harness-core.mjs`, so the split is invisible to them. We move functions out of the monolith and add `export { x } from "./constants.mjs"` to the barrel. This makes the refactor incremental and the gate meaningful at every step.

---

## 2. Ordered batches (each = one clean commit)

Ordering rule: **leaves first** (modules with no internal deps), then dependents, then tests, then the TS entry, then docs. Every batch ends green.

### Batch 1 — leaf core modules: `constants`, `safety`, `parse`
- Create `core/constants.mjs` (12 constants — no deps).
- Create `core/safety.mjs` (bash-safety + path/scope — deps: `constants` only, for `USE_COLOR`? none actually; pure).
- Create `core/parse.mjs` (all `parse*` + `stripAcceptanceBlocks` — deps: `constants` for taxonomies).
- Rewrite `core/harness-core.mjs` barrel to re-export from these three; leave all other functions inline in the barrel for now.
- **Testing:** existing `harness-core.test.mjs` imports from the barrel → still green. No test edits this batch.
- **Commit:** `refactor(core): extract constants/safety/parse into cohesion modules behind a barrel`
- **Acceptance:** barrel still exports every name; gate green; no logic changed (tests unchanged & passing).

### Batch 2 — leaf core modules: `output`, `detect`, `git`, `report`
- Create `core/output.mjs` (tail, token/summary, failure extraction, edit-mismatch coach).
- Create `core/detect.mjs` (scripts + verify detection).
- Create `core/git.mjs` (autoCommit, gitDiff, gitNewFiles, changedFileHeads).
- Create `core/report.mjs` (buildSnapshot, fmt, reportRows, buildTldr, reportColor, renderTable).
- Extend the barrel. Gate green. No test edits.
- **Commit:** `refactor(core): extract output/detect/git/report into cohesion modules`

### Batch 3 — dependent core modules: `thinking`, `stages`, `artifacts`, `state`
- Create `core/thinking.mjs` (deps: constants, parse).
- Create `core/stages.mjs` (deps: constants).
- Create `core/artifacts.mjs` (deps: constants).
- Create `core/state.mjs` (deps: constants, artifacts — gate cache/failures/run stats/memory).
- Extend the barrel. Gate green. No test edits.
- **Commit:** `refactor(core): extract thinking/stages/artifacts/state into cohesion modules`

> **Checkpoint A (after Batch 3):** `harness-core.mjs` is now ~0 lines of real logic — a pure barrel. Verify: `grep -c "export {" harness-core.mjs` shows all ~70 re-exports; `npm run test` green; `index.ts` imports unchanged.

### Batch 4 — mirror the test suite
- Split `core/harness-core.test.mjs` into `core/*.test.mjs`, one per module (`constants.test.mjs`, `safety.test.mjs`, `parse.test.mjs`, `output.test.mjs`, `detect.test.mjs`, `git.test.mjs`, `report.test.mjs`, `thinking.test.mjs`, `stages.test.mjs`, `artifacts.test.mjs`, `state.test.mjs`).
- Tests move **verbatim** (no assertion edits) — import from `harness-core.mjs` barrel, so they don't need to change to point at each module.
- Update `package.json` test script: `node --test harness/core/` (Node globs the dir).
- **Testing:** run `npm run test`; then also `node --test harness/core/harness-core.test.mjs` once to confirm the old single-file path is gone/merged. Delete the old combined test file only after the split is green.
- **Commit:** `test(core): mirror module split with per-module test files; switch to dir glob`
- **Acceptance:** same assertion count as before; gate green; no coverage regression.

### Batch 5 — TS entry, helper modules first (no hooks)
- Extract from `index.ts`: `state.ts` (RunState + persistence + auto-commit/finish), `protocol.ts`, `thinking.ts`, `cards.ts`, `settle.ts`, `report.ts`.
- `index.ts` imports them; keeps the hook-wiring body. Typecheck + test green.
- **Testing:** `npm run typecheck` AND `npm run test` both green. (Add typecheck to the check habit here since we touch TS.)
- **Commit:** `refactor(entry): extract state/protocol/thinking/cards/settle/report from index.ts`

### Batch 6 — TS entry, the `harness()` body
- Extract `hooks.ts` (the hook registration body) and `coach.ts` (`maybeTruncateBashOutput`, `mergePlanTasks`, `editCoachForEvent`).
- `index.ts` becomes thin: resolve config/cards, call hooks wiring, `export default harness`.
- **Testing:** typecheck + test green. Manual smoke: `/reload` in a pi session + one `/run` to confirm the extension still wires up (best-effort; not part of the automated gate).
- **Commit:** `refactor(entry): extract hooks + coach; index.ts becomes thin entry`
- **Acceptance:** `harness/index.ts` drops to a few hundred lines; every hook still registered; exports intact.

### Batch 7 — file the root docs
- `git mv GAPS-EFFICIENCY.md docs/gaps-efficiency.md`
- `git mv HARNESS-ANALYSIS.md docs/harness-analysis.md`
- `git mv PLAN-GAPS.md docs/plan-gaps.md`
- Add one-line note in `README.md` pointing to `docs/` for the analysis/plan history. Update any cross-references found via `grep -rn "PLAN-GAPS\|GAPS-EFFICIENCY\|HARNESS-ANALYSIS"`.
- **Testing:** gate green (docs don't affect tests); `grep` confirms no dangling references.
- **Commit:** `docs(root): file analysis docs under docs/ and link from README`

### Batch 8 — final pass
- `npm run typecheck` + `npm run test` + `npm run validate-skills` all green.
- Run `install-dev.sh` + `/reload` in a live pi session for a real smoke test (best-effort).
- Update `README.md` file tree if it lists the old layout.
- **Commit:** `chore: final refactor pass — green gate + docs + smoke`

---

## 3. Hard constraints (non-negotiable during execution)

1. **Self-contained dir:** `install.sh`/`install-dev.sh` do `cp -r harness/` → `extensions/`. No import may escape `harness/` except `node:` builtins and the pi SDK. Barrel re-exports are internal → safe.
2. **Entry path fixed:** pi auto-discovers `extensions/*/index.ts`; `harness/index.ts` must stay the entry.
3. **Core stays `.mjs`:** no build step; tested directly via `node --test`.
4. **Version guard:** keep `CORE_VERSION` in `constants.mjs`, re-exported through the barrel so `EXPECTED_CORE_VERSION` comparison in `index.ts` keeps firing.
5. **Skill cards:** `loadSkillCard(join(HERE, "core", "skillcards"), …)` — do not move `skillcards/`.
6. **No behavior change:** this is a move-only refactor. Any diff that changes logic is a defect.

---

## 4. First-Principles Review (one pass)

- **Questioned:** Do we need to split the TS entry at all? — Yes, but it's lower value than the core split and higher risk (touchy pi SDK wiring), so it comes after and is optional if budget runs low.
- **Questioned:** Is a full module split worth it vs just `describe`-blocking the tests? — Test `describe` blocks alone don't shrink the 2454-line core monolith; the module split does. We do both (split tests mirror modules).
- **Deleted:** No new bundler/tooling, no barrel-generation scripts, no codemods. Adding tooling to a move-only refactor would be pure overhead.
- **Simplified:** Kept the barrel even though it adds indirection — because it is what makes the whole refactor incremental and low-risk. Without it we'd have to touch `index.ts` imports + tests all at once.
- **Simplified:** Merged `state.mjs` from a hypothetical 4 files down to 1 (gate-cache + failures + run-stats + skill-card memory are all "persisted state" — cohesive enough).
- **Accelerate:** Leaf-first ordering means each commit is tiny and independently green → fast feedback, easy bisect.
- **Automate (deferred, not proven):** A script to auto-split exports was rejected — the barrel + 8 batches is already cheap; automation would add failure modes without measured payoff.

---

## 5. Facts / Assumptions / Unknowns

**Facts**
- `harness-core.mjs` = 2454 lines; exports ~70 symbols; `index.ts` imports ~70 of them in one block.
- Test script today: `node --test harness/core/harness-core.test.mjs`.
- `install.sh`/`install-dev.sh` = clean `cp -r` of `harness/` (self-contained model).
- Node >= 20 (per `package.json` `engines`) → `node --test <dir>` globbing is supported.

**Assumptions**
- `node --test harness/core/` will discover `*.test.mjs` in subdirs (verify in Batch 4; Node ≥20 does recurse, but confirm).
- The three root docs (`GAPS-EFFICIENCY.md` etc.) are historical analysis artifacts, not load-bearing at runtime. Verified they are markdown docs, not imported.
- No external consumer imports `harness/core/harness-core.mjs` names directly (it's an installed extension, not a published lib) — so the barrel's re-export surface only needs to serve `index.ts` + the tests.

**Unknowns**
- Whether a live `/run` smoke test can run in this environment (needs a pi session). Marked best-effort.
- Exact final line counts of the extracted TS modules (depends on whitespace/comments).

---

## 6. Success criteria (definition of done)

- `harness/core/harness-core.mjs` is a barrel (no real logic).
- `harness/index.ts` is thin (<~400 lines); orchestration lives in named modules.
- `harness/core/*.test.mjs` mirrors the module split; same total assertions.
- All three `npm run <test|typecheck|validate-skills>` green on the final branch.
- 8 clean commits (one per batch), each independently green, each reviewable in isolation.
- `docs/` holds the moved analysis docs; no dangling references.

---

## 7. Open questions for the user (before execution)

1. **Scope cut if budget-limited:** is Batch 6 (the `harness()` body split — highest risk) acceptable to defer, keeping Batches 1–5 + 7? The core split is the main win.
2. **`buildSnapshot` placement:** plan puts it in `report.mjs`; the prior proposal flagged it as slightly git-adjacent. Keep in `report.mjs` or move to `git.mjs`?
3. **README file-tree section:** does it currently list the old layout (confirm before Batch 8 edits)?
