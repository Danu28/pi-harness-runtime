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
  parsePhasePrediction,
  parseCandidates,
  gate1Required,
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

test("reportRows surfaces leftover even when auto-commit skips", () => {
  const base = {
    stats: { calls: 1, tokensIn: 1, tokensCached: 0, tokensOut: 1, cost: 0, gateRuns: 1, gateFails: 0, blockedEdits: 0, consecutiveFails: 0, consecutivePasses: 0, extensionCount: 0, turns: 2 },
    budget: { maxTurns: 30 },
    status: "done",
    verifyLabel: "node --check",
    baseline: { ok: true },
    scope: { declared: [] },
    autoCommit: true,
  };
  // skipped commit that left uncommitted files must still list them
  const skipped = reportRows({ ...base, autoCommitResult: { committed: false, reason: "no scoped files", leftover: ["content.js", "test/x.js"] } });
  const row = skipped.find((r) => r[0] === "auto-commit");
  assert.equal(row[1], "skipped");
  assert.ok(row[2].includes("2 uncommitted"), row[2]);
  assert.ok(row[2].includes("content.js"), row[2]);
  // a clean skip (no leftovers) shows just the reason
  const clean = reportRows({ ...base, autoCommitResult: { committed: false, reason: "no changed scoped files", leftover: [] } });
  assert.equal(clean.find((r) => r[0] === "auto-commit")[2], "no changed scoped files");
});

test("reportRows surfaces the plan count when a tasklist exists", () => {
  const base = {
    stats: { calls: 1, tokensIn: 1, tokensCached: 0, tokensOut: 1, cost: 0, gateRuns: 1, gateFails: 0, blockedEdits: 0, consecutiveFails: 0, consecutivePasses: 0, extensionCount: 0, turns: 2 },
    budget: { maxTurns: 30 },
    status: "done",
    verifyLabel: "node --check",
    baseline: { ok: true },
    scope: { declared: [] },
  };
  const withPlan = reportRows({ ...base, plan: { tasks: ["a", "b", "c"] } });
  const row = withPlan.find((r) => r[0] === "plan");
  assert.equal(row[1], "3 tasks");
  // no plan → no row
  const noPlan = reportRows(base);
  assert.equal(noPlan.find((r) => r[0] === "plan"), undefined);
});

test("reportRows shows the ideation phase only for ideate runs", () => {
  const base = {
    stats: { calls: 1, tokensIn: 1, tokensCached: 0, tokensOut: 1, cost: 0, gateRuns: 1, gateFails: 0, blockedEdits: 0, consecutiveFails: 0, consecutivePasses: 0, extensionCount: 0, turns: 2 },
    budget: { maxTurns: 30 },
    status: "done",
    verifyLabel: "node --check",
    baseline: { ok: true },
    scope: { declared: [] },
    autoCommit: true,
  };
  // default implement run: no phase row at all
  assert.equal(reportRows(base).some((r) => r[0] === "phase"), false);
  // ideate run with pending gate 1
  const ideate = reportRows({ ...base, phase: "ideate", plan: { candidates: ["Users can X."], gate1: "pending" } });
  const row = ideate.find((r) => r[0] === "phase");
  assert.equal(row[1], "ideate");
  assert.ok(row[2].includes("gate 1 pending"), row[2]);
  // rejected gate 1 → no-build meaning
  const rejected = reportRows({ ...base, phase: "ideate", plan: { candidates: ["Users can X."], gate1: "rejected" } });
  assert.ok(rejected.find((r) => r[0] === "phase")[2].includes("no build"), rejected.find((r) => r[0] === "phase")[2]);
});

