// thinking.ts — extracted from harness/index.ts (Batch 5 of REFACTOR-PLAN.md).
// Pure helpers — identical to the original source.
import { phaseThinking } from "../core/harness-core.mjs";
import type { RunState, ThinkingLevel } from "./index-consts.ts";
// Thinking-level policy. The planning phase (before the model declares its edit
// scope) runs at planLevel; once scope is declared, editing runs at editLevel.
// planLevel precedence: user --think → AI prediction (Thinking: marker) →
// thinkingStart. editLevel precedence: user --edit → thinkingStart. Task lane
// is deliberately excluded (P1 decouple): a lane must never raise per-turn
// thinking cost — the reactive fail-ladder is the only edit escalator.
export function planLevel(run: RunState): ThinkingLevel {
  return phaseThinking({ forcedThink: run.planning?.thinkLevel ?? null, thinkingStart: run.ladder.thinkingStart }).plan;
}
export function editLevel(run: RunState): ThinkingLevel {
  return phaseThinking({ forcedEdit: run.planning?.editLevel ?? null, thinkingStart: run.ladder.thinkingStart }).edit;
}
// Level to start (or resume) a run at: planning level until scope is declared,
// editing level once it is.
export function startThinking(run: RunState): ThinkingLevel {
  return !run.planning?.done ? planLevel(run) : editLevel(run);
}

/** Human-readable meaning of a verify tier (revised-plan A6). */
export function tierMeaning(tier: "quick" | "standard" | "full"): string {
  return tier === "quick"
    ? "skip verifier; build-boundary gate is the check"
    : tier === "full"
      ? "tests + review + security + performance audit"
      : "tests + review";
}
