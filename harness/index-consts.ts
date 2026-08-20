// index-consts.ts — shared READ-ONLY constants + types extracted from harness/index.ts
// (Batch 5 of REFACTOR-PLAN.md). Single source for live ESM bindings.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CORE_VERSION, autoCommit, verifyTier } from "./core/harness-core.mjs";

// Self-contained anchor: this extension's own directory, wherever pi loaded it
// from (~/.pi/agent/extensions/harness/ as a subdir copy, or extensions/ flat).
// Skill cards and the run protocol resolve relative to HERE first, so the whole
// harness ships in one folder and install = copy that folder into place.
export const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Must match CORE_VERSION in harness-core.mjs. If a /reload served a stale
 * core (node's ESM cache pins .mjs deps — jiti's moduleCache only covers its
 * own transforms), the mismatch catches it and /run explains instead of
 * crashing with a cryptic "X is not a function".
 */
export const EXPECTED_CORE_VERSION = "1.13.1";
export let staleCore = CORE_VERSION !== EXPECTED_CORE_VERSION;

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface RunState {
  task: string;
  cwd: string;
  verifyCmd: string | null;
  verifyLabel: string;
  verifyKind: "script" | "tsc" | "test" | "vet" | "compile" | "syntax" | "custom" | "none";
  verifyCwd: string;
  fullCmd: string | null;
  fullLabel: string | null;
  timeoutMs: number;
  scope: { declared: string[]; strict: boolean };
  budget: {
    maxTurns: number;
    maxConsecutiveFails: number;
    deEscalateAfter: number;
    absMaxTurns: number;
    softBudgetPct: number;
    maxExtensions: number;
    maxCost: number | null; // optional $ ceiling (--budget / maxCost) for the cost soft-warning
    softAsked: boolean;
    pendingEstimate: number | null;
    estBias: { n: number; bias: number } | null;
  };
  autoCommit: boolean;
  autoCommitResult?: { committed: boolean; count?: number; message?: string; reason?: string; leftover?: string[] };
  settleCap?: boolean; // run was force-finalized by the settle cap, not a real agent_settled
  budgetWarnings?: string[];
  budgetOverage?: boolean; // T2: turns crossed the budget via a text-only tail (no tool calls)
  ladder: { thinkingStart: ThinkingLevel; thinkingEscalated: ThinkingLevel; escalated: boolean };
  // planning.thinkLevel = level during the pre-declare planning phase (--think, else
  // AI prediction, else thinkingStart). planning.editLevel = level after declare
  // (--edit, else thinkingStart). done = scope declared (planning ended).
  planning: { thinkLevel: ThinkingLevel | null; editLevel: ThinkingLevel | null; done: boolean };
  // plan = the model's structured planning artifact (revised-plan A2b).
  // goal = restated user task; anchors = high-level plan body; tasks = priority
  // list with per-task footprint; risky = boundary/risk notes present (drives
  // Gate 2). Captured before scope is declared; surfaced in resume + report.
  plan: {
    goal: string;
    anchors: string;
    tasks: { text: string; footprint: string }[];
    risky: boolean;
    // candidates = the brainstormer's `## Candidate Requirements` (ideation
    // feature), captured before the plan; feeds Gate 1.
    candidates: string[];
    // Gate 1 (ideas review) status: null = not triggered, "pending" = reviewer
    // must challenge the candidates, "passed"/"skipped" = cleared,
    // "rejected" = ideation concluded no viable idea (no build).
    gate1: "pending" | "passed" | "skipped" | "rejected" | null;
    // Gate 2 (plan review) status: null = not triggered, "pending" = reviewer
    // required, "passed" = reviewer approved, "skipped" = user override.
    gate2: "pending" | "passed" | "skipped" | null;
    // progress = execution progress (A4): done/total/remaining/current task,
    // updated from the model's checkbox ticks during development.
    progress: { done: number; total: number; remaining: number; current: string | null };
  };
  // Run lifecycle stage. planning → (harness_declare) → development →
  // (harness_review) → review. Printed so the user sees which stage is active.
  stage: "planning" | "development" | "review";
  // Run phase (ideation feature): "ideate" runs a divergent brainstorm phase
  // (brainstormer card) before filtering (Gate 1) and planning; "implement" is
  // the default pipeline. Set via --phase flag or the `Phase:` marker.
  phase: "ideate" | "implement";
  phaseForced: boolean; // true when the user passed --phase (marker cannot override)
  // persona.domain = task-adaptive domain focus (taxonomy entry). Stage role is
  // fixed (Product Owner / Senior Developer / Reviewer); domain varies per task.
  persona: { domain: string | null };
  // lane = task complexity triage (S/M/L). Resolved once: --lane flag → model
  // "Lane:" marker → classifyLane() heuristic → default M. Gate 1/2 are
  // conditional on L; S/M skip them. laneForced = user mandated via --lane.
  lane: "S" | "M" | "L";
  laneForced: boolean;
  // verifyTier = code-selected review depth (quick | standard | full) from lane
  // + plan footprint + prior pass status (revised-plan A6).
  verifyTier: "quick" | "standard" | "full";
  stats: {
    calls: number;
    tokensIn: number;
    tokensCached: number;
    tokensOut: number;
    gateRuns: number;
    gateFails: number;
    blockedEdits: number;
    consecutiveFails: number;
    consecutivePasses: number;
    turns: number;
    cost: number;
    extensionCount: number;
    warned50: boolean;
    // gateDirty: a bash/event may have changed the tree since the last gate, so
    // the review-gate dedup must not reuse a stale result. Set on any bash, cleared
    // whenever the gate re-verifies. warnedCost50: one-shot cost soft-warning.
    gateDirty: boolean;
    warnedCost50: boolean;
    knownFiles: string[];
    pendingNewFiles?: string[];
    skillCardTokens?: number; // idea #1: operating-discipline card tokens injected this run
    peakTurnCost: number;
    gateCacheHits?: number; // gap #2: cross-run green gates reused from cache
    finalGate?: { ok: boolean };
    finalFull?: { ok: boolean };
  };
  baseline: { ok: boolean; head: string } | null;
  baselineFull: { ok: boolean; head: string } | null;
  // Acceptance closure (v1.13): the model's acceptance statement (verdict +
  // criteria), the task-targeted probe result (acceptCmd), the failure-memory
  // check, and the cross-run trend hint — surfaced in the report; auto-commit
  // is blocked on an "unmet" verdict.
  acceptance: { verdict: "met" | "partial" | "unmet" | null; criteria: { text: string; done: boolean }[] };
  acceptCmd: string | null;
  acceptResult: { ok: boolean; head: string } | null;
  memoryCheck: { ok: boolean; note: string } | null;
  trend: { median: number; n: number; suggestion: number; reason: string } | null;
  estRemaining: number | null;
  commitSubject?: string | null; // commit subject from the model's final summary (auto-commit quality)
  resumeCount: number;
  prevThinking: ThinkingLevel;
  status: "prepared" | "running" | "done" | "stopped";
  startedAt: string;
  endedAt: string | null;
}

export const RUN_DIR = ".harness";
export const RUN_FILE = join(RUN_DIR, "run.json");
export const LAST_RUN_FILE = join(RUN_DIR, "last-run.json");
// Cap for how long /run waits for the agent to settle; a genuinely long task
// past this is finalized anyway (with a warning). Override via env.
export const SETTLE_CAP_MS = Number(process.env.HARNESS_SETTLE_CAP_MS ?? 30 * 60_000);
