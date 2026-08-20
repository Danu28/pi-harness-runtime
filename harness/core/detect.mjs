// detect.mjs — part of the script/verify detection domain extracted from harness-core.mjs (Batch 2 of
// REFACTOR-PLAN.md). Pure logic, identical to the original source.
import { resolve, sep, join, dirname } from "node:path";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { execSync } from "node:child_process";
import { DEFAULT_CONFIG } from "./constants.mjs";
import { extractFailures } from "./output.mjs";
import { isIgnored } from "./safety.mjs";
import { normalizeRel } from "./safety.mjs";
import { shq } from "./safety.mjs";
import { tail } from "./output.mjs";
export const SCRIPT_NAMES = ["test", "typecheck", "types", "check", "lint", "verify", "ci"];

/** Load package.json scripts (empty object when absent/unreadable). */
export function loadScripts(cwd) {
  try {
    const p = join(cwd, "package.json");
    if (!existsSync(p)) return {};
    const pkg = JSON.parse(readFileSync(p, "utf8"));
    return pkg?.scripts ?? {};
  } catch {
    return {};
  }
}

/** Local typescript compiler when the project has tsconfig.json + installed TS. */
export function tscCommand(cwd) {
  try {
    if (!existsSync(join(cwd, "tsconfig.json"))) return null;
    if (!existsSync(join(cwd, "node_modules", "typescript", "bin", "tsc"))) return null;
    return "node node_modules/typescript/bin/tsc --noEmit";
  } catch {
    return null;
  }
}

