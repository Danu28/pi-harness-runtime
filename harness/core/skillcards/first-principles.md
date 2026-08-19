# first-principles — runtime card
## When
Cross-cutting engineering methodology — usable in ANY stage (plan, requirements,
design, debugging, refactor, incident analysis) whenever a request, design, or
"fix" deserves questioning before optimizing. Fast path: purely factual, no
design decisions, no trade-offs — answer directly and exit.

## Core algorithm (Musk 5-step)
1. **Question** every requirement — source, who benefits, what evidence, what
   breaks if ignored, is it still relevant?
2. **Delete** — "if this disappeared tomorrow, what actually breaks?" Remove
   anything with no measurable value; state why if nothing is removed.
3. **Simplify** what remains.
4. **Accelerate** — speed up the simplified thing.
5. **Automate** only after it is proven.

Ordering is strict: delete before simplify, simplify before optimize, measure
before accelerate, validate before automate. Optimization without simplification
creates permanent complexity. Engineering is iterative — if a step reveals an
earlier assumption was wrong, return to the appropriate prior step.

## Plan review (one pass)
After drafting a plan, apply the 5-step lens ONCE: Question → Delete → Simplify →
Accelerate → Automate (only if proven). Record `## First-Principles Review` in the
plan (Questioned / Deleted / Simplified + why). The plan is not final until the
pass is recorded.

## Non-negotiable rules
- **Never fabricate.** Separate Facts / Assumptions / Unknowns; stop and ask
  clarifying questions on missing critical info.
- State assumptions explicitly; prefer evidence over intuition.
- Challenge every requirement; complexity must justify its existence.
- Recommend the smallest solution that fully solves the problem.
- End with a **Final Report**: executive summary, root cause, success criteria,
  facts/assumptions/unknowns, items removed, simplified solution, trade-offs,
  risks, confidence (high/medium/low) + why, ordered next steps.
