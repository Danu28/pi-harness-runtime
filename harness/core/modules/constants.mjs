// constants.mjs — part of the constants domain extracted from harness-core.mjs (Batch 1 of
// REFACTOR-PLAN.md). Pure logic, identical to the original source.

export const CORE_VERSION = "1.13.1";

export const DEFAULT_CONFIG = {
  verifyCmd: null, // override; auto-detected from package.json scripts otherwise
  timeoutMs: 60_000,
  maxTurns: 50,
  maxConsecutiveFails: 2,
  deEscalateAfter: 3, // green gates before thinking drops back to thinkingStart
  absMaxTurns: 60, // absolute wall that health-gated budget extension can never exceed
  softBudgetPct: 0.65, // fraction of maxTurns where the harness asks the model for its remaining-work estimate
  maxExtensions: 2, // max auto-extensions per run — bounds a green-but-stuck loop
  autoCommit: true, // auto-commit scoped changes after a successful run
  // Task-targeted acceptance probe (v1.13): run once at review entry when the
  // model claims the task is done (Acceptance: met|partial). Lazy — never at
  // start — and only when the run's acceptance verdict invites verification.
  acceptCmd: null, // e.g. "npm run verify:accept" — the acceptance command
  // Optional review lens (v1.13): raise thinking for the review stage only, so
  // the diff audit doesn't run at the editing floor. null = keep current level.
  reviewThinking: null, // e.g. "medium" — applied in harness_review
  // Name of a runtime skill-card (skillcards/<name>.md) to append to the protocol
  // as operating discipline. Set to null/false to disable. The harness protocol
  // always governs on conflict.
  skillCard: "builder",
  // Tool-output token budget (idea #4): bash tool results larger than this are
  // summarized (head + tail + error lines) before re-injection into context; the
  // full output is archived under .harness/temp/. pi's own bash tool already
  // tail-truncates at 2000 lines/50KB (~12.5K tokens) — this tightens the
  // re-injected result to a token budget. null/0 disables.
  toolOutputTokens: 3000,
  // Cross-run gate cache (gap #2): reuse a last-green gate verdict when the git
  // state (HEAD + working-tree porcelain set) exactly matches a prior green run.
  cacheGreenGates: true,
  // Selective tests (gap #1): narrow the edit-gate to tests affected by the
  // changed files when the verify command is a recognized runner. Full suite
  // always runs at review. Opt-in — false keeps today's behavior.
  selectiveTests: false,
  // Skip-gate on pure-doc/whitespace edits (gap #8): only changed doc files
  // (.md/.txt/images) → the edit-gate is skipped; review still runs full.
  skipDocGate: true,
  // Warn→confirm tiers (gap #9): harness.json → dangerTiers: {"<pattern>":
  // "block"|"confirm"|"allow"}. Default block keeps today's behavior.
  dangerTiers: {},
  // Monorepo per-package gates (gap #10): when all changed files resolve to one
  // nested package, gate that package's verify instead of the root suite.
  perPackageGate: false,
  // Last-green rollback point (gap #3): on a red gate, record the failing head
  // and coach the newest cached green as a rollback point (`/harness-fork-green`
  // shows it). Off by default — today's behavior stays when unset/false.
  autoFork: false,
  thinkingStart: "low",
  thinkingEscalated: "high",
  strict: true,
  ignore: [
    "node_modules",
    ".git",
    ".harness",
    ".pi",
    "dist",
    "build",
    "coverage",
    ".next",
    ".cache",
    ".venv",
    "venv",
    "__pycache__",
    "target",
    "vendor",
    "bin",
    "obj",
    ".gradle",
    ".tox",
    ".pytest_cache",
    ".mypy_cache",
    ".idea",
    // secrets / generated — keep credential filenames out of the snapshot context
    "auth.json",
    "credentials.json",
    ".env",
    ".env.*",
    ".ssh",
    "*.pem",
    "*.key",
    "*.p12",
    "*.local",
  ],
};

// Valid thinking levels, ordered lowest → highest. Used for flag parsing and
// for capping AI self-assigned levels.
export const THINK_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

// AI (model self-assessment) may never exceed this level. xhigh/max are
// expensive and reserved for manual --think/--edit overrides only.
export const AI_CAP = "high";

/**
 * Parse the structured planning artifact (revised-plan A2a): a `Goal:` line, a
 * `Plan:` body, and a priority Tasks List whose items may carry a `footprint:`
 * risk tag. Returns { goal, plan, tasks: [{ text, footprint }], risky } where
 * risky = any task tagged `footprint: boundary` or a `## Risk Notes` section.
 * All fields best-effort: absent parts default to empty/false.
 */
// Acceptance closure (v1.13): the model states its acceptance criteria during
// planning (`## Acceptance` + `- [x]/- [ ]` lines) and ends the run with an
// evidence-based verdict line `Acceptance: met|partial|unmet`. The harness
// reports it and blocks auto-commit on `unmet`. Parsed, not trusted.
export const ACCEPT_VERDICTS = ["met", "partial", "unmet"];

// Valid persona domain focuses. The stage ROLE (Product Owner / Senior Developer
// / Reviewer) is stage-fixed; this domain adapts per task (auto or --persona).
export const PERSONA_TAXONOMY = ["generalist", "security", "performance", "api", "refactor", "test-first"];

// Task complexity lanes (harness-design Phase 0). Gate 2 is conditional on
// lane: L (boundary/risk) runs the plan-review gate. Lane is ADVISORY — it
// never sets thinking levels (P1 decouple); the fail-ladder is the only edit
// escalator.
export const LANES = ["S", "M", "L"];

// Agent-facing artifact dirs (revised review: reuse the gitignored .harness/
// instead of a new top-level /harness folder). Enforcement is BY DIRECTORY,
// not by model judgment: anything the agent writes under TEMP_DIR is cleared at
// task end; LONGTERM_DIR is preserved and referenceable across runs.
export const TEMP_DIR = ".harness/temp";
export const LONGTERM_DIR = ".harness/longterm";

/** ANSI color helpers — applied only when stdout is a TTY and NO_COLOR is unset (TUI-safe). */
export const USE_COLOR = !!process.stdout.isTTY && !process.env.NO_COLOR;
const ansi = (code) => (s) => (USE_COLOR ? `\x1b[${code}m${s}\x1b[0m` : s);
export const color = {
  green: ansi(32),
  red: ansi(31),
  yellow: ansi(33),
  bold: ansi(1),
};
