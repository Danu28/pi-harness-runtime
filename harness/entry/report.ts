// report.ts — extracted from harness/index.ts (Batch 5 of REFACTOR-PLAN.md).
// Pure helpers — identical to the original source.
import { buildTldr, changedPaths, color, isHarnessPath, renderTable, reportRows, tail, USE_COLOR } from "../core/harness-core.mjs";
import type { RunState } from "./index-consts.ts";
/** Print the HARNESS REPORT table + gate notes. */
export function printReport(run: RunState, ctx: { ui?: { notify?: (text: string, level?: string) => void } }) {
  const lines = [
    `=== HARNESS REPORT ===`,
    buildTldr(run),
    `task: ${run.task}${run.resumeCount > 0 ? ` (resumed x${run.resumeCount})` : ""}`,
    renderTable(reportRows(run), { color: false }),
  ];
  if (run.verifyKind === "none") {
    lines.push("Note: no verify gate — correctness rests on the diff review. Add harness.json (verifyCmd) to enable one.");
  } else if (run.verifyKind === "syntax") {
    lines.push("Note: the gate is a syntax check only — review the diff for correctness before shipping.");
  }
  if (run.status === "stopped") {
    lines.push("Resume with /harness-resume [extraTurns] to continue this run (e.g. /harness-resume 10).");
  }
  if (run.budgetOverage) {
    lines.push("Note: turns exceeded the budget (text-only tail, no tool calls) — the hard stop fires at the next tool call; the run settled naturally.");
  }
  if (run.plan?.requirements?.length) {
    lines.push("Requirements (first-principles self-review):");
    const rv = run.requirementVerdicts ?? {};
    for (const r of run.plan.requirements) {
      const id = String(r).split(/[. ]/)[0];
      const v = rv[id] ? ` — ${rv[id]}` : "";
      lines.push(`  - ${r}${v}`);
    }
  }
  // G2 (scope leak): flag changed files that fall outside the declared edit scope
  // (advisory only — masking .harness artifacts). Lets the report answer "did I
  // touch more than I said I would?" at the last chance before commit.
  try {
    const declared = run.scope?.declared ?? [];
    const changed = changedPaths(run.cwd);
    const out = changed.filter((rel) => !declared.includes(rel) && !isHarnessPath(rel));
    if (out.length) {
      lines.push(`Note: ${out.length} changed file(s) outside declared scope: ${out.slice(0, 5).join(", ")}${out.length > 5 ? "..." : ""}.`);
    }
    // P2 (plan/scope mismatch): flag declared files that were never modified —
    // over-declared scope is the inverse of the leak above, hinting the planned
    // footprint didn't match the work actually done.
    const unused = declared.filter((rel) => !changed.includes(rel));
    if (unused.length) {
      lines.push(`Note: ${unused.length} declared file(s) never modified: ${unused.slice(0, 5).join(", ")}${unused.length > 5 ? "..." : ""}.`);
    }
  } catch {
    /* no git / changedPaths unavailable — skip the note */
  }
  // G1-lite (structural review guard): warn when review is reached with plan
  // tasks still unchecked, so "done" can't silently mean unfinished work.
  const prog = run.plan?.progress;
  if (run.stage === "review" && prog && prog.total > 0 && prog.done < prog.total) {
    lines.push(`Note: review entered with ${prog.remaining} plan task(s) unchecked (${prog.done}/${prog.total}).`);
  }
  // P3 (lane/tier mismatch): a boundary/risk plan under a non-L lane means the
  // initial triage under-called the risk — surface the tier bump explicitly.
  if (run.plan?.risky && run.lane && run.lane !== "L") {
    lines.push(`Note: plan carries a boundary/risk footprint but the run lane was ${run.lane} — verify tier raised to ${run.verifyTier ?? "full"}.`);
  }
  lines.push("=== END HARNESS REPORT ===");
  const text = lines.join("\n");
  // Interactive TUI: render through the notification path so the report shows as
  // a discrete banner instead of raw console output interleaved mid-response.
  // Piped/RPC contexts (no TTY, e.g. the smoke suite) keep stdout/stderr output
  // so report markers stay machine-capturable.
  if (USE_COLOR) {
    try {
      ctx.ui?.notify?.(text, "info");
      return;
    } catch {
      /* fall through to console */
    }
  }
  console.log(text);
}