test("reportRows shows the lifecycle stages reached", () => {
  const base = {
    stats: { calls: 1, tokensIn: 1, tokensCached: 0, tokensOut: 1, cost: 0, gateRuns: 1, gateFails: 0, blockedEdits: 0, consecutiveFails: 0, consecutivePasses: 0, extensionCount: 0, turns: 2 },
    budget: { maxTurns: 30 },
    status: "done",
    verifyLabel: "node --check",
    baseline: { ok: true },
    scope: { declared: [] },
  };
  const stage = (s) => reportRows({ ...base, stage: s }).find((r) => r[0] === "stages")[1];
  assert.equal(stage("review"), "planning → development → review");
  assert.equal(stage("development"), "planning → development");
  assert.equal(stage("planning"), "planning");
  assert.equal(reportRows({ ...base }).find((r) => r[0] === "stages")[1], "?");
});

test("statsRows renders a scannable trend row per record", () => {
  const rows = statsRows([{ task: "tune hot loop", calls: 8, cost: 0.2, cacheHitPct: 60, turns: 9, gateRuns: 4, gateFails: 0, status: "done" }]);
  assert.equal(rows.length, 2); // header + one record
  const rec = rows[1];
  assert.equal(rec[0], "tune hot loop");
  assert.ok(rec[1].includes("8") && rec[1].includes("0.20") && rec[1].includes("60%"));
  assert.ok(rec[2].includes("9") && rec[2].includes("4/0") && rec[2].includes("done"));
  // empty input → just the header
  assert.equal(statsRows([]).length, 1);
});

test("buildSnapshot ranks task-relevant files first and respects ignore", () => {
  const dir = makeProject({
    "package.json": "{}",
    "src/auth.ts": "export function auth() { return 1; }\n",
    "src/other.ts": "export const x = 1;\n",
    "src/secret.ts": "export const s = 1;\n",
    "node_modules/pkg/index.js": "module.exports = 1;\n",
  });
  try {
    const snap = buildSnapshot(dir, { task: "refactor the auth module", baseline: { ok: true } });
    // auth.ts appears before other.ts (task relevance)
    const authIdx = snap.indexOf("auth.ts");
    const otherIdx = snap.indexOf("other.ts");
    assert.ok(authIdx !== -1 && otherIdx !== -1 && authIdx < otherIdx, "auth.ts should rank before other.ts");
    // node_modules is ignored
    assert.ok(!snap.includes("node_modules"), "ignored dir must be excluded");
  } finally {
    rmProject(dir);
  }
});

test("buildSnapshot inlines changed-file heads when the diff does not cover them", () => {
  const dir = makeProject({ "package.json": "{}", "newfile.ts": "export const fresh = true;" });
  try {
    const snap = buildSnapshot(dir, { task: "add fresh file", baseline: { ok: true } });
    assert.ok(snap.includes("newfile.ts"), "snapshot should list the new file");
  } finally {
    rmProject(dir);
  }
});

test("reportRows classifies a failing full gate via lazy baselineFull (AC6)", () => {
  const base = {
    stats: { calls: 1, tokensIn: 1, tokensCached: 0, tokensOut: 1, cost: 0, gateRuns: 1, gateFails: 0, peakTurnCost: 0, blockedEdits: 0, consecutiveFails: 0, consecutivePasses: 0, extensionCount: 0, turns: 2, finalFull: { ok: false } },
    budget: { maxTurns: 30 },
    status: "done",
    verifyLabel: "node --check",
    baseline: { ok: true },
    fullCmd: "npm test",
    scope: { declared: [] },
  };
  // broke it (baseline full was green before the run)
  const broke = reportRows({ ...base, baselineFull: { ok: true } }).find((r) => r[0] === "full gate");
  assert.equal(broke[1], "FAIL");
  assert.ok(broke[2].includes("fix before shipping"), broke[2]);
  // already red before the run
  const already = reportRows({ ...base, baselineFull: { ok: false } }).find((r) => r[0] === "full gate");
  assert.ok(already[2].includes("already red"), already[2]);
  // passing final gate → "passed at completion"
  const passed = reportRows({ ...base, stats: { ...base.stats, finalFull: { ok: true } } }).find((r) => r[0] === "full gate");
  assert.equal(passed[1], "PASS");
  assert.ok(passed[2].includes("passed at completion"), passed[2]);
});

