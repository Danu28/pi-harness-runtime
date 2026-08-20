// harness-core.mjs — pure, dependency-free logic for the pi harness extension.
// No pi imports; unit-testable with plain `node --test`. harness.ts wires this to pi.
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { DEFAULT_CONFIG } from "./constants.mjs";
import { LONGTERM_DIR } from "./constants.mjs";
import { TEMP_DIR } from "./constants.mjs";
import { THINK_LEVELS } from "./constants.mjs";
import { USE_COLOR } from "./constants.mjs";
import { color } from "./constants.mjs";
import { isIgnored } from "./safety.mjs";
import { normalizeRel } from "./safety.mjs";
import { shq } from "./safety.mjs";

// ---- barrel re-exports (Batch 1): moved-out modules -----------------------
export { ACCEPT_VERDICTS } from "./constants.mjs";
export { AI_CAP } from "./constants.mjs";
export { CORE_VERSION } from "./constants.mjs";
export { DEFAULT_CONFIG } from "./constants.mjs";
export { LANES } from "./constants.mjs";
export { LONGTERM_DIR } from "./constants.mjs";
export { PERSONA_TAXONOMY } from "./constants.mjs";
export { PHASE_TAXONOMY } from "./constants.mjs";
export { TEMP_DIR } from "./constants.mjs";
export { THINK_LEVELS } from "./constants.mjs";
export { USE_COLOR } from "./constants.mjs";
export { bashMutates } from "./safety.mjs";
export { color } from "./constants.mjs";
export { dangerTier } from "./safety.mjs";
export { dangerousBash } from "./safety.mjs";
export { declareRequired } from "./safety.mjs";
export { editRequiresGate } from "./safety.mjs";
export { globToRegExp } from "./safety.mjs";
export { insideProject } from "./safety.mjs";
export { isIgnored } from "./safety.mjs";
export { normalizeRel } from "./safety.mjs";
export { parseAcceptance } from "./parse.mjs";
export { parseCandidates } from "./parse.mjs";
export { parseCommitSubject } from "./parse.mjs";
export { parseLanePrediction } from "./parse.mjs";
export { parsePersona } from "./parse.mjs";
export { parsePhasePrediction } from "./parse.mjs";
export { parsePlan } from "./parse.mjs";
export { parsePlanProgress } from "./parse.mjs";
export { parseRemainingEstimate } from "./parse.mjs";
export { parseRunArgs } from "./parse.mjs";
export { parseThinkingPrediction } from "./parse.mjs";
export { scopeAllowed } from "./safety.mjs";
export { shq } from "./safety.mjs";
export { stripAcceptanceBlocks } from "./parse.mjs";

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

/**
 * Resolve phase thinking levels, decoupled from task lane (P1 decouple): a
 * task complexity lane must never raise per-turn thinking cost — the reactive
 * fail-ladder is the only edit escalator.
 *
 * Precedence: user flags (forcedThink / forcedEdit) → AI prediction (planning
 * only) → thinkingStart default. `lane` is accepted for call-site symmetry but
 * deliberately IGNORED; regression tests pin this contract.
 */
export function phaseThinking({ forcedThink = null, forcedEdit = null, aiPrediction = null, lane = null, thinkingStart = DEFAULT_CONFIG.thinkingStart } = {}) {
  void lane; // explicit no-op: lane is advisory-only (Gate 2 / tier / report)
  return { plan: forcedThink ?? aiPrediction ?? thinkingStart, edit: forcedEdit ?? thinkingStart };
}

/**
 * True when a planning-phase tasklist should be produced/captured — i.e. the
 * effective planning thinking level is non-trivial (>= medium). Trivial (low)
 * runs skip the tasklist entirely so cheap tasks cost nothing extra.
 */
export function tasklistEnabled(level) {
  return THINK_LEVELS.indexOf(String(level ?? "").toLowerCase()) >= THINK_LEVELS.indexOf("medium");
}

/**
 * Gate 2 condition (revised-plan A3b): the plan-review gate fires only for
 * boundary/risk plans — an L-lane run carrying a risky plan (a `footprint:
 * boundary` task or `## Risk Notes`). Non-boundary M plans skip Gate 2.
 * Returns true when the reviewer must review the plan before build.
 */
export function gate2Required(lane, plan) {
  return lane === "L" && !!(plan && plan.risky);
}

/**
 * Gate 1 condition (ideation feature): the ideas-review gate fires only for an
 * ideate-phase run that has produced candidates. Mirrors gate2Required: the
 * reviewer must challenge the candidates before planning proceeds.
 */
export function gate1Required(phase, plan) {
  return phase === "ideate" && !!(plan && plan.candidates && plan.candidates.length);
}

// Stage → skill-card mapping (revised-plan A7). The injected operating-discipline
// card follows the active stage instead of always being "builder".
const STAGE_CARD = {
  ideation: "brainstormer",
  // Strict first-principles BEFORE building: the run state machine's real
  // pre-development stage is "planning" (its only stages are planning/
  // development/review). Mapping it to first-principles makes the question/delete
  // lens the active operating discipline while requirements are scoped and the
  // plan is drafted, cutting redundant development before any build work starts.
  planning: "first-principles",
  requirements: "first-principles",
  plan: "planner",
  "plan-review": "reviewer",
  development: "builder",
  build: "builder",
  review: "verifier",
  verify: "verifier",
};

/** Skill card name for a run stage, or null when none is mapped. */
export function stageSkillCard(stage) {
  return STAGE_CARD[String(stage ?? "").toLowerCase()] ?? null;
}

// Layered operating-discipline lenses (composed WITH the primary stage card, not
// replacing it). With first-principles now the primary requirements card, the
// reviewer's plan-contract gate rides alongside it as the backup layer, so the
// questioning/delete lens leads while the acceptance structure is retained.
// Only the stage-default path layers; an explicit `skillCard` config stays
// authoritative.
const STAGE_LAYER_CARD = {
  requirements: "reviewer",
};

/** Extra skill-card lens layered onto a stage's primary card, or null. */
export function stageLayerCard(stage) {
  return STAGE_LAYER_CARD[String(stage ?? "").toLowerCase()] ?? null;
}

/**
 * Verify tier selection (revised-plan A6). Returns "quick" | "standard" |
 * "full" based on lane + plan footprint + prior pass-verified status.
 *   - Quick:  S-lane OR all tasks `footprint: none` AND previously pass-verified
 *             (skip the verifier; the build-boundary gate is the quality check).
 *   - Standard: M-lane with no boundary footprint (tests + review).
 *   - Full:   L-lane or any boundary/risk plan (tests + review + security + perf).
 * The boundary/risk footprint is the escape hatch: any `footprint: boundary`
 * task or `## Risk Notes` forces Full, so a mis-laned risky task can't slip
 * through a Quick/Standard tier.
 */
export function verifyTier({ lane, plan, previouslyPassed = false } = {}) {
  const risky = !!(plan && plan.risky);
  if (risky || lane === "L") return "full";
  const boundaryFree = (plan?.tasks?.length ?? 0) === 0 || plan.tasks.every((t) => !t || t.footprint === "none" || t.footprint === "small");
  if ((lane === "S" || boundaryFree) && previouslyPassed) return "quick";
  return "standard";
}

/**
 * Deterministic heuristic lane classifier (fallback when neither --lane nor the
 * model's Lane: marker is present). Reads the task text + snapshot for signals.
 * Returns S / M / L; defaults to M.
 */
export function classifyLane(task, snapshot = "") {
  const text = String(task ?? "").toLowerCase() + "\n" + String(snapshot ?? "").toLowerCase();
  // L: boundary/risk/scale signals — trust/network/auth/DB exposure, hot paths,
  // migrations, many files, or structural scope (design/refactor/extension).
  const L_RE =
    /\b(security|auth|network|database|\bdb\b|migration|trust|hot\s?-?path|boundary|monorepo|many\s+files|refactor|design|extension|pipeline|permission|encrypt|secret|\bapi\b|performance|large|complex)\b|files?:\s*\d{2,}/;
  // S: trivial scope — single-file, read-only, no new deps, no trust boundary.
  const S_RE =
    /\b(typo|rename|explain|check|answer|read-?only|trivial|what is|show me|simple|quick|spelling|comment)\b/;
  if (L_RE.test(text)) return "L";
  if (S_RE.test(text)) return "S";
  return "M";
}

