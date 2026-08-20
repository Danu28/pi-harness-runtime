// harness-core.mjs — pure, dependency-free logic for the pi harness extension.
// No pi imports; unit-testable with plain `node --test`. harness.ts wires this to pi.
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { DEFAULT_CONFIG } from "./constants.mjs";
import { LONGTERM_DIR } from "./constants.mjs";
import { TEMP_DIR } from "./constants.mjs";
import { THINK_LEVELS } from "./constants.mjs";
import { USE_COLOR } from "./constants.mjs";
import { color } from "./constants.mjs";
import { isIgnored } from "./safety.mjs";
import { normalizeRel } from "./safety.mjs";
import { shq } from "./safety.mjs";

// ---- barrel re-exports (Batch 1): moved-out modules -----------------------
export { ACCEPT_VERDICTS } from "./constants.mjs";
export { AI_CAP } from "./constants.mjs";
export { CORE_VERSION } from "./constants.mjs";
export { DEFAULT_CONFIG } from "./constants.mjs";
export { LANES } from "./constants.mjs";
export { LONGTERM_DIR } from "./constants.mjs";
export { PERSONA_TAXONOMY } from "./constants.mjs";
export { PHASE_TAXONOMY } from "./constants.mjs";
export { TEMP_DIR } from "./constants.mjs";
export { THINK_LEVELS } from "./constants.mjs";
export { USE_COLOR } from "./constants.mjs";
export { bashMutates } from "./safety.mjs";
export { color } from "./constants.mjs";
export { dangerTier } from "./safety.mjs";
export { dangerousBash } from "./safety.mjs";
export { declareRequired } from "./safety.mjs";
export { editRequiresGate } from "./safety.mjs";
export { globToRegExp } from "./safety.mjs";
export { insideProject } from "./safety.mjs";
export { isIgnored } from "./safety.mjs";
export { normalizeRel } from "./safety.mjs";
export { parseAcceptance } from "./parse.mjs";
export { parseCandidates } from "./parse.mjs";
export { parseCommitSubject } from "./parse.mjs";
export { parseLanePrediction } from "./parse.mjs";
export { parsePersona } from "./parse.mjs";
export { parsePhasePrediction } from "./parse.mjs";
export { parsePlan } from "./parse.mjs";
export { parsePlanProgress } from "./parse.mjs";
export { parseRemainingEstimate } from "./parse.mjs";
export { parseRunArgs } from "./parse.mjs";
export { parseThinkingPrediction } from "./parse.mjs";
export { scopeAllowed } from "./safety.mjs";
export { shq } from "./safety.mjs";
export { stripAcceptanceBlocks } from "./parse.mjs";
import { gitPorcelain } from "./git.mjs";
import { setFromPorcelain } from "./git.mjs";

// ---- barrel re-exports (Batch 2): moved-out modules -----------------------
export { EDIT_MISS_RE } from "./output.mjs";
export { SCRIPT_NAMES } from "./detect.mjs";
export { autoCommit } from "./git.mjs";
export { buildSnapshot } from "./report.mjs";
export { buildTldr } from "./report.mjs";
export { changedFileHeads } from "./git.mjs";
export { detectVerify } from "./detect.mjs";
export { editMismatchHint } from "./output.mjs";
export { estimateTokens } from "./output.mjs";
export { extractFailures } from "./output.mjs";
export { findFilesByExt } from "./detect.mjs";
export { findProjectJsFiles } from "./detect.mjs";
export { fmt } from "./report.mjs";
export { gateResult } from "./detect.mjs";
export { gitDiff } from "./git.mjs";
export { gitNewFiles } from "./git.mjs";
export { loadScripts } from "./detect.mjs";
export { mismatchedEditIndices } from "./output.mjs";
export { nearestPackageDir } from "./detect.mjs";
export { parseTestFailures } from "./output.mjs";
export { renderTable } from "./report.mjs";
export { repoRoot } from "./detect.mjs";
export { reportColor } from "./report.mjs";
export { reportRows } from "./report.mjs";
export { summarizeToolOutput } from "./output.mjs";
export { tail } from "./output.mjs";
export { testSelector } from "./detect.mjs";
export { tscCommand } from "./detect.mjs";

