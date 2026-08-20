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
} from "./harness-core.mjs";
import { CWD, makeProject, rmProject, ALL_PROBES } from "./test-utils.mjs";

test("artifact dirs: ensure + clear temp, keep longterm, path carve-out", () => {
  const dir = makeProject({});
  try {
    ensureArtifactDirs(dir);
    assert.ok(existsSync(join(dir, TEMP_DIR)), "temp dir created");
    assert.ok(existsSync(join(dir, LONGTERM_DIR)), "longterm dir created");
    // file scratch in temp, keep in longterm
    writeFileSync(join(dir, TEMP_DIR, "scratch.txt"), "x");
    mkdirSync(join(dir, TEMP_DIR, "sub"), { recursive: true });
    writeFileSync(join(dir, TEMP_DIR, "sub", "nested.txt"), "y");
    writeFileSync(join(dir, LONGTERM_DIR, "keep.txt"), "z");
    const removed = clearTempDir(dir);
    assert.equal(removed, 2);
    assert.ok(!existsSync(join(dir, TEMP_DIR, "scratch.txt")), "temp cleared");
    assert.ok(!existsSync(join(dir, TEMP_DIR, "sub")), "temp subdir cleared");
    assert.ok(existsSync(join(dir, LONGTERM_DIR, "keep.txt")), "longterm kept");
    // whole-.harness carve-out covers memory + any harness-internal file
    assert.equal(isHarnessPath(".harness/longterm/memory/plan.md"), true);
    assert.equal(isHarnessPath(".harness/temp/x.txt"), true);
    assert.equal(isHarnessPath(".harness/run.json"), true);
    assert.equal(isHarnessPath(".harness"), true);
    assert.equal(isHarnessPath("memory/plan.md"), false); // top-level memory is NOT carved out
    assert.equal(isHarnessPath("src/main.js"), false);
  } finally {
    rmProject(dir);
  }
});

test("isForbiddenArtifactPath — top-level memory is hard-blocked, .harness is not", () => {
  // STRICT rule: never a top-level memory/ directory.
  assert.equal(isForbiddenArtifactPath("memory"), true);
  assert.equal(isForbiddenArtifactPath("memory/plan.md"), true);
  assert.equal(isForbiddenArtifactPath("memory/sub/decisions.md"), true);
  // .harness/ memory is the sanctioned home — never blocked.
  assert.equal(isForbiddenArtifactPath(".harness/longterm/memory/plan.md"), false);
  assert.equal(isForbiddenArtifactPath(".harness/temp/scratch.md"), false);
  // Unrelated / prefix-safe paths pass through.
  assert.equal(isForbiddenArtifactPath("src/main.js"), false);
  assert.equal(isForbiddenArtifactPath("memory-foo/notes.md"), false);
  assert.equal(isForbiddenArtifactPath("memories/x.md"), false);
});

test("cleanupRunArtifacts removes temp artifacts but keeps telemetry + archive", () => {
  const dir = makeProject({});
  try {
    // create the redundant temp artifacts a run leaves behind
    mkdirSync(join(dir, ".harness/pycache/sub"), { recursive: true });
    writeFileSync(join(dir, ".harness/pycache/sub/foo.cpython-312.pyc"), "x");
    writeFileSync(join(dir, ".harness/run.json.tmp"), "stale");
    mkdirSync(join(dir, TEMP_DIR), { recursive: true });
    writeFileSync(join(dir, TEMP_DIR, "scratch.txt"), "x");
    mkdirSync(join(dir, LONGTERM_DIR), { recursive: true });
    writeFileSync(join(dir, LONGTERM_DIR, "keep.txt"), "z");
    // telemetry + archive that must survive
    writeFileSync(join(dir, ".harness/stats.json"), "{}");
    writeFileSync(join(dir, ".harness/estimates.json"), "{}");
    writeFileSync(join(dir, ".harness/last-run.json"), "{}");
    writeFileSync(join(dir, ".harness/run.json"), "{}");

    cleanupRunArtifacts(dir);

    assert.ok(!existsSync(join(dir, ".harness/pycache")), "pycache dir removed");
    assert.ok(!existsSync(join(dir, ".harness/run.json.tmp")), "run.json.tmp removed");
    assert.ok(!existsSync(join(dir, TEMP_DIR, "scratch.txt")), "agent temp cleared");
    assert.ok(existsSync(join(dir, LONGTERM_DIR, "keep.txt")), "agent longterm kept");
    assert.ok(existsSync(join(dir, ".harness/stats.json")), "stats kept");
    assert.ok(existsSync(join(dir, ".harness/estimates.json")), "estimates kept");
    assert.ok(existsSync(join(dir, ".harness/last-run.json")), "last-run kept");
    assert.ok(existsSync(join(dir, ".harness/run.json")), "run.json kept");
  } finally {
    rmProject(dir);
  }
});
