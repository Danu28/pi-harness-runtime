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

test("loadSkillCard reads a card and returns empty for missing/unsafe names", () => {
  const dir = makeProject({ "builder.md": "hello" });
  try {
    assert.equal(loadSkillCard(dir, "builder"), "hello");
    assert.equal(loadSkillCard(dir, "missing"), ""); // no card
    assert.equal(loadSkillCard(dir, ""), ""); // empty name
    assert.equal(loadSkillCard(dir, null), ""); // null name
  } finally {
    rmProject(dir);
  }
});

test("gateCacheKey is stable and distinct", () => {
  const a = gateCacheKey({ verifyCmd: "npm test", head: "abc", porcelain: ["a.ts", "b.ts"] });
  assert.equal(a, gateCacheKey({ verifyCmd: "npm test", head: "abc", porcelain: ["a.ts", "b.ts"] }));
  assert.notEqual(a, gateCacheKey({ verifyCmd: "npm test", head: "abc", porcelain: ["b.ts", "a.ts"] }), "porcelain order matters");
  assert.notEqual(a, gateCacheKey({ verifyCmd: "npm test", head: "def", porcelain: ["a.ts", "b.ts"] }), "head matters");
  assert.notEqual(a, gateCacheKey({ verifyCmd: "npm run test", head: "abc", porcelain: ["a.ts", "b.ts"] }), "verifyCmd matters");
});

test("recordGreen then cachedGreen reuses the verdict; changed tree misses", () => {
  const dir = makeProject({});
  try {
    const st = { verifyCmd: "npm test", head: "abc", porcelain: ["src/a.ts"] };
    assert.equal(cachedGreen(dir, st), null, "no cache yet");
    recordGreen(dir, st);
    const hit = cachedGreen(dir, st);
    assert.equal(hit.ok, true);
    assert.equal(hit.cached, true);
    // Changed tree (different porcelain) → miss, never stale-green.
    assert.equal(cachedGreen(dir, { ...st, porcelain: ["src/b.ts"] }), null);
    assert.equal(cachedGreen(dir, { ...st, head: "zzz" }), null);
  } finally {
    rmProject(dir);
  }
});

test("invalidateGreen drops a cached entry", () => {
  const dir = makeProject({});
  try {
    const st = { verifyCmd: "npm test", head: "abc", porcelain: [] };
    recordGreen(dir, st);
    assert.ok(cachedGreen(dir, st));
    invalidateGreen(dir, st);
    assert.equal(cachedGreen(dir, st), null);
  } finally {
    rmProject(dir);
  }
});

test("gate cache is capped and survives reload", () => {
  const dir = makeProject({});
  try {
    for (let i = 0; i < 25; i++) recordGreen(dir, { verifyCmd: `cmd${i}`, head: `h${i}`, porcelain: [] });
    const { entries } = loadGateCache(dir);
    assert.equal(entries.length, 20, "capped at 20");
    assert.equal(entries[0].verifyCmd, "cmd24", "newest first");
  } finally {
    rmProject(dir);
  }
});

test("loadGateCache tolerates a missing/corrupt file", () => {
  const dir = makeProject({});
  try {
    assert.deepEqual(loadGateCache(dir), { entries: [] });
    mkdirSync(join(dir, ".harness/longterm"), { recursive: true });
    writeFileSync(join(dir, ".harness/longterm/gate-cache.json"), "not json", "utf8");
    assert.deepEqual(loadGateCache(dir), { entries: [] });
  } finally {
    rmProject(dir);
  }
});

test("lastGreen returns the newest cached green entry, or null when empty", () => {
  const dir = makeProject({});
  try {
    assert.equal(lastGreen(dir), null, "empty cache → no rollback point");
    recordGreen(dir, { verifyCmd: "npm test", head: "aaa", porcelain: [] });
    recordGreen(dir, { verifyCmd: "npm test", head: "bbb", porcelain: [] });
    const lg = lastGreen(dir);
    assert.equal(lg.head, "bbb", "newest green wins");
    assert.equal(lg.verifyCmd, "npm test");
    assert.ok(typeof lg.ts === "number");
  } finally {
    rmProject(dir);
  }
});

test("recordGateFail persists rollback records, newest-first, capped at 50", () => {
  const dir = makeProject({});
  try {
    for (let i = 0; i < 60; i++) recordGateFail(dir, { head: `h${i}`, verifyCmd: "npm test", reason: `fail ${i}` });
    const recs = loadGateRollbacks(dir, 100);
    assert.equal(recs.length, 50, "capped at 50");
    assert.equal(recs[0].head, "h59", "newest first");
    assert.ok(String(recs[0].reason).includes("fail 59"));
    assert.equal(recs[0].verifyCmd, "npm test");
  } finally {
    rmProject(dir);
  }
});

test("a red-gate rollback record does not disturb the last-green rollback point", () => {
  const dir = makeProject({});
  try {
    recordGreen(dir, { verifyCmd: "npm test", head: "aaa", porcelain: [] });
    recordGateFail(dir, { head: "bbb", verifyCmd: "npm test", reason: "red" });
    assert.equal(lastGreen(dir).head, "aaa", "rollback point unchanged by a red record");
    assert.equal(cachedGreen(dir, { verifyCmd: "npm test", head: "bbb", porcelain: [] }), null, "red is not a green");
  } finally {
    rmProject(dir);
  }
});

test("failureTriage classifies a repeat failure as KNOWN", () => {
  const prior = { output: "FAIL src/a.test.js: 1) parseAcceptance works\nAssertionError: expected 2 to equal 3" };
  const same = "FAIL src/a.test.js: 1) parseAcceptance works\nAssertionError: expected 2 to equal 3";
  const triage = failureTriage(same, [prior]);
  assert.equal(triage.kind, "known");
  assert.ok(triage.score > 0.5);
});

test("failureTriage marks an unrelated failure NEW", () => {
  const prior = { output: "FAIL src/a.test.js: parseAcceptance works" };
  const other = "Cannot read properties of undefined (reading 'map')\nTypeError at src/b.ts:12";
  assert.equal(failureTriage(other, [prior]).kind, "new");
  assert.equal(failureTriage("", [prior]).kind, "new");
  assert.equal(failureTriage("x", []).kind, "new");
});

test("recordGateFailure persists and dedups by hash", () => {
  const dir = makeProject({});
  try {
    recordGateFailure(dir, { output: "boom error at line 1" });
    recordGateFailure(dir, { output: "boom error at line 1" });
    recordGateFailure(dir, { output: "different failure here" });
    const recs = loadGateFailures(dir);
    assert.equal(recs.length, 2);
    assert.ok(recs.some((r) => r.output.includes("boom")));
    recordGateFailure(dir, { output: "  " });
    assert.equal(loadGateFailures(dir).length, 2, "blank output not recorded");
  } finally {
    rmProject(dir);
  }
});

test("gitHead/changedPaths are resilient outside a repo", () => {
  const dir = makeProject({});
  try {
    assert.equal(typeof gitHead(dir), "string");
    assert.ok(Array.isArray(changedPaths(dir)));
  } finally {
    rmProject(dir);
  }
});
