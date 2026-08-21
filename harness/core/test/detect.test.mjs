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
