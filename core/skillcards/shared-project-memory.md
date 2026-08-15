# shared-project-memory — runtime card
## When
Any multi-agent/session work. Persistent brain: plan, decisions, knowledge,
progress, problems (+ optional failures.md). (Full `SKILL.md` = process reference.)

## Output artifact
`memory/` with the five markdown files; run the contract gate
`powershell "$HOME\.pi\agent\skills\shared-project-memory\check.ps1" -MemoryPath memory`
after plan-publish, build, and verify.

## File roles
- **plan.md** — the contract (what was promised): Restatement, Acceptance Criteria,
  Tasks (`verify:` + `footprint:`), Risk Notes, Loop Budget. Immutable until revised.
- **progress.md** — status (what's done): `- [x] done <date> (verify: <check> — passed)`.
- **decisions.md** — choice + Context/Options/Chosen/Consequences (record rejected options).
- **knowledge.md** — facts + gotchas (note the file each fact refers to; mark unsure `(unverified)`).
- **problems.md** — one problem per entry (Status: Open/Investigating/Fixed).
- **failures.md** — Failure Memory: minimal 3-line lessons (Failure, Prevention Rule, `sig:`), `conf:` 1.

## Non-negotiable rules
- Read before you act; create files if missing; write as you learn; small dated append-mostly entries.
- **Status lives in progress.md only — never append status markers to plan.md task lines.**
- **Revisions are dated deltas, never edited in place**; the latest delta's `### Tasks (current)`
  is authoritative. Never delete history — archive, don't erase.
- The builder reads plan.md + progress.md; knowledge/decisions only when a task touches their domain.
- No entry without a date. Never fabricate memory. Keep entries short.
