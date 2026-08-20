// parse.mjs — part of the text parsing domain extracted from harness-core.mjs (Batch 1 of
// REFACTOR-PLAN.md). Pure logic, identical to the original source.
import { THINK_LEVELS } from "./constants.mjs";
import { AI_CAP } from "./constants.mjs";
import { PERSONA_TAXONOMY } from "./constants.mjs";
import { LANES } from "./constants.mjs";
import { PHASE_TAXONOMY } from "./constants.mjs";

/** Parse a model-stated remaining-work estimate: "Remaining: 5 turns" → 5. */
export function parseRemainingEstimate(text) {
  if (!text) return null;
  const m = String(text).match(/remaining\s*[:=]?\s*(\d+)\s*(turns?|steps?|calls?)?/i);
  return m ? Math.max(0, parseInt(m[1], 10)) : null;
}

// Strip markdown noise from a candidate commit subject: bold markers, bullets,
// backticks/hashes, and whitespace runs. Returns a single-line string or null.
function sanitizeCommitSubject(s) {
  let t = String(s)
    .replace(/\s*\*\*\s*/g, "") // ** bold markers
    .replace(/^[ \t]*[-*•]\s*/, "") // leading bullets
    .replace(/[`#]+/g, "") // backticks / heading hashes
    .replace(/\s+/g, " ") // collapse newlines/whitespace to one space
    .replace(/\s+-\s*$/, "") // trailing " -"
    .trim();
  if (!t) return null;
  return t.length > 72 ? t.slice(0, 69).trimEnd() + "…" : t;
}

/**
 * Derive a quality commit subject from the model's final message:
 *   1. an explicit `Commit: <one-line>` marker line, else
 *   2. the first useful line of its `## Summary` section (or the whole text
 *      when there is no header), skipping Task:/Remaining:/VERDICT lines.
 * Returns null when nothing usable (callers fall back to goal/task).
 */
export function parseCommitSubject(text) {
  const src = String(text ?? "");
  if (!src.trim()) return null;
  const marker = src.match(/^[ \t]*Commit\s*:\s*(.+)$/im);
  if (marker && marker[1].trim()) return sanitizeCommitSubject(marker[1]);
  const sec = src.match(/^#{1,3}\s*Summary\s*$/im);
  const body = sec ? src.slice(sec.index + sec[0].length) : src;
  const skip = /^(?:\*\*)?(?:Task|Summary|Remaining|VERDICT)\s*[:：]/i;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (!line || skip.test(line)) continue;
    const clean = sanitizeCommitSubject(line);
    if (clean) return clean;
  }
  return null;
}

/**
 * Parse /run args into --think/--edit flags and the remaining task text.
 * Each flag consumes its own value token; the rest (quotes preserved as tokens)
 * is re-joined as the task. Malformed flags are ignored (their tokens dropped).
 * Returns { flags: { think, edit }, task }.
 */
export function parseRunArgs(args) {
  const flags = { think: null, edit: null, persona: null, lane: null, budget: null, phase: null };
  if (!args) return { flags, task: "" };
  const tokens = String(args).match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  const rest = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t === "--phase") {
      const val = tokens[i + 1];
      if (val && !val.startsWith("--") && PHASE_TAXONOMY.includes(val.toLowerCase())) {
        flags.phase = val.toLowerCase();
        i++; // consume the value token
      }
      // else: missing/invalid value → drop the flag token, keep the rest
      continue;
    }
    if (t === "--budget") {
      // Numeric cost ceiling (dollars) for the soft-warning; NaN/<=0 dropped.
      const val = tokens[i + 1];
      const num = val && !val.startsWith("--") ? Number(val) : NaN;
      if (Number.isFinite(num) && num > 0) {
        flags.budget = num;
        i++; // consume the value token
      }
      // else: missing/invalid value → drop the flag token, keep the rest
      continue;
    }
    if (t === "--think" || t === "--edit" || t === "--persona" || t === "--lane") {
      const key = t === "--persona" ? "persona" : t === "--think" ? "think" : t === "--edit" ? "edit" : "lane";
      const val = tokens[i + 1];
      const valid =
        key === "persona"
          ? val && !val.startsWith("--") && PERSONA_TAXONOMY.includes(val)
          : key === "lane"
            ? val && !val.startsWith("--") && LANES.includes(val.toUpperCase())
            : val && !val.startsWith("--") && THINK_LEVELS.includes(val);
      if (valid) {
        flags[key] = key === "lane" ? val.toUpperCase() : val;
        i++; // consume the value token
      }
      // else: missing/invalid value → drop the flag token, keep the rest
      continue;
    }
    rest.push(stripOuterQuotes(t));
  }
  return { flags, task: rest.join(" ") };
}

