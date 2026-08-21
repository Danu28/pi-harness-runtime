// Unit tests for the pure harness core. Run: node --test harness-core.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_CONFIG,
  appendRunStats,
  bashMutates,
  buildSnapshot,
  changedFileHeads,
  cleanupRunArtifacts,
  dangerousBash,
  declareRequired,
  detectVerify,
  discountEstimate,
  extendBudget,
  gitNewFiles,
  globToRegExp,
  isIgnored,
  loadRunStats,
  loadSkillCard,
  normalizeBudget,
  parseLanePrediction,
  classifyLane,
  gate2Required,
  parsePlan,
  parseAcceptance,
  stripAcceptanceBlocks,
  extractFailures,
  editMismatchHint,
  EDIT_MISS_RE,
  estimateTokens,
  mismatchedEditIndices,
  checkFailureMemory,
  suggestBudget,
  parsePlanProgress,
  stageSkillCard,
  stageLayerCard,
  summarizeToolOutput,
  verifyTier,
  ensureArtifactDirs,
  clearTempDir,
  isHarnessPath,
  isForbiddenArtifactPath,
  TEMP_DIR,
  LONGTERM_DIR,
  parsePersona,
  parseRunArgs,
  parseThinkingPrediction,
  phaseThinking,
  renderPersona,
  reportRows,
  statsRows,
  tasklistEnabled,
  scopeAllowed,
  shq,
  shouldEscalate,
  shouldStop,
  parseCommitSubject,
  gitHead,
  changedPaths,
  loadGateCache,
  gateCacheKey,
  cachedGreen,
  recordGreen,
  invalidateGreen,
  lastGreen,
  recordGateFail,
  loadGateRollbacks,
  loadGateFailures,
  recordGateFailure,
  failureTriage,
  parseTestFailures,
  testSelector,
  dangerTier,
  editRequiresGate,
  nearestPackageDir,
} from "../harness-core.mjs";
import { CWD, makeProject, rmProject, ALL_PROBES } from "./test-utils.mjs";

test("shouldStop / shouldEscalate", () => {
  assert.equal(shouldStop(30, 30), true);
  assert.equal(shouldStop(29, 30), false);
  assert.equal(shouldEscalate(2, 2, false), true);
  assert.equal(shouldEscalate(2, 2, true), false);
});

test("extendBudget — healthy extension bounded by absMax", () => {
  assert.deepEqual(extendBudget({ turns: 29, maxTurns: 30, absMaxTurns: 60, pendingEstimate: 20, consecutiveFails: 0, maxConsecutiveFails: 2, escalated: false }), { extend: true, newMaxTurns: 49 });
});

test("extendBudget — blocks on escalation / fail streak / no estimate / max extensions", () => {
  assert.equal(extendBudget({ turns: 29, maxTurns: 30, pendingEstimate: 20, consecutiveFails: 0, maxConsecutiveFails: 2, escalated: true }).extend, false);
  assert.equal(extendBudget({ turns: 29, maxTurns: 30, pendingEstimate: 20, consecutiveFails: 2, maxConsecutiveFails: 2, escalated: false }).extend, false);
  assert.equal(extendBudget({ turns: 29, maxTurns: 30, pendingEstimate: null, consecutiveFails: 0, maxConsecutiveFails: 2, escalated: false }).extend, false);
  // a healthy-but-stuck loop can only auto-extend maxExtensions (2) times
  assert.equal(extendBudget({ turns: 29, maxTurns: 30, pendingEstimate: 20, consecutiveFails: 0, maxConsecutiveFails: 2, escalated: false, extensionCount: 2, maxExtensions: 2 }).extend, false);
});

test("discountEstimate", () => {
  assert.equal(discountEstimate(20, 0.5), 30);
  assert.equal(discountEstimate(20, null), 20);
  assert.equal(discountEstimate(20, -0.5), 20); // over-estimates are trusted, never shrunk
});

test("normalizeBudget clamps + warns", () => {
  assert.equal(normalizeBudget({ maxTurns: 1 }, DEFAULT_CONFIG).maxTurns, 3);
  assert.ok(normalizeBudget({ maxTurns: 1 }, DEFAULT_CONFIG).warnings.length > 0);
  assert.equal(normalizeBudget({}, DEFAULT_CONFIG).warnings.length, 0);
  assert.equal(normalizeBudget({ softBudgetPct: 1.5 }, DEFAULT_CONFIG).softBudgetPct, 0.65);
  assert.equal(normalizeBudget({ maxTurns: 40, absMaxTurns: 10 }, DEFAULT_CONFIG).absMaxTurns, 40);
});

