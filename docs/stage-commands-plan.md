# PLAN — Per-stage commands (`/harness-plan`, `/harness-develop`, `/harness-review`)

Status: proposal (analysis-grounded). No code written yet — this is the design to approve before building.

## 1. Goal

Let the user run a task **up to and stopping at a specific stage**: plan-only, plan+develop (pause before review), or full run-to-completion. Surfaced as thin commands over the existing stage machine:

- `/harness-plan "task"` → runs **planning** only, hands control back (resumable).
- `/harness-develop "task"` → runs planning **→ development**, stops **before review**.
- `/harness-review "task"` → full pipeline through review (same as `/run`).

(Also usable as a generic flag: `/run --stage planning|development|review|full "task"`.)

## 2. Current architecture (verified)

Commands registered in `harness/index.ts`: `/run` (L306), `/harness-resume` (L559), `/harness-reset` (L679), `/harness-gate2-pass/skip` (L708/715), `/harness-gate1-pass/skip/reject` (L737/744/751), `/harness-clean-temp` (L760), `/harness-stats` (L769), `/harness-fork-green` (L784). Two tools: `harness_declare` (L804), `harness_review` (L887).

**The stage machine is model-driven**, not auto-driven:
1. `/run` builds `RunState` with `stage: "planning"` (L430) and sends the protocol prompt.
2. **Planning** happens while the model drafts the plan / reads the snapshot. The run advances only when the model **calls the `harness_declare` tool** → `run.stage = "development"` (L857).
3. **Development** = gate-checked edits, until the model **calls `harness_review`** → `run.stage = "review"` (L907), which runs the full gate + returns the review prompt.
4. Finalize: `finishRun` + auto-commit; `/harness-resume` already continues a **stopped** run (status machine: `prepared → running → done | stopped`).

Because the model drives transitions via the two tools, the natural enforcement points are exactly those two tool handlers + the protocol prompt.

## 3. Design

### 3a. Mechanism — a `--stage`/`--stop` target on the run
- `parseRunArgs` (in `harness/core/modules/parse.mjs`, already parses `--think/--edit/--lane/--phase/--budget/--persona`) gains `--stage <planning|development|review|full>` (default `full`).
- `RunState` (interface in `harness/entry/index-consts.ts`) gains one optional field: `haltAfter?: "planning" | "development" | "review" | "full"`.
- `/run` stores it at init (L430 block).

### 3b. User-facing sugar — three thin commands
Each is `/run` with `--stage` pre-set, registered alongside the others:
- `/harness-plan` → `--stage planning`
- `/harness-develop` → `--stage development`
- `/harness-review` → `--stage full` (identity, aliases the default)

Implementation: a shared `runToStage(stage, args, ctx)` helper that the three handlers call (avoids duplicating the ~250-line `/run` handler). Smallest safe approach: refactor the `/run` handler body into `startRun(args, ctx, { haltAfter })`, and have `/run` + the three commands call it.

### 3c. Enforcement at the transitions (the actual "stop")
Two guard points, plus the protocol, so even a stray model tool call can't overshoot:

1. **`harness_declare` tool (planning → development, L804):** if `run.haltAfter === "planning"`, do **not** transition to development. Instead reply to the model "planning stage reached — run paused here (halt-after=planning)" and signal the run is at a stopping point. The model then settles → `agent_settled` finalizes as a **planning-paused** run.
2. **`harness_review` tool (development → review, L887):** if `run.haltAfter === "development"`, do **not** enter review. Reply "development stage reached — run paused (halt-after=development)" and let it settle/finalize paused.
3. **Protocol prompt** (both `harness/prompts/run.md` + `DEFAULT_PROTOCOL` in `harness/entry/protocol.ts`): when `haltAfter` is set, append a directive: "This run halts after the {planning|development} stage. Stop there, do not call {harness_declare|harness_review}, and return a summary." This is the primary control; the tool guards are the safety net.

### 3d. Paused-finalization + resume
- A halted run should **not auto-commit** (nothing user-approved beyond that stage). Reuse the existing `stopped`/resumable path: on halt, mark the run `status = "stopped"`, set `run.stage` to the reached stage, and print a short "paused at {stage}" report (a truncated `printReport`).
- The plan/scope/state is already persisted to `.harness/run.json`, so **`/harness-resume` continues from the exact paused stage** (plan still captured; scope already declared for the development halt). This gives the user inspect-approve-then-resume flow with zero new persistence.

## 4. Files to touch (ordered)

| # | File | Change |
|---|---|---|
| 1 | `harness/core/modules/parse.mjs` | `parseRunArgs`: parse `--stage`; export `STAGES` taxonomy; tests |
| 2 | `harness/entry/index-consts.ts` | `RunState.haltAfter` field |
| 3 | `harness/index.ts` | `startRun(...)` refactor + `run.haltAfter` init; guards in `harness_declare` + `harness_review`; paused-finalize path; register `/harness-plan/-develop/-review` |
| 4 | `harness/entry/protocol.ts` + `harness/prompts/run.md` | append the halt directive when `haltAfter` set |
| 5 | `harness/core/test/{parse,state}.test.mjs` | tests for `--stage` parsing + halt transitions |
| 6 | `README.md` | document the three commands |

## 5. Acceptance criteria

- [ ] `/harness-plan "t"` ends the run at planning (no scope declared, no commit), resumable.
- [ ] `/harness-develop "t"` reaches development (scope declared, edits allowed) then pauses before review, resumable.
- [ ] `/harness-review "t"` equals `/run` full behavior (no regression — 111 existing tests still pass).
- [ ] A model calling the "next" tool despite the halt is blocked by the guard (can't overshoot).
- [ ] `parseRunArgs("--stage development ...")` parses correctly (unit-tested).
- [ ] `npm run test` (111) + `npm run typecheck` + `npm run validate-skills` green.

## 6. Trade-offs, risks, unknowns

- **No new persistence** — relies on the existing `run.json` + `stopped`/`/harness-resume` machinery; lowest-risk path.
- **Risk (moderate):** touching the `/run` handler (refactor to `startRun`) is the one delicate edit — mitigated by keeping it mechanical + the existing green suite + typecheck.
- **Small optional:** a `haltAfter` presence is advisory for `review`/`full` (no behavior change) — avoids special-casing the default.
- **Unknown:** whether the user wants the *committed* state at a planning halt (currently none — nothing changed) vs. a draft plan file. Recommend: no commit at planning; the plan is already in `run.plan`/resume.

## 7. First-Principles Review

- **Questioned:** Do we need real new commands, or just a flag? → Both, but commands are the user-facing ask; the flag is the mechanism (thin sugar, one code path).
- **Deleted:** Removed the idea of separate persistence/state files for halted runs — the existing `stopped` + `run.json` already cover it.
- **Simplified:** No auto-driving stages — we keep the model-driven tool-call model and only *gate* it at the boundary. Falling back to that would be a rewrite for no gain.
- **Accelerate:** reuse `/harness-resume` unchanged for "run from where I paused".
- **Automate (deferred):** a per-command plan is one flag; no codegen/tooling needed.

**Recommendation:** approve this design; build in the listed file order, ending with the 6 acceptance checks.
