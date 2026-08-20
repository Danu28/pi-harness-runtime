// thinking.mjs — part of the budget/thinking management domain extracted from harness-core.mjs (Batch 3 of
// REFACTOR-PLAN.md). Pure logic, identical to the original source.
import { join } from "node:path";
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { DEFAULT_CONFIG } from "./constants.mjs";
import { THINK_LEVELS } from "./constants.mjs";
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

export { STATS_FILE };