/**
 * Build the "Act as <role> [with a <domain> focus]." framing for a stage.
 * stage: planning | development | review. domain: a taxonomy entry or null.
 */
export function renderPersona(stage, domain) {
  const roles = { planning: "Product Owner", development: "Senior Developer", review: "Reviewer" };
  const role = roles[stage] ?? "Engineer";
  const d = domain && domain !== "generalist" ? domain : null;
  const art = d && /^[aeiou]/.test(d) ? "an" : "a";
  return d ? `Act as a ${role} with ${art} ${d} focus.` : `Act as a ${role}.`;
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

export function shouldEscalate(consecutiveFails, max, alreadyEscalated) {
  return !alreadyEscalated && consecutiveFails >= max;
}

export function shouldStop(turns, maxTurns) {
  return turns >= maxTurns;
}

/**
 * Asymmetric budget extension: raise the ceiling only when the run is healthy
 * (no active escalation, no failure streak) AND the model gave a positive
 * remaining-work estimate. Never beyond absMaxTurns.
 */
export function extendBudget(o) {
  const absMax = o.absMaxTurns ?? o.maxTurns * 2;
  if (o.escalated || o.consecutiveFails >= o.maxConsecutiveFails) {
    return { extend: false, reason: "unhealthy (escalation or failure streak)" };
  }
  // Bounds a healthy-but-stuck loop: auto-extension is allowed at most N times,
  // so even a green loop can't run all the way to absMaxTurns.
  if ((o.extensionCount ?? 0) >= (o.maxExtensions ?? 2)) {
    return { extend: false, reason: "max extensions reached" };
  }
  const est = o.pendingEstimate ?? 0;
  if (!(est > 0)) return { extend: false, reason: "no estimate" };
  const newMax = Math.min(o.turns + Math.ceil(est), absMax);
  if (newMax <= o.turns + 1) return { extend: false, reason: "bump too small or at absolute cap" };
  return { extend: true, newMaxTurns: newMax };
}

/** Discount a model estimate by historical bias (positive bias = model under-estimates). */
export function discountEstimate(est, bias) {
  if (!(est > 0) || bias == null) return est;
  return Math.max(1, Math.round(est * (1 + Math.max(0, bias))));
}

/**
 * Clamp/validate budget config so the adaptive budget can't be silently
 * disabled (e.g. maxTurns=1 stops before the soft-ask can happen) and the
 * absolute wall never undercuts maxTurns. Returns normalized values + warnings.
 */
export function normalizeBudget(raw = {}, defaults = DEFAULT_CONFIG) {
  const warnings = [];
  let maxTurns = Number(raw.maxTurns ?? defaults.maxTurns);
  let softBudgetPct = Number(raw.softBudgetPct ?? defaults.softBudgetPct);
  let absMaxTurns = Number(raw.absMaxTurns ?? defaults.absMaxTurns);
  const MIN_TURNS = 3;
  if (maxTurns < MIN_TURNS) {
    warnings.push(`maxTurns ${maxTurns} < ${MIN_TURNS} — auto-adjustment needs a minimum; raised to ${MIN_TURNS}.`);
    maxTurns = MIN_TURNS;
  }
  if (!(softBudgetPct > 0 && softBudgetPct < 1)) {
    warnings.push(`softBudgetPct ${softBudgetPct} out of range (0,1); using ${defaults.softBudgetPct}.`);
    softBudgetPct = defaults.softBudgetPct;
  }
  if (absMaxTurns < maxTurns) {
    warnings.push(`absMaxTurns ${absMaxTurns} < maxTurns ${maxTurns}; raised to ${maxTurns}.`);
    absMaxTurns = maxTurns;
  }
  return { maxTurns, softBudgetPct, absMaxTurns, warnings };
}

const ESTIMATES_FILE = ".harness/estimates.json";
const STATS_FILE = ".harness/stats.json";

/** Rolling estimate-accuracy bias (actual - predicted) from past runs, or null. */
export function loadEstimateBias(cwd) {
  try {
    const recs = JSON.parse(readFileSync(join(cwd, ESTIMATES_FILE), "utf8"))?.records;
    if (!Array.isArray(recs) || recs.length < 2) return null;
    const deltas = recs.map((r) => (r.actual ?? 0) - (r.estimated ?? 0));
    return { n: deltas.length, bias: deltas.reduce((a, b) => a + b, 0) / deltas.length };
  } catch {
    return null;
  }
}

/** Record one run's predicted-vs-actual turns for accuracy tracking. */
export function appendEstimateRecord(cwd, { estimated, actual }) {
  try {
    let recs = [];
    try {
      recs = JSON.parse(readFileSync(join(cwd, ESTIMATES_FILE), "utf8"))?.records ?? [];
    } catch {
      /* fresh file */
    }
    recs.push({ estimated: estimated ?? 0, actual: actual ?? 0 });
    if (recs.length > 50) recs = recs.slice(-50);
    mkdirSync(join(cwd, ".harness"), { recursive: true });
    writeFileSync(join(cwd, ESTIMATES_FILE), JSON.stringify({ records: recs }, null, 2), "utf8");
  } catch {
    /* best-effort */
  }
}

/**
 * Persist one finished run's summary to .harness/stats.json (capped ~200 records).
 * Runs on both done and stopped so the trend records the true terminal status.
 * Best-effort: a write failure is never fatal to the run.
 */
export function appendRunStats(cwd, run) {
  const st = run?.stats ?? {};
  const total = (st.tokensIn ?? 0) + (st.tokensCached ?? 0) + (st.tokensOut ?? 0);
  const rec = {
    ts: Date.now(),
    task: String(run?.task ?? "").slice(0, 80),
    status: run?.status ?? "?",
    calls: st.calls ?? 0,
    cost: st.cost ?? 0,
    cacheHitPct: total > 0 ? Math.round(((st.tokensCached ?? 0) / total) * 100) : 0,
    turns: st.turns ?? 0,
    gateRuns: st.gateRuns ?? 0,
    gateFails: st.gateFails ?? 0,
    stage: run?.stage ?? "?",
    resumed: run?.resumeCount ?? 0,
  };
  try {
    let recs = [];
    try {
      recs = JSON.parse(readFileSync(join(cwd, STATS_FILE), "utf8") ?? "{}")?.records ?? [];
    } catch {
      /* fresh file */
    }
    recs.push(rec);
    if (recs.length > 200) recs = recs.slice(-200);
    mkdirSync(join(cwd, ".harness"), { recursive: true });
    writeFileSync(join(cwd, STATS_FILE), JSON.stringify({ records: recs }, null, 2), "utf8");
  } catch {
    /* best-effort */
  }
}

const PYCACHE_DIR = ".harness/pycache";
const RUN_TMP_FILE = ".harness/run.json.tmp";

/** Ensure the agent-facing artifact dirs exist (called at run start). */
export function ensureArtifactDirs(cwd) {
  for (const rel of [TEMP_DIR, LONGTERM_DIR]) {
    try {
      mkdirSync(join(cwd, rel), { recursive: true });
    } catch {
      /* best-effort */
    }
  }
}

/**
 * Clear the agent temp dir contents (not the dir itself). Longterm is never
 * touched. Used at task completion and by /harness-clean-temp. Best-effort.
 */
export function clearTempDir(cwd) {
  const dir = join(cwd, TEMP_DIR);
  try {
    if (!existsSync(dir)) return 0;
    let removed = 0;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      rmSync(join(dir, e.name), { recursive: true, force: true });
      removed++;
    }
    return removed;
  } catch {
    return 0;
  }
}

/**
 * True when a relative path lives anywhere under `.harness/` (incl. the root).
 * Used as the edit carve-out so the agent can write its memory/longterm files
 * under `.harness/longterm/` without triggering a scope/declare block.
 */
export function isHarnessPath(rel) {
  return rel === ".harness" || rel.startsWith(".harness/");
}

/**
 * True when a relative path is a TOP-LEVEL memory path (memory/ or memory/**).
 * The artifact-filing protocol is STRICT here: memory files (plan, progress,
 * decisions, knowledge, problems, failures) must live under
 * .harness/longterm/memory/ — never a top-level memory/ directory. This is the
 * hard block counterpart to the isHarnessPath carve-out: writes to these paths
 * are refused even when declared, so a mis-filed memory doc can't slip through
 * strict scope.
 */
