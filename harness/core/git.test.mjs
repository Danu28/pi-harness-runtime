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

test("gitNewFiles returns array of porcelain paths", () => {
  const { added, set } = gitNewFiles(CWD, new Set(["harness-core.mjs", "harness.ts"]));
  assert.ok(Array.isArray(added));
  assert.ok(Array.isArray(set));
  // paths must not be shifted by the porcelain leading-space bug
  for (const p of set) assert.ok(!p.startsWith("arness-"), `corrupted path ${p}`);
});

test("changedFileHeads excludes files already shown in the git diff", () => {
  const scanned = [{ rel: "a.ts", content: "1" }, { rel: "b.ts", content: "2" }, { rel: "c.ts", content: "3" }, { rel: "d.ts", content: "4" }];
  const changed = new Set(["a.ts", "b.ts", "c.ts"]);
  const diff = "diff --git a/a.ts b/a.ts\n...\ndiff --git a/c.ts b/c.ts\n...";
  const hot = changedFileHeads(scanned, changed, diff);
  // a.ts and c.ts are diff-covered → excluded; b.ts (changed, not in diff) → included
  assert.deepEqual(hot.map((f) => f.rel), ["b.ts"]);
  // capped at 2 even when many changed files aren't diff-covered
  const hot2 = changedFileHeads(scanned, new Set(["a.ts", "b.ts", "c.ts", "d.ts"]), "");
  assert.equal(hot2.length, 2);
  assert.deepEqual(hot2.map((f) => f.rel), ["a.ts", "b.ts"]);
});
