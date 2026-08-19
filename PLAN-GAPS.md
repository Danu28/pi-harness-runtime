# Implementation Plan — close the 11 efficiency gaps

Source: `GAPS-EFFICIENCY.md`. This plan sequences all 11 gaps, gives the top
recommendations (#1, #2) full implementation detail (functions, files, tests), and specs
the rest at design level. It is implementation-ready, not a wishlist.

---

## Goal
Fill the 11 gaps so `harness` makes PI runs cheaper and faster — starting with the two
that attack the dominant cost (re-running the full verify suite on every edit).

## Design principles
- **Safe by default.** Cross-run caching and selective tests must **never** report a
  stale-green or skip a real failure. When uncertain → run the full suite.
- **Pure logic in `harness/core/harness-core.mjs`** (unit-testable, zero pi imports);
  `harness/index.ts` only wires events. Match the existing `appendEstimateRecord` /
  `appendRunStats` persistence patterns.
- **All new persistent state under `.harness/`** (temp/longterm) — never the repo tree.
- **Every feature gated by config** so a user who wants the old behavior is unaffected.

---

## Phase 1 — Top recommendations (implement first)

### Task 1 · Cross-run gate caching (Gap #2)
**Goal:** reuse a last-green gate result when the tree is unchanged, so repeat/resume runs
pay ~$0 for the gate.

**Key insight (safe):** cache on **git state**, not on expensive file hashing. Key =
`{ verifyCmd, head: <HEAD sha>, porcelain: <sorted porcelain set> }`. Same commit + same
working-tree mods ⇒ same test result (tests are assumed deterministic, as today). A dirty
tree mid-run almost never matches a cached green, so this only fires when it is provably
safe (clean-tree baseline, resume after auto-commit, repeat runs at the same commit).

**Core functions to add** (`harness-core.mjs`):
```js
// .harness/longterm/gate-cache.json
const GATE_CACHE_FILE = join(LONGTERM_DIR, "gate-cache.json");
export function loadGateCache(cwd)          // -> { entries: [{verifyCmd, head, porcelain, ts}] } (cap 20, newest-first)
export function saveGateCache(cwd, entries) // best-effort write (mirror appendRunStats)
// sha1 of a file or a stable git-state string (reuse crypto)
export function gateCacheKey({ verifyCmd, head, porcelain })
// returns { ok:true, cached:true, ts } when a green match exists, else null
export function cachedGreen(cwd, { verifyCmd, head, porcelain })
// after a real GREEN gate run, call this to record it
export function recordGreen(cwd, { verifyCmd, head, porcelain })
```

**Wiring** (`index.ts` `tool_result` gate + `harness_review`): compute git state
(extend/export the existing `gitPorcelain`/`setFromPorcelain` helpers + a `gitHead()`),
then before `gateResult(...)`:
- if `cachedGreen(...)` → reuse verdict, coach `HARNESS: gate cached (unchanged tree)`,
  do **not** increment `gateRuns`/cost.
- if the real gate **passes** → `recordGreen(...)`; if it **fails** → invalidate any
  matching entry (a fail proves the prior cache was wrong or the tree is flaky).

**Tests** (`harness-core.test.mjs`):
- `loadGateCache` empty file → `{ entries: [] }`.
- `gateCacheKey` is stable for same inputs, distinct for different `verifyCmd`/`porcelain`.
- `cachedGreen` returns the entry only on exact `head`+`porcelain` match; miss → `null`.
- `recordGreen` + reload → entry present; cache capped at 20 (oldest dropped).
- A recorded green is **not** returned after the porcelain set changes (no stale-green).

**Config:** `harness.json` → `cacheGreenGates: true` (default true; false disables).

**Risk / footprint:** low — pure additions, off-path, opt-out. `footprint: boundary` only
because it touches the gate hot path (gate must never go stale-green).

---

### Task 2 · Selective / targeted tests (Gap #1)
**Goal:** on each edit, gate only the tests affected by changed files; full suite at review.

**Design:** two-layer, conservative:
- **Only engages when configured** and the `verifyCmd` matches a recognized runner.
  `harness.json` → `selectiveTests: true`.
- **Framework map** built in core: given changed source files, emit a runner-specific
  selector (see table). **Changed files come from the existing porcelain set.**
- **Fallback:** if no framework matches, or selector building fails, or any changed file is
  outside a mapped package → run the **full** command. Never risk skipping a real failure.

| Runner | detect | selector from changed files |
|---|---|---|
| jest (npm) | `verifyCmd` contains `jest` / `npm test` + `jest` present | `--testPathPattern "<regex over changed paths>"` (also add `--silent`) |
| vitest | contains `vitest` | `run <changed-file-paths>` |
| pytest | contains `pytest` | `pytest -k "<or-of-changed-module-names>"` OR `pytest <changed _test files>` |
| go test | contains `go test` | `go test <packages-of-changed-files>` |
| node --test | `verifyCmd` is the syntax fallback / contains `node --test` | `node --test <changed test files>` |

**Core functions:**
```js
export function testSelector(verifyCmd, changedFiles)
//  -> { type:"full" } | { type:"selective", cmd } (runner-specific; null/full on unknown)
export function gitHead(cwd)                 // sha1 of HEAD
export function changedPaths(cwd)            // export the porcelain set as sorted rel paths
```

**Wiring:** `index.ts` `tool_result` gate + `harness_review`:
- edit-gate: if `selectiveTests` and `stage === "development"` → `testSelector(...)`; run the
  selective cmd; on green it's just a cheaper gate, on red the full suite is implied broken.
- review/full gate (`harness_review`): always run the **full** `verifyCmd` (correctness
  gate for shipping) — never selective.

**Tests:**
- jest `--testPathPattern` built from `["src/a.ts"]` → regex `src/a` (and `test` file).
- unknown runner (e.g., a custom `verifyCmd`) → `{ type:"full" }`.
- go: changed `pkg/foo.go` → `go test ./pkg`.
- empty changed set → `{ type:"full" }` (nothing to select — run everything).

**Risk / footprint:** **boundary.** Selective test-selection is the riskiest of the 11
(false-negative = skipping a failing test). Mitigations: opt-in, runner allowlist, full
fallback on any uncertainty, full suite always at review, and tests proving the fallback.

---

## Phase 2 — Structural (highest value after #1/#2)

### Task 3 · Auto-fork on gate failure (Gap #3)
- On a red gate, before the inline fix, snapshot a **last-green** point.
- `harness/index.ts`: on first gate fail, call `ctx.sessionManager` to record a labeled
  entry (`pi.setLabel(entryId, "last-green")`) and note it in the coach. Provide
  `/harness-fork-green` to branch there via pi's `/fork` surface.
- **footprint: boundary** (touches session state). Deliverable: model never loses the last
  known-good state; cheap rollback.

### Task 4 · Parallel sub-runs (Gap #4)
- Add `harness.json` → `parallel: { splits: number, budget: maxTurns }` (default off).
- Partition the declared scope into independent groups; run each as a bounded sub-run and
  merge reports (appendRunStats per group). Gate stays per-sub-run; full gate merges.
- **footprint: boundary** (concurrency, merge correctness). Optional; ship gated behind config.

---

## Phase 3 — Medium / incremental

### Task 5 · Structured test-runner output (Gap #5)
- Extend `extractFailures` to parse TAP (`TAP version`, `ok N`, `not ok N - <name>`) and
  JUnit (`<testsuite>`, `<testcase>`) → per-test rows `file:line — name (failed)`.
- Surface these rows first in the coach rail (already structured for some kinds).
- Tests: feed a TAP blob + a JUnit blob, assert rows. **Low risk.**

### Task 6 · Auto-triage gate failures → failure-memory (Gap #6)
- On a red gate, match `output` against `loadRunStats()` + `.harness/longterm/memory/failures.md`
  (fuzzy token match) → pre-classify `known/new/transient`, pre-fill the lesson line.
- `checkFailureMemory()` extended to accept a suggested lesson; model confirms/edits.
- Tests: a repeated failure output classifies `known`. **Low risk.**

### Task 7 · Unify with `context-mode` KB (Gap #7)
- Optional adapter: when `toolOutputTokens` is reached, route large verify output to the
  `context-mode` indexer (`ctx_index`/`ctx_search` pattern) instead of only head+tail.
- Config flag `toolOutputMode: "tail"|"kb"` (default tail; kb is experimental).
- **footprint: boundary** (external tool dependency). Optional.

### Task 8 · Skip gate on non-mutating / doc edits (Gap #8)
- Classify each edit: `.md`/`.txt`/comment-only/whitespace → `noGate`, else `gate`.
- Reuse `gitDiff()`; if changed files are all doc/whitespace → skip the edit-gate (full
  gate at review still runs).
- Tests: doc-only change → no gate; `.ts` change → gate. **Low risk.**

### Task 9 · Warn→confirm tiers for dangerous actions (Gap #9)
- `dangerousBash()` returns a matched pattern + tier (`block|confirm|allow`), configured via
  `harness.json` → `dangerTiers: { "rm -rf /": "block", "rm -rf ~/build": "confirm" }`.
- `block` → hard block (today); `confirm` → `ctx.ui.confirm` then allow if accepted.
- **footprint: boundary** (security). Tests for tier parsing.

### Task 10 · Monorepo per-package gates (Gap #10)
- For each changed file, walk to nearest `package.json` (or `go.mod`/`Cargo.toml`); if all
  changed files share one package, run that package's `detectVerify()` with `verifyCwd`.
- Cross-package change → root gate. `detectVerify()` already accepts a cwd.
- Tests: `packages/a/x.ts` + `packages/b/y.ts` → root; single-package → per-package.

### Task 11 · Prompt-cache maximization across resume (Gap #11)
- Persist the injected prefix (snapshot/plan/card) as a stable, byte-identical template keyed
  by `(run.task, run.verifyCmd)`; on `/harness-resume` reuse it verbatim.
- Read `message_end` `usage.cacheRead` to report cache-hit % in the report (extend
  `reportRows`). Tests for the key + report row. **Low risk.**

---

## Priority-ordered task list
- [ ] T1 · Cross-run gate caching (#2) — **implement first** — low risk
- [ ] T2 · Selective tests (#1) — **implement second** — `footprint: boundary`
- [ ] T3 · Auto-fork on gate failure (#3) — `footprint: boundary`
- [ ] T4 · Parallel sub-runs (#4) — `footprint: boundary`
- [ ] T5 · Structured test-runner output (#5)
- [ ] T6 · Auto-triage gate failures (#6)
- [ ] T7 · Unify with context-mode KB (#7) — `footprint: boundary`
- [ ] T8 · Skip gate on doc/whitespace edits (#8)
- [ ] T9 · Warn→confirm tiers (#9) — `footprint: boundary`
- [ ] T10 · Monorepo per-package gates (#10)
- [ ] T11 · Prompt-cache across resume (#11)

## Files touched (all)
- `harness/core/harness-core.mjs` — new pure functions + tests
- `harness/core/harness-core.test.mjs` — ~20–30 new unit tests
- `harness/index.ts` — event wiring (gate path, review gate, config load)
- `harness/core/compile-skills.mjs` — only if skill-card counts change (likely not)

## Verify
`npm run test` must stay green after **every** feature (gate runs after each edit). Each
feature also gets its own unit tests (deterministic, not LLM-judged).

## Acceptance
- [ ] T1 caches and reuses a green gate on unchanged tree; never stale-green on a changed tree.
- [ ] T2 runs selective tests on edit-gate, full suite at review, and falls back to full on any unknown runner.
- [ ] T3–T11 each implemented behind a config flag with unit tests and a green `npm run test`.
- [ ] Baseline remains green and no feature can skip a real failure (safety-first fallbacks).