/** Remove a pair of matching surrounding quotes from a token, if present. */
function stripOuterQuotes(t) {
  if (t.length >= 2) {
    const first = t[0];
    if ((first === '"' || first === "'") && t[t.length - 1] === first) return t.slice(1, -1);
  }
  return t;
}

/**
 * Parse a "Thinking: <level>" prediction from the model's first message.
 * Returns a validated, AI-capped level, or null if absent/invalid. Mirrors
 * parseRemainingEstimate's marker pattern so the harness can read the model's
 * self-assessed complexity and apply it for the planning phase.
 */
export function parseThinkingPrediction(text) {
  if (!text) return null;
  const m = String(text).match(/\bthinking\s*(?:level\s*)?[:=]\s*"?([a-z]+)"?/i);
  if (!m) return null;
  const lvl = m[1].toLowerCase();
  const idx = THINK_LEVELS.indexOf(lvl);
  if (idx === -1) return null;
  const capIdx = THINK_LEVELS.indexOf(AI_CAP);
  return idx > capIdx ? AI_CAP : lvl;
}

/**
 * Remove `## Acceptance` sections from a message BEFORE task-list parsing, so
 * acceptance-criteria checkboxes never leak into the plan tasklist or the
 * plan-progress counts (which scan all `- [x]` lines globally). Stops at the
 * next `##` heading; repeated for every block in the message.
 */
