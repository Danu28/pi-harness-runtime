# Stage-by-Stage Gap Analysis — requirements → planning → development → review

**Goal:** simple but effective. Not a feature wishlist — each gap earns a place
only if closing it is cheap AND removes real friction in the run flow. Backlog
is ranked P1/P2/P3 by value ÷ effort, with a concrete minimal fix each.

The flow today:
`requirements` (first-principles self-review) → `planning` (scope + task list,
`harness_declare`) → `development` (gate-driven edits, `harness_review`) → `review`
(full gate + diff audit + acceptance). One gate now: Gate 2 (boundary/risk L plans).

---

## Stage 1 — Requirements

**Current:** model drafts `## Requirements`, self-reviews via first-principles, the
list is parsed (`parseRequirements`) and stored on `run.plan.requirements`, and
surfaced in the final report.

| # | Gap | Why it matters | Minimal fix |
|---|-----|----------------|-------------|
| R1 | **No requirement IDs / traceability.** Requirements are plain strings; nothing links a requirement → the plan task that addresses it → the acceptance line that verifies it. | You can't tell whether a run actually closed all its requirements — the review is vibes, not a checklist. | Give each requirement an ordinal (R1, R2…) at parse time; let plan tasks cite `(R#)`. Cheap, text-only. |
| R2 | **Requirements are never re-checked at review.** Captured up front, then abandoned — acceptance is a self-reported verdict with no cross-check that each requirement was met. | The whole "requirements-first" design has no closing loop. | At `harness_review`, require the model to map each R# → met/partial/unmet before a `met` verdict resolves. Adds a few protocol lines, no engine change. |
| R3 | **No scope marker.** Nothing records "out of scope / explicitly not doing X", so decisions to cut are lost between stages. | Cutting scope is the highest-value move (deletion > automation) but untracked. | One extra "**Out of scope:**" line parsed+persisted like requirements. |

---

## Stage 2 — Planning

**Current:** lane triage (`--lane` → `Lane:` marker → `classifyLane` heuristic),
`verifyTier` from plan footprint, `## Plan` parsed (`parsePlan`), tasks merged
(`mergePlanTasks`), scope declared via `harness_declare`.

| # | Gap | Why it matters | Minimal fix |
|---|-----|----------------|-------------|
| P1 | **Tasks have no stable IDs.** `mergePlanTasks` dedupes on exact `text`; progress (`parsePlanProgress`) matches checkboxes by text. A rephrased task = a "new" task; progress counts drift. | Progress reporting (done/total) becomes unreliable when the model restates tasks mid-run. | Normalize task text (trim/collapse whitespace, lowercase) before dedupe+progress-match. Pure function, no schema change. |
| P2 | **Plan ↔ declared-scope not cross-checked.** You can declare files with no task, or touch files with no task; the run never flags it. | Scope is the trust boundary — a mismatch is exactly what leaks edits. | On `harness_review`, report "declared files with no task" / "touched files outside tasks" as advisory notes. Read-only, no blocking. |
| P3 | **Lane heuristic is coarse** (`classifyLane` regex: `refactor|design|api…`). A miss sets the wrong tier for the whole run. | Wrong S vs L changes gate strictness silently. | After the plan commits, re-derive tier from actual task footprints (already happens for `verifyTier`) and log lane-vs-plan mismatch as a warning. |
| P4 | **Scope is declared once, never re-confirmed** if the task pivots mid-run (resume path re-declares but not re-validated). | A genuine pivot can leave the original scope stale. | On `harness_resume`, remind the model: "re-verify scope matches the current plan or re-`harness_declare`". One protocol line. |

---

## Stage 3 — Development

**Current:** gate runs the verify command after every edit; edits outside declared
scope are blocked; fail-ladder escalates thinking; edit-mismatch coach hints on
`oldText` misses; `selectiveTests` (cfg flag) can narrow the gate.