/**
 * Resolve phase thinking levels, decoupled from task lane (P1 decouple): a
 * task complexity lane must never raise per-turn thinking cost — the reactive
 * fail-ladder is the only edit escalator.
 *
 * Precedence: user flags (forcedThink / forcedEdit) → AI prediction (planning
 * only) → thinkingStart default. `lane` is accepted for call-site symmetry but
 * deliberately IGNORED; regression tests pin this contract.
 */
export function phaseThinking({ forcedThink = null, forcedEdit = null, aiPrediction = null, lane = null, thinkingStart = DEFAULT_CONFIG.thinkingStart } = {}) {
  void lane; // explicit no-op: lane is advisory-only (Gate 2 / tier / report)
  return { plan: forcedThink ?? aiPrediction ?? thinkingStart, edit: forcedEdit ?? thinkingStart };
}

/**
 * True when a planning-phase tasklist should be produced/captured — i.e. the
 * effective planning thinking level is non-trivial (>= medium). Trivial (low)
 * runs skip the tasklist entirely so cheap tasks cost nothing extra.
 */
export function tasklistEnabled(level) {
  return THINK_LEVELS.indexOf(String(level ?? "").toLowerCase()) >= THINK_LEVELS.indexOf("medium");
}

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

export function shouldEscalate(consecutiveFails, max, alreadyEscalated) {
  return !alreadyEscalated && consecutiveFails >= max;
}

export function shouldStop(turns, maxTurns) {
  return turns >= maxTurns;
}

/**
 * Asymmetric budget extension: raise the ceiling only when the run is healthy
 * (no active escalation, no failure streak) AND the model gave a positive
 * remaining-work estimate. Never beyond absMaxTurns.
 */
export function extendBudget(o) {
  const absMax = o.absMaxTurns ?? o.maxTurns * 2;
  if (o.escalated || o.consecutiveFails >= o.maxConsecutiveFails) {
    return { extend: false, reason: "unhealthy (escalation or failure streak)" };
  }
  // Bounds a healthy-but-stuck loop: auto-extension is allowed at most N times,
  // so even a green loop can't run all the way to absMaxTurns.
  if ((o.extensionCount ?? 0) >= (o.maxExtensions ?? 2)) {
    return { extend: false, reason: "max extensions reached" };
  }
  const est = o.pendingEstimate ?? 0;
  if (!(est > 0)) return { extend: false, reason: "no estimate" };
  const newMax = Math.min(o.turns + Math.ceil(est), absMax);
  if (newMax <= o.turns + 1) return { extend: false, reason: "bump too small or at absolute cap" };
  return { extend: true, newMaxTurns: newMax };
}

/** Discount a model estimate by historical bias (positive bias = model under-estimates). */
export function discountEstimate(est, bias) {
  if (!(est > 0) || bias == null) return est;
  return Math.max(1, Math.round(est * (1 + Math.max(0, bias))));
}

/**
 * Clamp/validate budget config so the adaptive budget can't be silently
 * disabled (e.g. maxTurns=1 stops before the soft-ask can happen) and the
 * absolute wall never undercuts maxTurns. Returns normalized values + warnings.
 */
export function normalizeBudget(raw = {}, defaults = DEFAULT_CONFIG) {
  const warnings = [];
  let maxTurns = Number(raw.maxTurns ?? defaults.maxTurns);
  let softBudgetPct = Number(raw.softBudgetPct ?? defaults.softBudgetPct);
  let absMaxTurns = Number(raw.absMaxTurns ?? defaults.absMaxTurns);
  const MIN_TURNS = 3;
  if (maxTurns < MIN_TURNS) {
    warnings.push(`maxTurns ${maxTurns} < ${MIN_TURNS} — auto-adjustment needs a minimum; raised to ${MIN_TURNS}.`);
    maxTurns = MIN_TURNS;
  }
  if (!(softBudgetPct > 0 && softBudgetPct < 1)) {
    warnings.push(`softBudgetPct ${softBudgetPct} out of range (0,1); using ${defaults.softBudgetPct}.`);
    softBudgetPct = defaults.softBudgetPct;
  }
  if (absMaxTurns < maxTurns) {
    warnings.push(`absMaxTurns ${absMaxTurns} < maxTurns ${maxTurns}; raised to ${maxTurns}.`);
    absMaxTurns = maxTurns;
  }
  return { maxTurns, softBudgetPct, absMaxTurns, warnings };
}