export function isForbiddenArtifactPath(rel) {
  return rel === "memory" || rel.startsWith("memory/");
}

// ---- Cross-run gate cache (gap #2) --------------------------------------
// Reuse a last-green gate verdict when the git state (HEAD + working-tree
// porcelain set) EXACTLY matches a prior green run. Same commit + same mods ⇒
// the same test result (tests are assumed deterministic, as everywhere else in
// the harness). Only fires when it is provably safe — a dirty mid-run tree
// almost never matches a cached green. Cache lives under .harness/longterm/,
// capped at 20, and never stores a red (a red run invalidates its key).
const GATE_CACHE_FILE = join(LONGTERM_DIR, "gate-cache.json");
const GATE_CACHE_CAP = 20;

/** Current HEAD sha ("" when not a git repo or rev-parse fails). */
export function gitHead(cwd) {
  try {
    return execSync("git rev-parse HEAD", { cwd, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
}

/** Sorted list of changed rel paths from the porcelain set. */
export function changedPaths(cwd) {
  const set = setFromPorcelain(gitPorcelain(cwd));
  return [...set].sort();
}

/** Load the persisted gate cache (newest-first, capped). Never throws. */
export function loadGateCache(cwd) {
  try {
    const recs = JSON.parse(readFileSync(join(cwd, GATE_CACHE_FILE), "utf8") ?? "{}")?.entries;
    if (!Array.isArray(recs)) return { entries: [] };
    return { entries: recs.slice(0, GATE_CACHE_CAP) };
  } catch {
    return { entries: [] };
  }
}

/** Best-effort persist of the gate cache. */
export function saveGateCache(cwd, entries) {
  try {
    mkdirSync(join(cwd, LONGTERM_DIR), { recursive: true });
    writeFileSync(join(cwd, GATE_CACHE_FILE), JSON.stringify({ entries: entries.slice(0, GATE_CACHE_CAP) }, null, 2), "utf8");
  } catch {
    /* best-effort */
  }
}

/** Stable cache key: verifyCmd + HEAD + sorted porcelain set. */
export function gateCacheKey({ verifyCmd, head, porcelain }) {
  const src = `${String(verifyCmd ?? "")}\u0000${String(head ?? "")}\u0000${(Array.isArray(porcelain) ? porcelain : []).join("\u0001")}`;
  return createHash("sha1").update(src).digest("hex");
}

/** A cached GREEN entry for the exact git state, or null (never stale-green). */
export function cachedGreen(cwd, { verifyCmd, head, porcelain }) {
  const key = gateCacheKey({ verifyCmd, head, porcelain });
  const { entries } = loadGateCache(cwd);
  const hit = entries.find((e) => e.key === key && e.ok === true);
  return hit ? { ok: true, cached: true, ts: hit.ts } : null;
}

/** Record a genuinely green gate result for the current git state. */
export function recordGreen(cwd, { verifyCmd, head, porcelain }) {
  const { entries } = loadGateCache(cwd);
  const key = gateCacheKey({ verifyCmd, head, porcelain });
  const next = [
    { key, verifyCmd: String(verifyCmd ?? ""), head: String(head ?? ""), porcelain: Array.isArray(porcelain) ? porcelain : [], ok: true, ts: Date.now() },
    ...entries.filter((e) => e.key !== key),
  ];
  saveGateCache(cwd, next);
  return next.length;
}

/** Drop any cached entry whose key matches (called on a red gate). */
export function invalidateGreen(cwd, { verifyCmd, head, porcelain }) {
  const key = gateCacheKey({ verifyCmd, head, porcelain });
  const { entries } = loadGateCache(cwd);
  const next = entries.filter((e) => e.key !== key);
  if (next.length !== entries.length) saveGateCache(cwd, next);
  return next.length;
}

// ---- Last-green rollback point (gap #3) ----------------------------------
// After a gate failure the model can lose the last known-good state. The newest
// GREEN entry in the persisted gate cache IS the rollback point (reused state,
// no second store). A small separate log records each red gate (head + reason)
// so /harness-fork-green can show when/why the rollback point matters.

/** Newest cached GREEN gate entry → the rollback point, or null. */
export function lastGreen(cwd) {
  const { entries } = loadGateCache(cwd);
  const hit = entries.find((e) => e.ok === true && e.head);
  return hit ? { head: hit.head, verifyCmd: hit.verifyCmd, ts: hit.ts } : null;
}

const GATE_ROLLBACK_FILE = join(LONGTERM_DIR, "gate-rollback.json");
const GATE_ROLLBACK_CAP = 50;

/** Load persisted red-gate rollback records (newest-first, capped). Never throws. */
export function loadGateRollbacks(cwd, max = 20) {
  try {
    const recs = JSON.parse(readFileSync(join(cwd, GATE_ROLLBACK_FILE), "utf8") ?? "{}")?.records;
    if (!Array.isArray(recs)) return [];
    return recs.slice(0, max);
  } catch {
    return [];
  }
}

/** Best-effort persist of a red-gate rollback record (head + reason, cap 50). */
export function recordGateFail(cwd, { head, verifyCmd, reason }) {
  try {
    const rec = {
      head: String(head ?? ""),
      verifyCmd: String(verifyCmd ?? ""),
      reason: String(reason ?? "").slice(0, 300),
      ts: Date.now(),
    };
    const recs = [rec, ...loadGateRollbacks(cwd, GATE_ROLLBACK_CAP)];
    mkdirSync(join(cwd, LONGTERM_DIR), { recursive: true });
    writeFileSync(join(cwd, GATE_ROLLBACK_FILE), JSON.stringify({ records: recs.slice(0, GATE_ROLLBACK_CAP) }, null, 2), "utf8");
    return recs.length;
  } catch {
    return 0;
  }
}

// ---- Auto-triage of gate failures (gap #6) ------------------------------
// Persist recent red-gate outputs (signature store) and classify a new failure
// as KNOWN (matches a prior failure) or NEW, so the model gets a pre-filled
// classification and can apply the remembered fix instead of re-debugging.
const GATE_FAILURES_FILE = join(LONGTERM_DIR, "gate-failures.json");
const GATE_FAILURES_CAP = 50;

/** Load recent red-gate outputs (newest-first, capped). Never throws. */
export function loadGateFailures(cwd, max = 20) {
  try {
    const recs = JSON.parse(readFileSync(join(cwd, GATE_FAILURES_FILE), "utf8") ?? "{}")?.records;
    if (!Array.isArray(recs)) return [];
    return recs.slice(0, max);
  } catch {
    return [];
  }
}

/** Best-effort persist of a red-gate output (dedup by output hash, cap 50). */
export function recordGateFailure(cwd, { output }) {
  try {
    const o = String(output ?? "");
    if (!o.trim()) return 0;
    const hash = createHash("sha1").update(o).digest("hex");
    let recs = loadGateFailures(cwd, GATE_FAILURES_CAP);
    recs = [{ hash, output: o.slice(0, 1500), ts: Date.now() }, ...recs.filter((r) => r.hash !== hash)];
    mkdirSync(join(cwd, LONGTERM_DIR), { recursive: true });
    writeFileSync(join(cwd, GATE_FAILURES_FILE), JSON.stringify({ records: recs.slice(0, GATE_FAILURES_CAP) }, null, 2), "utf8");
    return recs.length;
  } catch {
    return 0;
  }
}

/**
 * Classify a gate failure against prior red-gate outputs. Token-cosine match;
 * score > 0.5 → KNOWN with a matching prior excerpt, else NEW. Pure + testable.
 */
export function failureTriage(output, recents = []) {
  const o = String(output ?? "");
  if (!o.trim()) return { kind: "new" };
  const toks = (s) => new Set(String(s).toLowerCase().split(/[^a-z0-9_.:/-]+/).filter((t) => t.length >= 4));
  const ot = toks(o);
  if (!ot.size) return { kind: "new" };
  let best = null;
  for (const r of Array.isArray(recents) ? recents : []) {
    const rt = toks(r?.output ?? "");
    if (!rt.size) continue;
    let shared = 0;
    for (const t of ot) if (rt.has(t)) shared++;
    const score = shared / Math.sqrt(ot.size * rt.size);
    if (score > 0.5 && (!best || score > best.score)) best = { score, output: String(r?.output ?? "").slice(0, 200) };
  }
  return best ? { kind: "known", match: best.output, score: best.score } : { kind: "new" };
}

/**
 * Remove redundant temp artifacts a /run created that are no longer needed
 * once the task completes. Keeps telemetry + archive (stats.json,
 * estimates.json, last-run.json) and resumable run state (run.json).
 *
 * Removed:
 *  - .harness/pycache/  — Python __pycache__ bytecode dir created by the
 *    py_compile gate (fast tier). Pure build by-product, never read after the
 *    gate runs.
 *  - .harness/run.json.tmp — transient write-buffer from writeRun(); normally
 *    renamed away, but can linger after a crash.
 *
 * Best-effort: a removal failure is never fatal.
 */
export function cleanupRunArtifacts(cwd) {
  for (const rel of [PYCACHE_DIR, RUN_TMP_FILE]) {
    const p = join(cwd, rel);
    try {
      if (existsSync(p)) rmSync(p, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
  // Agent temp artifacts: cleared at completion (longterm is preserved).
  clearTempDir(cwd);
}

/** Read the most recent `max` recorded run stats (most recent first). */
/** Read a runtime skill-card file (skillcards/<name>.md). Returns "" if missing. */
export function loadSkillCard(cardDir, name) {
  const safe = String(name ?? "").replace(/[^a-z0-9-]/gi, "");
  if (!safe) return "";
  try {
    return readFileSync(join(cardDir, `${safe}.md`), "utf8");
  } catch {
    return "";
  }
}

// Failure-memory check (v1.13): when a run's gate failed, the harness verifies
// a lesson actually landed in .harness/longterm/memory/failures.md this run —
// advisory (reported, not blocked) so memory discipline is CHECKED, not just
// nudged by prose.
export function checkFailureMemory(cwd, startedAt, gateFails) {
  if (!gateFails) return { ok: true, note: "no gate failures to record" };
  const p = join(cwd, LONGTERM_DIR, "memory", "failures.md");
  try {
    if (!existsSync(p)) return { ok: false, note: "gate failed — no failures.md under .harness/longterm/memory/" };
    const start = new Date(String(startedAt ?? "")).getTime() || 0;
    return statSync(p).mtimeMs >= start
      ? { ok: true, note: "failure lesson recorded this run" }
      : { ok: false, note: "failures.md exists but no lesson was appended this run" };
  } catch {
    return { ok: false, note: "failures.md unreadable" };
  }
}

/**
 * Cross-run budget hint (v1.13): from the persisted run-stats trend, suggest a
 * maxTurns when recent runs cluster near the ceiling (raise) or finish far
 * under it (tighten). Advisory only — the caller decides whether to apply it.
 * Returns null when there is insufficient data or the budget looks right-sized.
 */
export function suggestBudget(records, maxTurns = DEFAULT_CONFIG.maxTurns) {
  const done = (Array.isArray(records) ? records : [])
    .filter((r) => r?.status === "done" || r?.status === "stopped")
    .map((r) => Number(r?.turns))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (done.length < 3) return null;
  const sorted = [...done].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  if (median > maxTurns * 0.9) {
    return { median, n: done.length, suggestion: Math.ceil(median * 1.25), reason: "recent runs cluster near the turn ceiling" };
  }
  if (median < maxTurns * 0.5) {
    return { median, n: done.length, suggestion: Math.max(5, Math.ceil(median * 1.5)), reason: "recent runs finish well under budget" };
  }
  return null;
}

export function loadRunStats(cwd, max = 12) {
  try {
    const recs = JSON.parse(readFileSync(join(cwd, STATS_FILE), "utf8") ?? "{}")?.records;
    if (!Array.isArray(recs)) return [];
    return recs.slice(-max).reverse();
  } catch {
    return [];
  }
}

/** Build [field, value, meaning] trend rows for renderTable from run stats. */
export function statsRows(records) {
  const rows = [["task", "calls · cost · cache%", "turns · gate · status"]];
  for (const r of records) {
    rows.push([
      (String(r.task ?? "?").slice(0, 20) || "(untitled)"),
      `${r.calls ?? 0} · $${(r.cost ?? 0).toFixed(4)} · ${r.cacheHitPct ?? 0}%`,
      `${r.turns ?? 0} · gate ${r.gateRuns ?? 0}/${r.gateFails ?? 0} · ${r.status ?? "?"}`,
    ]);
  }
  return rows;
}

/**
 * Auto-commit the run's scoped files that actually changed, after a successful
 * run. Only files the run declared are committed (never .harness/ or unrelated
 * changes). Returns { committed, count?, message?, reason? }.
 */
export function autoCommit(cwd, task, declared) {
  const files = (Array.isArray(declared) ? declared : []).filter((f) => typeof f === "string" && f.trim());
  if (!files.length) return { committed: false, reason: "no scoped files", leftover: [] };
  try {
    const changed = setFromPorcelain(gitPorcelain(cwd));
    const toCommit = files.filter((f) => changed.has(f));
    // Everything non-ignored the run didn't commit (bash side-effects, generated
    // files, pre-existing user changes) is surfaced as leftover so the report can
    // flag an inconsistent repo instead of silently leaving it.
    const leftover = [...changed].filter((f) => !files.includes(f));
    if (!toCommit.length) return { committed: false, reason: "no changed scoped files", leftover };
    const msg = `harness: ${String(task).trim().slice(0, 72)}`;
    const body = `files: ${toCommit.join(", ")}`;
    // `git add -A --ignore-errors -- <paths>` stages modifications, additions
    // AND deletions within the declared scope (the prior existsSync filter
    // silently dropped deleted files); --ignore-errors tolerates paths that were
    // declared but never created.
    execSync(`git add -A --ignore-errors -- ${files.map(shq).join(" ")}`, { cwd, timeout: 10000, stdio: "pipe" });
    execSync(`git commit -m ${shq(msg)} -m ${shq(body)}`, { cwd, timeout: 10000, stdio: "pipe" });
    return { committed: true, count: toCommit.length, message: msg, leftover };
  } catch {
    return { committed: false, reason: "git error", leftover: [] };
  }
}

export function tail(text, maxLines) {
  const lines = String(text ?? "").split("\n").filter((l) => l.trim() !== "");
  if (lines.length <= maxLines) return lines.join("\n");
  const HEAD = 3;
  const TAIL = 3;
  const omitted = lines.length - HEAD - TAIL;
  return lines
    .slice(0, HEAD)
    .concat(`... (${omitted} more lines)`, lines.slice(-TAIL))
    .join("\n");
}

/** Rough token estimate (chars/4) — mirrors compile-skills.mjs's local copy. */
export function estimateTokens(text) {
  return Math.ceil(String(text ?? "").length / 4);
}

// Tool-output token budget (idea #4): pi's bash tool tail-truncates at 2000
// lines/50KB before the result even reaches the harness, but ~12.5K tokens is
// still a lot to re-inject on every following model call. This shrinks the
// result further to a token budget while keeping what the model actually needs:
// the head, the tail (where build errors land), matching error lines, and a
// marker pointing at the archived full output.
const TOOL_ERR_RE = /error|failed|fail|exception|fatal|✖/i;
const TOOL_SKIP_RE = /^ok\b|passed|passing|0 errors?|errors?:\s*0\b|^\s*ℹ/;

/**
 * Summarize a tool-output text to a token budget. Pure; unit-tested.
 * Under/at budget (or disabled via budget 0/null) → passthrough.
 * Over budget → head + "omitted" note + error lines + tail + marker.
 * Returns { text, truncated, before, after }.
 */
export function summarizeToolOutput(text, budget, { headLines = 12, tailLines = 12, maxErrorLines = 10, note = "" } = {}) {
  const src = String(text ?? "");
  const before = estimateTokens(src);
  if (budget == null || budget <= 0 || before <= budget) {
    return { text: src, truncated: false, before, after: before };
  }
  const lines = src.split("\n");
  const head = lines.slice(0, headLines);
  const tail = lines.slice(-tailLines);
  const errs = [];
  const seen = new Set();
  for (const ln of lines) {
    const l = ln.trim();
    if (!l || l.length > 300) continue;
    if (TOOL_SKIP_RE.test(l)) continue;
    if (TOOL_ERR_RE.test(l) && !seen.has(l)) {
      seen.add(l);
      errs.push(l.slice(0, 160));
      if (errs.length >= maxErrorLines) break;
    }
  }
  const omitted = lines.length - head.length - tail.length;
  const parts = [head.join("\n")];
  if (omitted > 0) parts.push(`... (${omitted} lines omitted)`);
  if (errs.length) parts.push("[error lines]", ...errs);
  if (omitted > 0) parts.push("...");
  parts.push(tail.join("\n"));
  const out = parts.join("\n");
  const after = estimateTokens(out);
  const mark = `[truncated: ${before}→${after} tok${note ? `, ${note}` : ""}; full output archived at .harness/temp]`;
  return { text: `${mark}\n${out}`, truncated: true, before, after: estimateTokens(`${mark}\n${out}`) };
}

// Structured gate output (v1.13): instead of only a raw tail, the gate now
// surfaces the specific failing lines (test names, tsc errors) so the model
// doesn't have to grep for the real failure inside truncated output.
const FAILURE_PATTERNS = {
  test: [/✖/, /not ok\b/, /AssertionError/, /FAILED/, /failed:\s*\d+/],
  tsc: [/error TS\d+/],
  syntax: [/SyntaxError/],
  vet: [/\berror\b/i, /\bfailed\b/i],
  compile: [/\berror\b/i, /\bfailed\b/i],
  script: [/\berror\b/i, /\bfailed\b/i, /✖/, /FAILED/],
  custom: [/\berror\b/i, /\bfailed\b/i],
};
const FAILURE_SKIP = /^ok\b|passing|passed|0 errors?|no errors|errors?:\s*0\b|^\s*ℹ|✔/;

/** Extract up to 8 distinct failure lines from gate output, kind-aware. */
// Structured test-runner output (gap #5): extract per-test failure rows from
// TAP ("not ok N - name") and JUnit XML (<testcase><failure>) so the model sees
// WHICH test broke (and where), not just a pass/fail blob. Pure + testable.
export function parseTestFailures(text) {
  const clean = String(text ?? "").replace(/\x1b\[[0-9;]*m/g, "");
  const rows = [];
  const seen = new Set();
  // TAP: `not ok N - name`
  for (const m of clean.matchAll(/^not ok\s+\d+\s*-\s*(.+)$/gm)) {
    const name = m[1].trim().slice(0, 140);
    if (name && !seen.has(name)) {
      seen.add(name);
      rows.push(`test: ${name} (TAP)`);
    }
  }
  // JUnit: <testcase name="x">...<failure ...
  for (const m of clean.matchAll(/<testcase\s+[^>]*name="([^"]+)"[^>]*>(?:(?!<\/testcase>)[\s\S])*?<failure/g)) {
    const name = m[1].slice(0, 140);
    if (name && !seen.has(name)) {
      seen.add(name);
      rows.push(`test: ${name} (JUnit)`);
    }
  }
  return rows.slice(0, 8);
}

export function extractFailures(text, kind = "custom") {
  const clean = String(text ?? "").replace(/\x1b\[[0-9;]*m/g, "").split("\n");
  const pats = FAILURE_PATTERNS[kind] ?? FAILURE_PATTERNS.custom;
  const seen = new Set();
  const out = [];
  for (const line of clean) {
    if (out.length >= 8) break;
    const l = line.trim();
    if (!l || l.length > 300) continue;
    if (FAILURE_SKIP.test(l)) continue;
    if (pats.some((p) => p.test(l)) && !seen.has(l)) {
      seen.add(l);
      out.push(l.slice(0, 160));
    }
  }
  // For test output, also surface per-test failure rows from TAP/JUnit — but
  // only when the test name wasn't already surfaced by a raw pattern line.
  if (kind === "test") {
    for (const row of parseTestFailures(text)) {
      if (out.length >= 8) break;
      const name = row.slice(row.indexOf(": ") + 2, row.lastIndexOf(" ("));
      if (name && out.some((l) => l.includes(name))) continue;
      if (!seen.has(row)) {
        seen.add(row);
        out.push(row);
      }
    }
  }
  return out;
}

// Edit-mismatch marker: both error variants pi's edit tool emits on an oldText
// miss — batch form "Could not find edits[N] in <file>", single-edit form
// "Could not find the exact text in <file>".
export const EDIT_MISS_RE = /could not find (?:the exact text|edits\[\d+\])/i;

// Edit-mismatch coach (v1.13.1): the edit tool fails with a byte-exact
// "Could not find oldText" error and gives no diagnostics. These helpers
// simulate the tool's atomic batch matching and locate the intended block in
// the target file, reporting the EXACT byte diff — indent count, tabs-vs-
// spaces, CRLF-vs-LF, invisible chars (em-dash, curly quotes, NBSP) — so the
// model fixes the mismatch in one shot instead of blind retries.
const countLead = (s) => {
  let sp = 0;
  let tb = 0;
  for (const ch of s) {
    if (ch === " ") sp++;
    else if (ch === "\t") tb++;
    else break;
  }
  return { sp, tb };
};
const lineClose = (a, b) => {
  if (a === b) return true;
  const n = Math.min(a.length, b.length);
  let d = 0;
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) d++;
  return d + Math.abs(a.length - b.length) <= Math.max(1, Math.floor(Math.max(a.length, b.length) * 0.25));
};
const leadRepr = (s) => {
  const { sp, tb } = countLead(String(s));
  if (!sp && !tb) return "no indent";
  const parts = [];
  if (tb) parts.push(`${tb} tab${tb > 1 ? "s" : ""}`);
  if (sp) parts.push(`${sp} space${sp > 1 ? "s" : ""}`);
  return parts.join(" + ");
};

/** Byte-diff one file line against the intended oldText line (null when byte-equal). */
function lineDiff(target, intent) {
  if (target === intent) return null;
  const tLead = countLead(target);
  const iLead = countLead(intent);
  if (tLead.sp !== iLead.sp || tLead.tb !== iLead.tb) {
    return `indent mismatch: file has ${leadRepr(target)}, oldText has ${leadRepr(intent)}`;
  }
  if (target.endsWith("\r") !== intent.endsWith("\r")) {
    return `line ending: file uses ${target.endsWith("\r") ? "CRLF" : "LF"}, oldText uses ${intent.endsWith("\r") ? "CRLF" : "LF"}`;
  }
  const n = Math.min(target.length, intent.length);
  for (let i = 0; i < n; i++) {
    if (target[i] !== intent[i]) {
      const a = target[i];
      const b = intent[i];
      const cp = (c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
      return `char ${i + 1}: file has ${JSON.stringify(a)} (${cp(a)}), oldText has ${JSON.stringify(b)} (${cp(b)})`;
    }
  }
  return `length differs after ${JSON.stringify(target.slice(0, n))} (file ${target.length} chars, oldText ${intent.length})`;
}

/** Given a file's text and an oldText that FAILED to match, find the best
 *  whitespace-normalized anchor in the file and report what differs, or null
 *  when nothing is close (wrong file/region — stay silent rather than guess). */
export function editMismatchHint(fileText, oldText) {
  const f = String(fileText ?? "").split("\n");
  const o = String(oldText ?? "").split("\n");
  if (o.length > 1 && o[o.length - 1] === "") o.pop(); // trailing newline
  if (!o.length || o.every((l) => !l.trim())) return null;
  const norm = (l) => l.replace(/\s+/g, " ").trim();
  const nf = f.map(norm);
  const no = o.map(norm);
  if (o.length > f.length) {
    return `your oldText has ${o.length} lines but the file only has ${f.length} lines`;
  }
  let best = null;
  for (let i = 0; i + o.length <= f.length; i++) {
    let score = 0;
    for (let j = 0; j < o.length; j++) if (no[j] === nf[i + j]) score++;
    if (!best || score > best.score) best = { i, score };
    if (score === o.length) break;
  }
  if (!best || best.score === 0) {
    // No whitespace-normalized exact hit — retry with fuzzy line closeness:
    // an invisible char (em-dash vs hyphen, curly quotes) is NOT whitespace,
    // so it changes the norm; the byte-diff below still pinpoints it.
    best = null;
    for (let i = 0; i + o.length <= f.length; i++) {
      let score = 0;
      for (let j = 0; j < o.length; j++) if (lineClose(nf[i + j], no[j])) score++;
      if (!best || score > best.score) best = { i, score };
    }
    if (!best || best.score === 0) return null;
  }
  const diags = [];
  for (let j = 0; j < o.length && diags.length < 2; j++) {
    const d = lineDiff(f[best.i + j], o[j]);
    if (d) diags.push(`block line ${j + 1} (file line ${best.i + j + 1}): ${d}`);
  }
  if (!diags.length) return null;
  const near =
    best.score === o.length
      ? `your ${o.length}-line block matches at file lines ${best.i + 1}–${best.i + o.length}: `
      : `best match for ${o.length}-line block at file lines ${best.i + 1}–${best.i + o.length} (${best.score}/${o.length} lines close): `;
  return near + diags.join("; ");
}

/** Simulate the edit tool's atomic batch matching: apply edits in order and
 *  return the indices whose oldText is not found (stops at the first miss,
 *  mirroring the tool's whole-call rejection). */
export function mismatchedEditIndices(fileText, edits) {
  const out = [];
  let s = String(fileText ?? "");
  const list = Array.isArray(edits) ? edits : [];
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    const oldText = typeof e?.oldText === "string" ? e.oldText : "";
    if (!oldText) continue;
    const idx = s.indexOf(oldText);
    if (idx === -1) {
      out.push(i);
      break;
    }
    const newText = typeof e?.newText === "string" ? e.newText : "";
    s = s.slice(0, idx) + newText + s.slice(idx + oldText.length);
  }
  return out;
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

/** One `git status --porcelain` spawn shared by the status line + changed set. */
function gitPorcelain(cwd) {
  try {
    const out = execSync("git status --porcelain", {
      cwd,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    // Do NOT trim the leading whitespace: porcelain lines are "<XY> <path>" and
    // the X char can be a space — trim() would shift slice(3) by one and corrupt
    // the first path (a regression that broke autoCommit/gitNewFiles).
    return { ok: true, text: String(out).replace(/\n+$/, "") };
  } catch {
    return { ok: false, text: "" };
  }
}

function statusFromPorcelain({ ok, text }) {
  if (!ok) return "no git repo";
  return text ? text.trim().split("\n").slice(0, 8).map((l) => l.trim()).join(" | ") : "clean";
}

function setFromPorcelain({ ok, text }) {
  const set = new Set();
  if (!ok) return set;
  for (const line of text.split("\n")) {
    const p = line.slice(3).trim();
    if (!p) continue;
    const arrow = p.indexOf(" -> ");
    set.add(arrow !== -1 ? p.slice(arrow + 4) : p);
  }
  return set;
}

// gitStatus / gitChangedSet were removed as redundant: buildSnapshot and
// autoCommit use gitPorcelain/setFromPorcelain/statusFromPorcelain directly.

/** Compact diff of uncommitted tracked changes (stat + body), byte-capped. */
export function gitDiff(cwd, maxBytes = 3000) {
  try {
    const out = execSync("git diff --stat && git diff", {
      cwd,
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let t = String(out).trim();
    if (!t) return "";
    if (t.length > maxBytes) t = t.slice(0, maxBytes) + "\n... (truncated)";
    return t;
  } catch {
    return "";
  }
}

/** Files in the current porcelain set that weren't in the `known` set. */
export function gitNewFiles(cwd, known) {
  const set = setFromPorcelain(gitPorcelain(cwd));
  return { added: [...set].filter((f) => !known?.has(f)), set: [...set] };
}

const TASK_STOP = new Set(["the","a","an","to","of","in","on","for","and","or","with","this","that","it","is","are","be","fix","add","update","change","please","help","make","let","have","not","all","you"]);

function taskTerms(task) {
  return String(task ?? "").toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !TASK_STOP.has(t));
}

/** Score a file's relevance to the task by token overlap in its path. */
function taskScore(rel, terms) {
  if (!terms.length) return 0;
  const path = rel.toLowerCase().split(/[\/._-]+/);
  return terms.reduce((s, t) => s + (path.some((p) => p === t || p.includes(t) || t.includes(p)) ? 1 : 0), 0);
}

const SYMBOL_RES = {
  js: /^\s*(export\s+)?(async\s+)?(function|class|const|let|var)\s+([A-Za-z0-9_$]+)|^\s*module\.exports\s*=|^\s*export\s+default\b/,
  py: /^\s*(async\s+)?def\s+([A-Za-z0-9_]+)|^\s*class\s+([A-Za-z0-9_]+)/,
  go: /^\s*func\s+(\([^)]*\)\s+)?([A-Za-z0-9_]+)|^\s*type\s+([A-Za-z0-9_]+)/,
  rs: /^\s*(pub\s+)?(async\s+)?(fn|struct|enum|trait|impl|type|const|static)\s+([A-Za-z0-9_]+)/,
  rb: /^\s*(def|class|module)\s+([A-Za-z0-9_:]+)/,
  java: /^\s*(public|protected|private)?\s*(static\s+|final\s+)*(class|interface|enum|record)\s+([A-Za-z0-9_]+)/,
  cs: /^\s*(public|protected|private|internal\s+)?\s*(static\s+|sealed\s+|abstract\s+)?\s*(class|interface|enum|record|struct)\s+([A-Za-z0-9_]+)/,
  php: /^\s*(<\?php\s*)?(abstract\s+|final\s+)?(class|interface|trait)\s+([A-Za-z0-9_]+)|^\s*(public|protected|private)?\s*(static\s+)?function\s+([A-Za-z0-9_]+)/,
};

function symbolGroup(rel) {
  if (/\.(py)$/.test(rel)) return "py";
  if (/\.(go)$/.test(rel)) return "go";
  if (/\.(rs)$/.test(rel)) return "rs";
  if (/\.(rb)$/.test(rel)) return "rb";
  if (/\.(java|kt)$/.test(rel)) return "java";
  if (/\.(cs)$/.test(rel)) return "cs";
  if (/\.(php)$/.test(rel)) return "php";
  return "js"; // js/mjs/cjs/ts/tsx + anything unknown
}

function symbolsForFile(content, rel) {
  const re = SYMBOL_RES[symbolGroup(rel)];
  const out = [];
  const lines = String(content).split("\n");
  for (let i = 0; i < lines.length && out.length < 10; i++) {
    const m = lines[i].match(re);
    if (m) out.push(`:${i + 1} ${lines[i].trim().slice(0, 70)}`);
  }
  return out;
}

/**
 * Pure helper: pick the changed source files whose heads should be inlined into
 * the snapshot. Excludes files already shown by the git diff (diffCovered) so the
 * prompt doesn't duplicate the diff. Takes (changed, diff) so it's unit-testable
 * without a git repo; buildSnapshot passes its own scanned/changed/diff through.
 */
export function changedFileHeads(scanned, changed, diff) {
  const diffCovered = new Set();
  for (const m of String(diff ?? "").matchAll(/^diff --git a\/.+? b\/(.+)$/gm)) diffCovered.add(m[1]);
  return (Array.isArray(scanned) ? scanned : [])
    .filter((f) => changed?.has?.(f.rel) && !diffCovered.has(f.rel))
    .slice(0, 2);
}

export function buildSnapshot(cwd, { verifyCmd, baseline, ignore, task } = {}) {
  const ig = Array.isArray(ignore) && ignore.length ? ignore : DEFAULT_CONFIG.ignore;
  // One porcelain spawn reused for both the status line and the changed set.
  const git = gitPorcelain(cwd);
  const changed = setFromPorcelain(git);
  const terms = taskTerms(task);
  // Source extensions surfaced first once the file cap is hit, so the snapshot
  // favours the code the task is actually about.
  const PRIORITY = [".ts", ".tsx", ".mjs", ".js", ".cjs", ".py", ".go", ".rs", ".java", ".kt", ".cs", ".rb", ".php"];
  const isPriority = (rel) => PRIORITY.some((x) => rel.endsWith(x));

  // Pass 1: cheap directory walk — collect candidate paths only (no file reads).
  // Cap higher than the final 30 so we can rank by relevance before trimming.
  const rels = [];
  const stack = [cwd];
  while (stack.length && rels.length < 120) {
    const cur = stack.pop();
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
        if (!isIgnored(rel, ig)) stack.push(full);
      } else if (e.isFile() && !isIgnored(rel, ig)) {
        try {
          if (statSync(full).size > 1_000_000) continue; // skip big/binary files
        } catch {
          continue;
        }
        rels.push(rel);
      }
    }
  }

  // Rank by relevance (git-changed → source file → alphabetical), then select
  // files within a byte budget instead of a blind file count. Small projects get
  // full coverage; large projects spend the budget on the most relevant code
  // rather than a flat top-N (which under-serves wide/context-heavy repos).
  // Sizes come from statSync — no file content is read to choose the set.
  const scored = new Map(rels.map((r) => [r, taskScore(r, terms)]));
  rels.sort((a, b) => {
    const ca = changed.has(a) ? 0 : 1;
    const cb = changed.has(b) ? 0 : 1;
    if (ca !== cb) return ca - cb;
    const sa = scored.get(a);
    const sb = scored.get(b);
    if (sa !== sb) return sb - sa; // task-relevant files first
    const pa = isPriority(a) ? 0 : 1;
    const pb = isPriority(b) ? 0 : 1;
    if (pa !== pb) return pa - pb;
    return a < b ? -1 : a > b ? 1 : 0;
  });
  const MAX_FILES = 60;
  const BYTE_BUDGET = 200_000; // ~50k tokens of source, bounded I/O
  const files = [];
  let budget = BYTE_BUDGET;
  for (const rel of rels) {
    if (files.length >= MAX_FILES) break;
    if (files.length >= 3 && budget <= 0) break; // always keep at least the top 3
    let size = 0;
    try {
      size = statSync(join(cwd, rel)).size;
    } catch {
      continue;
    }
    files.push(rel);
    budget -= size;
  }

  // Pass 2: read each selected file ONCE and reuse its content for both the
  // line count and the symbol scan (was two separate reads per file before).
  let s = "HARNESS SNAPSHOT\n";
  s += `- verify: ${verifyCmd ?? "none"}\n`;
  s += baseline
    ? `- baseline: ${baseline.ok ? "GREEN" : "RED"}${baseline.ok ? "" : ` — ${tail(baseline.output, 2)}`}\n`
    : "- baseline: N/A (no verify command)\n";
  s += `- git: ${statusFromPorcelain(git)}\n`;
  // Context engineering: surface the actual state of what changed so the model
  // doesn't need extra read calls to learn what a resumed run has done so far.
  const diff = gitDiff(cwd, 3000);
  if (diff) s += "- diff (uncommitted tracked changes):\n" + diff.split("\n").map((l) => "  " + l).join("\n") + "\n";
  s += "- files:\n";
  const scanned = [];
  for (const rel of files) {
    let n = 0;
    let content = "";
    try {
      content = readFileSync(join(cwd, rel), "utf8");
      // Count newlines without materializing a full line array.
      let c = 1;
      for (let k = 0; k < content.length; k++) if (content.charCodeAt(k) === 10) c++;
      n = c;
    } catch {
      continue;
    }
    s += `  - ${rel} (${n} lines)\n`;
    scanned.push({ rel, content });
  }
  s += "- symbols:\n";
  let symbolCount = 0;
  for (const { rel, content } of scanned) {
    if (symbolCount >= 40) break;
    try {
      const syms = symbolsForFile(content, rel);
      for (const sm of syms) {
        if (symbolCount++ >= 40) break;
        s += `  - ${rel}${sm}\n`;
      }
    } catch {
      /* skip unreadable */
    }
  }
  // Context engineering: surface the heads of up to 2 changed source files so
  // the model sees actual code for the hot files without extra read calls.
  // Show heads only for changed files the git diff does NOT already cover (e.g.
  // untracked new files) — avoids duplicating the diff in the prompt.
  const hot = changedFileHeads(scanned, changed, diff);
  if (hot.length) {
    s += "- context (changed-file heads):\n";
    for (const { rel, content } of hot) {
      s += `  --- ${rel} ---\n` + content.split("\n").slice(0, 15).map((l) => `  ${l}`).join("\n") + "\n";
    }
  }
  return s;
}

// ---- Report rendering ------------------------------------------------------

export function fmt(n) {
  return Number(n ?? 0).toLocaleString("en-US");
}

function verifyMeaning(run) {
  switch (run.verifyKind) {
    case "script":
      return "project script gate (test/typecheck)";
    case "tsc":
      return "TypeScript typecheck (tsc --noEmit)";
    case "test":
      return "test runner gate (pytest / rake / phpunit)";
    case "vet":
      return "go vet (compiles + static checks)";
    case "compile":
      return "compile gate (cargo / mvn / gradle / dotnet)";
    case "syntax":
      return "syntax check — weak oracle, review diffs";
    case "custom":
      return "harness.json verifyCmd override";
    default:
      return "no gate — degraded (correctness via diff review)";
  }
}

/** Build [field, value, meaning] rows for the HARNESS REPORT table — grouped: VERDICT / EFFICIENCY / SAFETY. */
export function reportRows(run) {
  const st = run.stats ?? {};
  const total = (st.tokensIn ?? 0) + (st.tokensCached ?? 0) + (st.tokensOut ?? 0);
  const hit = total > 0 ? Math.round(((st.tokensCached ?? 0) / total) * 100) : 0;
  const status =
    run.status === "stopped"
      ? "stopped (budget)"
      : run.status === "done"
        ? run.settleCap
          ? "done (settle cap)"
          : "done"
        : String(run.status ?? "?");
  const rows = [["VERDICT", "", ""]];
  rows.push(
    ["status", status, run.status === "stopped" ? "stopped at budget" : "finished"],
    ["verify", run.verifyLabel ?? "none", verifyMeaning(run)],
    ["baseline", run.baseline ? (run.baseline.ok ? "GREEN" : "RED") : "N/A", "pre-run state"],
  );
  if (st.skillCardTokens) {
    rows.push(["skill cards", `${st.skillCardTokens} tok`, "operating-discipline card tokens injected this run"]);
  }
  // Ideation phase row: shown only for ideate runs (or a set gate 1 verdict), so
  // the default implement path's report stays clean.
  if (run.phase === "ideate" || run.plan?.gate1) {
    const g1 = run.plan?.gate1;
    const meaning =
      g1 === "rejected"
        ? "no build — ideation concluded no viable idea"
        : g1 === "pending"
          ? "candidates produced — gate 1 pending"
          : g1 === "passed"
            ? "candidates reviewed — gate 1 passed"
            : g1 === "skipped"
              ? "candidates — gate 1 skipped (override)"
              : "ideation";
    rows.push(["phase", "ideate", meaning]);
  }
  if (run.verifyCwd && run.verifyCwd !== run.cwd) {
    rows.push(["gate root", run.verifyCwd, "manifest above cwd"]);
  }
  if (run.fullCmd && run.status === "done") {
    const fg = st.finalFull;
    const meaning = !fg
      ? "not run"
      : fg.ok
        ? "passed at completion"
        : run.baselineFull?.ok
          ? "failed — fix before shipping"
          : "still failing (baseline already red)";
    rows.push(["full gate", fg ? (fg.ok ? "PASS" : "FAIL") : "skipped", meaning]);
  }
  if (run.status === "stopped") {
    const fg = st.finalGate;
    const meaning = !fg
      ? "no gate"
      : fg.ok
        ? "re-verified at stop"
        : run.baseline?.ok
          ? "build broke — fix before shipping"
          : "still failing (baseline already red)";
    rows.push(["final gate", fg ? (fg.ok ? "PASS" : "FAIL") : "skipped", meaning]);
  }
  // Acceptance closure (v1.13): the model's own acceptance statement — verdict,
  // criteria ticks, and any configured task-targeted probe result — so "done"
  // carries the model's evidence, not just a green gate.
  const acc = run.acceptance;
  if (acc?.verdict || acc?.criteria?.length) {
    const verdict = acc?.verdict ?? "not stated";
    const meaning =
      verdict === "met" ? "criteria satisfied per model" :
      verdict === "partial" ? "some criteria not met" :
      verdict === "unmet" ? "model reports acceptance NOT met" :
      acc?.criteria?.length ? "criteria listed, no verdict" : "not stated";
    rows.push(["acceptance", verdict, meaning]);
    if (acc?.criteria?.length) {
      const done = acc.criteria.filter((c) => c.done).length;
      rows.push(["criteria", `${done}/${acc.criteria.length}`, String(acc.criteria[0]?.text ?? "").slice(0, 40)]);
    }
  }
  if (run.acceptResult) {
    rows.push(["accept probe", run.acceptResult.ok ? "PASS" : "FAIL", run.acceptCmd ? `task-targeted: ${run.acceptCmd}` : "acceptCmd probe"]);
  }
  if (run.memoryCheck) {
    rows.push(["failure memory", run.memoryCheck.ok ? "recorded" : "missing", run.memoryCheck.note]);
  }
  rows.push(["EFFICIENCY", "", ""]);
  rows.push(
    ["gate runs / fails", `${st.gateRuns ?? 0} / ${st.gateFails ?? 0}`, "per-edit gate runs / fails"],
    ["gate cache hits", `${st.gateCacheHits ?? 0}`, "cross-run green gates reused (gap #2)"],
    ["turns", `${fmt(st.turns)} / ${run.budget?.maxTurns ?? "?"}`, "used / budget"],
    ["calls", fmt(st.calls), "API calls"],
    ["est. cost", `$${(st.cost ?? 0).toFixed(4)}`, "total, all rates"],
    ["tokens", `${fmt(st.tokensIn)} / ${fmt(st.tokensCached)} (${hit}%) / ${fmt(st.tokensOut)}`, "in / cached% / out"],
    ["peak turn cost", `$${(st.peakTurnCost ?? 0).toFixed(4)}`, "most expensive single turn"],
  );
  if (run.trend) {
    rows.push(["trend", `median ${run.trend.median} turns (${run.trend.n} runs)`, `suggests maxTurns ${run.trend.suggestion} — ${run.trend.reason}`]);
  }
  if (run.status === "stopped" && run.estRemaining != null) {
    rows.push(["est. remaining", `${run.estRemaining} turns`, "resume with /harness-resume"]);
  }
  if (run.resumeCount > 0) {
    rows.push(["resumes", fmt(run.resumeCount), "via /harness-resume"]);
  }
  if (run.budget?.estBias) {
    rows.push(["est. accuracy", `${run.budget.estBias.n} runs, bias ${run.budget.estBias.bias.toFixed(1)}`, "avg actual−predicted"]);
  }
  if (run.autoCommitResult) {
    const r = run.autoCommitResult;
    // When auto-commit skips, still surface leftover uncommitted changes (e.g. work
    // done via bash outside the declared scope) so the user isn't misled into
    // thinking there's nothing to commit.
    let note;
    if (r.committed) {
      note = `committed ${r.count} file(s)${r.leftover?.length ? `; ${r.leftover.length} uncommitted (${r.leftover.slice(0, 3).join(", ")}...)` : ""}`;
    } else if (r.leftover?.length) {
      note = `skipped (${r.reason ?? "not committed"}); ${r.leftover.length} uncommitted: ${r.leftover.slice(0, 3).join(", ")}${r.leftover.length > 3 ? "..." : ""}`;
    } else {
      note = r.reason ?? "not committed";
    }
    rows.push(["auto-commit", r.committed ? `PASS (${r.count})` : "skipped", note]);
  }
  if ((run.plan?.tasks?.length ?? 0) > 0) {
    rows.push(["plan", `${run.plan.tasks.length} tasks${run.plan?.risky ? " (RISKY)" : ""}${run.plan?.gate2 ? ` | gate2 ${run.plan.gate2}` : ""}`, "Goal/Plan/Tasks"]);
  }
  const prog = run.plan?.progress;
  if (prog && prog.total > 0) {
    const cur = prog.current ? ` | on: ${String(prog.current).slice(0, 40)}` : (prog.remaining === 0 ? " | all done" : "");
    rows.push(["plan progress", `${prog.done}/${prog.total} (${prog.remaining} left)${cur}`, "checkbox ticks"]);
  }
  const lane = run.lane ?? "?";
  const laneMeaning = lane === "S" ? "trivial" : lane === "M" ? "small" : lane === "L" ? "boundary/risk" : "unset";
  rows.push(["lane", lane, laneMeaning]);
  if (run.verifyTier) rows.push(["verify tier", run.verifyTier, "quick/standard/full"]);
  const stages = run.stage === "review" ? "planning → development → review" : run.stage === "development" ? "planning → development" : run.stage ? "planning" : "?";
  rows.push(["stages", stages, "lifecycle"]);
  rows.push(["SAFETY", "", ""]);
  rows.push(
    ["blocked edits", fmt(st.blockedEdits), "scope/safety blocks"],
    ["ladder escalated", run.ladder?.escalated ? "yes" : "no", "thinking raised on gate fails"],
  );
  return rows;
}

/** Compact one-line summary shown above the report table (scannable TL;DR). */
export function buildTldr(run) {
  const st = run.stats ?? {};
  const total = (st.tokensIn ?? 0) + (st.tokensCached ?? 0) + (st.tokensOut ?? 0);
  const hit = total > 0 ? Math.round(((st.tokensCached ?? 0) / total) * 100) : 0;
  const statusVal = run.status === "stopped" ? "stopped" : run.status === "done" ? (run.settleCap ? "done (settle cap)" : "done") : String(run.status ?? "?");
  const statusC = run.status === "done" ? (run.settleCap ? color.yellow : color.green) : run.status === "stopped" ? color.yellow : color.red;
  return [
    statusC(statusVal),
    `${st.calls ?? 0} calls`,
    `$${(st.cost ?? 0).toFixed(4)}`,
    `${hit}% cached`,
    `gate ${st.gateRuns ?? 0}/${st.gateFails ?? 0}`,
    `turns ${st.turns ?? 0}/${run.budget?.maxTurns ?? "?"}`,
  ].join(" · ");
}

/** Map a report row's field + value to an ANSI color fn (or undefined when not colorable). */
export function reportColor(field, value) {
  if (!USE_COLOR) return undefined;
  switch (field) {
    case "status":
      return value.startsWith("done") ? color.green : value.startsWith("stopped") ? color.yellow : color.red;
    case "baseline":
      return value === "GREEN" ? color.green : value === "RED" ? color.red : undefined;
    case "full gate":
    case "final gate":
      return value === "PASS" ? color.green : value === "FAIL" ? color.red : undefined;
    case "ladder escalated":
      return value === "yes" ? color.yellow : undefined;
    default:
      return undefined;
  }
}

/** ASCII-safe table renderer (box chars misalign in some TUIs): wraps long cells, aligns columns. */


export function renderTable(rows, opts = {}) {
  const caps = { field: 20, value: 34, meaning: 46, ...(opts.caps ?? {}) };
  const capNames = ["field", "value", "meaning"];
  const colorOf = opts.color; // (field, value) => color fn | undefined
  const norm = (r) => [String(r[0] ?? ""), String(r[1] ?? ""), String(r[2] ?? "")];
  const all = [["field", "value", "meaning"], ...rows.map(norm)];

  const wrap = (text, w) => {
    const words = String(text).split(/\s+/).filter(Boolean);
    if (!words.length) return [""];
    const lines = [];
    let cur = "";
    for (const wd of words) {
      if (wd.length > w) {
        if (cur) lines.push(cur);
        cur = "";
        lines.push(wd.slice(0, w));
        continue;
      }
      const next = cur ? `${cur} ${wd}` : wd;
      if (next.length > w) {
        lines.push(cur);
        cur = wd;
      } else {
        cur = next;
      }
    }
    if (cur) lines.push(cur);
    return lines;
  };

  const widths = [0, 1, 2].map((i) => Math.min(caps[capNames[i]], Math.max(5, ...all.map((r) => r[i].length))));
  const pad = (text, w) => text + " ".repeat(Math.max(0, w - text.length));
  const hline = (mid) => `+${"-".repeat(widths[0] + 2)}${mid}${"-".repeat(widths[1] + 2)}${mid}${"-".repeat(widths[2] + 2)}+`;

  const out = [hline("+")];
  const renderRow = (r, field) => {
    const cells = r.map((c, i) => wrap(c, widths[i]));
    const h = Math.max(...cells.map((c) => c.length));
    for (let l = 0; l < h; l++) {
      // Pad the RAW (uncolored) text to the column width first, then colorize:
      // coloring before padding would let ANSI escape codes inflate the pad
      // length and misalign every colored value (e.g. done, GREEN).
      const padded = cells.map((c, i) => pad(c[l] ?? "", widths[i]));
      const colored = colorOf
        ? padded.map((txt, i) => {
            if (i !== 1 || !field) return txt;
            const fn = colorOf(field, r[1] ?? "");
            return fn ? fn(txt) : txt;
          })
        : padded;
      out.push(`| ${colored.join(" | ")} |`);
    }
  };
  renderRow(all[0], "field");
  out.push(hline("+"));
  for (const r of all.slice(1)) renderRow(r, r[0]);
  out.push(hline("+"));
  return out.join("\n");
}

