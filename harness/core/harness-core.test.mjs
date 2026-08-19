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

const CWD = process.cwd();

/** Make a throwaway project dir with the given files; auto-cleaned by the test. */
function makeProject(files) {
  const dir = mkdtempSync(join(tmpdir(), "harness-test-"));
  for (const [rel, content] of Object.entries(files ?? {})) {
    const p = join(dir, rel);
    mkdirSync(join(dir, rel.split("/").slice(0, -1).join("/")), { recursive: true });
    writeFileSync(p, content, "utf8");
  }
  return dir;
}

function rmProject(dir) {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
}

/** All probes "installed" so no real runtimes spawn during detectVerify tests. */
const ALL_PROBES = (val = true) =>
  Object.fromEntries(["python", "python3", "pytest", "go", "cargo", "mvn", "gradle", "dotnet", "ruby", "bundle", "php"].map((k) => [k, val]));

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

test("gitNewFiles returns array of porcelain paths", () => {
  const { added, set } = gitNewFiles(CWD, new Set(["harness-core.mjs", "harness.ts"]));
  assert.ok(Array.isArray(added));
  assert.ok(Array.isArray(set));
  // paths must not be shifted by the porcelain leading-space bug
  for (const p of set) assert.ok(!p.startsWith("arness-"), `corrupted path ${p}`);
});

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

test("parseRunArgs extracts --think/--edit/--lane and leaves the task", () => {
  assert.deepEqual(parseRunArgs('--think high "refactor the auth module"'), {
    flags: { think: "high", edit: null, persona: null, lane: null, budget: null, phase: null },
    task: "refactor the auth module",
  });
  assert.deepEqual(parseRunArgs("--think medium --edit low add the OAuth flow"), {
    flags: { think: "medium", edit: "low", persona: null, lane: null, budget: null, phase: null },
    task: "add the OAuth flow",
  });
  assert.deepEqual(parseRunArgs("--edit high bump version"), {
    flags: { think: null, edit: "high", persona: null, lane: null, budget: null, phase: null },
    task: "bump version",
  });
  // --lane flag parsed + uppercased
  assert.deepEqual(parseRunArgs("--lane l fix the auth migration"), {
    flags: { think: null, edit: null, persona: null, lane: "L", budget: null, phase: null },
    task: "fix the auth migration",
  });
  assert.deepEqual(parseRunArgs("--lane S bump version"), {
    flags: { think: null, edit: null, persona: null, lane: "S", budget: null, phase: null },
    task: "bump version",
  });
  // no flags → untouched task, null flags
  assert.deepEqual(parseRunArgs("just a normal task"), { flags: { think: null, edit: null, persona: null, lane: null, budget: null, phase: null }, task: "just a normal task" });
  // flags come before or among task words
  assert.deepEqual(parseRunArgs("refactor --think high the module"), {
    flags: { think: "high", edit: null, persona: null, lane: null, budget: null, phase: null },
    task: "refactor the module",
  });
  // --budget flag parsed as a positive number
  assert.deepEqual(parseRunArgs("--budget 2.5 ship the refactor"), {
    flags: { think: null, edit: null, persona: null, lane: null, budget: 2.5, phase: null },
    task: "ship the refactor",
  });
  assert.deepEqual(parseRunArgs("--think low --budget 10 do work"), {
    flags: { think: "low", edit: null, persona: null, lane: null, budget: 10, phase: null },
    task: "do work",
  });
  // --phase flag parsed + lowercased
  assert.deepEqual(parseRunArgs("--phase ideate come up with feature ideas"), {
    flags: { think: null, edit: null, persona: null, lane: null, budget: null, phase: "ideate" },
    task: "come up with feature ideas",
  });
  assert.deepEqual(parseRunArgs("--phase IMPLEMENT fix the bug"), {
    flags: { think: null, edit: null, persona: null, lane: null, budget: null, phase: "implement" },
    task: "fix the bug",
  });
});

