# Ponytail-Audit Implementation Plan

**Status:** Proposed (Product Owner view)
**Source:** `ponytail-audit` run over `pi-harness-runtime`
**Goal:** remove ~25 lines of dead weight + one duplicated helper and one inlined
flag from the harness, with zero behavior change and zero regression on the
existing 111-test gate (`npm run test`).

This plan converts the audit findings into a prioritized backlog. Each item
carries: what to cut, the exact location, effort, risk, acceptance criteria, and
sequencing. Items are independent unless stated — the ordering is by value ÷ risk.

---

## Summary of findings (from audit)

| # | Tag | What | Where | Est. cut |
|---|-----|------|-------|----------|
| A1 | delete | Entire top import block of the barrel — unused stdlib + redundant module imports | harness/core/harness-core.mjs:4–14 | ~11 lines |
| A2 | delete | `gitPorcelain`, `setFromPorcelain` imported, never used/exported | harness/core/harness-core.mjs:55–56 | ~2 lines |
| A3 | yagni | The 129-line pure-re-export barrel itself | harness/core/harness-core.mjs | (defer — see §Barrel decision) |
| A4 | stdlib | Inlined `isTTY && !NO_COLOR` instead of the exported `USE_COLOR` | harness/entry/report.ts:37 | 1 line |
| A5 | shrink | `lastAssistantText` re-implements `contentText`'s part-array→text logic | harness/entry/settle.ts:17–38 | ~6 lines |
| A6 | delete | Five stale one-off planning docs | docs/{refactor-plan,plan-gaps,gaps-efficiency,stage-commands-plan,harness-analysis}.md | ~700+ lines |
| A7 | yagni | Six micro-fragment entry files | harness/entry/*.ts | (reverse of over-engineering — defer) |

---

## Key technical facts established by the audit

1. **The barrel has no body logic.** `harness/core/harness-core.mjs` is imports +
   re-exports only. Therefore every top-of-file import (A1) is either redundant
   with its `export … from` line or pure dead weight. This is safe to trim by
   construction — nothing references those bindings inside the file.
2. **The barrel is load-bearing as a seam, not for behavior.** `index.ts` imports
   ~80 symbols from it, and all 111 unit tests (except `test-utils.mjs`, a fixture
   helper) import through it. Its *content* can change freely as long as the
   exported surface stays intact — `export … from` lines are untouched.
3. **`gitPorcelain` / `setFromPorcelain`** are imported at :55–56 but neither
   re-exported nor used → provably dead (A2).
4. **`USE_COLOR`** is already the exact expression `!!process.stdout.isTTY &&
   !process.env.NO_COLOR` and is exported from the barrel (A4).
5. **`contentText`** is exported from `settle.ts` and already normalizes both the
   string and part-array shapes; `lastAssistantText` re-writes that normalization
   inline (A5).

---

## Backlog (ranked by value ÷ risk)

### Item 1 — Delete dead barrel imports (A1 + A2)  ⭐ highest value/risk ratio
- **Work:** In `harness/core/harness-core.mjs`, delete lines 4–9 (the `node:crypto`,
  `node:child_process`, `node:fs`, `node:os`, `node:path` imports) and lines
  10–14 + 55–56 (the module imports that are redundant with their re-export
  lines OR never re-exported). Keep every `export … from` line intact.
- **Keep:** nothing — all deleted bindings are unused in the barrel body.
- **Effort:** S · **Risk:** none (surface unchanged) · **Gate:** `npm run test`
- **Acceptance:**
  - [ ] `npm run test` green (111 tests)
  - [ ] `npm run typecheck` green
  - [ ] no `import … from` remains that feeds a symbol also produced by an
        `export … from` from the same module
  - [ ] barrel still re-exports every symbol index.ts + tests import

### Item 2 — Reuse `USE_COLOR` instead of inlining it (A4)
- **Work:** In `harness/entry/report.ts:37`, replace
  `process.stdout.isTTY && !process.env.NO_COLOR` with the imported `USE_COLOR`
  (already exported by the barrel; add it to the existing import line).
- **Effort:** S · **Risk:** none · **Gate:** `npm run test`
- **Acceptance:**
  - [ ] exact same truth value in all TTY / NON-TTY / NO_COLOR combos
  - [ ] report still renders via `notify` on TTY and `console.log` otherwise

### Item 3 — `lastAssistantText` delegates to `contentText` (A5)
- **Work:** In `harness/entry/settle.ts`, change the inline part-array handling in
  `lastAssistantText` to call `contentText(e.message.content)`. `contentText`
  already handles both `string` and `Array<{type,text}>` shapes.
- **Effort:** S · **Risk:** none (pure refactor of identical logic) · **Gate:** `npm run test`
- **Acceptance:**
  - [ ] `lastAssistantText` returns identical output for string, part-array, and
        empty/malformed content
  - [ ] `contentText` still exported (used by gather path)

### Item 4 — Purge stale planning docs (A6) — **decision required**
- **Work:** Delete `docs/refactor-plan.md`, `docs/plan-gaps.md`,
  `docs/gaps-efficiency.md`, `docs/stage-commands-plan.md`, `docs/harness-analysis.md`.
  These are executed history; the execution is done and described in README.
- **⚠ Product Owner gate:** README currently frames `docs/` as deliberately kept
  history. Confirm no article/blog/report still links to them, then delete.
  If any is still referenced, keep it and note the link.
- **Effort:** S · **Risk:** documentation-only · **Gate:** n/a (no code)
- **Acceptance:**
  - [ ] README and repo contain no dangling links to deleted files
  - [ ] five files removed from git
  - [ ] (explicit confirmation) history no longer needed as living reference

---

## Deferred items (explicitly NOT in this sprint)

### Barrel file itself (A3)
Keep for now. It is the documented, intentional unit-test seam — the entire suite
imports through it, and collapsing it to direct `modules/*` imports is a
structural refactor with broader blast radius. Revisit only if/when `index.ts`
shrinks and the import target count drops. Low value now; keep the dead-import
trim (Item 1) instead.

### Entry micro-fragmentation (A7)
Borderline — the six files are each a single-function module (30–51 lines) split
out of a 1538-line `index.ts`. They *reduce* per-file complexity even if they
raise file count. Do not collapse while `index.ts` remains large; revisit only as
part of a larger consolidation. No action this sprint.

---

## Sequencing & verification

All Items 1–3 are pure deletable-refactor with zero behavior change and can be
landed in one change, gated by `npm run test` + `npm run typecheck`. Item 4 is
independent and needs the PO sign-off noted above.

1. Item 1 → run gate → green
2. Item 2 → run gate → green
3. Item 3 → run gate → green
4. Item 4 → PO confirmation → delete → grep for dangling links

**Coordination:** none — no item shares a file with another, so they are
independently shippable and revertible.

---

## Acceptance (whole sprint)

- [ ] `npm run test` green throughout (111 tests, baseline unchanged)
- [ ] `npm run typecheck` green
- [ ] barrel export surface 100% unchanged (index.ts + tests still resolve)
- [ ] net code removed ≈ −25 lines, 0 deps added, 0 behavior change
- [ ] no dangling doc links after Item 4

---

## Rollback

Every item is a small, revertible single-file (or docs-only) change. Any item
that turns the gate red is reverted individually; no shared rollback path needed.
