# Implementation Plan — efficiency gaps: audit + remaining work

Source: `GAPS-EFFICIENCY.md`. This file is the **living plan**. It was originally written
when all 11 gaps were open; an audit against the current source (see **Current status**)
shows **8 of 11 are already implemented** in commit `3a43970` ("Fix 8/11 efficiency gaps").
This plan therefore (a) records the audit, and (b) is implementation-ready for the **3 that
remain** (#3, #4, #7). Do not re-implement the 8 closed gaps.

---

## Current status (audit against source)

| # | Gap | Status | Where |
|---|---|---|---|
| 1 | Selective / targeted tests per edit | ✅ **done** | `testSelector()` + `selectiveTests` config (`harness-core.mjs` ~1819), wired in `index.ts` edit-gate |
| 2 | Cross-run gate caching | ✅ **done** | `loadGateCache`/`cachedGreen`/`recordGreen` + `cacheGreenGates` (`harness-core.mjs` ~1244/1269), reused in `index.ts` gate |
| 5 | Structured test-runner output | ✅ **done** | TAP + JUnit parsing in `extractFailures()` (`harness-core.mjs` ~1594) |
| 6 | Auto-triage gate failures → memory | ✅ **done** | `index.ts` gate-fail path triages `known|new|transient` and pre-fills the lesson |
| 8 | Skip gate on doc/whitespace edits | ✅ **done** | `skipDocGate` config + `index.ts` edit-gate classification |
| 9 | Warn→confirm tiers for dangerous actions | ✅ **done** | `dangerTier()` + `dangerTiers` config (`harness-core.mjs` ~164) |
| 10 | Monorepo per-package gates | ✅ **done** | `perPackageGate` config + nearest-manifest resolution (`harness-core.mjs` ~1031, `index.ts`) |
| 11 | Prompt-cache reporting | ✅ **done** (reporting half) | `message_end` `usage.cacheRead` → `tokensCached` + `cacheHitPct` report row (`reportRows`); byte-stable prefix *persistence* left as follow-up |
| 3 | Auto-fork on gate failure | ✅ **done** | `lastGreen`/`recordGateFail`/`loadGateRollbacks` + `autoFork` config (`harness-core.mjs`), edit-gate rollback coach + `/harness-fork-green` (`index.ts`) |
| **4** | **Parallel sub-runs** | ⬜ **open** | not in source |
| **7** | **Unify tool-output budget with context-mode KB** | ⬜ **open** | not in source |

**Verdict:** 8/11 closed (commit `3a43970`). Three remain, and only #3 is a clean,
self-contained, high-value/low-risk add. Per first-principles (question → delete → simplify):
#4 and #7 are real but carry big footprint/optional value; recommend implementing #3 now and
keeping #4/#7 as gated, clearly-optional tasks — not default behavior.

---

## Design principles (unchanged)

- **Safe by default.** Anything that can skip a real failure or report a stale-green is
  opt-in and falls back to the full suite. When uncertain → run the full suite.
- **Pure logic in `harness/core/harness-core.mjs`** (unit-testable, zero pi imports);
  `harness/index.ts` only wires events.
- **All persistent state under `.harness/`** (temp/longterm) — never the repo tree.
- **Every feature gated by config** so the old behavior is the default.

---

## Remaining work

### Task 3 · Auto-fork on gate failure (gap #3) — **implement next, low risk**
**Goal:** never lose the last-known-good state. When the first gate fails, snapshot the last
green commit/session point so the model (or user) can roll back cheaply instead of fixing
inline on a broken linear run.

**Design (conservative — no mid-run `/fork` required):**
- Core function `lastGreenState(cwd, run)` → the HEAD sha + `verifyCmd` recorded at the last
  real GREEN gate of the run (reuse `gateCache` infra: the most recent `recordGreen` entry).
- On the first gate **fail** in `index.ts` (edit-gate or review-gate): emit a coach line
  `HARNESS: last green at <short-sha> — rollback point: git reset --hard <sha>`, and append a
  `last-green` entry to `.harness/longterm/gate-failures.json` (already exists) with
  `{ ts, head, verifyCmd }`.
- Do **not** auto-invoke `ctx.sessionManager`/`/fork` from inside the run (forking mid-run is
  disruptive and pi's fork surface is interactive). Instead, surface the rollback point and
  register a `/harness-fork-green` command that re-enters the persisted last-green state when
  the user invokes it. Default off via `harness.json` → `autoFork: false`.

**Core functions:**
```js
export function lastGreen(cwd)                  // -> { head, verifyCmd, ts } | null  (newest gate-cache entry)
export function recordGateFail(cwd, { head, verifyCmd, reason }) // append to gate-failures.json (cap 50)
```
**Wiring (`index.ts` gate-fail + review-fail):** call `recordGateFail`; coach the
`lastGreen()` rollback point; register the `/harness-fork-green` command (prints the state;
actual branching stays a user action).

**Tests:**
- `lastGreen` returns null on empty cache; newest entry otherwise.
- `recordGateFail` persists and caps at 50; reload → entry present.

**Risk / footprint:** low — pure persistence + a coach message + a read-only command. No
session mutation inside the run.

### Task 4 · Parallel sub-runs (gap #4) — **optional, footprint: boundary**
**Goal:** wall-clock speedup on multi-part tasks by partitioning independent work.

**Design:** add `harness.json` → `parallel: { splits: N, budget: maxTurns }` (default off).
Partition the declared scope into independent groups; run each as a bounded sub-run reusing
the run protocol; merge via `appendRunStats` per group. Gate stays per-sub-run; review runs
the full suite once at the end.

**Footprint / why gated:** concurrency + merge correctness is the riskiest remaining item
(false merge, budget races). Keep default off; document that the serial path is unchanged.

### Task 7 · Unify tool-output budget with context-mode KB (gap #7) — **optional, footprint: boundary**
**Goal:** remove the head/tail-only blind spot for large outputs by routing them through the
`context-mode` knowledge base (`ctx_index`/`ctx_search`) instead of truncating.

**Design:** when a tool result exceeds `toolOutputTokens` and the `context-mode` extension is
present, index the full output under `.harness/longterm/` and re-inject only recall-by-topic
sections. Config `toolOutputMode: "tail"|"kb"` (default `tail`, so today's behavior is
unchanged).

**Footprint / why gated:** external-tool dependency (context-mode may not be installed);
experimental. Ship only behind the flag.

### Follow-up · prompt-cache byte-stable prefix (gap #11, second half)
Persist the injected prefix (snapshot/plan/card) as a stable, byte-identical template keyed
by `(run.task, run.verifyCmd)` so `/harness-resume` reuses the cached prefix verbatim
(increases `cacheRead`). Reporting is already done; only the persistence half remains. Low
risk, small.

---

## Priority-ordered task list
- [x] T1 · Cross-run gate caching (#2) — done `3a43970`
- [x] T2 · Selective tests (#1) — done `3a43970`
- [x] T5 · Structured test-runner output (#5) — done `3a43970`
- [x] T6 · Auto-triage gate failures (#6) — done `3a43970`
- [x] T8 · Skip gate on doc/whitespace edits (#8) — done `3a43970`
- [x] T9 · Warn→confirm tiers (#9) — done `3a43970`
- [x] T10 · Monorepo per-package gates (#10) — done `3a43970`
- [x] T11 · Prompt-cache reporting (#11) — done `3a43970` (persistence = follow-up)
- [x] T3 · Auto-fork / last-green rollback point (#3) — done (lastGreen/recordGateFail + coach + `/harness-fork-green`)
- [ ] T4 · Parallel sub-runs (#4) — `footprint: boundary`, optional, gated
- [ ] T7 · Unify with context-mode KB (#7) — `footprint: boundary`, optional, gated
- [ ] T11b · Prompt-cache byte-stable prefix persistence — follow-up, low risk

## Files touched (only for the remaining tasks)
- `harness/core/harness-core.mjs` — `lastGreen`/`recordGateFail` (+ any T4/T7 helpers)
- `harness/core/harness-core.test.mjs` — unit tests for the above
- `harness/index.ts` — gate-fail coach + `/harness-fork-green` command; T4/T7 config wiring
- `harness/core/compile-skills.mjs` — only if skill-card counts change (likely not)

## Verify
`npm run test` must stay green after **every** change (gate runs after each edit). Each new
feature gets deterministic unit tests (not LLM-judged).

## Acceptance
- [ ] Audit table matches source reality (8/11 done; #3/#4/#7 remain).
- [ ] T3: first gate fail surfaces the last-green rollback point; `recordGateFail`/`lastGreen` have unit tests; `npm run test` green.
- [ ] T4 / T7: behind config flags, default off, with unit tests where feasible — or explicitly deferred with a reason.
- [ ] Baseline remains green; no feature can skip a real failure (safety-first fallbacks).

---

## First-Principles Review
- **Questioned:** are #4 (parallel) and #7 (context-mode) worth building now? → Only
  marginally; both are optional and gated. #3 is the only remaining clean high-value add.
- **Deleted:** nothing removed from the audit; the 8 closed gaps are marked done, not
  re-planned.
- **Simplified:** #3 reduced from "auto-fork a session" to "record a last-green rollback
  point + coach it + a read-only `/harness-fork-green`" — no mid-run session mutation.
- **Accelerated:** reuse the existing gate-cache persistence instead of new state for `lastGreen`.
- **Automated:** defer to `npm run test` (already proven); no new tooling.
