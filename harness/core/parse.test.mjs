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

test("parsePersona validates against the taxonomy", () => {
  assert.equal(parsePersona("Persona: security"), "security");
  assert.equal(parsePersona("Persona: performance\nThinking: high"), "performance");
  assert.equal(parsePersona("persona = test-first"), "test-first");
  // unknown / absent → null
  assert.equal(parsePersona("Persona: wizard"), null);
  assert.equal(parsePersona("no persona here"), null);
  assert.equal(parsePersona(null), null);
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