test("parseRunArgs drops malformed/invalid flags", () => {
  // unknown level → flag dropped, value stays as a task word
  assert.deepEqual(parseRunArgs("--think turbo do work"), { flags: { think: null, edit: null, persona: null, lane: null, budget: null, phase: null }, task: "turbo do work" });
  // invalid lane → dropped, value stays as task word
  assert.deepEqual(parseRunArgs("--lane XL do work"), { flags: { think: null, edit: null, persona: null, lane: null, budget: null, phase: null }, task: "XL do work" });
  // invalid phase → dropped, value stays as task word
  assert.deepEqual(parseRunArgs("--phase brainstorm do work"), { flags: { think: null, edit: null, persona: null, lane: null, budget: null, phase: null }, task: "brainstorm do work" });
  // non-numeric / non-positive budget → dropped, value stays as task word
  assert.deepEqual(parseRunArgs("--budget abc do work"), { flags: { think: null, edit: null, persona: null, lane: null, budget: null, phase: null }, task: "abc do work" });
  assert.deepEqual(parseRunArgs("--budget 0 do work"), { flags: { think: null, edit: null, persona: null, lane: null, budget: null, phase: null }, task: "0 do work" });
  assert.deepEqual(parseRunArgs("--budget"), { flags: { think: null, edit: null, persona: null, lane: null, budget: null, phase: null }, task: "" });
  // missing value → flag dropped
  assert.deepEqual(parseRunArgs("--think"), { flags: { think: null, edit: null, persona: null, lane: null, budget: null, phase: null }, task: "" });
  assert.deepEqual(parseRunArgs("--phase"), { flags: { think: null, edit: null, persona: null, lane: null, budget: null, phase: null }, task: "" });
  // empty input
  assert.deepEqual(parseRunArgs(""), { flags: { think: null, edit: null, persona: null, lane: null, budget: null, phase: null }, task: "" });
  assert.deepEqual(parseRunArgs(null), { flags: { think: null, edit: null, persona: null, lane: null, budget: null, phase: null }, task: "" });
});

test("parseLanePrediction validates the Lane marker", () => {
  assert.equal(parseLanePrediction("Lane: L"), "L");
  assert.equal(parseLanePrediction("Lane: s\nRestate task here"), "S");
  assert.equal(parseLanePrediction("lane = M"), null); // wrong syntax
  assert.equal(parseLanePrediction("Lane: XL"), null); // invalid lane
  assert.equal(parseLanePrediction("no marker"), null); // absent
});

test("parsePhasePrediction validates the Phase marker", () => {
  assert.equal(parsePhasePrediction("Phase: ideate"), "ideate");
  assert.equal(parsePhasePrediction("Phase: IMPLEMENT\nRestate task here"), "implement");
  assert.equal(parsePhasePrediction("phase = ideate"), null); // wrong syntax
  assert.equal(parsePhasePrediction("Phase: brainstorm"), null); // invalid phase
  assert.equal(parsePhasePrediction("no marker"), null); // absent
});

