// state.mjs — part of the persisted run/gate/rollback state domain extracted from harness-core.mjs (Batch 3 of
// REFACTOR-PLAN.md). Pure logic, identical to the original source.
import { join } from "node:path";
import { readFileSync, existsSync, mkdirSync, writeFileSync, statSync } from "node:fs";
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { DEFAULT_CONFIG } from "./constants.mjs";
import { LONGTERM_DIR } from "./constants.mjs";
import { STATS_FILE } from "./thinking.mjs";
import { gitPorcelain } from "./git.mjs";
import { setFromPorcelain } from "./git.mjs";
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
