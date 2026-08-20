// output.mjs — part of the tool-output processing / edit-mismatch coaching domain extracted from harness-core.mjs (Batch 2 of
// REFACTOR-PLAN.md). Pure logic, identical to the original source.
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
