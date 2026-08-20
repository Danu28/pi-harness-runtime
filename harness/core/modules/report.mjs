// report.mjs — part of the report rendering + snapshot assembly domain extracted from harness-core.mjs (Batch 2 of
// REFACTOR-PLAN.md). Pure logic, identical to the original source.
import { join } from "node:path";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { DEFAULT_CONFIG } from "./constants.mjs";
import { USE_COLOR } from "./constants.mjs";
import { changedFileHeads } from "./git.mjs";
import { color } from "./constants.mjs";
import { gitDiff } from "./git.mjs";
import { gitPorcelain } from "./git.mjs";
import { isIgnored } from "./safety.mjs";
import { normalizeRel } from "./safety.mjs";
import { probe } from "./detect.mjs";
import { setFromPorcelain } from "./git.mjs";
import { statusFromPorcelain } from "./git.mjs";
import { symbolsForFile } from "./git.mjs";
import { tail } from "./output.mjs";
import { taskScore } from "./git.mjs";
import { taskTerms } from "./git.mjs";
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
