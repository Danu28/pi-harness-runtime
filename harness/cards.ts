// cards.ts — extracted from harness/index.ts (Batch 5 of REFACTOR-PLAN.md).
// Pure helpers — identical to the original source.
import { join } from "node:path";
import { DEFAULT_CONFIG, estimateTokens, loadSkillCard, stageLayerCard, stageSkillCard } from "./core/harness-core.mjs";
import { HERE } from "./index-consts.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
/**
 * Append a runtime skill-card as operating discipline to the protocol. The card
 * gives the model the compact process rules (~300 tok) instead of the full skill
 * (~5000 tok). The harness protocol always governs on conflict. Disable via
 * `skillCard: null` in harness.json. Cards ship inside the extension dir
 * (self-contained); the getAgentDir() mirror path covers legacy flat installs.
 * The verifier card at review-entry/resume is tier-gated (P3-T2): quick-tier
 * runs skip it; standard/full runs get it.
 */
/** Resolve the active operating-discipline card name(s) for a stage (primary +
 *  layered lens). Single source of truth for both prompt injection and the
 *  user-facing notify. An explicit `skillCard` config always wins and suppresses
 *  layering; otherwise the stage's mapped card (or the builder default) is used. */
export function activeCardNames(cfg: Record<string, unknown>, stage?: string): string[] {
  const explicit = cfg.skillCard as string | null | undefined;
  const stageCard = stage ? stageSkillCard(stage) : null;
  const name = explicit ?? stageCard ?? DEFAULT_CONFIG.skillCard;
  const names: string[] = [];
  if (name) names.push(String(name));
  if (!explicit && stage) {
    const layer = stageLayerCard(stage);
    if (layer && layer !== name) names.push(layer);
  }
  return names;
}

export function skillCardNote(cfg: Record<string, unknown>, stage?: string, stats?: { skillCardTokens?: number }): string {
  const load = (n: string) =>
    loadSkillCard(join(HERE, "core", "skillcards"), n) ||
    loadSkillCard(join(getAgentDir(), "extensions", "core", "skillcards"), n);
  const blocks: string[] = [];
  let tokens = 0;
  for (const n of activeCardNames(cfg, stage)) {
    const c = load(n);
    if (c) {
      blocks.push(`## Operating discipline (skill card: ${n})\n${c}`);
      tokens += estimateTokens(c);
    }
  }
  if (!blocks.length) return "";
  // Idea #1 telemetry: count the injected card(s)' tokens (advisory — the report
  // shows how much context the operating-discipline cards cost per run).
  if (stats) stats.skillCardTokens = (stats.skillCardTokens ?? 0) + tokens;
  return `\n\n${blocks.join("\n\n")}\nThe harness protocol above governs — if a card rule conflicts with it, the harness protocol wins.`;
}
