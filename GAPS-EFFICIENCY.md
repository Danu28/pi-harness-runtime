# Gaps this extension can fill — to use PI more efficiently

Each point = a concrete gap the `harness` extension can fill, the efficiency win, and the
pi API it would hook. Ordered by efficiency impact. "Already built" notes keep this honest
vs. what the harness already does.

> Context: the harness already has verify-gate-after-edit, declared scope, turn budget +
> health-gated extension, thinking ladder, cost soft-warning (uses pi's `usage.cost`),
> telemetry report, crash-resume, acceptance markers, failure-memory, dangerous-bash
> blocker, tool-output token budget, skill cards, verify auto-detect, ideation (Gate 1)
> and plan-review (Gate 2) gates. These gaps are what's **not** there yet.

---

## High impact (biggest efficiency wins)

1. **Selective / targeted tests on every edit (test-selection).**
   Today the gate runs the **whole** `verifyCmd` (`npm test`) after every edit. On a
   medium+ repo that suite dominates the run's latency and cost.
   *Fill:* analyze which files changed, map to affected tests (jest/playwright `--testPathPattern`,
   go `-run`, pytest `-k`), gate on the subset; full suite only at review.
   *Hook:* `pi.on("tool_call"/"tool_result")` + `gitDiff()` (already exists) + a changed-files→test mapper.
   *Win:* cuts per-edit gate time/cost by an order of magnitude on big repos.

2. **Cross-run gate caching (reuse last green result).**
   The within-run review-gate dedup (`gateDirty`) is smart, but not persisted across runs.
   Re-running `npm test` on a tree that didn't change since the last green run wastes money.
   *Fill:* cache per-file content-hash → gate verdict in `.harness/longterm/`; on a new run,
   skip the gate when no relevant file changed (or run only the delta tests from #1).
   *Hook:* `gitNewFiles()`/`changedFileHeads()` (exist) + a persistent hash store.
   *Win:* repeat runs over unchanged code pay ~$0 for the gate.

3. **Auto-fork / branch on gate failure (session-tree integration).**
   When a gate fails, the run is linear and the fix happens inline — if it breaks further you
   lose the "last green" point. pi natively supports `/fork` `/clone` `/tree` + `ctx.sessionManager`.
   *Fill:* on a failed gate, auto-create a session branch at the last green state so the user
   can review the broken attempt side-by-side and resume from green.
   *Hook:* `pi.on("tool_call")` on failure + `ctx.sessionManager` + `pi.appendEntry()`.
   *Win:* never lose a known-good state; cheaper rollback, better post-mortems.

4. **Parallel sub-agent / sub-run delegation.**
   Independent subtasks (e.g., "fix API + fix tests + update docs") run serially today.
   *Fill:* spawn bounded parallel harness sub-runs and merge results — the harness protocol
   is already self-contained per run.
   *Hook:* pi's extension API supports launching agents; parallel tool calls (queue-aware).
   *Win:* wall-clock speedup on multi-part tasks; the extension API already supports this
   (sub-agents are a "no" natively, but "build it with extensions" is the intended path).

## Medium impact

5. **Structured test-runner output, not a pass/fail blob.**
   `gateResult()` greps one command's output for failures. No per-test/per-file structure.
   *Fill:* parse runner output (TAP/JUnit) → emit kind-aware "failing test: file:line" rows
   straight into the coach rail (it already surfaces structured failing lines for some kinds).
   *Hook:* `extractFailures()` (exists, extend it) + parse TAP/JUnit.
   *Win:* the model sees *which* test broke and where — faster first fix, fewer gate cycles.

6. **Auto-triage of gate failures → feed failure-memory.**
   Failure-memory exists but relies on the model to self-classify (`known/new/transient`).
   *Fill:* auto-classify by matching the failing output against prior `failures.md` entries
   and the last run; pre-fill the lesson and suggested fix, then let the model confirm.
   *Hook:* `checkFailureMemory()` (exists) + `loadRunStats()`/stats.json.
   *Win:* repeat failures get fixed from memory in one shot instead of being re-debugged.

7. **Unify the tool-output budget with the `context-mode` extension.**
   The harness's `summarizeToolOutput()` and the separately-installed `context-mode`
   (`ctx_execute`/`ctx_search`/`ctx_batch_execute`, BM25/FTS5 indexing) solve the *same*
   problem — "big output floods context" — in two different ways.
   *Fill:* let the harness route large verify/tool output through the knowledge-base indexer
   and surface only recall-by-topic sections (already the pattern in this session).
   *Win:* removes the head/tail-only blind spot; large outputs stay queryable, context stays thin.

## Lower impact / nice-to-have

8. **Skip the gate on non-mutating or pure-doc edits.**
   Today every `edit`/`write` triggers the gate. A comment-only or `README` change re-runs the
   whole suite.
   *Fill:* classify the edit (doc/whitespace/new-file vs. logic) and gate only when code paths
   plausibly change.
   *Hook:* `bashMutates()`/`editMismatchHint()` style classification + `gitDiff()`.
   *Win:* small savings per doc/comment edit; avoids noisy red on cosmetic changes.

9. **Warn→confirm tiers for dangerous actions (not just hard-block).**
   The dangerous-bash matcher hard-blocks. pi ships no permission popups but `ctx.ui.confirm`
   exists.
   *Fill:* configurable `block | confirm | allow` tier per pattern (e.g., `rm -rf ~/build` →
   confirm, `rm -rf /` → block).
   *Hook:* `dangerousBash()` (exists) + `ctx.ui.confirm`.
   *Win:* less friction for legit destructive-in-scope commands; matches pi's "no popups unless
   you build them" ethos.

10. **Monorepo per-package gate selection.**
    `verifyCwd` picks one root; a change in `packages/a` re-runs the whole monorepo suite.
    *Fill:* resolve the nearest package for each changed file and run that package's verify
    (falling back to root on cross-package changes).
    *Hook:* `detectVerify()` (exists, per-cwd) + changed-file → nearest `package.json` walk.
    *Win:* big monorepos gate only the affected package per edit.

11. **Prompt-cache maximization across resume.**
    The protocol already says "keep the prefix stable to cut cost"; make it explicit.
    *Fill:* persist the snapshot/plan/card prefix byte-stable so `/harness-resume` reuses the
    cached prefix instead of re-billing it (pi honors `cacheRead`).
    *Hook:* `message_end` `usage.cacheRead` (already read) → tune prefix layout for cache hits.
    *Win:* lower cost on multi-session/resumed tasks.

---

## Summary (ranked by efficiency win)

| # | Gap | Win |
|---|---|---|
| 1 | Selective tests per edit | Biggest — order-of-magnitude gate cost cut on big repos |
| 2 | Cross-run gate caching | ~$0 gate on unchanged repeat runs |
| 3 | Auto-fork on gate failure | Never lose a last-green state |
| 4 | Parallel sub-runs | Wall-clock speedup on multi-part tasks |
| 5 | Structured test output | Faster first fix, fewer gate cycles |
| 6 | Auto-triage failures → memory | Repeat failures fixed in one shot |
| 7 | Unify with context-mode KB | Large outputs queryable, context thin |
| 8 | Skip gate on doc/whitespace edits | Save cost on cosmetic changes |
| 9 | Warn→confirm tiers | Less friction, safer |
| 10 | Monorepo per-package gates | Gate only the affected package |
| 11 | Prompt-cache across resume | Lower cost on resumed tasks |

**Recommendation:** start with **#1 (selective tests)** and **#2 (cross-run cache)** — both
attack the single most expensive thing the harness does today (re-running the full suite on
every edit) and are the clearest "use PI more efficiently" wins. **#3–#4** are the highest
structural-value adds. The rest are incremental.
