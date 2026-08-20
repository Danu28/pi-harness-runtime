// safety.mjs — part of the bash-safety + path/scope domain extracted from harness-core.mjs (Batch 1 of
// REFACTOR-PLAN.md). Pure logic, identical to the original source.
import { relative, resolve, sep } from "node:path";

/**
 * Token-aware dangerous-command matcher. Returns the matched pattern (truthy) or
 * null (safe). Unlike a substring match, `rm -rf /tmp` and `rm -rf ~/build` are
 * allowed while the catastrophic `rm -rf /`, `rm -rf ~`, and `sudo rm -rf /` are
 * blocked: leading wrappers (sudo/env/cd/time) are peeled, then the rm target is
 * compared exactly against `/`, `~`, or `$HOME`. Quoted targets are unquoted.
 */
export function dangerousBash(cmd) {
  const c = String(cmd ?? "").trim();
  if (!c) return null;
  let s = c;
  s = s.replace(/^(sudo\s+|time\s+)+/, "");
  s = s.replace(/^env\s+[\w=]+\s+/, "");
  s = s.replace(/^cd\s+[^;&|]+\s*(?:&&|\|\||[;&|])\s*/, "");
  s = s.trim();
  const toks = s.split(/[;&|]|\s+/).filter(Boolean);
  const head = toks[0] ?? "";
  if (head === "rm") {
    // Parse rm flags (short -r/-f, long --recursive/--force) and the target,
    // honoring a `--` end-of-options separator. Catastrophic only when recursive
    // AND force AND the target is exactly /, ~, or $HOME — safe subdirs pass.
    let recursive = false;
    let force = false;
    let target = null;
    let afterSep = false;
    for (let i = 1; i < toks.length; i++) {
      const t = toks[i];
      if (afterSep) {
        target = t;
        break;
      }
      if (t === "--") {
        afterSep = true;
        continue;
      }
      if (t.startsWith("--")) {
        if (t.includes("recursive")) recursive = true;
        if (t.includes("force")) force = true;
        continue;
      }
      if (t.startsWith("-") && t.length > 1) {
        if (t.includes("r")) recursive = true;
        if (t.includes("f")) force = true;
        continue;
      }
      target = t;
      break;
    }
    if (recursive && force && target != null) {
      // Strip quotes AND trailing slashes so `rm -rf $HOME/` and `rm -rf ~/`
      // cannot bypass the guard (they delete the home dir too). Keep a bare "/"
      // intact (root) — collapsing it to "" would let `rm -rf /` escape.
      let t0 = target.replace(/^["'`]+|["'`]+$/g, "");
      if (t0.length > 1) t0 = t0.replace(/\/+$/, "");
      if (t0 === "/" || t0 === "~" || t0 === "$HOME" || t0 === "$home") return "rm -rf /|~|$HOME";
    }
  }
  if (c.includes("mkfs")) return "mkfs";
  if (c.includes(":(){")) return "fork bomb";
  if (/\s*>\s*\/dev\/sd/.test(c)) return "> /dev/sd*";
  if (/\bdel\s+\/f\s+\/s\s+\/q\s+c:/i.test(c)) return "del /f /s /q c:";
  if (/\brd\s+\/s\s+\/q\s+c:/i.test(c)) return "rd /s /q c:";
  return null;
}

/**
 * Warn→confirm tiers (gap #9): map a dangerous command's matched pattern to a
 * configured tier. `dangerTiers` (harness.json) is `{ "<pattern>": "block" |
 * "confirm" | "allow" }` where pattern is exactly what `dangerousBash()` returns
 * (e.g. "rm -rf /|~|$HOME"). Default fallback is "block" — today's hard-block.
 * Returns { tier: null } when the command is safe, else { tier, pattern }.
 */
export function dangerTier(cmd, tiers = {}, fallback = "block") {
  const hit = dangerousBash(cmd);
  if (!hit) return { tier: null };
  const t = String(tiers?.[hit] ?? fallback);
  return { tier: t === "allow" || t === "confirm" ? t : "block", pattern: hit };
}

const READONLY_CMDS = new Set([
  "ls", "cat", "grep", "rg", "find", "head", "tail", "wc", "echo", "pwd",
  "which", "type", "tree", "printf", "less", "more", "sed", "awk", "sort", "uniq", "cut",
]);
const MUTATING_CMDS = new Set([
  "rm", "mv", "cp", "touch", "mkdir", "rmdir", "ln", "tee", "dd",
  "npm", "yarn", "pnpm", "npx", "bun", "pip", "pip3", "bundle", "gem",
  "make", "cmake", "cargo", "go", "dotnet", "mvn", "mvnw", "gradle", "gradlew",
  "python", "python3", "node", "tsc", "php", "ruby", "gcc", "g++", "javac", "git",
]);
const MUTATING_SUFFIX = ["install", "build", "add", "commit", "apply", "reset", "checkout", "stash", "rebase", "merge", "deploy", "generate", "bundle"];

/**
 * Conservative heuristic: does a bash command plausibly write to the project?
 * Used to decide whether to run the verify gate after a bash tool result.
 * Read-only commands are skipped; redirects, installs, builds and VCS
 * mutations trigger a gate so a command-line fix is verified mid-run.
 */
export function bashMutates(cmd) {
  const c = String(cmd ?? "");
  if (!c.trim()) return false;
  if (/\s*>\s*[^\s]|\s*>>\s*/.test(c)) return true; // output redirect to a file
  const peeled = c.trim().replace(/^(cd [^;|&]+[;|&]?\s*|env\s+[\w=]+\s+|\btime\s+)/, "");
  const toks = peeled.split(/[;|&]+|\s+/).filter(Boolean);
  const head = toks[0] ?? "";
  // In-place edits write files even though the tool is normally read-only.
  if (head === "sed" && /(^|\s)-i(\.[A-Za-z0-9]+)?($|\s)/.test(peeled)) return true;
  if (head === "awk" && /-i\s+inplace/.test(peeled)) return true;
  if (READONLY_CMDS.has(head)) return false;
  if (head === "git") {
    const sub = toks[1] ?? "";
    return !["status", "log", "diff", "show", "branch", "remote", "config", "ls-files", "rev-parse"].includes(sub);
  }
  // Tool-specific read-only flags (e.g. node --check, php -l) are not mutations
  // and shouldn't trigger a redundant gate.
  const READONLY_TOOL_FLAGS = {
    node: ["--version", "--check", "--help"],
    tsc: ["--noEmit", "--version", "--help"],
    php: ["-l", "--version", "--help"],
    ruby: ["-c", "--version", "--help"],
  };
  if (READONLY_TOOL_FLAGS[head]?.some((f) => peeled.includes(f))) return false;
  if (MUTATING_CMDS.has(head)) return true;
  return toks.some((t) => MUTATING_SUFFIX.some((s) => t.endsWith(s)));
}

// Skip-gate classifier (gap #8): a change is "doc-only" when every changed file
// is a documentation/text/image surface (or the diff is empty). Pure-doc edits
// skip the per-edit gate (the review/full gate still runs). Markdown, plain
// text, RST/AsciiDoc, and image assets are safe; config/data files that affect
// the build (package.json, tsconfig, .json, .yaml) are NOT exempt.
const DOC_SURFACE_RE = /\.(md|mdx|txt|rst|adoc|svg|png|jpe?g|gif|webp|ico)$/i;
export function editRequiresGate(changedFiles) {
  const changed = (Array.isArray(changedFiles) ? changedFiles : []).map(String).filter(Boolean);
  if (!changed.length) return false;
  return changed.some((f) => !DOC_SURFACE_RE.test(f));
}

export function normalizeRel(p, cwd) {
  try {
    return relative(resolve(cwd), resolve(p)).split(sep).join("/");
  } catch {
    return String(p);
  }
}

/** Quote a path for safe shell embedding (escapes backslash + double-quote). */
export function shq(p) {
  return `"${String(p).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function insideProject(p, cwd) {
  const r = resolve(cwd);
  const t = resolve(p);
  return t === r || t.startsWith(r + sep);
}

/**
 * Convert a glob pattern to a RegExp. Both `*` and `**` match any characters
 * including `/`, so a pattern matches across path segments:
 *  - `*.pem`   → `key.pem`, `src/key.pem`
 *  - `.env.*`  → `.env.prod`, `.env.sub.prod`
 *  - `src/**`  → `src`, `src/a/b.ts`
 * (Treating `*` as multi-segment is deliberate: these are ignore patterns,
 * and over-matching is safer than under-matching for ignore/scope checks.)
 */
export function globToRegExp(glob) {
  let re = String(glob).replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  re = re.replace(/\*\*/g, ".*");
  re = re.replace(/\*/g, ".*");
  return new RegExp("^" + re + "$");
}

export function isIgnored(rel, ignore) {
  const parts = rel.split("/");
  const base = parts[parts.length - 1] ?? rel;
  return ignore.some((ig) => {
    const i = String(ig).replace(/\/+$/, "");
    if (!i) return false;
    // exact segment / prefix match
    if (parts.includes(i) || rel === i || rel.startsWith(i + "/")) return true;
    // glob support: `*`/`**` match across segments (e.g. *.pem, .env.*,
    // src/**, **/*.test.ts). Test against both the full relative path and the
    // basename so `*.pem` catches `src/key.pem` via the full path, while the
    // basename test also catches patterns that only name a file at any depth.
    if (i.includes("*")) {
      const re = globToRegExp(i);
      if (re.test(rel) || re.test(base)) return true;
    }
    return false;
  });
}

export function scopeAllowed(rel, declared, strict) {
  if (!strict || !Array.isArray(declared) || declared.length === 0) return true;
  return declared.includes(rel);
}

/** Strict scope requires an explicit harness_declare before any edit. */
export function declareRequired(declared, strict) {
  return strict && (!Array.isArray(declared) || declared.length === 0);
}
