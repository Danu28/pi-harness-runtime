// compile-skills.mjs — validate runtime skill-cards against their SKILL.md sources.
//
// The full skills are process templates (~1300-3800 tokens each). Loading them
// into every agent context is the "skills fill context" leak. Each skill gets a
// compact runtime card in skillcards/ (~300-500 tokens) that the dev-loop injects
// instead. This script proves the win: it verifies a card exists for every core
// skill, enforces a token budget, and prints the size reduction.
//
//   node compile-skills.mjs [skillsRoot] [cardDir]
// Pure helpers are exported for unit testing (node --test).
//
// Environment semantics: the SOURCES live outside the repo
// (~/.pi/agent/skills/<name>/SKILL.md), so on a fresh machine/CI where the
// whole skills root is absent the source comparison is SKIPPED (exit 0) while
// the repo-local invariants (card exists, ≤ CARD_MAX_TOKENS) are still
// enforced. A missing source inside a provisioned root is real drift → FAIL.
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

export const HERE = dirname(fileURLToPath(import.meta.url));

export const CORE_SKILLS = ["planner", "reviewer", "builder", "verifier", "shared-project-memory", "first-principles"];
// Target is ~300 tokens/card; this is a hard cap using a chars/4 token estimate.
export const CARD_MAX_TOKENS = 500;
export const DEFAULT_SKILLS_ROOT = join(homedir(), ".pi", "agent", "skills");

/** Rough token estimate (chars/4). Good enough to enforce a budget. */
export function estimateTokens(text) {
  return Math.ceil(String(text ?? "").length / 4);
}

/** Validate one skill's card: exists, matches a source, within token budget. */
export function checkCard(skillsRoot, cardDir, name) {
  const cardPath = join(cardDir, `${name}.md`);
  if (!existsSync(cardPath)) return { name, ok: false, error: `missing card ${cardPath}` };
  const cardToks = estimateTokens(readFileSync(cardPath, "utf8"));
  if (cardToks > CARD_MAX_TOKENS) {
    return { name, ok: false, error: `card ${cardToks} tok exceeds ${CARD_MAX_TOKENS}` };
  }
  const src = join(skillsRoot, name, "SKILL.md");
  if (!existsSync(skillsRoot)) {
    return { name, ok: true, skipped: true, error: `no skills root at ${skillsRoot}` };
  }
  if (!existsSync(src)) return { name, ok: false, error: `missing source ${src}` };
  const srcToks = estimateTokens(readFileSync(src, "utf8"));
  return { name, ok: true, srcToks, cardToks, saved: srcToks - cardToks, pct: Math.round((100 * cardToks) / srcToks) };
}

/** Validate every core skill. Returns one result per skill. */
export function compileSkills(skillsRoot, cardDir) {
  return CORE_SKILLS.map((n) => checkCard(skillsRoot, cardDir, n));
}

// CLI: run only when this file is the entry point (not when imported by node --test).
if (process.argv[1] && process.argv[1].split(/[\\/]/).pop() === "compile-skills.mjs") {
  const skillsRoot = process.argv[2] ?? DEFAULT_SKILLS_ROOT;
  const cardDir = process.argv[3] ?? join(HERE, "skillcards");
  const results = compileSkills(skillsRoot, cardDir);
  for (const r of results) {
    if (r.skipped) console.log(`SKIP ${r.name}: ${r.error}`);
    else if (r.ok) console.log(`OK   ${r.name}: ${r.srcToks} -> ${r.cardToks} tok (${r.saved} saved, ${r.pct}%)`);
    else console.log(`FAIL ${r.name}: ${r.error}`);
  }
  const bad = results.filter((r) => !r.ok);
  const totalSrc = results.reduce((a, r) => a + (r.srcToks ?? 0), 0);
  const totalCard = results.reduce((a, r) => a + (r.cardToks ?? 0), 0);
  console.log(`\nTOTAL: ${totalSrc} -> ${totalCard} tok (${totalSrc - totalCard} saved)`);
  process.exit(bad.length ? 1 : 0);
}
