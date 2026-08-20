// report.ts — extracted from harness/index.ts (Batch 5 of REFACTOR-PLAN.md).
// Pure helpers — identical to the original source.
import { buildTldr, color, renderTable, reportRows, tail } from "../core/harness-core.mjs";
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
  if (run.plan?.gate1 === "rejected") {
    lines.push("Ideation concluded: no viable idea — no build was performed. Use /run --phase ideate to explore other ideas.");
  }
  if (run.plan?.requirements?.length) {
    lines.push("Requirements (first-principles self-review):");
    for (const r of run.plan.requirements) lines.push(`  - ${r}`);
  }
  lines.push("=== END HARNESS REPORT ===");
  const text = lines.join("\n");
  // Interactive TUI: render through the notification path so the report shows as
  // a discrete banner instead of raw console output interleaved mid-response.
  // Piped/RPC contexts (no TTY, e.g. the smoke suite) keep stdout/stderr output
  // so report markers stay machine-capturable.
  if (process.stdout.isTTY && !process.env.NO_COLOR) {
    try {
      ctx.ui?.notify?.(text, "info");
      return;
    } catch {
      /* fall through to console */
    }
  }
  console.log(text);
}
