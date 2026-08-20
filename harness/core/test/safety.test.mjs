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


test("globToRegExp crosses path segments", () => {
  assert.equal(globToRegExp(".env.*").test(".env.prod"), true);
  assert.equal(globToRegExp(".env.*").test(".env.sub.prod"), true);
  assert.equal(globToRegExp("*.pem").test("key.pem"), true);
  assert.equal(globToRegExp("*.pem").test("src/key.pem"), true);
  assert.equal(globToRegExp("src/**").test("src/a/b.ts"), true);
});

test("isIgnored", () => {
  assert.equal(isIgnored("src/key.pem", ["*.pem"]), true);
  assert.equal(isIgnored("node_modules/x/y.js", ["node_modules"]), true);
  assert.equal(isIgnored("lib/index.js", ["node_modules"]), false);
});

test("scopeAllowed / declareRequired", () => {
  assert.equal(scopeAllowed("a.ts", ["a.ts"], true), true);
  assert.equal(scopeAllowed("b.ts", ["a.ts"], true), false);
  assert.equal(scopeAllowed("b.ts", ["a.ts"], false), true);
  assert.equal(declareRequired([], true), true);
  assert.equal(declareRequired(["a.ts"], true), false);
});

test("bashMutates — mutations vs read-only", () => {
  assert.equal(bashMutates("npm install"), true);
  assert.equal(bashMutates("sed -i s/a/b/ f.ts"), true);
  assert.equal(bashMutates("ls -la"), false);
  assert.equal(bashMutates("sed -n p f.ts"), false);
  // tool-specific read-only flags are not mutations
  assert.equal(bashMutates("node --check harness-core.mjs"), false);
  assert.equal(bashMutates("php -l f.php"), false);
  assert.equal(bashMutates("ruby -c f.rb"), false);
  assert.equal(bashMutates("node --version"), false);
});

test("shq escapes quotes/backslashes", () => {
  assert.equal(shq("a"), '"a"');
  assert.equal(shq('a"b\\c'), '"a\\"b\\\\c"');
});

test("dangerousBash allows safe rm while blocking catastrophic ones", () => {
  // safe
  assert.equal(dangerousBash("rm -rf /tmp"), null);
  assert.equal(dangerousBash("rm -rf ~/build"), null);
  assert.equal(dangerousBash("ls -la"), null);
  assert.equal(dangerousBash("rm -rf ./dist"), null);
  // catastrophic rm (exact root/home target)
  assert.ok(dangerousBash("rm -rf /"));
  assert.ok(dangerousBash("rm -rf ~"));
  assert.ok(dangerousBash("sudo rm -rf /"));
  assert.ok(dangerousBash("rm -fr ~"));
  assert.ok(dangerousBash("rm -rf $HOME"));
  // trailing-slash bypasses must also be blocked (they delete the home dir too)
  assert.ok(dangerousBash("rm -rf $HOME/"));
  assert.ok(dangerousBash("rm -rf ~/"));
  assert.ok(dangerousBash("rm -rf \"/\""));
  assert.ok(dangerousBash("cd /tmp && rm -rf /"));
  assert.ok(dangerousBash("env FOO=1 rm -rf ~"));
  // security bypasses from review: long-form flags and -- separator
  assert.ok(dangerousBash("rm --recursive --force /"));
  assert.ok(dangerousBash("rm -rf -- /"));
  // other destructive patterns
  assert.ok(dangerousBash("mkfs.ext4 /dev/sda1"));
  assert.ok(dangerousBash(":(){ :|:& };:"));
  assert.ok(dangerousBash("echo x > /dev/sda"));
});

test("dangerTier maps patterns to block/confirm/allow", () => {
  const tiers = { "rm -rf /|~|$HOME": "confirm", "mkfs": "allow" };
  assert.equal(dangerTier("rm -rf /", tiers).tier, "confirm");
  assert.equal(dangerTier("mkfs /dev/sda", tiers).tier, "allow");
  assert.equal(dangerTier("rm -rf ~", {}).tier, "block", "default block");
  assert.deepEqual(dangerTier("ls -la", tiers), { tier: null }, "safe command");
  assert.equal(dangerTier("rm -rf ~", tiers).pattern, "rm -rf /|~|$HOME");
});

test("editRequiresGate: doc-only edits skip, code edits gate", () => {
  assert.equal(editRequiresGate(["README.md", "docs/guide.txt"]), false);
  assert.equal(editRequiresGate([]), false);
  assert.equal(editRequiresGate(["src/a.ts"]), true);
  assert.equal(editRequiresGate(["README.md", "src/a.ts"]), true, "any code file gates");
  assert.equal(editRequiresGate(["package.json"]), true, "config files gate");
});
