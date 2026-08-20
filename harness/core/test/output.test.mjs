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
