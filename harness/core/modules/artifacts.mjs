// artifacts.mjs — part of the artifact dirs + cleanup domain extracted from harness-core.mjs (Batch 3 of
// REFACTOR-PLAN.md). Pure logic, identical to the original source.
import { join } from "node:path";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { LONGTERM_DIR } from "./constants.mjs";
import { TEMP_DIR } from "./constants.mjs";
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