test("reportRows surfaces peakTurnCost for long runs (AC4)", () => {
  const base = {
    stats: { calls: 1, tokensIn: 1, tokensCached: 0, tokensOut: 1, cost: 0.5, gateRuns: 1, gateFails: 0, peakTurnCost: 0.123, blockedEdits: 0, consecutiveFails: 0, consecutivePasses: 0, extensionCount: 0, turns: 45 },
    budget: { maxTurns: 30 },
    status: "done",
    verifyLabel: "node --check",
    baseline: { ok: true },
    scope: { declared: [] },
  };
  const row = reportRows(base).find((r) => r[0] === "peak turn cost");
  assert.equal(row[1], "$0.1230");
  assert.ok(row[2].includes("most expensive single turn"));
});

test("reportRows surfaces acceptance, probe, memory, trend rows", () => {
  const base = {
    stats: { calls: 1, tokensIn: 1, tokensCached: 0, tokensOut: 1, cost: 0, gateRuns: 1, gateFails: 1, blockedEdits: 0, consecutiveFails: 0, consecutivePasses: 0, extensionCount: 0, turns: 2 },
    budget: { maxTurns: 30 },
    status: "done",
    verifyLabel: "node --check",
    baseline: { ok: true },
    scope: { declared: [] },
    autoCommit: true,
    acceptance: { verdict: "met", criteria: [{ text: "gate green", done: true }, { text: "probe passes", done: true }] },
    acceptResult: { ok: true },
    acceptCmd: "npm run verify:accept",
    memoryCheck: { ok: true, note: "failure lesson recorded this run" },
    trend: { median: 40, n: 4, suggestion: 50, reason: "recent runs cluster near the turn ceiling" },
  };
  const rows = reportRows(base);
  assert.equal(rows.find((r) => r[0] === "acceptance")[1], "met");
  assert.equal(rows.find((r) => r[0] === "criteria")[1], "2/2");
  assert.equal(rows.find((r) => r[0] === "accept probe")[1], "PASS");
  assert.ok(rows.find((r) => r[0] === "accept probe")[2].includes("verify:accept"));
  assert.equal(rows.find((r) => r[0] === "failure memory")[1], "recorded");
  assert.equal(rows.find((r) => r[0] === "trend")[1], "median 40 turns (4 runs)");
});

test("reportRows: no acceptance info → no acceptance rows", () => {
  const base = {
    stats: { calls: 1, tokensIn: 1, tokensCached: 0, tokensOut: 1, cost: 0, gateRuns: 1, gateFails: 0, blockedEdits: 0, consecutiveFails: 0, consecutivePasses: 0, extensionCount: 0, turns: 2 },
    budget: { maxTurns: 30 },
    status: "done",
    verifyLabel: "node --check",
    baseline: { ok: true },
    scope: { declared: [] },
    autoCommit: true,
  };
  const rows = reportRows(base);
  assert.equal(rows.find((r) => r[0] === "acceptance"), undefined);
  assert.equal(rows.find((r) => r[0] === "accept probe"), undefined);
  assert.equal(rows.find((r) => r[0] === "failure memory"), undefined);
  assert.equal(rows.find((r) => r[0] === "trend"), undefined);
});

test("reportRows: unmet acceptance flags the report and the skip reason", () => {
  const base = {
    stats: { calls: 1, tokensIn: 1, tokensCached: 0, tokensOut: 1, cost: 0, gateRuns: 1, gateFails: 0, blockedEdits: 0, consecutiveFails: 0, consecutivePasses: 0, extensionCount: 0, turns: 2 },
    budget: { maxTurns: 30 },
    status: "done",
    verifyLabel: "node --check",
    baseline: { ok: true },
    scope: { declared: [] },
    autoCommit: true,
    acceptance: { verdict: "unmet", criteria: [] },
    autoCommitResult: { committed: false, reason: "acceptance unmet (run reports not-accepted)", leftover: [] },
  };
  const rows = reportRows(base);
  assert.equal(rows.find((r) => r[0] === "acceptance")[2], "model reports acceptance NOT met");
  assert.ok(rows.find((r) => r[0] === "auto-commit")[2].includes("acceptance unmet"));
});