| # | Gap | Why it matters | Minimal fix |
|---|-----|----------------|-------------|
| D1 | **Full gate re-runs on every edit.** `selectiveTests` (the fix) is opt-in via `harness.json` and heuristic. | Slow full verify per edit = wasted turns + cost on medium/large repos; high-resistance default. | Auto-enable `selectiveTests` when the repo has a test script + git (fall back to full gate when in doubt). Default-on beats config-off. |
| D2 | **No automatic diff-size guard during development.** A run can pile up a huge uncommitted diff before review. | Big diffs are harder to review and correlate with high regression risk late. | Soft warning (not block) when changed-file count / diff bytes cross a threshold mid-run. |
| D3 | **No auto-retry on edit mismatch.** The coach reports the exact byte diff but the model must manually redo the edit. | Re-issuing an edit that the coach already located is pure wasted turn. | Coach already computes the fix location — expose it as a machine-readable hint the model pastes instead of re-guessing. (Smallest: keep manual, just the hint is already good.) |

---

## Stage 4 — Review + Acceptance

**Current:** `harness_review` runs the full gate, prints it; model audits its own
diff and declares `Acceptance: met|partial|unmet`; report renders rows + notes.

| # | Gap | Why it matters | Minimal fix |
|---|-----|----------------|-------------|
| G1 | **Acceptance is fully self-reported, unverified.** No automated check that all plan tasks completed or all requirements mapped. | `met` with `done < total` or unmapped R# is accepted silently. | Cheap structural checks at review: `done == total`, every `## Requirements` R# appears in the plan or is marked out-of-scope. Advisory warning if not. |
| G2 | **Scope-exceedance isn't flagged at review.** Blocking happens during dev, but the final diff isn't cross-checked against declared scope in the report. | Review is the last chance to catch a scope leak. | Report a "files outside declared scope" line (already have `changedPaths`); read-only. |
| G3 | **No per-requirement acceptance in the report.** Report shows requirements but not their met-status. | The report can't answer "is every requirement actually done?" | Fold R# met-status (from R2) into the report rows. Reuses R2's mapping. |

---

## Recommended first sprint (P1 only, smallest lock)

1. **R1+R2+G1 together** — requirement IDs + review-time mapping + `done==total`
   guard. One coherent "traceability" theme: parse ordinals, check at review.
   _Reuses existing `parseRequirements` / review wiring. No new files._
2. **G2** — scope-exceeded line in the report (uses existing `changedPaths`).
3. **D1** — make `selectiveTests` default-on behind a safe fallback. Biggest
   runtime cost win.

**Deferred (P2/P3):** P1 (task-id normalization), D2 (diff guard), D3
(auto-retry) — each is real but independent and lower value ÷ effort.

---

## Non-goals (deliberately out — keeps it simple)
- No new stages, no new gates beyond Gate 2, no schema/db migrations, no UI.
- No automatic scope-expansion — the agent never self-authorizes edits outside
  declared scope.
- No per-edit dependency graph; `selectiveTests` stays best-effort, not exact.

---

## Sprint roadmap

**Sprint 1 — traceability + fast gate + review guard** (started)
- R1 requirement IDs at capture (R1., R2.…)
- D1 `selectiveTests` default-on (safe fallback when it can't narrow)
- G2 report note for changed files outside declared scope
- G1-lite structural review guard: warn if review entered with tasks unchecked

**Sprint 2 — requirement → task → acceptance mapping**
- R2 review-time requirement mapping (each R# → met/partial/unmet, advisory)
- G3 per-requirement met-status folded into the report rows

**Sprint 3 — planning hardening**
- P1 task-id normalization (dedupe + progress match on normalized text)
- P2 plan↔declared-scope cross-check note
- P4 re-confirm scope on `/harness-resume`

**Sprint 4 — dev efficiency / safety nets**
- D2 mid-run diff-size warning
- D3 auto-retry on edit mismatch (or keep the coach hint)
- P3 lane-vs-actual-plan mismatch warning

