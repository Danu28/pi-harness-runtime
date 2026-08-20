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


test("stageSkillCard maps run stages to operating-discipline cards", () => {
  assert.equal(stageSkillCard("plan"), "planner");
  // The run machine's real pre-development stage is "planning" — first-principles
  // must fire there so it is genuinely active before any build work.
  assert.equal(stageSkillCard("planning"), "first-principles");
  assert.equal(stageSkillCard("requirements"), "first-principles");
  assert.equal(stageSkillCard("plan-review"), "reviewer");
  assert.equal(stageSkillCard("development"), "builder");
  assert.equal(stageSkillCard("build"), "builder");
  assert.equal(stageSkillCard("review"), "verifier");
  assert.equal(stageSkillCard("verify"), "verifier");
  assert.equal(stageSkillCard("unknown"), null);
  assert.equal(stageSkillCard(""), null);
  assert.equal(stageSkillCard(null), null);
});

test("stageLayerCard layers an extra lens onto requirements only", () => {
  assert.equal(stageLayerCard("requirements"), "reviewer");
  assert.equal(stageLayerCard("ideation"), null);
  assert.equal(stageLayerCard("plan"), null);
  assert.equal(stageLayerCard("plan-review"), null);
  assert.equal(stageLayerCard("development"), null);
  assert.equal(stageLayerCard("build"), null);
  assert.equal(stageLayerCard("review"), null);
  assert.equal(stageLayerCard("verify"), null);
  assert.equal(stageLayerCard("unknown"), null);
  assert.equal(stageLayerCard(null), null);
});

test("every run stage maps to a non-null skill card (no default fallback)", () => {
  const stages = ["ideation", "planning", "requirements", "plan", "plan-review", "development", "build", "review", "verify"];
  for (const s of stages) assert.ok(stageSkillCard(s), `stage "${s}" must map to a card`);
});

test("verifyTier selects quick/standard/full from lane + plan footprint", () => {
  const safe = { risky: false, tasks: [{ text: "a", footprint: "none" }, { text: "b", footprint: "small" }] };
  const boundary = { risky: true, tasks: [{ text: "c", footprint: "boundary" }] };
  // Full: L-lane, or any boundary/risk plan (escape hatch)
  assert.equal(verifyTier({ lane: "L", plan: safe }), "full");
  assert.equal(verifyTier({ lane: "M", plan: boundary }), "full");
  assert.equal(verifyTier({ lane: "S", plan: boundary }), "full");
  // Quick: S-lane or boundary-free plan AND previously pass-verified
  assert.equal(verifyTier({ lane: "S", plan: safe, previouslyPassed: true }), "quick");
  assert.equal(verifyTier({ lane: "M", plan: safe, previouslyPassed: true }), "quick");
  // Standard: otherwise (M-lane, no prior pass)
  assert.equal(verifyTier({ lane: "M", plan: safe }), "standard");
  assert.equal(verifyTier({ lane: "M" }), "standard");
});

test("gate1Required fires only for ideate runs with candidates", () => {
  const withCands = { candidates: ["Users can X."], tasks: [] };
  const emptyCands = { candidates: [], tasks: [] };
  // ideate + candidates → required
  assert.equal(gate1Required("ideate", withCands), true);
  // implement phase → never required
  assert.equal(gate1Required("implement", withCands), false);
  // no candidates → not required
  assert.equal(gate1Required("ideate", emptyCands), false);
  assert.equal(gate1Required("ideate", null), false);
  assert.equal(gate1Required("ideate", undefined), false);
  // blank items are filtered at capture time (parseCandidates), not here — an
  // empty array never triggers the gate
  assert.equal(gate1Required("ideate", { candidates: [], tasks: [] }), false);
});

test("gate2Required fires only for L-lane boundary/risk plans", () => {
  const riskyPlan = { risky: true, tasks: [{ text: "x", footprint: "boundary" }] };
  const safePlan = { risky: false, tasks: [{ text: "y", footprint: "none" }] };
  // L-lane + risky plan → required
  assert.equal(gate2Required("L", riskyPlan), true);
  // L-lane + safe plan → not required
  assert.equal(gate2Required("L", safePlan), false);
  // M-lane even with risky plan → not required (advisory only)
  assert.equal(gate2Required("M", riskyPlan), false);
  assert.equal(gate2Required("S", riskyPlan), false);
  // no plan → not required
  assert.equal(gate2Required("L", null), false);
  assert.equal(gate2Required("L", undefined), false);
});

test("classifyLane heuristically returns S / M / L", () => {
  assert.equal(classifyLane("fix a typo in the readme"), "S");
  assert.equal(classifyLane("explain what this function does"), "S");
  assert.equal(classifyLane("add a trivial comment"), "S");
  assert.equal(classifyLane("migrate the auth service to OAuth2"), "L");
  assert.equal(classifyLane("redesign the network layer for the extension"), "L");
  assert.equal(classifyLane("refactor the permission checks"), "L");
  assert.equal(classifyLane("a modest change with no obvious risk"), "M");
  assert.equal(classifyLane("bump the version number"), "M");
  // snapshot scale signal pushes to L (many files)
  assert.equal(classifyLane("do the thing", "files: 14 files"), "L");
});

test("renderPersona builds stage role + optional domain focus", () => {
  assert.equal(renderPersona("planning", null), "Act as a Product Owner.");
  assert.equal(renderPersona("development", null), "Act as a Senior Developer.");
  assert.equal(renderPersona("review", null), "Act as a Reviewer.");
  assert.equal(renderPersona("planning", "security"), "Act as a Product Owner with a security focus.");
  assert.equal(renderPersona("development", "performance"), "Act as a Senior Developer with a performance focus.");
  assert.equal(renderPersona("review", "api"), "Act as a Reviewer with an api focus.");
  // generalist means no domain suffix
  assert.equal(renderPersona("development", "generalist"), "Act as a Senior Developer.");
});
