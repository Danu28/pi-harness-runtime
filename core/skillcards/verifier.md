# verifier — runtime card
## When
Verify completed work before shipping. (Full `SKILL.md` = process reference.)

## Output artifact
`VERDICT: Pass (automated) / Pass (n quality notes) / Pass / Conditional / Fail`
+ `Re-verify cycle: n/2`, then evidence-backed sections for the phases that ran.

## Tier selection (drives which phases run)
- **Quick** — all tasks `footprint: none`, records present, previously Pass-verified → SKIP (gate only).
- **Standard** — no genuinely risky boundary/hot-path, OR first-build none-plan → Tests + Review.
- **Full** — a boundary/hot-path task touching real risk (network/input/DB/auth/hot loop) → all 4 phases.
- A tag alone is not risk: a boundary task touching only a local read/write downgrades to Standard.
- Performance runs only on a real hot path.

## Non-negotiable rules
- **Validate only what the builder didn't prove** — trust `verify: <check> — passed` + `files:`
  records; don't re-run builder-proved checks. Supply evidence only for unproven criteria.
- **Cross-check plan-vs-intent**: a criterion that drifted from or dropped the user's intent is a
  Fail even if the code meets the plan. Check.ps1 gate is part of the evidence base.
- **Deterministic ACs get deterministic evidence** (grep/command/lint), not LLM judgment.
- Tests exist to fail — mentally mutate the code; a test that still passes is worthless.
- Findings need file:line + evidence; no vibes. **Report, don't fix, unless asked.**
- Delta-only re-verify on cycle ≥2 (audit only `## Re-verify scope`); bounded loop, stop at 2/2.
- On Pass: append one line to `memory/workflow.md` (lane | cycles | revisions | repeats | verdict)
  and a `## Reflection` to plan.md.