export function stripAcceptanceBlocks(text) {
  let src = String(text ?? "");
  const re = /##\s*Acceptance(?:\s+criteria)?/gi;
  let m;
  while ((m = re.exec(src))) {
    const rest = src.slice(m.index + m[0].length);
    const end = rest.search(/\n(?=##)/); // newline before the next heading
    const blockEnd = end === -1 ? src.length : m.index + m[0].length + end;
    src = src.slice(0, m.index) + src.slice(blockEnd);
    re.lastIndex = 0; // restart the scan on the modified string
  }
  return src;
}

/**
 * Parse the model's acceptance statement from a message. Returns
 * { verdict, criteria } where verdict is the last `Acceptance: met|partial|
 * |unmet` line (null when absent) and criteria are the `- [x]/- [ ]` items
 * under a `## Acceptance` heading. Best-effort: no markers → empty defaults.
 */
export function parseAcceptance(text) {
  const src = String(text ?? "");
  const criteria = [];
  const h = src.match(/##\s*Acceptance(?:\s+criteria)?/i);
  if (h) {
    const rest = src.slice(h.index + h[0].length);
    const end = rest.search(/\n##(?!#)/);
    const block = (end === -1 ? rest : rest.slice(0, end)).trim();
    const re = /^[ \t]*[-*]\s*\[([ xX])\]\s+(.+)$/gm;
    let m;
    while ((m = re.exec(block))) criteria.push({ text: m[2].trim(), done: m[1].toLowerCase() === "x" });
  }
  const vm = src.match(/(?:^|\s)Acceptance\s*:\s*(met|partial|unmet)\b/im);
  return { verdict: vm ? vm[1].toLowerCase() : null, criteria };
}

export function parsePlan(text) {
  const src = stripAcceptanceBlocks(text);
  const goal = (src.match(/^\s*Goal\s*:\s*(.+)$/im)?.[1] ?? "").trim();
  // Plan body: text between a `## Plan` / `Plan:` header and the tasks list.
  let plan = "";
  {
    const pm = src.match(/^\s*(?:##\s*)?Plan\s*:\s*([\s\S]*?)(?=^\s*(?:##|[-*]\s*\[)|$)/im);
    if (pm && pm[1]) plan = pm[1].trim();
  }
  const tasks = [];
  const re = /^[ \t]*[-*]\s*\[[ xX]\]\s+(.+)$/gm;
  let m;
  while ((m = re.exec(src))) {
    const raw = m[1].trim();
    // footprint tag may be bare (`footprint: boundary`) or parenthesized
    // (`(footprint: boundary)`) after the task text.
    const fm = raw.match(/(?:^|\s)(?:\(|\[)?footprint\s*:\s*(none|small|boundary)(?:\)|\])?/i);
    tasks.push({
      text: fm ? raw.slice(0, fm.index).trim() : raw,
      footprint: fm ? fm[1].toLowerCase() : "none",
    });
  }
  const risky = tasks.some((t) => t.footprint === "boundary") || /##\s*Risk Notes/i.test(src);
  return { goal, plan, tasks, risky };
}

/**
 * Parse a "Phase: <ideate|implement>" prediction from the model's first message.
 * Validated against PHASE_TAXONOMY; returns null if absent/invalid. Precedence:
 * --phase flag > this prediction > "implement". Honored only pre-declare.
 */
export function parsePhasePrediction(text) {
  const m = String(text ?? "").match(/Phase:\s*(ideate|implement)\b/i);
  if (!m) return null;
  const phase = m[1].toLowerCase();
  return PHASE_TAXONOMY.includes(phase) ? phase : null;
}

/**
 * Parse a "Lane: <S|M|L>" prediction from the model's first message (the
 * triage marker). Validated against LANES; returns null if absent/invalid.
 * Precedence: --lane flag > this prediction > classifyLane() heuristic.
 */
export function parseLanePrediction(text) {
  const m = String(text ?? "").match(/Lane:\s*([SML])\b/i);
  if (!m) return null;
  const lane = m[1].toUpperCase();
  return LANES.includes(lane) ? lane : null;
}

/**
 * Parse a `## Candidate Requirements` block (the brainstormer's deliverable)
 * into a ranked list of candidate strings. Extracts the numbered/bulleted items
 * under the heading, stopping at the next `##` heading. Best-effort: no block
 * → empty array.
 */
export function parseCandidates(text) {
  const s = String(text ?? "");
  const m = s.match(/##\s*Candidate Requirements/i);
  if (!m) return [];
  const body = s.slice(m.index + m[0].length);
  const end = body.search(/^##(?!#)/m);
  const block = (end === -1 ? body : body.slice(0, end)).trim();
  if (!block) return [];
  return block
    .split(/\n(?=(?:\d+[\.\)]\s|[-*]\s))/)
    .map((l) => l.replace(/^\s*(?:\d+[\.\)]\s|[-*]\s)/, "").trim())
    .filter(Boolean);
}

/**
 * Compute plan-execution progress (revised-plan A4) from a message's checkbox
 * ticks (`- [x]` done vs `- [ ]` open). Returns { done, total, remaining,
 * current } where current = the first open task's text (the task Build should
 * be on), or null when none/complete. Best-effort: no checkboxes → zeros.
 */
export function parsePlanProgress(text) {
  const src = stripAcceptanceBlocks(String(text ?? ""));
  const items = [];
  const re = /^[ \t]*[-*]\s*\[([ xX])\]\s+(.+)$/gm;
  let m;
  while ((m = re.exec(src))) items.push({ done: m[1].toLowerCase() === "x", text: m[2].trim() });
  const done = items.filter((i) => i.done).length;
  const current = items.find((i) => !i.done)?.text ?? null;
  return { done, total: items.length, remaining: items.length - done, current };
}

/**
 * Parse a "Persona: <domain>" marker from the model's first message. Returns a
 * validated taxonomy entry, or null if absent/invalid (caller falls back to
 * generalist). Mirrors parseThinkingPrediction.
 */
export function parsePersona(text) {
  if (!text) return null;
  const m = String(text).match(/\bpersona\s*[:=]\s*"?([a-z-]+)"?/i);
  if (!m) return null;
  const name = m[1].toLowerCase();
  return PERSONA_TAXONOMY.includes(name) ? name : null;
}