test("phaseThinking: lane is advisory — it never raises thinking levels (P1 decouple)", () => {
  // Replaces the laneThinking contract: S/M/L lanes are accepted but ignored;
  // the fail-ladder is the only edit escalator.
  assert.deepEqual(phaseThinking({ lane: "L", thinkingStart: "low" }), { plan: "low", edit: "low" });
  assert.deepEqual(phaseThinking({ lane: "M", thinkingStart: "low" }), { plan: "low", edit: "low" });
  assert.equal(phaseThinking({ lane: "L", forcedEdit: "medium", thinkingStart: "low" }).edit, "medium"); // --edit wins on an L lane
});

test("phaseThinking precedence: forced flag > AI prediction > thinkingStart (planning)", () => {
  assert.equal(phaseThinking({ forcedThink: "high", aiPrediction: "medium", thinkingStart: "low" }).plan, "high");
  assert.equal(phaseThinking({ aiPrediction: "medium", thinkingStart: "low" }).plan, "medium");
  assert.deepEqual(phaseThinking({ thinkingStart: "high" }), { plan: "high", edit: "high" });
});

test("phaseThinking: AI prediction never affects the edit level", () => {
  assert.equal(phaseThinking({ aiPrediction: "high", forcedEdit: null, thinkingStart: "low" }).edit, "low");
  assert.equal(phaseThinking({ aiPrediction: "high", forcedEdit: "medium" }).edit, "medium");
});

test("tasklistEnabled is true only for non-trivial (>= medium) levels", () => {
  assert.equal(tasklistEnabled("low"), false);
  assert.equal(tasklistEnabled("minimal"), false);
  assert.equal(tasklistEnabled("off"), false);
  assert.equal(tasklistEnabled("medium"), true);
  assert.equal(tasklistEnabled("high"), true);
  assert.equal(tasklistEnabled("xhigh"), true);
  assert.equal(tasklistEnabled("max"), true);
  assert.equal(tasklistEnabled(null), false);
  assert.equal(tasklistEnabled(undefined), false);
});

test("appendRunStats + loadRunStats persist and cap records", () => {
  const dir = makeProject({});
  try {
    assert.deepEqual(loadRunStats(dir), []);
    const run = (status) => ({ task: "fix auth", status, stats: { calls: 5, cost: 0.1, tokensIn: 100, tokensCached: 50, tokensOut: 20, turns: 7, gateRuns: 3, gateFails: 1 }, stage: "development", resumeCount: 1 });
    appendRunStats(dir, run("done"));
    appendRunStats(dir, run("stopped"));
    const recs = loadRunStats(dir, 10);
    assert.equal(recs.length, 2);
    // most recent first
    assert.equal(recs[0].status, "stopped");
    assert.equal(recs[0].task, "fix auth");
    assert.equal(recs[1].status, "done");
    // cache-hit % computed from tokens
    assert.equal(recs[1].cacheHitPct, 29); // 50/170
    assert.ok(existsSync(join(dir, ".harness/stats.json")));
  } finally {
    rmProject(dir);
  }
});

test("checkFailureMemory: no failures → nothing to record", () => {
  assert.deepEqual(checkFailureMemory(CWD, new Date().toISOString(), 0), { ok: true, note: "no gate failures to record" });
});

test("checkFailureMemory: missing miss, fresh hit, stale miss", () => {
  const dir = makeProject({});
  try {
    const mem = join(dir, ".harness", "longterm", "memory");
    const p = join(mem, "failures.md");
    const startedAt = new Date().toISOString();
    assert.equal(checkFailureMemory(dir, startedAt, 2).ok, false); // missing
    mkdirSync(mem, { recursive: true });
    writeFileSync(p, "## 2024-01-01\n- lesson\n", "utf8");
    assert.deepEqual(checkFailureMemory(dir, startedAt, 2), { ok: true, note: "failure lesson recorded this run" }); // fresh
    const future = new Date(Date.now() + 60_000).toISOString();
    assert.equal(checkFailureMemory(dir, future, 2).ok, false); // stale
  } finally {
    rmProject(dir);
  }
});

test("suggestBudget: needs 3 finished runs", () => {
  assert.equal(suggestBudget([], 50), null);
  assert.equal(suggestBudget([{ status: "done", turns: 4 }, { status: "done", turns: 5 }], 50), null);
});

test("suggestBudget: raises near the ceiling, tightens well under, silent in band", () => {
  const nearCeiling = [
    { status: "done", turns: 48 },
    { status: "stopped", turns: 50 },
    { status: "done", turns: 46 },
    { status: "done", turns: 49 },
  ];
  const up = suggestBudget(nearCeiling, 50);
  assert.ok(up.suggestion > 50);
  assert.equal(up.n, 4);
  const slack = [
    { status: "done", turns: 6 },
    { status: "done", turns: 8 },
    { status: "done", turns: 10 },
  ];
  const down = suggestBudget(slack, 50);
  assert.ok(down.suggestion < 50);
  assert.ok(down.suggestion >= 5);
  assert.equal(suggestBudget([{ status: "done", turns: 20 }, { status: "done", turns: 30 }, { status: "done", turns: 25 }], 50), null);
});
