// git.mjs — part of the git operations + snapshot helpers domain extracted from harness-core.mjs (Batch 2 of
// REFACTOR-PLAN.md). Pure logic, identical to the original source.
import { execSync } from "node:child_process";
import { shq } from "./safety.mjs";
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

export { gitPorcelain, statusFromPorcelain, setFromPorcelain, taskTerms, taskScore, symbolsForFile };