test("parseCandidates extracts a Candidate Requirements block", () => {
  const text = `## Ideas\n...\n## Candidate Requirements\n1. Users can cache gate results by content hash.\n2. Users can cap a run by estimated spend.\n3. Users can classify gate failures as known/new/transient.\n\n## Plan\n...`;
  assert.deepEqual(parseCandidates(text), [
    "Users can cache gate results by content hash.",
    "Users can cap a run by estimated spend.",
    "Users can classify gate failures as known/new/transient.",
  ]);
  // bullet style works too
  assert.deepEqual(parseCandidates(`## Candidate Requirements\n- A\n- B`), ["A", "B"]);
  // no block → empty
  assert.deepEqual(parseCandidates("just a task"), []);
  assert.deepEqual(parseCandidates(""), []);
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

test("harness.ts no longer consults laneThinking for thinking levels (P1 contract)", () => {
  const src = readFileSync(new URL("../index.ts", import.meta.url), "utf8");
  assert.ok(!src.includes("laneThinking"), "lane must not appear in thinking-level code");
});

test("parsePlan extracts goal, plan body, footprint-tagged tasks, risky", () => {
  const p = parsePlan(`Goal: fix the auth bug\nPlan: reorder the middleware first\n\n- [ ] T1 reorder middleware (footprint: boundary)\n- [ ] T2 add a regression test\n\n## Risk Notes\nsome risk`);
  assert.equal(p.goal, "fix the auth bug");
  assert.ok(p.plan.includes("reorder the middleware first"));
  assert.equal(p.tasks.length, 2);
  assert.equal(p.tasks[0].text, "T1 reorder middleware");
  assert.equal(p.tasks[0].footprint, "boundary");
  assert.equal(p.tasks[1].footprint, "none");
  assert.equal(p.risky, true); // boundary task OR Risk Notes

  // no goal/plan → best-effort empties; no boundary → not risky
  const plain = parsePlan("- [ ] just do the thing");
  assert.equal(plain.goal, "");
  assert.equal(plain.tasks.length, 1);
  assert.equal(plain.risky, false);
  assert.equal(parsePlan("").tasks.length, 0);
});

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

// Idea #1 (phase-scoped cards) residual gap: every stage the dev loop actually
// runs must map to a card, so none silently falls back to the builder default.
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

// Idea #4: tool-output token budget — summarizeToolOutput.
test("summarizeToolOutput passes through under budget", () => {
  const r = summarizeToolOutput("hello world", 100);
  assert.equal(r.truncated, false);
  assert.equal(r.text, "hello world");
  assert.equal(r.before, estimateTokens("hello world"));
  assert.equal(r.after, r.before);
});

test("summarizeToolOutput passes through at the exact budget boundary", () => {
  const text = "abcd".repeat(10); // 40 chars = 10 tok
  assert.equal(estimateTokens(text), 10);
  const r = summarizeToolOutput(text, 10);
  assert.equal(r.truncated, false);
  assert.equal(r.text, text);
});

test("summarizeToolOutput truncates over budget keeping head, tail, and error lines", () => {
  const lines = ["L1", "L2", "boom: something failed", ...Array.from({ length: 40 }, (_, i) => `line ${i}`), "END1", "END2"];
  const r = summarizeToolOutput(lines.join("\n"), 10);
  assert.equal(r.truncated, true);
  assert.ok(r.after < r.before, "truncated text must be smaller");
  assert.match(r.text, /L1/); // head kept
  assert.match(r.text, /END2/); // tail kept
  assert.match(r.text, /boom: something failed/); // error line kept
  assert.match(r.text, /\[truncated:/); // marker present
  assert.match(r.text, /\(\d+ lines omitted\)/); // omission noted
});

test("summarizeToolOutput is disabled by budget 0 or null", () => {
  const big = "x\n".repeat(5000);
  assert.equal(summarizeToolOutput(big, 0).truncated, false);
  assert.equal(summarizeToolOutput(big, null).truncated, false);
});

test("summarizeToolOutput marker carries a caller note (isError)", () => {
  const r = summarizeToolOutput("y\n".repeat(100), 5, { note: "isError" });
  assert.match(r.text, /\[truncated:[^\]]*isError/);
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

test("parsePlanProgress computes done/remaining/current from checkbox ticks", () => {
  const prog = parsePlanProgress("- [x] task 1\n- [ ] task 2\n- [x] task 3\n- [ ] task 4");
  assert.equal(prog.done, 2);
  assert.equal(prog.total, 4);
  assert.equal(prog.remaining, 2);
  assert.equal(prog.current, "task 2"); // first open task
  // all done → current null
  const all = parsePlanProgress("- [x] a\n- [x] b");
  assert.equal(all.done, 2);
  assert.equal(all.current, null);
  assert.equal(all.remaining, 0);
  // no checkboxes → zeros
  const none = parsePlanProgress("just prose");
  assert.equal(none.total, 0);
  assert.equal(none.done, 0);
  assert.equal(none.current, null);
  assert.equal(parsePlanProgress("").total, 0);
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

test("parseThinkingPrediction validates and AI-caps the level", () => {
  assert.equal(parseThinkingPrediction("Thinking: high"), "high");
  assert.equal(parseThinkingPrediction("Thinking: medium\nRestate task here"), "medium");
  assert.equal(parseThinkingPrediction("thinking = low"), "low");
  // AI may never exceed high
  assert.equal(parseThinkingPrediction("Thinking: max"), "high");
  assert.equal(parseThinkingPrediction("Thinking: xhigh"), "high");
  // invalid/absent → null
  assert.equal(parseThinkingPrediction("Thinking: turbo"), null);
  assert.equal(parseThinkingPrediction("no marker here"), null);
  assert.equal(parseThinkingPrediction(null), null);
  assert.equal(parseThinkingPrediction(""), null);
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

test("parsePersona validates against the taxonomy", () => {
  assert.equal(parsePersona("Persona: security"), "security");
  assert.equal(parsePersona("Persona: performance\nThinking: high"), "performance");
  assert.equal(parsePersona("persona = test-first"), "test-first");
  // unknown / absent → null
  assert.equal(parsePersona("Persona: wizard"), null);
  assert.equal(parsePersona("no persona here"), null);
  assert.equal(parsePersona(null), null);
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

test("parseRunArgs extracts --persona and validates it", () => {
  assert.deepEqual(parseRunArgs('--persona security "harden the auth module"'), {
    flags: { think: null, edit: null, persona: "security", lane: null, budget: null, phase: null },
    task: "harden the auth module",
  });
  assert.deepEqual(parseRunArgs("--think high --persona performance refactor hot loop"), {
    flags: { think: "high", edit: null, persona: "performance", lane: null, budget: null, phase: null },
    task: "refactor hot loop",
  });
  // invalid persona → flag dropped, value stays as a task word
  assert.deepEqual(parseRunArgs("--persona wizard do work"), { flags: { think: null, edit: null, persona: null, lane: null, budget: null, phase: null }, task: "wizard do work" });
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

// ---- T3: dangerousBash ------------------------------------------------
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

// ---- T5: changedFileHeads (pure dedup) --------------------------------
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

// ---- T1/T2: stats persistence + trend rows ----------------------------
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

// ---- T4: detectVerify via injected probes + fixtures ------------------
test("detectVerify picks a package.json script gate first", () => {
  const dir = makeProject({ "package.json": JSON.stringify({ scripts: { test: "node --test" } }), "index.js": "export const a = 1;" });
  try {
    const g = detectVerify(dir, { probes: ALL_PROBES() });
    assert.ok(g);
    assert.equal(g.kind, "script");
    assert.equal(g.command, "npm run test");
    assert.equal(g.verifyCwd, dir);
  } finally {
    rmProject(dir);
  }
});

test("detectVerify falls back to tsc --noEmit when TS is installed", () => {
  const dir = makeProject({ "tsconfig.json": "{}", "index.ts": "export const a: number = 1;", "node_modules/typescript/bin/tsc": "#!/usr/bin/env node" });
  try {
    const g = detectVerify(dir, { probes: ALL_PROBES() });
    assert.ok(g);
    assert.equal(g.kind, "tsc");
    assert.match(g.command, /tsc --noEmit/);
  } finally {
    rmProject(dir);
  }
});

test("detectVerify detects python with py_compile and pytest full gate", () => {
  const dir = makeProject({ "pyproject.toml": "", "app.py": "def f():\n    return 1\n", "test_app.py": "def test_f():\n    assert f() == 1\n" });
  try {
    const g = detectVerify(dir, { probes: ALL_PROBES() });
    assert.ok(g);
    assert.equal(g.kind, "syntax");
    assert.match(g.command, /py_compile/);
    assert.match(g.fullCommand, /pytest/);
  } finally {
    rmProject(dir);
  }
});

test("detectVerify detects go, java, dotnet, ruby, php manifests", () => {
  const cases = [
    [{ "go.mod": "", "main.go": "package main\n" }, "go", "vet", "go test"],
    [{ "pom.xml": "", "src/main/java/A.java": "class A {}\n" }, "mvn", "compile", "mvn -q test"],
    [{ "App.csproj": "", "Program.cs": "class P {}\n" }, "dotnet", "compile", "dotnet test"],
    [{ "Gemfile": "", "app.rb": "class A\nend\n" }, "ruby", "syntax", "rake test"],
    [{ "composer.json": "", "app.php": "<?php class A {}\n" }, "php", "syntax", "phpunit"],
  ];
  for (const [files, _label, kind, fullLabel] of cases) {
    const dir = makeProject(files);
    try {
      const g = detectVerify(dir, { probes: ALL_PROBES() });
      assert.ok(g, `no gate for ${JSON.stringify(Object.keys(files))}`);
      assert.equal(g.kind, kind);
      if (g.fullCommand) assert.ok(g.fullCommand.includes(fullLabel) || fullLabel.includes(g.fullCommand));
    } finally {
      rmProject(dir);
    }
  }
});

test("detectVerify does upward discovery for monorepo subdirs", () => {
  const dir = makeProject({ "package.json": JSON.stringify({ scripts: { check: "tsc" } }), "src/index.ts": "export const a = 1;" });
  const sub = join(dir, "packages", "svc");
  mkdirSync(sub, { recursive: true });
  try {
    const g = detectVerify(sub, { probes: ALL_PROBES() });
    assert.ok(g);
    assert.equal(g.kind, "script");
    assert.equal(g.verifyCwd, dir); // gate runs at the manifest root
  } finally {
    rmProject(dir);
  }
});

test("detectVerify degrades to syntax fallback, then null", () => {
  const dir = makeProject({ "a.js": "const x = 1;\n", "b.mjs": "export const y = 2;\n" });
  try {
    const g = detectVerify(dir, { probes: ALL_PROBES() });
    assert.ok(g);
    assert.equal(g.kind, "syntax");
    assert.match(g.command, /node --check/);
    // empty project (no scripts, no manifests, no js) → null (degraded)
    const empty = makeProject({ "README.md": "hi" });
    try {
      assert.equal(detectVerify(empty, { probes: ALL_PROBES() }), null);
    } finally {
      rmProject(empty);
    }
  } finally {
    rmProject(dir);
  }
});

// ---- T5: buildSnapshot via a temp fixture -----------------------------
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

test("parseCommitSubject: explicit Commit: marker wins over the summary", () => {
  const text = `## Summary
**Task:** fix the thing
**Done — did the thing.**
Commit: gate the tail edits and ship
Remaining: 2 turns`;
  assert.equal(parseCommitSubject(text), "gate the tail edits and ship");
});

test("parseCommitSubject: summary fallback skips the Task: restate line", () => {
  const text = `## Summary
**Task:** improve commit messages
**Done — subjects now describe what changed.**`;
  assert.equal(parseCommitSubject(text), "Done — subjects now describe what changed.");
});

test("parseCommitSubject: no header falls back to the whole text", () => {
  const text = `Done — committed and pushed.
The tree is clean.`;
  assert.equal(parseCommitSubject(text), "Done — committed and pushed.");
});

test("parseCommitSubject: only Remaining/VERDICT lines yields null", () => {
  assert.equal(parseCommitSubject("Remaining: 5 turns\nVERDICT: Pass"), null);
  assert.equal(parseCommitSubject(""), null);
  assert.equal(parseCommitSubject(undefined), null);
});

test("parseCommitSubject: sanitizes markdown and caps at 72 chars", () => {
  const long = `**Summary**
- \`${'x'.repeat(120)}\` — **bold** bullet line with backticks`;
  const out = parseCommitSubject(long);
  assert.ok(out.length <= 72);
  assert.ok(!out.includes("*"));
  assert.ok(!out.includes("`"));
  assert.ok(!out.startsWith("- "));
});

// ---- Acceptance closure (v1.13) ----------------------------------------
test("parseAcceptance extracts verdict and criteria", () => {
  const text = `## Acceptance
- [x] parseAcceptance exported
- [ ] verdict blocks auto-commit

Acceptance: partial`;
  assert.deepEqual(parseAcceptance(text), {
    verdict: "partial",
    criteria: [
      { text: "parseAcceptance exported", done: true },
      { text: "verdict blocks auto-commit", done: false },
    ],
  });
});

test("parseAcceptance: verdict without criteria, case-insensitive, absent", () => {
  assert.deepEqual(parseAcceptance("Done. ACCEPTANCE: MET"), { verdict: "met", criteria: [] });
  assert.deepEqual(parseAcceptance("no markers here"), { verdict: null, criteria: [] });
  assert.deepEqual(parseAcceptance(undefined), { verdict: null, criteria: [] });
});

test("parseAcceptance: the heading alone is not a verdict", () => {
  const a = parseAcceptance("## Acceptance\n- [x] something");
  assert.equal(a.verdict, null);
  assert.equal(a.criteria.length, 1);
});

test("stripAcceptanceBlocks keeps criteria out of plan tasks and progress", () => {
  const text = `## Plan
Goal: fix auth
- [x] task one

## Acceptance
- [ ] criterion that is NOT a task`;
  assert.equal(parsePlan(text).tasks.length, 1);
  assert.equal(parsePlan(text).tasks[0].text, "task one");
  assert.equal(parsePlanProgress(text).total, 1);
  assert.equal(parsePlanProgress(text).done, 1);
});

// ---- Structured gate output (v1.13) -------------------------------------
test("extractFailures: node --test style", () => {
  const out = `✔ globToRegExp crosses path segments
✖ parseAcceptance works (12ms)
not ok 3 - plan progress counts criteria
ℹ tests 5`;
  const f = extractFailures(out, "test");
  assert.equal(f.length, 2);
  assert.ok(f[0].includes("parseAcceptance works"));
  assert.ok(f[1].includes("plan progress counts criteria"));
});

test("extractFailures: tsc and syntax kinds", () => {
  assert.deepEqual(extractFailures("src/a.ts:3:5 - error TS2304: Cannot find name 'x'", "tsc"), ["src/a.ts:3:5 - error TS2304: Cannot find name 'x'"]);
  assert.deepEqual(extractFailures("SyntaxError: Unexpected token", "syntax"), ["SyntaxError: Unexpected token"]);
});

test("extractFailures: caps at 8, dedupes, skips passing lines", () => {
  const lines = [];
  for (let i = 0; i < 12; i++) lines.push(`error line ${i}`);
  const f = extractFailures(lines.join("\n") + "\nerror line 3", "custom");
  assert.ok(f.length <= 8);
  assert.equal(new Set(f).size, f.length);
  assert.equal(extractFailures("0 errors\nno errors\ntests passed", "custom").length, 0);
});

// ---- Failure-memory check (v1.13) ---------------------------------------
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

// ---- Cross-run budget trend (v1.13) -------------------------------------
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

// ---- Report rows (v1.13) ------------------------------------------------
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

test("editMismatchHint — the classic 12-vs-8 space indent mismatch", () => {
  const file = "line a\n        details: x\n      text: y\n";
  const oldText = "line a\n            details: x\n      text: y\n";
  const h = editMismatchHint(file, oldText);
  assert.ok(h);
  assert.match(h, /indent mismatch/);
  assert.match(h, /8 spaces/);
  assert.match(h, /12 spaces/);
  assert.match(h, /file line 2/);
});

test("editMismatchHint — tab vs spaces on the same slab", () => {
  const h = editMismatchHint("\tconst a = 1;\n", "  const a = 1;\n");
  assert.ok(h);
  assert.match(h, /indent mismatch/);
  assert.match(h, /tab/);
});

test("editMismatchHint — CRLF vs LF line ending", () => {
  const h = editMismatchHint("line1\nline2\r\nline3\n", "line2\n");
  assert.ok(h);
  assert.match(h, /CRLF/);
});

test("editMismatchHint — invisible char diff reports both codepoints", () => {
  const h = editMismatchHint("note — dash here\n", "note - dash here\n");
  assert.ok(h);
  assert.match(h, /U\+2014/);
  assert.match(h, /U\+002D/);
});

test("editMismatchHint — oldText block longer than the file", () => {
  const h = editMismatchHint("a\nb\nc", "a\nb\nC NEW\nc\n");
  assert.ok(h);
  assert.match(h, /4 lines but the file only has 3/);
});

test("editMismatchHint — no near match returns null", () => {
  const h = editMismatchHint("totally different content\n", "zzz none of this exists\n");
  assert.equal(h, null);
});

test("editMismatchHint — byte-equal block returns null (no mismatch to report)", () => {
  const h = editMismatchHint("const a = 1;\nconst b = 2;\n", "const a = 1;\n");
  assert.equal(h, null);
});

test("mismatchedEditIndices — batch stops at the first missing oldText (atomic)", () => {
  const file = "a\nb\nc\n";
  const edits = [
    { oldText: "a\n", newText: "A\n" },
    { oldText: "zz\n", newText: "Z\n" },
    { oldText: "b\n", newText: "B\n" },
  ];
  assert.deepEqual(mismatchedEditIndices(file, edits), [1]);
});

test("mismatchedEditIndices — prior edits apply so a later match can depend on them", () => {
  const edits = [
    { oldText: "a\n", newText: "a\nb\n" },
    { oldText: "b\n", newText: "B\n" },
  ];
  assert.deepEqual(mismatchedEditIndices("a\n", edits), []);
});

test("mismatchedEditIndices — all present returns empty", () => {
  const edits = [
    { oldText: "a\n", newText: "A\n" },
    { oldText: "b\n", newText: "B\n" },
  ];
  assert.deepEqual(mismatchedEditIndices("a\nb\n", edits), []);
});

test("edit-mismatch marker regex catches both edit-tool miss variants", () => {
  assert.ok(EDIT_MISS_RE.test("Could not find edits[3] in harness/index.ts."), "batch edits[N] form");
  assert.ok(EDIT_MISS_RE.test("Could not find the exact text in harness/index.ts."), "single-edit form");
  assert.ok(!EDIT_MISS_RE.test("Successfully replaced 1 block(s) in x."), "success path stays silent");
});

// ---- Cross-run gate cache (gap #2) ---------------------------------------
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

// ---- Last-green rollback point (gap #3) ----------------------------------
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

// ---- Auto-triage of gate failures (gap #6) --------------------------------
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

// ---- Structured test-runner output (gap #5) --------------------------------
test("parseTestFailures extracts TAP rows", () => {
  const rows = parseTestFailures("ok 1 passes\nnot ok 2 - parseAcceptance fails\nnot ok 3 - plan progress miscounts");
  assert.equal(rows.length, 2);
  assert.ok(rows[0].includes("parseAcceptance fails"));
  assert.ok(rows[0].endsWith("(TAP)"));
});

test("parseTestFailures extracts JUnit rows and caps at 8", () => {
  const xml = '<testsuite><testcase name="alpha"><failure/></testcase><testcase name="beta"><failure/></testcase></testsuite>';
  const rows = parseTestFailures(xml);
  assert.equal(rows.length, 2);
  assert.ok(rows[0].includes("alpha"));
  assert.ok(rows[1].includes("beta"));
  const many = "not ok " + Array.from({ length: 20 }, (_, i) => `${i + 1} - t${i}`).join("\nnot ok ");
  assert.ok(parseTestFailures(many).length <= 8);
});

// ---- Selective tests (gap #1) ----------------------------------------------
test("testSelector: unknown runner returns full", () => {
  assert.deepEqual(testSelector("npm run test", ["src/a.ts"]), { type: "full" });
  assert.deepEqual(testSelector("", ["src/a.ts"]), { type: "full" });
  assert.deepEqual(testSelector("jest", []), { type: "full" });
  assert.deepEqual(testSelector("node --test x", []), { type: "full" });
});

test("testSelector: node --test runs changed test files", () => {
  const sel = testSelector("node --test", ["src/a.test.js", "src/b.js"]);
  assert.equal(sel.type, "selective");
  assert.ok(sel.cmd.includes("a.test.js"));
  assert.ok(!sel.cmd.includes("b.js"));
  // No changed test files → full.
  assert.deepEqual(testSelector("node --test", ["src/lib.js"]), { type: "full" });
});

test("testSelector: jest / vitest / pytest / go", () => {
  const j = testSelector("jest", ["src/foo.ts", "src/bar.test.ts"]);
  assert.equal(j.type, "selective");
  assert.ok(j.cmd.includes("--testPathPattern"));
  assert.ok(j.cmd.includes("foo"));
  assert.ok(testSelector("vitest", ["src/x.test.ts"]).cmd.includes("vitest run"));
  const p = testSelector("pytest", ["tests/test_a.py", "tests/b.py"]);
  assert.equal(p.type, "selective");
  assert.ok(p.cmd.includes("-k"));
  const g = testSelector("go test ./...", ["pkg/foo.go", "pkg/bar.go"]);
  assert.equal(g.type, "selective");
  assert.ok(g.cmd.includes("pkg"));
});

// ---- Warn→confirm tiers (gap #9) --------------------------------------------
test("dangerTier maps patterns to block/confirm/allow", () => {
  const tiers = { "rm -rf /|~|$HOME": "confirm", "mkfs": "allow" };
  assert.equal(dangerTier("rm -rf /", tiers).tier, "confirm");
  assert.equal(dangerTier("mkfs /dev/sda", tiers).tier, "allow");
  assert.equal(dangerTier("rm -rf ~", {}).tier, "block", "default block");
  assert.deepEqual(dangerTier("ls -la", tiers), { tier: null }, "safe command");
  assert.equal(dangerTier("rm -rf ~", tiers).pattern, "rm -rf /|~|$HOME");
});

// ---- Skip-gate on doc edits (gap #8) ----------------------------------------
test("editRequiresGate: doc-only edits skip, code edits gate", () => {
  assert.equal(editRequiresGate(["README.md", "docs/guide.txt"]), false);
  assert.equal(editRequiresGate([]), false);
  assert.equal(editRequiresGate(["src/a.ts"]), true);
  assert.equal(editRequiresGate(["README.md", "src/a.ts"]), true, "any code file gates");
  assert.equal(editRequiresGate(["package.json"]), true, "config files gate");
});

// ---- Monorepo per-package gates (gap #10) -----------------------------------
test("nearestPackageDir: single nested package wins, cross-package → root", () => {
  const dir = makeProject({
    "package.json": "{}",
    "packages/a/package.json": "{}",
    "packages/b/package.json": "{}",
  });
  try {
    const a = nearestPackageDir(["packages/a/src/x.ts"], dir);
    assert.equal(a, join(dir, "packages/a"));
    const mixed = nearestPackageDir(["packages/a/src/x.ts", "packages/b/src/y.ts"], dir);
    assert.equal(mixed, null, "cross-package → root gate");
    assert.equal(nearestPackageDir([], dir), null);
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