const ESTIMATES_FILE = ".harness/estimates.json";
const STATS_FILE = ".harness/stats.json";

/** Rolling estimate-accuracy bias (actual - predicted) from past runs, or null. */
export function loadEstimateBias(cwd) {
  try {
    const recs = JSON.parse(readFileSync(join(cwd, ESTIMATES_FILE), "utf8"))?.records;
    if (!Array.isArray(recs) || recs.length < 2) return null;
    const deltas = recs.map((r) => (r.actual ?? 0) - (r.estimated ?? 0));
    return { n: deltas.length, bias: deltas.reduce((a, b) => a + b, 0) / deltas.length };
  } catch {
    return null;
  }
}

/** Record one run's predicted-vs-actual turns for accuracy tracking. */
export function appendEstimateRecord(cwd, { estimated, actual }) {
  try {
    let recs = [];
    try {
      recs = JSON.parse(readFileSync(join(cwd, ESTIMATES_FILE), "utf8"))?.records ?? [];
    } catch {
      /* fresh file */
    }
    recs.push({ estimated: estimated ?? 0, actual: actual ?? 0 });
    if (recs.length > 50) recs = recs.slice(-50);
    mkdirSync(join(cwd, ".harness"), { recursive: true });
    writeFileSync(join(cwd, ESTIMATES_FILE), JSON.stringify({ records: recs }, null, 2), "utf8");
  } catch {
    /* best-effort */
  }
}

/**
 * Persist one finished run's summary to .harness/stats.json (capped ~200 records).
 * Runs on both done and stopped so the trend records the true terminal status.
 * Best-effort: a write failure is never fatal to the run.
 */
export function appendRunStats(cwd, run) {
  const st = run?.stats ?? {};
  const total = (st.tokensIn ?? 0) + (st.tokensCached ?? 0) + (st.tokensOut ?? 0);
  const rec = {
    ts: Date.now(),
    task: String(run?.task ?? "").slice(0, 80),
    status: run?.status ?? "?",
    calls: st.calls ?? 0,
    cost: st.cost ?? 0,
    cacheHitPct: total > 0 ? Math.round(((st.tokensCached ?? 0) / total) * 100) : 0,
    turns: st.turns ?? 0,
    gateRuns: st.gateRuns ?? 0,
    gateFails: st.gateFails ?? 0,
    stage: run?.stage ?? "?",
    resumed: run?.resumeCount ?? 0,
  };
  try {
    let recs = [];
    try {
      recs = JSON.parse(readFileSync(join(cwd, STATS_FILE), "utf8") ?? "{}")?.records ?? [];
    } catch {
      /* fresh file */
    }
    recs.push(rec);
    if (recs.length > 200) recs = recs.slice(-200);
    mkdirSync(join(cwd, ".harness"), { recursive: true });
    writeFileSync(join(cwd, STATS_FILE), JSON.stringify({ records: recs }, null, 2), "utf8");
  } catch {
    /* best-effort */
  }
}

const PYCACHE_DIR = ".harness/pycache";
const RUN_TMP_FILE = ".harness/run.json.tmp";

