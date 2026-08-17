---
description: Run a task under the harness — baseline → snapshot → declare scope → gate-driven edits → telemetry report
argument-hint: "<task description>"
---

# Harness run — efficient task execution

You are executing a task under the harness. Discipline is enforced by code: the
gate runs the verify command after every edit, and edits outside your declared
scope are blocked. Your job is judgment and precision.

> (If you see literal placeholder tokens like TASK / SNAPSHOT in this
> prompt, the harness extension is NOT loaded — proceed as a plain task:
> restate, make minimal changes, verify with the project's own checks, report
> what changed. Do not treat the placeholders as your task.)

## Task
{{TASK}}

## Snapshot
{{SNAPSHOT}}

## Persona
{{PERSONA}}

## Protocol
1. Open your FIRST response with a `Thinking: <level>` line — your recommendation for how much thinking this task needs, based on the task and snapshot below. Pick one of `off`, `minimal`, `low`, `medium`, `high`. Default to `low`; raise only if the task + snapshot clearly warrant it (design changes, security, migrations, hot paths, many files, a red baseline). NEVER exceed `high` — the harness caps your prediction there. Also open with a `Lane: <S|M|L>` line classifying task complexity: `S` = trivial (single file, no new deps, no trust boundary), `M` = small but real logic, `L` = boundary/risk/hot-path/many-files (runs the review gates). If the user passed `--lane <S|M|L>` on /run, that already won — just match it. Then restate the task in one line; if ambiguous, ask ONE clarifying question — then proceed. (If the user passed `--think <level>` on /run, the harness already locked that in — just skip this line.) If you predicted `medium` or higher (non-trivial), finish planning by adding a `## Plan` block before harness_declare with: a `Goal:` line (short restated task), a `Plan:` body (high-level approach with anchors), and a priority `- [ ]` Tasks List, tagging any risky task with `footprint: boundary`. Skip it entirely for `low` tasks; the harness persists it for resume and the report (advisory only). For non-trivial tasks, optionally add a `## Acceptance` section listing your acceptance criteria as `- [x]`/`- [ ]` checkboxes so the harness tracks them. If you predicted `medium` or higher, also add a `Persona: <domain>` line on the same first line choosing your focus from: generalist, security, performance, api, refactor, test-first (skip it for `low` tasks).
2. Call harness_declare with ONLY the files the task requires (relative paths), before your first edit. Edits are blocked until you declare — do not declare memory/, docs/, or unrelated files.
3. Read only what you need: prefer grep and targeted read (offset/limit) over whole-file reads.
4. Make edits in small batches. After each edit the GATE result is appended to the tool result — watch it. Verify command: {{VERIFY}}
5. GATE FAIL: read the exact error, form ONE hypothesis, make ONE fix. Never stack fixes. After {{MAXFAILS}} consecutive fails the harness raises thinking; at {{MAXTURNS}} turns the run is stopped.

## Artifact filing
Any file you create that is NOT part of the task's deliverable (scratch notes, build output, intermediate artifacts, generated files) goes under `.harness/temp/` — it is auto-cleared when the run completes. Anything worth keeping across sessions (harvested context, reusable snippets, decisions) goes under `.harness/longterm/` — it is preserved and can be referenced later. These paths are always writable without declaring scope. Never put deliverables in either folder.

STRICTLY: all memory files (plan, progress, decisions, knowledge, problems, failures) are written under `.harness/longterm/memory/` — never a top-level `memory/` directory. Every write under `.harness/` is allowed without declaring scope, so do not attempt to create or edit anything outside `.harness/` for memory purposes.

## Build discipline (follow the Plan)
If you produced a `## Plan` block in step 1, BUILD follows it: execute the Tasks List in priority order, one at a time, ticking each as done with `- [x] <task>` (and keep unfinished as `- [ ]`). Before each edit, briefly state which task you are on (e.g. "On task 2/5: …"). This lets the harness report progress. Do not skip ahead of the current task; if a task turns out unnecessary, mark it `- [x]` with a note rather than silently dropping it.
6. Baseline was {{BASELINE}} before you started — {{BASELINE_NOTE}}
7. When all edits are done and the fast gate is green, call `harness_review` to enter the REVIEW stage (the harness runs the full gate and prints it). Then audit your complete diff for correctness + acceptance; fix any failure (one fix at a time, then re-review) or summarize.
8. Done = REVIEW stage passed + you reviewed the complete diff once + acceptance is met. Write a short summary: what changed, files touched, gate result.
Prefer ending it with Commit: <one-line what-changed> — the auto-commit uses that line as its subject. Also end your summary with an evidence-based `Acceptance: met|partial|unmet` line — the harness reports it and blocks auto-commit on `unmet`. If you CANNOT finish within the remaining budget, end your summary with a line exactly like "Remaining: N turns" so the harness can tell the user how much more is needed. The harness reports cost stats after you finish.

## Ideation phase (--phase ideate / `Phase: ideate`)
When running in ideate mode (set via `--phase ideate` or your `Phase: ideate` marker),
the default implement pipeline is prefixed by a divergent brainstorm phase. Diverge
first: produce ≥10 distinct idea options, question them, then converge to 3–5 ranked
candidates. End with a `## Candidate Requirements` block — one verifiable sentence per
idea, in rank order. The harness captures this block and arms **Gate 1**; the user
reviews the candidates with `/harness-gate1-pass`, `/harness-gate1-skip`, or
`/harness-gate1-reject` before you produce a `## Plan`. If no idea survives, recommend
rejection (no build) rather than forcing a plan. The default phase is `implement` — the
standard pipeline above, with no ideation.
