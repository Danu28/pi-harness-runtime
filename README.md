# harness

A [pi](https://github.com/earendil-works/pi) extension that turns one command — **`/run <task>`** — into a fully autonomous, gate-enforced agent run: baseline check → repo snapshot → declared edit scope → verify gate after every edit → cost/turn telemetry, with crash recovery and resume.

The discipline is enforced in **code**, not prose: the verify command runs after every edit, edits outside the declared scope are blocked, the thinking ladder escalates on repeated gate failures, and the run ends with a report (status, verify kind, turns, calls, cost).

*This repo is the standalone, installable slice of the full `pi-harness` dev environment — see [github.com/Danu28/pi-harness](https://github.com/Danu28/pi-harness) for the complete development workspace (E2E trial runner, docs checkers, fixtures).*

## What's inside (the runtime set)

Everything lives under one self-contained directory, `harness/` — the complete extension as a single drop-in unit (create-pi-extension style: `index.ts` entry + its modules bundled alongside). The root files — `package.json`, `tsconfig.json`, `README.md`, `LICENSE` — are the dev pipeline (tests/typecheck), not part of the installed unit.

| File | Role |
|------|------|
| `harness/index.ts` | The extension entry: registers `/run`, `/harness-resume`, `/harness-reset`, `/harness-stats`, `/harness-clean-temp`, the `harness_declare`/`harness_review` tools, and the gate/telemetry machinery (Plans today rely on the planning/review stages + thinking ladder) |
| `harness/core/harness-core.mjs` | **Barrel entry** to the pure logic — re-exports the full API surface from the 12 cohesion modules below (unit-testable without pi) |
| `harness/core/{constants,safety,parse,output,detect,git,report,thinking,stages,artifacts,state}.mjs` | The pure logic split into focused cohesion modules (scope checks, budget ladder, snapshot/tldr, auto-commit, gate cache, skill-card mapping, …) |
| `harness/core/*.test.mjs` | Per-module unit tests (111 total, zero deps, `node --test harness/core/*.test.mjs`) |
| `harness/core/test-utils.mjs` | Shared test fixtures (`makeProject`/`rmProject`/`ALL_PROBES`/`CWD`) |
| `harness/{index-consts,protocol,thinking,cards,settle,report}.ts` | Shared constants/types + helper logic split out of the entry |
| `harness/core/compile-skills.mjs` | Card validator — enforces a card exists + token budget, cross-checks against full `SKILL.md` sources when a skills root is present |
| `harness/prompts/run.md` | The `/run` protocol prompt (task/snapshot/persona markers) — read by the harness at runtime |

> The historical analysis/planning docs live in [`docs/`](./docs/) — `gaps-efficiency.md`, `harness-analysis.md`, `plan-gaps.md`, `refactor-plan.md`.
| `harness/install.sh` · `harness/install-dev.sh` | Idempotent installers — clone/pull or local-sync the extension into the live agent dir |

> **About the skills — nothing is missing.** The 6 cards in `harness/core/skillcards/` are the full operating discipline: they're what the dev loop injects and `compile-skills.mjs` validates. The injected card is **phase-scoped** — the planner card while planning, builder while building, verifier while verifying, reviewer at plan/review gates (override via `skillCard` in `harness.json`; unmapped stages fall back to the configured default). The long-form `SKILL.md` sources are intentionally not shipped — loading ~1,300–3,800-token templates into every agent context recreates the exact "skills fill context" leak this design removes (14,362 → 2,245 tokens). The harness never reads them at runtime; want them, or your own skills? Drop them in `~/.pi/agent/skills/<name>/SKILL.md` — the validator still passes on machines without that root.

## Install

The harness is **self-contained**: skill cards and the `/run` protocol resolve relative to the extension's own location, so the whole thing ships in one dir. Installing is a single copy — pi auto-discovers the subdirectory entry (`~/.pi/agent/extensions/*/index.ts`):

```bash
cp -r harness ~/.pi/agent/extensions/   # done — that's the whole install
```

Then reload — `/reload` (or restart pi). On Windows, `~` is `%USERPROFILE%`.

The entry (`index.ts`), its core (`core/`), and the protocol (`prompts/run.md`) all travel together inside `harness/`; nothing lands in shared dirs. (Legacy flat-layout installs — entry + `core/` scattered under `extensions/`, protocol under `~/.pi/agent/prompts/` — still work via fallback paths.)

**Prefer a script?** Run `bash ./harness/install.sh` — idempotent: clones/pulls the repo and clean-installs `harness/` into `~/.pi/agent/extensions/harness`, removing stale flat-layout leftovers. Developing without pushing? `bash ./harness/install-dev.sh` syncs your local `harness/` dir the same way (no clone/pull, remote untouched).

Need it per-project instead? Same files, but under `.pi/extensions/` and `.pi/prompts/` in the project.

## Usage

```text
/run <task description>          run a task under the harness
/run --think <off|minimal|low|medium|high>   force a thinking level
/run --lane <S|M|L>              force a complexity lane
/run --budget <$>                cost soft-warning ceiling (50% warning, no hard stop)
/run --phase <ideate|implement>  run a brainstorm-ideation phase before planning (default implement)
/harness-gate1-pass              clear Gate 1 (ideas review): candidates accepted → proceed to plan
/harness-gate1-skip              skip Gate 1 on judgment (user override)
/harness-gate1-reject            reject all candidates — conclude no viable idea, no build
/harness-resume [N]              resume a stopped run (state, stats, scope preserved)
/harness-reset                   clear stale run state after a crash
/harness-stats                   show run statistics
/harness-clean-temp              clear .harness/temp/ artifacts
```

During a run, the harness declares an edit scope (`harness_declare`), runs the verify gate after every edit, escalates thinking after ≥2 consecutive gate fails, and stops at the turn budget with a report ("Remaining: N turns" lets you `/harness-resume [N]`).

### Configuration — `harness.json` (project root)

| Key | Purpose |
|-----|---------|
| `verifyCmd` | Command run after every edit (failure fails the gate) |
| `verifyCwd` | Directory for the verify command (monorepo roots) |
| `verifyKind` | `custom` \| `npm` \| ... — how the gate is labeled |
| `fullCmd` / `fullLabel` | The review-stage gate (tests + audits), defaulted from `verifyCmd` |
| `timeoutMs` | Gate timeout |
| `verifyTier` | `quick` \| `standard` \| `full` — verifier depth |
| `autoCommit` | Commit the run's changes when done |
| `maxCost` | Optional cost ceiling ($); drives the 50% cost soft-warning (same as `--budget`) |
| `acceptCmd` | Task-targeted acceptance probe — run once, lazily, at review entry when the model claims the task done (`Acceptance: met\|partial`) |
| `reviewThinking` | Raise thinking for the review stage only, so the diff audit doesn't run at the editing floor |
| `scope.strict` | Block edits outside the declared set when `true` |

Two cheap correctness/cost refinements are built in:

- **Review-gate dedup** — when no `fullCmd` is configured, the review/final gate runs the
  same command the last edit-gate already ran on the identical tree, so the harness
  reuses that green result instead of re-running the suite. A `bash` event that might
  have changed the tree (even if `bashMutates()` didn't flag it) disables the dedup,
  so it can never report a stale-green review.
- **Failure-memory nudge** — on a gate failure the harness coaches the model to classify
  it (`known`/`new`/`transient`) and persist a lesson under `.harness/longterm/memory/`.
- **Acceptance closure** — the model states its acceptance criteria at planning
  (`## Acceptance` + `- [x]`/`- [ ]` checkboxes) and ends the run with an evidence-based
  `Acceptance: met|partial|unmet` line. The report shows the verdict (and criteria ticks),
  and auto-commit is skipped when the run reports `unmet`. Failure-memory is *checked*, not
  just nudged: a run with gate failures must have a lesson appended to
  `.harness/longterm/memory/failures.md` this run (advisory report row). Gate output is now
  **structured** — kind-aware failing-test/error lines are surfaced ahead of the tail, so the
  model sees the actual failure instead of grepping truncated output. A cross-run **trend hint**
  (median turns over recent runs) is surfaced at run start when the budget looks mis-sized.
- **Tool-output token budget** — bash tool results are summarized to a token budget (head +
  tail + error lines, with the full output archived under `.harness/temp/`) before they're
  re-injected into the next model call, so large command output can't inflate every following
  turn. Configurable via `toolOutputTokens` in `harness.json` (`0`/`null` disables); tightens
  pi's own 50KB bash truncation to a tighter token budget.

### Ideation phase (`--phase ideate`)
For "come up with ideas/features" requests, run `/run --phase ideate <task>` (or the
model self-selects via a `Phase: ideate` marker). A **brainstormer** skill card is
injected and the run diverges first (≥10 ideas) before converging to a `## Candidate
Requirements` block — the deliverable handed to **Gate 1** (ideas review). The user
then clears it with `/harness-gate1-pass` / `/harness-gate1-skip`, or ends the run with
`/harness-gate1-reject` (no viable idea → no build). Only after Gate 1 does the run
proceed to a `## Plan` and the normal pipeline. The default phase is `implement`
(no ideation); creativity comes from the card's divergence prompting, not temperature.

No `harness.json` → the harness scans `package.json` scripts + language-specific gates (tsc, pytest, go vet, cargo check…) and falls back to a `node --check` syntax gate; without any of those it runs in **degraded mode** (clearly labeled).

## Security

- The harness **executes arbitrary `verifyCmd`** from the project's `harness.json` and can **auto-commit** — only run `/run` in projects you trust.
- `.harness/` state and temp artifacts are created in the project dir and cleaned up on completion; `AGENTS.md`/`memory/` guidance is layered on top, not required.

## Development

```bash
npm install    # dev deps: pi types, typescript, @types/node
npm test       # 58 unit tests for harness/core/harness-core.mjs (node --test)
npm run typecheck
node harness/core/compile-skills.mjs   # validate the injected skill cards (token budget + source cross-check)
```

The full dev suite — E2E trial runs (`core/trial-runner.mjs`, `tests/harness/`), doc checkers, fixtures — lives in the [pi-harness](https://github.com/Danu28/pi-harness) repository.

## License

MIT — see [LICENSE](LICENSE).