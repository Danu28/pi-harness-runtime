# planner — runtime card
## When
Turn a request into a verified implementation plan BEFORE code. (Run the full
`SKILL.md` only when editing the planning process itself.)

## Output artifact → memory/plan.md
- **Restatement** — user's intent, verbatim.
- **Acceptance Criteria** — one verifiable sentence each.
- **Quality Contract** (M/L tasks) — 3–5 artifact-type criteria the verifier treats as ACs.
- **Tasks** — `T1. <action> → verify: <check>  (footprint: boundary|hot-path|none)`.
- **Risk Notes** — one line per trust boundary (network/auth/input/DB/filesystem write); `None` if none. Gate 2 fires on any exposure.
- **Loop Budget** — `Re-verify cycles: 2`.
- **Design** — embed load-bearing facts/gotchas so the builder never re-reads knowledge/decisions.

## Non-negotiable rules
- Read all 5 memory files first + `failures.md` (project AND `~/.pi/agent/memory/`) for known-failure prevention; scan `problems.md` for Planning-debt.
- Restate intent; ask only what you can't infer; surface assumptions; present conflicting interpretations; push back on scope.
- **No task without a `verify:` check; every task traces to a requirement** (else it's scope creep).
- Tag footprint conservatively — `boundary` = input/files/network/DB/auth; an honest `none` saves a verifier round.
- Plan-wrong → dated `## Revision` delta, user approves delta only; latest delta's `### Tasks (current)` is authoritative. Never edit a plan in place.
- Don't write production code during planning.
- End: name next stage (Gate 2 if any boundary, else Build).
