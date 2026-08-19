# Does the `harness` extension close real gaps in pi?

**Question:** Is this extension solving anything pi missed? Are there gaps in pi that
this extension fills — and what gaps remain that this extension *could* still solve?

**Short answer:** **Yes.** Pi deliberately ships a minimal core with no operating
discipline — no plan mode, no permission gates, no to-dos, no verify-after-edit, no run
budget, no run-level telemetry. That is a stated design choice (its "Philosophy": *"aggressively
extensible so it doesn't have to dictate your workflow"*). The harness is precisely the
"build it with extensions" layer pi points to. Below is the evidence for what pi natively
has, what the harness adds on top, and the gaps that remain.

---

## 1. What pi natively provides (the baseline)

From the shipped README + `docs/extensions.md` + `docs/skills.md`:

- **Built-in tools (7):** `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls`. Plus
  allow-listing/deny-listing via `--tools`, `--exclude-tools`, `--no-builtin-tools`.
- **Slash commands:** `/login /logout /model /scoped-models /settings /trust /tree /fork
  /clone /compact /copy /export /import /share`.
- **Extension API** (the raw material): `registerTool`, `registerCommand`, `on(...)`
  events (`tool_call`, `tool_result`, `turn_start`, `message_end`, `agent_settled`, …),
  `setThinkingLevel`, `setActiveTools`, `ctx.ui`, `appendEntry`, `setStatus`, `sendMessage`,
  `sessionManager`.
- **Sessions & compaction:** `/tree` branching, `/fork`, `/clone`, automatic + manual
  compaction, per-message `usage.cost` tracking.
- **Skills / prompt templates / packages / themes:** user-supplied context files.
- **Explicit non-features** (by design): **no plan mode, no to-dos, no permission popups,
  no sub-agents, no verify gate, no run budget.** The docs literally point users to build
  these with extensions.
- **Example extensions only (not built-in behavior):** `protected-paths.ts`, `confirm-destructive.ts`,
  `git-checkpoint.ts`, `auto-commit-on-exit.ts`, `dirty-repo-guard.ts`.

**Conclusion of this section:** pi gives you the *hooks* but ships *zero* operating
discipline. There is a large, deliberate gap between "an agent with 7 tools" and "a
disciplined, gate-enforced autonomous run."

---

## 2. What the `harness` extension adds on top (the gap it fills)

Each row maps to a native gap pi leaves open. Verified in `harness/index.ts` +
`harness/core/harness-core.mjs`.

| Capability | Native pi? | Harness implementation |
|---|---|---|
| **Verify gate after every edit** (run `npm test` etc. and block on failure) | ❌ | `pi.on("tool_result")` runs `gateResult(verifyCmd)` after each `edit`/`write` and mutating `bash`; coach output + structured failure lines |
| **Declared edit scope with hard blocking** | ❌ | `harness_declare` tool; `pi.on("tool_call")` blocks writes outside declared set (`scopeAllowed`/`isIgnored`) |
| **Turn budget + stop-and-summarize** | ❌ | `shouldStop()` on `turn_start`; hard stop with `block:true, terminate:true` at `maxTurns` |
| **Health-gated budget extension** | ❌ | `extendBudget()`; `absMaxTurns` cap; `suggestBudget()` from cross-run history |
| **Thinking ladder** (auto-escalate on ≥2 fails, de-escalate on green) | ❌ | `shouldEscalate()` + `pi.setThinkingLevel()` on consecutive-fail/pass streaks |
| **Cost soft-warning ceiling** | ❌ | `--budget`/`maxCost`; 50% warning via `maxCost` tracking |
| **Run-level telemetry report** (calls / tokens / cost / gate runs+fails) | ❌ (only per-message usage) | `reportRows(run)` → HARNESS REPORT at finish |
| **Crash recovery / resume** | ❌ | `.harness/run.json` persisted; `/harness-resume [N]` restores state, stats, scope |
| **Task lifecycle stages** (planning → development → review) | ❌ | `harness_declare`/`harness_review`; `run.stage` machine |
| **Acceptance markers + auto-commit gating** | ❌ | `## Acceptance` checkboxes, `Acceptance: met|partial|unmet`; `autoCommit()` skips on `unmet` |
| **Failure-memory persistence** (`known/new/transient`) | ❌ | `.harness/longterm/memory/failures.md`; `checkFailureMemory()` advisory |
| **Dangerous-bash blocker** (`rm -rf /` etc.) | ❌ | `dangerousBash()`; token-aware matcher in `pi.on("tool_call")` |
| **Tool-output token budget** (tightens pi's 50KB truncation) | ❌ | `summarizeToolOutput()` (head+tail+errors, archive full under `.harness/temp/`) |
| **Compact skill-card injection** (save ~12k context tokens) | partial (skills exist but full files are heavy) | `compile-skills.mjs` validates ≤500-token cards; injects phase-scoped card |
| **Auto-detect verify command** from `package.json`/lang gates | ❌ | `detectVerify()`; `tsc/pytest/go vet/cargo` probes; degraded-mode fallback |
| **Ideation phase with Gate 1** | ❌ | `--phase ideate`, brainstormer card, `/harness-gate1-pass/skip/reject` |
| **Plan review Gate 2** for boundary (L) runs | ❌ | `gate2Required()` + `/harness-gate2-pass/skip` |

**Bottom line:** every row in that table is a native pi gap. The harness is a coherent
(not one-off) implementation of the "build it with extensions" layer pi's philosophy
deliberately leaves to the user. This is *solving something pi missed* in the strongest
sense: pi shipped the extension surface and no discipline; the harness supplies the
discipline.

---

## 3. Remaining gaps this extension *could* still solve

These are opportunities the current harness does not yet exploit — the "gaps in pi harness
that we can still solve with this extension."

1. **Run/branch integration with pi's session tree.** Runs are linear; pi has `/fork`,
   `/clone`, `/tree`. A harness could auto-fork on a gate failure so the user can keep the
   broken attempt as a branch and resume from the last green state — a natural fit with
   pi's session API + `ctx.sessionManager`.
2. **Sub-agent / parallel delegation.** pi has no sub-agents, but the extension API
   supports spawning and merging work. A harness could parallelize independent tasks
   (e.g., multiple bounded verify loops) instead of a single serial run.
3. **Structured test-runner output, not just a pass/fail command.** `gateResult()` runs a
   single `verifyCmd` and greps for failures. Tapping into per-test runners (or pi's
   `message_end` `usage.cost`) would give per-test/per-file failure detail and reuse pi's
   native cost numbers instead of re-deriving them.
4. **Dedup/overlap with the `context-mode` extension.** The harness's idea #4
   (`summarizeToolOutput`) overlaps in spirit with the separately-installed `context-mode`
   tools (`ctx_execute`, `ctx_search`, `ctx_batch_execute`) that index large outputs into a
   BM25/FTS5 knowledge base. These are two different answers to the same "big output floods
   context" problem — worth unifying or documenting the boundary.
5. **User-confirmation gates on dangerous actions.** pi refuses permission popups but
   supports `ctx.ui.confirm`. The harness hard-blocks dangerous commands; a configurable
   "warn → confirm" tier (rather than blanket block) is possible and closer to pi's ethos.
6. **Multi-project / monorepo-aware gate selection** — partially there via `verifyCwd`,
   but could be per-package (`detectVerify` currently picks one).

---

## 4. Verdict

- **Is this extension solving anything pi missed?** **Yes, substantially.** It is the
  operating-discipline layer pi deliberately omits: gate-verified edits, declared scope,
  run budget, thinking ladder, crash recovery, telemetry, acceptance closure. It is the
  canonical "build it with extensions" answer to pi's own philosophy.
- **Are there gaps this extension can still solve?** **Yes.** The strongest are session-tree
  integration (auto-fork on failure), sub-agent parallelization, structured test output,
  resolving the overlap with `context-mode`, and optional confirm-tiers for dangerous actions.

**Framing note:** this is *not* a gap in pi that pi "forgot" — it is a deliberately
curated gap. pi chose a minimal core and provides the exact extension hooks the harness
uses. The harness is doing precisely what pi's design intends. The remaining opportunities
above are where this extension can keep growing value on top of pi.