/** Files matching exts (ignoring junk dirs), capped. */
export function findFilesByExt(cwd, exts, max = 40, maxDepth = Infinity) {
  const ignore = DEFAULT_CONFIG.ignore;
  const out = [];
  const stack = [[cwd, 0]];
  while (stack.length && out.length < max) {
    const [cur, depth] = stack.pop();
    let entries;
    try {
      entries = readdirSync(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const full = join(cur, e.name);
      const rel = normalizeRel(full, cwd);
      if (e.isDirectory()) {
        if (!isIgnored(rel, ignore) && depth + 1 <= maxDepth) stack.push([full, depth + 1]);
      } else if (e.isFile() && exts.some((x) => e.name.endsWith(x)) && !isIgnored(rel, ignore)) {
        out.push(rel);
      }
    }
  }
  return out.sort();
}

/** Project JS/MJS/CJS files (ignoring .git/node_modules/.harness etc.), capped. */
export function findProjectJsFiles(cwd, max = 40) {
  return findFilesByExt(cwd, [".js", ".mjs", ".cjs"], max);
}

/** True when `<cmd> --version` exits 0 (runtime installed). ~0.2s per probe. */
function probeOk(cmd) {
  try {
    execSync(`${cmd} --version`, {
      timeout: 4000,
      stdio: ["ignore", "pipe", "pipe"],
      shell: true,
      encoding: "utf8",
    });
    return true;
  } catch {
    return false;
  }
}

function probe(opts, key, cmd) {
  if (opts.probes && key in opts.probes) return Boolean(opts.probes[key]);
  // memoize within one detectVerify call so the same runtime isn't spawned repeatedly
  if (opts.probeCache && key in opts.probeCache) return opts.probeCache[key];
  const r = probeOk(cmd);
  if (opts.probeCache) opts.probeCache[key] = r;
  return r;
}

const PY_MANIFESTS = ["pyproject.toml", "setup.py", "requirements.txt"];

function detectPython(cwd, opts) {
  if (!PY_MANIFESTS.some((f) => existsSync(join(cwd, f)))) return null;
  const pyFiles = findFilesByExt(cwd, [".py"]);
  if (!pyFiles.length) return null;
  if (!probe(opts, "python", "python")) return null; // runtime missing → skip
  // Fast tier: pollution-free syntax gate (py_compile with pycache_prefix).
  // pytest with ZERO tests exits 5 (failure) — only offer it as the FULL tier
  // when test files exist.
  const files = pyFiles.map(shq).join(" ");
  const out = {
    command: `python -X pycache_prefix=.harness/pycache -m py_compile ${files}`,
    kind: "syntax",
    label: `python py_compile (syntax, ${pyFiles.length} file${pyFiles.length > 1 ? "s" : ""})`,
    verifyCwd: cwd,
  };
  const pyTestFiles = pyFiles.filter((f) => /(^|\/)test_.*\.py$|.*_test\.py$|tests?\/.*\.py$/.test(f));
  if (pyTestFiles.length && probe(opts, "pytest", "python -m pytest")) {
    out.fullCommand = "python -m pytest -q";
    out.fullLabel = `python -m pytest (${pyTestFiles.length} test file${pyTestFiles.length > 1 ? "s" : ""})`;
  }
  return out;
}

function detectGo(cwd, opts) {
  if (!existsSync(join(cwd, "go.mod"))) return null;
  if (!probe(opts, "go", "go")) return null;
  return {
    command: "go vet ./...",
    kind: "vet",
    label: "go vet ./...",
    verifyCwd: cwd,
    fullCommand: "go test ./...",
    fullLabel: "go test ./... (full)",
  };
}

function detectRust(cwd, opts) {
  if (!existsSync(join(cwd, "Cargo.toml"))) return null;
  if (!probe(opts, "cargo", "cargo")) return null;
  return {
    command: "cargo check",
    kind: "compile",
    label: "cargo check (fast)",
    verifyCwd: cwd,
    fullCommand: "cargo test",
    fullLabel: "cargo test (full)",
  };
}

function detectJava(cwd, opts) {
  const pom = existsSync(join(cwd, "pom.xml"));
  const gradle = existsSync(join(cwd, "build.gradle")) || existsSync(join(cwd, "build.gradle.kts"));
  if (!pom && !gradle) return null;
  if (pom && probe(opts, "mvn", "mvn")) {
    return {
      command: "mvn -q -DskipTests compile",
      kind: "compile",
      label: "mvn compile (fast)",
      verifyCwd: cwd,
      fullCommand: "mvn -q test",
      fullLabel: "mvn test (full)",
    };
  }
  if (gradle) {
    const wrapper = existsSync(join(cwd, "gradlew"));
    if (wrapper) {
      return {
        command: "gradlew compileJava -q",
        kind: "compile",
        label: "gradlew compileJava (fast)",
        verifyCwd: cwd,
        fullCommand: "gradlew test -q",
        fullLabel: "gradlew test (full)",
      };
    }
    if (probe(opts, "gradle", "gradle")) {
      return {
        command: "gradle compileJava -q",
        kind: "compile",
        label: "gradle compileJava (fast)",
        verifyCwd: cwd,
        fullCommand: "gradle test -q",
        fullLabel: "gradle test (full)",
      };
    }
  }
  return null;
}

function detectDotnet(cwd, opts) {
  // Bounded depth: this runs on cwd AND each ancestor during upward discovery;
  // an unbounded recursive walk of a large dir (e.g. Temp) looking for a
  // .csproj that isn't there costs seconds per /run.
  const csproj = findFilesByExt(cwd, [".csproj"], 1, 2)[0];
  if (!csproj) return null;
  if (!probe(opts, "dotnet", "dotnet")) return null;
  return {
    command: "dotnet build --nologo -v q",
    kind: "compile",
    label: "dotnet build (fast)",
    verifyCwd: cwd,
    fullCommand: "dotnet test --nologo -v q",
    fullLabel: "dotnet test (full)",
  };
}

function detectRuby(cwd, opts) {
  if (!existsSync(join(cwd, "Gemfile"))) return null;
  const rbFiles = findFilesByExt(cwd, [".rb"]);
  const hasRake = existsSync(join(cwd, "Rakefile")) || existsSync(join(cwd, "rakefile"));
  const hasBundle = probe(opts, "bundle", "bundle");
  if (!hasBundle && !(rbFiles.length && probe(opts, "ruby", "ruby"))) return null;
  const out = { verifyCwd: cwd };
  if (rbFiles.length && probe(opts, "ruby", "ruby")) {
    out.command = rbFiles.map((p) => `ruby -c ${shq(p)}`).join(" && ");
    out.kind = "syntax";
    out.label = `ruby -c (syntax, ${rbFiles.length} file${rbFiles.length > 1 ? "s" : ""})`;
  } else if (hasBundle && hasRake) {
    out.command = "bundle exec rake test";
    out.kind = "test";
    out.label = "bundle exec rake test";
  } else {
    return null;
  }
  if (hasBundle && hasRake) {
    out.fullCommand = "bundle exec rake test";
    out.fullLabel = "bundle exec rake test (full)";
  }
  return out;
}

function detectPhp(cwd, opts) {
  if (!existsSync(join(cwd, "composer.json"))) return null;
  const phpFiles = findFilesByExt(cwd, [".php"]);
  const phpOk = probe(opts, "php", "php");
  if (!phpOk && !phpFiles.length) return null;
  const out = { verifyCwd: cwd };
  if (phpFiles.length && phpOk) {
    out.command = phpFiles.map((p) => `php -l ${shq(p)}`).join(" && ");
    out.kind = "syntax";
    out.label = `php -l (syntax, ${phpFiles.length} file${phpFiles.length > 1 ? "s" : ""})`;
  } else {
    return null;
  }
  if (phpOk && (existsSync(join(cwd, "phpunit.xml")) || existsSync(join(cwd, "phpunit.xml.dist"))) && existsSync(join(cwd, "vendor", "bin", "phpunit"))) {
    out.fullCommand = "vendor/bin/phpunit";
    out.fullLabel = "vendor/bin/phpunit (full)";
  }
  return out;
}

/** Real gates only (no syntax fallbacks): scripts → tsc → language gates. */
function detectRealGates(cwd, opts) {
  const scripts = opts.scripts ?? loadScripts(cwd);
  for (const name of SCRIPT_NAMES) {
    if (typeof scripts[name] === "string" && scripts[name].trim()) {
      return { command: `npm run ${name}`, kind: "script", label: `npm run ${name}` };
    }
  }
  if (opts.tsc !== false) {
    const tsc = tscCommand(cwd);
    if (tsc) return { command: tsc, kind: "tsc", label: "tsc --noEmit (typecheck)" };
  }
  return detectPython(cwd, opts) ?? detectGo(cwd, opts) ?? detectRust(cwd, opts) ?? detectJava(cwd, opts) ?? detectDotnet(cwd, opts) ?? detectRuby(cwd, opts) ?? detectPhp(cwd, opts);
}

/** Nearest repo root (dir containing .git), bounded walk from cwd. */
export function repoRoot(cwd) {
  const home = homedir();
  let dir = resolve(cwd);
  let hops = 0;
  while (hops < 6 && dir && dir !== home && dir !== dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return dir;
    dir = dirname(dir);
    hops++;
  }
  return null;
}

/**
 * Find the project's verify command. Order: real gates at cwd (package.json
 * scripts → tsc → Python/Go/Rust/Java/.NET/Ruby/PHP) → real gates at ancestor
 * dirs (monorepo: gate runs at the manifest dir via verifyCwd) → syntax
 * fallback at cwd (node --check / py_compile / php -l / ruby -c) → null.
 * Returns { command, kind, label, verifyCwd } or null (degraded mode).
 * Probe results are injectable via opts.probes for tests.
 */
export function detectVerify(cwd, opts = {}) {
  const o = { ...opts, probeCache: opts.probeCache ?? {} };
  const here = detectRealGates(cwd, o);
  if (here) return { ...here, verifyCwd: cwd };

  // Upward discovery: from cwd up to the repo root (or ≤3 parents, home-stop).
  const root = repoRoot(cwd);
  const home = homedir();
  let dir = dirname(resolve(cwd));
  let hops = 0;
  while (
    hops < 3 &&
    dir &&
    dir !== home &&
    dir !== dirname(dir) &&
    (!root || dir.startsWith(root + sep) || dir === root)
  ) {
    const up = detectRealGates(dir, o);
    if (up) return { ...up, verifyCwd: dir };
    dir = dirname(dir);
    hops++;
  }

  // Syntax fallback at cwd.
  const js = opts.jsFiles ?? findProjectJsFiles(cwd);
  if (js.length) {
    const cmd = js.map((p) => `node --check ${shq(p)}`).join(" && ");
    return { command: cmd, kind: "syntax", label: `node --check (syntax, ${js.length} file${js.length > 1 ? "s" : ""})`, verifyCwd: cwd };
  }
  return null;
}

/**
 * Monorepo per-package gate (gap #10): from each changed file, walk up to the
 * nearest package manifest (package.json / go.mod / Cargo.toml). If ALL changed
 * files resolve to the SAME nested package dir, return that dir so the harness
 * can gate that package's suite instead of the root. Returns null when the
 * files resolve to the root itself or to more than one package (cross-package
 * change → root gate). Pure + path-only (no manifest parsing), so it's safe and
 * unit-testable without any build tooling.
 */
export function nearestPackageDir(changedFiles, cwd = process.cwd()) {
  const changed = (Array.isArray(changedFiles) ? changedFiles : []).map(String).filter(Boolean);
  if (!changed.length) return null;
  const root = resolve(cwd);
  const pkgs = new Set();
  for (const f of changed) {
    let dir = dirname(resolve(root, f));
    let found = null;
    let hops = 0;
    while (dir && dir !== root && dir !== dirname(dir) && hops < 8) {
      if (existsSync(join(dir, "package.json")) || existsSync(join(dir, "go.mod")) || existsSync(join(dir, "Cargo.toml"))) {
        found = dir;
        break;
      }
      dir = dirname(dir);
      hops++;
    }
    pkgs.add(found ?? root);
  }
  const single = pkgs.size === 1 ? [...pkgs][0] : null;
  return single && single !== root ? single : null;
}

export function gateResult(cmd, cwd, timeoutMs, kind = "custom") {
  // Strip test-runner vars so a nested `node --test` in the verify command
  // runs its own suite instead of silently exiting as a "child" process.
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith("NODE_TEST")) delete env[k];
  }
  try {
    const out = execSync(cmd, {
      cwd,
      timeout: timeoutMs,
      encoding: "utf8",
      shell: true,
      // Large build/lint output must not trip a false gate failure; output is
      // already tail()ed to a few lines before it reaches the model.
      maxBuffer: 64 * 1024 * 1024,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { ok: true, output: tail(String(out), 20), failures: [] };
  } catch (err) {
    const e = String(err?.stderr || err?.stdout || err?.message || "");
    const failures = extractFailures(e, kind);
    const t = tail(e, 25);
    const output = failures.length ? failures.join("\n") + (t ? "\n… (tail)\n" + t : "") : t;
    return { ok: false, output, failures };
  }
}

// ---- Selective test selection (gap #1) ----------------------------------
// Narrow the verify command to the tests affected by the changed files, for
// recognized runners only. Conservative by design: unknown runners, empty
// changed sets, or any mapping failure → run the FULL command. The review/full
// gate always runs the full suite regardless (the caller's job).
const SEL_RE_ESCAPE = /[.*+?^${}()|[\]\\]/g;
const selEsc = (s) => String(s).replace(SEL_RE_ESCAPE, "\\$&");

/**
 * Build a narrowed verify command for the changed files.
 * Returns { type: "full" } (run everything) or { type: "selective", cmd, label }.
 */
export function testSelector(verifyCmd, changedFiles) {
  const cmd = String(verifyCmd ?? "").trim();
  const changed = (Array.isArray(changedFiles) ? changedFiles : [])
    .map(String)
    .filter((f) => f && !isIgnored(f, DEFAULT_CONFIG.ignore));
  if (!cmd || !changed.length) return { type: "full" };
  const testFiles = changed.filter((f) => /\.(test|spec)\.[a-z0-9]+$/i.test(f));
  // node --test: run only the changed test files (full when none are tests).
  if (/node --test\b/.test(cmd)) {
    if (!testFiles.length) return { type: "full" };
    return { type: "selective", cmd: `node --test ${testFiles.map(shq).join(" ")}`, label: `node --test (${testFiles.length} changed test file${testFiles.length > 1 ? "s" : ""})` };
  }
  // jest: --testPathPattern from the changed source/test paths.
  if (/\bjest\b/.test(cmd)) {
    const pat = changed.map((f) => selEsc(f).replace(/\.[a-z0-9]+$/i, "")).join("|");
    if (!pat) return { type: "full" };
    return { type: "selective", cmd: `${cmd} --testPathPattern "${pat}" --silent`, label: `jest --testPathPattern (${changed.length} changed file${changed.length > 1 ? "s" : ""})` };
  }
  // vitest: run the changed files directly.
  if (/\bvitest\b/.test(cmd)) {
    return { type: "selective", cmd: `${cmd} run ${changed.map(shq).join(" ")}`, label: `vitest run (${changed.length} changed file${changed.length > 1 ? "s" : ""})` };
  }
  // pytest: -k on changed module names.
  if (/\bpytest\b/.test(cmd)) {
    const mods = [...new Set(changed.map((f) => f.split("/").pop().replace(/\.py$/i, "").replace(/^test_/, "").replace(/_test$/, "")))].filter(Boolean);
    if (!mods.length) return { type: "full" };
    return { type: "selective", cmd: `${cmd} -k "${mods.map(selEsc).join(" or ")}"`, label: `pytest -k (${mods.length} module${mods.length > 1 ? "s" : ""})` };
  }
  // go test: package(s) of the changed files.
  if (/\bgo\s+test\b/.test(cmd)) {
    const pkgs = [...new Set(changed.map((f) => {
      const i = f.lastIndexOf("/");
      return i > 0 ? f.slice(0, i) : ".";
    }))];
    return { type: "selective", cmd: `${cmd} ${pkgs.map(shq).join(" ")}`, label: `go test (${pkgs.length} package${pkgs.length > 1 ? "s" : ""})` };
  }
  // Unknown runner → never guess; run the full command.
  return { type: "full" };
}
export { probe };
