// stages.mjs — part of the run-stage/skill-card mapping + lane classification domain extracted from harness-core.mjs (Batch 3 of
// REFACTOR-PLAN.md). Pure logic, identical to the original source.
/**
 * Gate 2 condition (revised-plan A3b): the plan-review gate fires only for
 * boundary/risk plans — an L-lane run carrying a risky plan (a `footprint:
 * boundary` task or `## Risk Notes`). Non-boundary M plans skip Gate 2.
 * Returns true when the reviewer must review the plan before build.
 */
export function gate2Required(lane, plan) {
  return lane === "L" && !!(plan && plan.risky);
}

/**
 * Gate 1 condition (ideation feature): the ideas-review gate fires only for an
 * ideate-phase run that has produced candidates. Mirrors gate2Required: the
 * reviewer must challenge the candidates before planning proceeds.
 */
export function gate1Required(phase, plan) {
  return phase === "ideate" && !!(plan && plan.candidates && plan.candidates.length);
}

// Stage → skill-card mapping (revised-plan A7). The injected operating-discipline
// card follows the active stage instead of always being "builder".
const STAGE_CARD = {
  ideation: "brainstormer",
  // Strict first-principles BEFORE building: the run state machine's real
  // pre-development stage is "planning" (its only stages are planning/
  // development/review). Mapping it to first-principles makes the question/delete
  // lens the active operating discipline while requirements are scoped and the
  // plan is drafted, cutting redundant development before any build work starts.
  planning: "first-principles",
  requirements: "first-principles",
  plan: "planner",
  "plan-review": "reviewer",
  development: "builder",
  build: "builder",
  review: "verifier",
  verify: "verifier",
};

/** Skill card name for a run stage, or null when none is mapped. */
export function stageSkillCard(stage) {
  return STAGE_CARD[String(stage ?? "").toLowerCase()] ?? null;
}

// Layered operating-discipline lenses (composed WITH the primary stage card, not
// replacing it). With first-principles now the primary requirements card, the
// reviewer's plan-contract gate rides alongside it as the backup layer, so the
// questioning/delete lens leads while the acceptance structure is retained.
// Only the stage-default path layers; an explicit `skillCard` config stays
// authoritative.
const STAGE_LAYER_CARD = {
  requirements: "reviewer",
};

/** Extra skill-card lens layered onto a stage's primary card, or null. */
export function stageLayerCard(stage) {
  return STAGE_LAYER_CARD[String(stage ?? "").toLowerCase()] ?? null;
}

/**
 * Verify tier selection (revised-plan A6). Returns "quick" | "standard" |
 * "full" based on lane + plan footprint + prior pass-verified status.
 *   - Quick:  S-lane OR all tasks `footprint: none` AND previously pass-verified
 *             (skip the verifier; the build-boundary gate is the quality check).
 *   - Standard: M-lane with no boundary footprint (tests + review).
 *   - Full:   L-lane or any boundary/risk plan (tests + review + security + perf).
 * The boundary/risk footprint is the escape hatch: any `footprint: boundary`
 * task or `## Risk Notes` forces Full, so a mis-laned risky task can't slip
 * through a Quick/Standard tier.
 */
export function verifyTier({ lane, plan, previouslyPassed = false } = {}) {
  const risky = !!(plan && plan.risky);
  if (risky || lane === "L") return "full";
  const boundaryFree = (plan?.tasks?.length ?? 0) === 0 || plan.tasks.every((t) => !t || t.footprint === "none" || t.footprint === "small");
  if ((lane === "S" || boundaryFree) && previouslyPassed) return "quick";
  return "standard";
}

/**
 * Deterministic heuristic lane classifier (fallback when neither --lane nor the
 * model's Lane: marker is present). Reads the task text + snapshot for signals.
 * Returns S / M / L; defaults to M.
 */
export function classifyLane(task, snapshot = "") {
  const text = String(task ?? "").toLowerCase() + "\n" + String(snapshot ?? "").toLowerCase();
  // L: boundary/risk/scale signals — trust/network/auth/DB exposure, hot paths,
  // migrations, many files, or structural scope (design/refactor/extension).
  const L_RE =
    /\b(security|auth|network|database|\bdb\b|migration|trust|hot\s?-?path|boundary|monorepo|many\s+files|refactor|design|extension|pipeline|permission|encrypt|secret|\bapi\b|performance|large|complex)\b|files?:\s*\d{2,}/;
  // S: trivial scope — single-file, read-only, no new deps, no trust boundary.
  const S_RE =
    /\b(typo|rename|explain|check|answer|read-?only|trivial|what is|show me|simple|quick|spelling|comment)\b/;
  if (L_RE.test(text)) return "L";
  if (S_RE.test(text)) return "S";
  return "M";
}

/**
 * Build the "Act as <role> [with a <domain> focus]." framing for a stage.
 * stage: planning | development | review. domain: a taxonomy entry or null.
 */
export function renderPersona(stage, domain) {
  const roles = { planning: "Product Owner", development: "Senior Developer", review: "Reviewer" };
  const role = roles[stage] ?? "Engineer";
  const d = domain && domain !== "generalist" ? domain : null;
  const art = d && /^[aeiou]/.test(d) ? "an" : "a";
  return d ? `Act as a ${role} with ${art} ${d} focus.` : `Act as a ${role}.`;
}