/** Ensure the agent-facing artifact dirs exist (called at run start). */
export function ensureArtifactDirs(cwd) {
  for (const rel of [TEMP_DIR, LONGTERM_DIR]) {
    try {
      mkdirSync(join(cwd, rel), { recursive: true });
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Clear the agent temp dir contents (not the dir itself). Longterm is never
 * touched. Used at task completion and by /harness-clean-temp. Best-effort.
 */
export function clearTempDir(cwd) {
  const dir = join(cwd, TEMP_DIR);
  try {
    if (!existsSync(dir)) return 0;
    let removed = 0;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      rmSync(join(dir, e.name), { recursive: true, force: true });
      removed++;
    }
    return removed;
  } catch {
    return 0;
  }
}

/**
 * True when a relative path lives anywhere under `.harness/` (incl. the root).
 * Used as the edit carve-out so the agent can write its memory/longterm files
 * under `.harness/longterm/` without triggering a scope/declare block.
 */
export function isHarnessPath(rel) {
  return rel === ".harness" || rel.startsWith(".harness/");
}

/**
 * True when a relative path is a TOP-LEVEL memory path (memory/ or memory/**).
 * The artifact-filing protocol is STRICT here: memory files (plan, progress,
 * decisions, knowledge, problems, failures) must live under
 * .harness/longterm/memory/ — never a top-level memory/ directory. This is the
 * hard block counterpart to the isHarnessPath carve-out: writes to these paths
 * are refused even when declared, so a mis-filed memory doc can't slip through
 * strict scope.
 */
export function isForbiddenArtifactPath(rel) {
  return rel === "memory" || rel.startsWith("memory/");
}

// ---- Cross-run gate cache (gap #2) --------------------------------------
// Reuse a last-green gate verdict when the git state (HEAD + working-tree
// porcelain set) EXACTLY matches a prior green run. Same commit + same mods ⇒
// the same test result (tests are assumed deterministic, as everywhere else in
// the harness). Only fires when it is provably safe — a dirty mid-run tree
// almost never matches a cached green. Cache lives under .harness/longterm/,
// capped at 20, and never stores a red (a red run invalidates its key).
const GATE_CACHE_FILE = join(LONGTERM_DIR, "gate-cache.json");
const GATE_CACHE_CAP = 20;

/** Current HEAD sha ("" when not a git repo or rev-parse fails). */
export function gitHead(cwd) {
  try {
    return execSync("git rev-parse HEAD", { cwd, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
}

/** Sorted list of changed rel paths from the porcelain set. */
export function changedPaths(cwd) {
  const set = setFromPorcelain(gitPorcelain(cwd));
  return [...set].sort();
}

/** Load the persisted gate cache (newest-first, capped). Never throws. */
export function loadGateCache(cwd) {
  try {
    const recs = JSON.parse(readFileSync(join(cwd, GATE_CACHE_FILE), "utf8") ?? "{}")?.entries;
    if (!Array.isArray(recs)) return { entries: [] };
    return { entries: recs.slice(0, GATE_CACHE_CAP) };
  } catch {
    return { entries: [] };
  }
}

/** Best-effort persist of the gate cache. */
export function saveGateCache(cwd, entries) {
  try {
    mkdirSync(join(cwd, LONGTERM_DIR), { recursive: true });
    writeFileSync(join(cwd, GATE_CACHE_FILE), JSON.stringify({ entries: entries.slice(0, GATE_CACHE_CAP) }, null, 2), "utf8");
  } catch {
    /* best-effort */
  }
}

/** Stable cache key: verifyCmd + HEAD + sorted porcelain set. */
export function gateCacheKey({ verifyCmd, head, porcelain }) {
  const src = `${String(verifyCmd ?? "")}\u0000${String(head ?? "")}\u0000${(Array.isArray(porcelain) ? porcelain : []).join("\u0001")}`;
  return createHash("sha1").update(src).digest("hex");
}

/** A cached GREEN entry for the exact git state, or null (never stale-green). */
export function cachedGreen(cwd, { verifyCmd, head, porcelain }) {
  const key = gateCacheKey({ verifyCmd, head, porcelain });
  const { entries } = loadGateCache(cwd);
  const hit = entries.find((e) => e.key === key && e.ok === true);
  return hit ? { ok: true, cached: true, ts: hit.ts } : null;
}

/** Record a genuinely green gate result for the current git state. */
export function recordGreen(cwd, { verifyCmd, head, porcelain }) {
  const { entries } = loadGateCache(cwd);
  const key = gateCacheKey({ verifyCmd, head, porcelain });
  const next = [
    { key, verifyCmd: String(verifyCmd ?? ""), head: String(head ?? ""), porcelain: Array.isArray(porcelain) ? porcelain : [], ok: true, ts: Date.now() },
    ...entries.filter((e) => e.key !== key),
  ];
  saveGateCache(cwd, next);
  return next.length;
}

/** Drop any cached entry whose key matches (called on a red gate). */
export function invalidateGreen(cwd, { verifyCmd, head, porcelain }) {
  const key = gateCacheKey({ verifyCmd, head, porcelain });
  const { entries } = loadGateCache(cwd);
  const next = entries.filter((e) => e.key !== key);
  if (next.length !== entries.length) saveGateCache(cwd, next);
  return next.length;
}

// ---- Last-green rollback point (gap #3) ----------------------------------
// After a gate failure the model can lose the last known-good state. The newest
// GREEN entry in the persisted gate cache IS the rollback point (reused state,
// no second store). A small separate log records each red gate (head + reason)
// so /harness-fork-green can show when/why the rollback point matters.

/** Newest cached GREEN gate entry → the rollback point, or null. */
export function lastGreen(cwd) {
  const { entries } = loadGateCache(cwd);
  const hit = entries.find((e) => e.ok === true && e.head);
  return hit ? { head: hit.head, verifyCmd: hit.verifyCmd, ts: hit.ts } : null;
}

const GATE_ROLLBACK_FILE = join(LONGTERM_DIR, "gate-rollback.json");
const GATE_ROLLBACK_CAP = 50;

/** Load persisted red-gate rollback records (newest-first, capped). Never throws. */
export function loadGateRollbacks(cwd, max = 20) {
  try {
    const recs = JSON.parse(readFileSync(join(cwd, GATE_ROLLBACK_FILE), "utf8") ?? "{}")?.records;
    if (!Array.isArray(recs)) return [];
    return recs.slice(0, max);
  } catch {
    return [];
  }
}

/** Best-effort persist of a red-gate rollback record (head + reason, cap 50). */
export function recordGateFail(cwd, { head, verifyCmd, reason }) {
  try {
    const rec = {
      head: String(head ?? ""),
      verifyCmd: String(verifyCmd ?? ""),
      reason: String(reason ?? "").slice(0, 300),
      ts: Date.now(),
    };
    const recs = [rec, ...loadGateRollbacks(cwd, GATE_ROLLBACK_CAP)];
    mkdirSync(join(cwd, LONGTERM_DIR), { recursive: true });
    writeFileSync(join(cwd, GATE_ROLLBACK_FILE), JSON.stringify({ records: recs.slice(0, GATE_ROLLBACK_CAP) }, null, 2), "utf8");
    return recs.length;
  } catch {
    return 0;
  }
}

// ---- Auto-triage of gate failures (gap #6) ------------------------------
// Persist recent red-gate outputs (signature store) and classify a new failure
// as KNOWN (matches a prior failure) or NEW, so the model gets a pre-filled
// classification and can apply the remembered fix instead of re-debugging.
const GATE_FAILURES_FILE = join(LONGTERM_DIR, "gate-failures.json");
const GATE_FAILURES_CAP = 50;

/** Load recent red-gate outputs (newest-first, capped). Never throws. */
export function loadGateFailures(cwd, max = 20) {
  try {
    const recs = JSON.parse(readFileSync(join(cwd, GATE_FAILURES_FILE), "utf8") ?? "{}")?.records;
    if (!Array.isArray(recs)) return [];
    return recs.slice(0, max);
  } catch {
    return [];
  }
}

/** Best-effort persist of a red-gate output (dedup by output hash, cap 50). */
export function recordGateFailure(cwd, { output }) {
  try {
    const o = String(output ?? "");
    if (!o.trim()) return 0;
    const hash = createHash("sha1").update(o).digest("hex");
    let recs = loadGateFailures(cwd, GATE_FAILURES_CAP);
    recs = [{ hash, output: o.slice(0, 1500), ts: Date.now() }, ...recs.filter((r) => r.hash !== hash)];
    mkdirSync(join(cwd, LONGTERM_DIR), { recursive: true });
    writeFileSync(join(cwd, GATE_FAILURES_FILE), JSON.stringify({ records: recs.slice(0, GATE_FAILURES_CAP) }, null, 2), "utf8");
    return recs.length;
  } catch {
    return 0;
  }
}

/**
 * Classify a gate failure against prior red-gate outputs. Token-cosine match;
 * score > 0.5 → KNOWN with a matching prior excerpt, else NEW. Pure + testable.
 */
export function failureTriage(output, recents = []) {
  const o = String(output ?? "");
  if (!o.trim()) return { kind: "new" };
  const toks = (s) => new Set(String(s).toLowerCase().split(/[^a-z0-9_.:/-]+/).filter((t) => t.length >= 4));
  const ot = toks(o);
  if (!ot.size) return { kind: "new" };
  let best = null;
  for (const r of Array.isArray(recents) ? recents : []) {
    const rt = toks(r?.output ?? "");
    if (!rt.size) continue;
    let shared = 0;
    for (const t of ot) if (rt.has(t)) shared++;
    const score = shared / Math.sqrt(ot.size * rt.size);
    if (score > 0.5 && (!best || score > best.score)) best = { score, output: String(r?.output ?? "").slice(0, 200) };
  }
  return best ? { kind: "known", match: best.output, score: best.score } : { kind: "new" };
}

/**
 * Remove redundant temp artifacts a /run created that are no longer needed
 * once the task completes. Keeps telemetry + archive (stats.json,
 * estimates.json, last-run.json) and resumable run state (run.json).
 *
 * Removed:
 *  - .harness/pycache/  — Python __pycache__ bytecode dir created by the
 *    py_compile gate (fast tier). Pure build by-product, never read after the
 *    gate runs.
 *  - .harness/run.json.tmp — transient write-buffer from writeRun(); normally
 *    renamed away, but can linger after a crash.
 *
 * Best-effort: a removal failure is never fatal.
 */
export function cleanupRunArtifacts(cwd) {
  for (const rel of [PYCACHE_DIR, RUN_TMP_FILE]) {
    const p = join(cwd, rel);
    try {
      if (existsSync(p)) rmSync(p, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  // Agent temp artifacts: cleared at completion (longterm is preserved).
  clearTempDir(cwd);
}

/** Read the most recent `max` recorded run stats (most recent first). */
/** Read a runtime skill-card file (skillcards/<name>.md). Returns "" if missing. */
export function loadSkillCard(cardDir, name) {
  const safe = String(name ?? "").replace(/[^a-z0-9-]/gi, "");
  if (!safe) return "";
  try {
    return readFileSync(join(cardDir, `${safe}.md`), "utf8");
  } catch {
    return "";
  }
}

// Failure-memory check (v1.13): when a run's gate failed, the harness verifies
// a lesson actually landed in .harness/longterm/memory/failures.md this run —
// advisory (reported, not blocked) so memory discipline is CHECKED, not just
// nudged by prose.
export function checkFailureMemory(cwd, startedAt, gateFails) {
  if (!gateFails) return { ok: true, note: "no gate failures to record" };
  const p = join(cwd, LONGTERM_DIR, "memory", "failures.md");
  try {
    if (!existsSync(p)) return { ok: false, note: "gate failed — no failures.md under .harness/longterm/memory/" };
    const start = new Date(String(startedAt ?? "")).getTime() || 0;
    return statSync(p).mtimeMs >= start
      ? { ok: true, note: "failure lesson recorded this run" }
      : { ok: false, note: "failures.md exists but no lesson was appended this run" };
  } catch {
    return { ok: false, note: "failures.md unreadable" };
  }
}

/**
 * Cross-run budget hint (v1.13): from the persisted run-stats trend, suggest a
 * maxTurns when recent runs cluster near the ceiling (raise) or finish far
 * under it (tighten). Advisory only — the caller decides whether to apply it.
 * Returns null when there is insufficient data or the budget looks right-sized.
 */
export function suggestBudget(records, maxTurns = DEFAULT_CONFIG.maxTurns) {
  const done = (Array.isArray(records) ? records : [])
    .filter((r) => r?.status === "done" || r?.status === "stopped")
    .map((r) => Number(r?.turns))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (done.length < 3) return null;
  const sorted = [...done].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (median > maxTurns * 0.9) {
    return { median, n: done.length, suggestion: Math.ceil(median * 1.25), reason: "recent runs cluster near the turn ceiling" };
  }
  if (median < maxTurns * 0.5) {
    return { median, n: done.length, suggestion: Math.max(5, Math.ceil(median * 1.5)), reason: "recent runs finish well under budget" };
  }
  return null;
}

export function loadRunStats(cwd, max = 12) {
  try {
    const recs = JSON.parse(readFileSync(join(cwd, STATS_FILE), "utf8") ?? "{}")?.records;
    if (!Array.isArray(recs)) return [];
    return recs.slice(-max).reverse();
  } catch {
    return [];
  }
}

/** Build [field, value, meaning] trend rows for renderTable from run stats. */
export function statsRows(records) {
  const rows = [["task", "calls · cost · cache%", "turns · gate · status"]];
  for (const r of records) {
    rows.push([
      (String(r.task ?? "?").slice(0, 20) || "(untitled)"),
      `${r.calls ?? 0} · $${(r.cost ?? 0).toFixed(4)} · ${r.cacheHitPct ?? 0}%`,
      `${r.turns ?? 0} · gate ${r.gateRuns ?? 0}/${r.gateFails ?? 0} · ${r.status ?? "?"}`,
    ]);
  }
  return rows;
}
