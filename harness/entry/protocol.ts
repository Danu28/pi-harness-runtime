// protocol.ts — extracted from harness/index.ts (Batch 5 of REFACTOR-PLAN.md).
// Pure helpers — identical to the original source.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HERE } from "./index-consts.ts";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
export function loadHarnessConfig(cwd: string): Record<string, unknown> {
  const p = join(cwd, "harness.json");
  try {
    if (existsSync(p)) return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    /* bad config → defaults */
  }
  return {};
}

export function readProtocol(): string {
  // Self-contained first: the protocol ships inside the extension dir, so a
  // plain copy of the harness/ folder into extensions/ needs no extra copies.
  // The getAgentDir() mirror path covers legacy flat-layout installs.
  const candidates = [
    join(HERE, "prompts", "run.md"),
    join(getAgentDir(), "prompts", "run.md"),
  ];
  const src = candidates.find((p) => existsSync(p));
  if (!src) return DEFAULT_PROTOCOL;
  try {
    const raw = readFileSync(src, "utf8");
    // Strip YAML frontmatter (it is for /run-as-template autocomplete, not the LLM).
    if (raw.startsWith("---")) {
      const end = raw.indexOf("\n---", 3);
      if (end !== -1) return raw.slice(end + 4).trimStart();
    }
    return raw;
  } catch {
    return DEFAULT_PROTOCOL;
  }
}

export const DEFAULT_PROTOCOL = `# Harness run — efficient task execution

You are executing a task under the harness. Discipline is enforced by code: the
gate runs the verify command after every edit, and edits outside your declared
scope are blocked. Your job is judgment and precision.

> NOTE: prompts/run.md is missing — this is the fallback protocol; the full
> marker/pipeline harness (Thinking/Lane/Persona markers, planning gates,
> snapshot, telemetry) is unavailable. Proceed as a plain task: restate,
> make minimal changes, verify with the project's own checks, report what
> changed.

## Task
{{TASK}}

## Snapshot
{{SNAPSHOT}}

## Protocol
1. Restate the task in one line. If ambiguous, ask ONE clarifying question — then proceed.
2. Call harness_declare with ONLY the files the task requires (relative paths), before your first edit. Edits are blocked until you declare — do not declare memory/, docs/, or unrelated files.
3. Read only what you need: prefer grep and targeted read (offset/limit) over whole-file reads. Keep the prompt prefix stable — don't re-print already-shown context — to maximize cache hits and cut cost.
4. Make edits in small batches. After each edit the GATE result is appended to the tool result — watch it. Verify command: {{VERIFY}}
5. GATE FAIL: read the exact error, form ONE hypothesis, make ONE fix. Never stack fixes. After {{MAXFAILS}} consecutive fails the harness raises thinking; at {{MAXTURNS}} turns the run is stopped.
6. Baseline was {{BASELINE}} before you started — {{BASELINE_NOTE}}
7. Done = GATE passes + you reviewed the complete diff of your changes once + acceptance is met. Write a short summary: what changed, files touched, gate result. Prefer ending it with 'Commit: <one-line what-changed>' — the auto-commit uses that line as its subject (otherwise it falls back to your summary's first line). If you CANNOT finish within the remaining budget, end your summary with a line exactly like \"Remaining: N turns\" so the harness can tell the user how much more is needed. The harness reports cost stats after you finish.`;
