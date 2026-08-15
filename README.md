# harness

A [pi](https://github.com/earendil-works/pi) extension that turns one command — **`/run <task>`** — into a fully autonomous, gate-enforced agent run: baseline check → repo snapshot → declared edit scope → verify gate after every edit → cost/turn telemetry, with crash recovery and resume.

The discipline is enforced in **code**, not prose: the verify command runs after every edit, edits outside the declared scope are blocked, the thinking ladder escalates on repeated gate failures, and the run ends with a report (status, verify kind, turns, calls, cost).

*This repo is the standalone, installable slice of the full `pi-harness` dev environment — see [github.com/Danu28/pi-harness](https://github.com/Danu28/pi-harness) for the complete development workspace (E2E trial runner, docs checkers, fixtures).*

## What's inside (the runtime set)

| File | Role |
|------|------|
| `harness.ts` | The extension: registers `/run`, `/harness-resume`, `/harness-reset`, `/harness-stats`, `/harness-clean-temp`, the `harness_declare`/`harness_review` tools, and the gate/telemetry machinery |
| `core/harness-core.mjs` | All pure logic (scoring, scope checks, budget ladder, snapshot/tldr, auto-commit) — unit-testable without pi |
| `core/skillcards/*.md` | **Runtime skill cards** — compact (~300–500 token) versions of the planner/builder/reviewer/verifier/shared-project-memory skills that the harness injects into the run protocol |
| `core/harness-core.test.mjs` | 54 unit tests for the core (zero deps, `node --test`) |
| `core/compile-skills.mjs` | Card validator — enforces a card exists + token budget, cross-checks against full `SKILL.md` sources when a skills root is present |
| `prompts/run.md` | The `/run` protocol prompt (task/snapshot/persona markers) — read by the harness at runtime |

> **About the skills:** the harness deliberately does **not** need the full `SKILL.md` sources (`~/.pi/agent/skills/*/SKILL.md`). Loading those into every agent context is the "skills fill context" leak; the 5 cards above are what the dev loop actually injects, and `compile-skills.mjs` proves the size reduction (13,244 → 1,898 tokens). Copy only the cards — the full skill pipeline stays a personal-setup concern.

## Install

The harness assumes pi's **mirror layout** — several paths are resolved via `getAgentDir()`, not relative to the extension (skill cards load from `~/.pi/agent/extensions/core/skillcards/`, the protocol from `~/.pi/agent/prompts/run.md`). So the repo is laid out exactly as the files live under the agent dir; copy it in place:

```bash
# 1. the extension (auto-discovered from ~/.pi/agent/extensions/*.ts)
cp harness.ts ~/.pi/agent/extensions/harness.ts

# 2. shared core dir (merges with anything already under extensions/core/)
cp -r core ~/.pi/agent/extensions/          # adds core/harness-core.mjs, core/skillcards/, compile-skills

# 3. the /run protocol prompt (harness has an embedded fallback if skipped)
cp prompts/run.md ~/.pi/agent/prompts/run.md
```

Then reload — `/reload` (or restart pi). On Windows, `~` is `%USERPROFILE%`.

Need it per-project instead? Same files, but under `.pi/extensions/` and `.pi/prompts/` in the project.

## Usage

```text
/run <task description>          run a task under the harness
/run --think <off|minimal|low|medium|high>   force a thinking level
/run --lane <S|M|L>              force a complexity lane
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
| `scope.strict` | Block edits outside the declared set when `true` |

No `harness.json` → the harness scans `package.json` scripts + language-specific gates (tsc, pytest, go vet, cargo check…) and falls back to a `node --check` syntax gate; without any of those it runs in **degraded mode** (clearly labeled).

## Security

- The harness **executes arbitrary `verifyCmd`** from the project's `harness.json` and can **auto-commit** — only run `/run` in projects you trust.
- `.harness/` state and temp artifacts are created in the project dir and cleaned up on completion; `AGENTS.md`/`memory/` guidance is layered on top, not required.

## Development

```bash
npm install    # dev deps: pi types, typescript, @types/node
npm test       # 54 unit tests for core/harness-core.mjs (node --test)
npm run typecheck
node core/compile-skills.mjs   # validate the injected skill cards (token budget + source cross-check)
```

The full dev suite — E2E trial runs (`core/trial-runner.mjs`, `tests/harness/`), doc checkers, fixtures — lives in the [pi-harness](https://github.com/Danu28/pi-harness) repository.

## License

MIT — see [LICENSE](LICENSE).