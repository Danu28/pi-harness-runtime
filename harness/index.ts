/**
 * harness — code-enforced gates for efficient agentic software tasks.
 *
 * /run <task>  →  baseline → snapshot → declare scope → gate-driven edits → report
 *
 * What is enforced in CODE (not prose):
 *  - verify gate: after every edit/write, the project's verify command runs
 *    locally and the pass/fail + error head is appended to the tool result.
 *  - scope + safety: edits outside the project root, matching ignore patterns,
 *    or outside the declared scope (harness_declare) are blocked with a reason.
 *  - cost ladder: ≥N consecutive gate fails escalates thinking low → high;
 *    a turn budget stops the run with a report instead of grinding.
 *  - telemetry: calls / input / cached / output tokens / gate runs/fails are
 *    collected into .harness/run.json and printed in the final report.
 *
 * The harness is INERT when no run is active: every hook early-returns unless
 * a run is in flight (state lives in the module closure, mirrored to
 * .harness/run.json for crash recovery).
 *
 * Pure logic lives in harness-core.mjs (unit-testable without pi).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir, isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  appendEstimateRecord,
  appendRunStats,
  autoCommit,
  bashMutates,
  cleanupRunArtifacts,
  dangerousBash,
  gitNewFiles,
  loadRunStats,
  loadSkillCard,
  normalizeBudget,
  buildSnapshot,
  buildTldr,
  CORE_VERSION,
  DEFAULT_CONFIG,
  declareRequired,
  discountEstimate,
  extendBudget,
  loadEstimateBias,
  detectVerify,
  editMismatchHint,
  mismatchedEditIndices,
  EDIT_MISS_RE,
  estimateTokens,
  gateResult,
  insideProject,
  isIgnored,
  parsePersona,
  parseRunArgs,
  parsePlan,
  parseThinkingPrediction,
  phaseThinking,
  renderPersona,
  statsRows,
  summarizeToolOutput,
  tasklistEnabled,
  normalizeRel,
  parseLanePrediction,
  classifyLane,
  stageSkillCard,
  stageLayerCard,
  ensureArtifactDirs,
  clearTempDir,
  isHarnessPath,
  isForbiddenArtifactPath,
  gate2Required,
  parsePlanProgress,
  verifyTier,
  parseCommitSubject,
  parseAcceptance,
  checkFailureMemory,
  suggestBudget,
  parseRemainingEstimate,
  parseRequirements,
  renderTable,
  reportColor,
  reportRows,
  scopeAllowed,
  shouldEscalate,
  shouldStop,
  tail,
  gitHead,
  changedPaths,
  cachedGreen,
  recordGreen,
  invalidateGreen,
  lastGreen,
  recordGateFail,
  loadGateRollbacks,
  failureTriage,
  recordGateFailure,
  loadGateFailures,
  testSelector,
  dangerTier,
  editRequiresGate,
  nearestPackageDir,
} from "./core/harness-core.mjs";

import type { ThinkingLevel, RunState } from "./entry/index-consts.ts";
import { HERE, EXPECTED_CORE_VERSION, staleCore, RUN_DIR, RUN_FILE, LAST_RUN_FILE, SETTLE_CAP_MS } from "./entry/index-consts.ts";
import { contentText, lastAssistantText } from "./entry/settle.ts";
import { printReport } from "./entry/report.ts";
import { planLevel, editLevel, startThinking, tierMeaning } from "./entry/thinking.ts";
import { loadHarnessConfig, readProtocol } from "./entry/protocol.ts";
import { activeCardNames, skillCardNote } from "./entry/cards.ts";


let activeRun: RunState | null = null;
let settleWaiter: (() => void) | null = null;
// True when the agent settled via the real agent_settled event (not the settle
// cap). Used to avoid auto-committing work when a run was force-finalized.
let settledNaturally = false;
// T1: a run force-finalized by the settle cap keeps its tail (the agent is still
// working past the report/finalize). Remember it so the next agent_settled can
// late-sync (gate + auto-commit) that tail instead of silently losing it.
// Cleared at run start/reset so a stale sync can never fire into a new run.
let tailSyncRun: RunState | null = null;
// writeRun is trailing-debounced so bursts of telemetry (turn_start,
// message_end, tool_result) coalesce into one disk write instead of one per
// event. State is still flushed synchronously at stop/done for crash recovery.
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let pendingRun: RunState | null = null;

/** Wait for the agent to fully settle (agent_settled event) with a safety cap. */
function waitForSettle(): Promise<void> {
  return new Promise<void>((resolve) => {
    settleWaiter = resolve;
    // T5: if the agent settled in the gap between sendUserMessage and this
    // registration, don't sit out the full cap — resolve immediately.
    if (settledNaturally) {
      settleWaiter = null;
      resolve();
      return;
    }
    const cap = setTimeout(() => {
      if (settleWaiter === resolve) {
        settleWaiter = null;
        resolve();
        console.log(`HARNESS: settle cap (${Math.round(SETTLE_CAP_MS / 1000)}s) reached — finalizing run (agent may still be working).`);
      }
    }, SETTLE_CAP_MS);
    cap.unref?.();
  });
}

function runPath(cwd: string) {
  return join(cwd, RUN_FILE);
}

function writeRun(run: RunState) {
  pendingRun = run;
  if (writeTimer) return; // a flush is already scheduled — just coalesce
  writeTimer = setTimeout(() => {
    writeTimer = null;
    flushRunSync();
  }, 80);
}

/** Synchronously persist the latest state (used at stop/done and for recovery). */
function flushRunSync() {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  const run = pendingRun;
  pendingRun = null;
  if (!run) return;
  try {
    mkdirSync(join(run.cwd, RUN_DIR), { recursive: true });
    const tmp = join(run.cwd, RUN_DIR, "run.json.tmp");
    writeFileSync(tmp, JSON.stringify(run, null, 2), "utf8");
    renameSync(tmp, runPath(run.cwd));
  } catch {
    /* state mirror is best-effort */
  }
}

/** Auto-commit scoped changes once a run has completed successfully (done + healthy). */
/**
 * T7 lazy baselineFull: only when the final full gate FAILS, run the baseline
 * full gate now to classify the report meaning ("you broke it" vs "already red").
 * A passing full gate never pays the extra run.
 */
function fillLazyBaseline(run: RunState, fg: { ok: boolean } | undefined) {
  if (!fg?.ok && run.fullCmd && run.baselineFull == null) {
    const b = gateResult(run.fullCmd, run.verifyCwd ?? run.cwd, run.timeoutMs);
    run.baselineFull = { ok: b.ok, head: tail(b.output, 2) };
  }
}

/**
 * T1 late-sync: gate + auto-commit work that landed AFTER a settle-cap
 * finalize. Only runs on a real agent_settled (natural end) with a green
 * gate — the settleCap no-commit invariant for the pre-tail snapshot is
 * untouched (that path never reaches here). Never re-appends stats.
 */
function lateSync(run: RunState) {
  const ok = run.fullCmd
    ? gateResult(run.fullCmd, run.verifyCwd ?? run.cwd, run.timeoutMs).ok
    : run.stats.consecutiveFails === 0;
  if (ok && (run.autoCommit ?? DEFAULT_CONFIG.autoCommit)) {
    const subject = (run.commitSubject || run.plan?.goal?.trim() || run.task).slice(0, 72);
    const res = autoCommit(run.cwd, subject, run.scope.declared);
    console.log(
      `HARNESS: tail sync — gate PASS, ${res.committed ? `committed ${res.count} file(s): ${res.message}` : `no commit (${res.reason ?? "no scoped files"})`} (run was finalized at the settle cap)`,
    );
  } else {
    console.log(
      `HARNESS: tail sync — gate ${ok ? "PASS" : "FAIL"}; tail changes left uncommitted (run finalized at the settle cap)`,
    );
  }
}

function maybeAutoCommit(run: RunState) {
  if (run.status !== "done") return;
  if (run.settleCap) return; // force-finalized by the settle cap — never commit incomplete work
  if (run.acceptance?.verdict === "unmet") {
    // Acceptance closure (v1.13): a run that reports itself not-accepted must
    // not auto-commit — the report surfaces the skip so the user can decide.
    run.autoCommitResult = { committed: false, reason: "acceptance unmet (run reports not-accepted)", leftover: [] };
    console.log(`HARNESS: auto-commit skipped — ${run.autoCommitResult.reason}`);
    return;
  }
  if ((run.autoCommit ?? DEFAULT_CONFIG.autoCommit) === false) return;
  const healthy = run.fullCmd ? (run.stats.finalFull?.ok ?? false) : run.stats.consecutiveFails === 0;
  if (!healthy) return;
  // S6/C2: commit subject derives from the model's final summary (explicit
  // `Commit:` line, else the summary's first useful line), falling back to the
  // plan goal (a clean restated task) then the raw task for low runs.
  const commitSubject = (run.commitSubject || run.plan?.goal?.trim() || run.task).slice(0, 72);
  const res = autoCommit(run.cwd, commitSubject, run.scope.declared);
  run.autoCommitResult = res;
  if (res.committed) console.log(`HARNESS: auto-committed ${res.count} file(s): ${res.message}`);
}

function finishRun(run: RunState, pi: ExtensionAPI) {
  run.endedAt = new Date().toISOString();
  // Record predicted-vs-actual turns for estimate-accuracy tracking.
  if (run.budget?.pendingEstimate != null) {
    appendEstimateRecord(run.cwd, { estimated: run.budget.pendingEstimate, actual: run.stats.turns });
  }
  // Persist a trend record (T1) for both done and stopped runs.
  appendRunStats(run.cwd, run);
  if (run.status === "stopped") {
    // Resumable: keep run.json + activeRun so /harness-resume can continue with the
    // same stats/scope/ladder. Restore thinking so idle costs nothing.
    flushRunSync();
    try {
      pi.setThinkingLevel(run.prevThinking);
    } catch {
      /* ignore */
    }
    return;
  }
  run.status = "done";
  flushRunSync(); // guarantee run.json exists before archiving to last-run.json
  // Task is complete: drop redundant temp artifacts (python pycache, stale
  // run.json.tmp) while keeping telemetry + last-run archive.
  cleanupRunArtifacts(run.cwd);
  try {
    renameSync(runPath(run.cwd), join(run.cwd, LAST_RUN_FILE));
  } catch {
    /* no file to archive */
  }
  if (run.prevThinking) {
    try {
      pi.setThinkingLevel(run.prevThinking);
    } catch {
      /* ignore */
    }
  }
  activeRun = null;
}

export default function harness(pi: ExtensionAPI) {
  if (staleCore) {
    console.error(
      `HARNESS: stale harness-core (expected ${EXPECTED_CORE_VERSION}, got ${CORE_VERSION}) — restart pi; /reload cannot refresh .mjs dependencies.`,
    );
  }
  pi.on("agent_settled", () => {
    settledNaturally = true;
    const w = settleWaiter;
    if (w) {
      settleWaiter = null;
      w();
    }
    // T1 late-sync: a settle-cap-finalized run's tail finishes here; gate +
    // auto-commit it so the remainder isn't silently lost.
    if (tailSyncRun) {
      const r = tailSyncRun;
      tailSyncRun = null;
      lateSync(r);
    }
  });
  // ---- /run ---------------------------------------------------------------
  pi.registerCommand("run", {
    description: "Run a task under the harness: baseline → snapshot → declare → gate-driven edits → telemetry report",
    handler: async (args, ctx) => {
      if (staleCore) {
        ctx.ui.notify(
          `Harness: stale core detected (${CORE_VERSION} ≠ ${EXPECTED_CORE_VERSION}) — restart pi; /reload cannot refresh .mjs dependencies.`,
          "error",
        );
        return;
      }
      // Extract user thinking overrides (--think/--edit) from the command args;
      // the remainder is the task. Without flags, the model self-assesses the
      // planning level (AI prediction) — see the Thinking: marker in run.md.
      const { flags, task } = parseRunArgs(args);
      if (!task.trim()) {
        ctx.ui.notify("Usage: /run [--think <level>] [--edit <level>] [--lane <S|M|L>] <task description>", "warning");
        return;
      }
      const cwd = ctx.cwd;

      if (!ctx.isProjectTrusted()) {
        ctx.ui.notify("Harness: project is not trusted — refusing to run commands here.", "error");
        return;
      }
      if (activeRun) {
        ctx.ui.notify(
          `Harness: a run is ${activeRun.status === "stopped" ? "stopped — /harness-resume to continue, " : "already active — "}/harness-reset to clear.`,
          "error",
        );
        return;
      }
      try {
        const existing = JSON.parse(readFileSync(runPath(cwd), "utf8"));
        if (existing?.status === "prepared" || existing?.status === "running") {
          ctx.ui.notify("Harness: stale run state found (.harness/run.json) — use /harness-reset to clear it.", "error");
          return;
        }
      } catch {
        /* no stale file or unreadable */
      }

      const cfg = loadHarnessConfig(cwd);
      const custom = cfg.verifyCmd
        ? {
            command: String(cfg.verifyCmd),
            kind: "custom",
            label: String(cfg.verifyCmd),
            ...(cfg.fullCmd
              ? { fullCommand: String(cfg.fullCmd), fullLabel: cfg.fullLabel ? String(cfg.fullLabel) : String(cfg.fullCmd) }
              : {}),
          }
        : null;
      const detected = custom ?? detectVerify(cwd);
      const verifyCmd = detected?.command ?? null;
      const degraded = !verifyCmd;

      const timeoutMs = Number(cfg.timeoutMs ?? DEFAULT_CONFIG.timeoutMs);
      const baseline = verifyCmd ? gateResult(verifyCmd, cwd, timeoutMs) : null;
      const fullCmd = detected?.fullCommand ?? null;
      // baselineFull is deliberately NOT run at start (T7): it costs a full test-suite
      // run on every /run. It is filled lazily at completion only when the final full
      // gate FAILS, to classify "you broke it" vs "already red".
      const snapshot = buildSnapshot(cwd, { verifyCmd, baseline, task });
      // Seed context from the previous run (last-run.json) so totals carry over
      // instead of each run starting cold.
      let priorNote = "";
      try {
        const prev = JSON.parse(readFileSync(join(cwd, LAST_RUN_FILE), "utf8"));
        if (prev?.status) {
          const pst = prev.stats ?? {};
          priorNote = `\n\n[prior run] ${prev.status} · ${pst.calls ?? 0} calls · $${(pst.cost ?? 0).toFixed(4)} · gate ${pst.gateRuns ?? 0}/${pst.gateFails ?? 0} · ${pst.turns ?? 0}/${prev.budget?.maxTurns ?? "?"} turns`;
        }
      } catch {
        /* no prior run */
      }
      const prevThinking = pi.getThinkingLevel();
      const strict = cfg.strict !== false;
      // Acceptance probe + cross-run trend (v1.13): the task-targeted probe is
      // stored now and RUN LAZILY at review entry (never at start); the trend
      // hint is advisory — surfaced via notify + the report.
      const acceptCmd = String(cfg.acceptCmd ?? "").trim() || null;
      const trend = suggestBudget(loadRunStats(cwd));
      settledNaturally = false; // fresh run: only a real agent_settled marks it done
      tailSyncRun = null; // a stale late-sync must never fire into this fresh run
      const nb = normalizeBudget(cfg, DEFAULT_CONFIG);

      const run: RunState = {
        task,
        cwd,
        verifyCmd,
        verifyLabel: degraded ? "none" : (detected?.label ?? verifyCmd),
        verifyKind: degraded ? "none" : ((detected?.kind ?? "custom") as RunState["verifyKind"]),
        verifyCwd: detected?.verifyCwd ?? cwd,
        fullCmd,
        fullLabel: degraded ? null : (detected?.fullLabel ?? null),
        timeoutMs,
        scope: { declared: [], strict },
        budget: {
          maxTurns: nb.maxTurns,
          maxConsecutiveFails: Number(cfg.maxConsecutiveFails ?? DEFAULT_CONFIG.maxConsecutiveFails),
          deEscalateAfter: Number(cfg.deEscalateAfter ?? DEFAULT_CONFIG.deEscalateAfter),
          absMaxTurns: nb.absMaxTurns,
          softBudgetPct: nb.softBudgetPct,
          maxExtensions: Number(cfg.maxExtensions ?? DEFAULT_CONFIG.maxExtensions),
          maxCost: Number(flags.budget ?? cfg.maxCost ?? 0) || null,
          softAsked: false,
          pendingEstimate: null,
          estBias: loadEstimateBias(cwd),
        },
        budgetWarnings: nb.warnings,
        autoCommit: cfg.autoCommit !== false,
        ladder: {
          thinkingStart: (cfg.thinkingStart as ThinkingLevel) ?? DEFAULT_CONFIG.thinkingStart,
          thinkingEscalated: (cfg.thinkingEscalated as ThinkingLevel) ?? DEFAULT_CONFIG.thinkingEscalated,
          escalated: false,
        },
        planning: {
          // User flags win. Null thinkLevel means the model's AI prediction
          // (from its first message) fills it in; otherwise thinkingStart applies.
          thinkLevel: (flags.think as ThinkingLevel) ?? null,
          editLevel: (flags.edit as ThinkingLevel) ?? null,
          done: false,
        },
        plan: { goal: "", anchors: "", tasks: [], risky: false, requirements: [], gate2: null, progress: { done: 0, total: 0, remaining: 0, current: null } },
        stage: "requirements",
        persona: { domain: (flags.persona as string) ?? null },
        // Lane triage (Phase 0): user --lane wins; else seed with the heuristic
        // fallback now and let the model's "Lane:" marker refine it in message_end
        // (only if not user-forced). Default M when neither present.
        lane: (flags.lane as "S" | "M" | "L") ?? classifyLane(task, snapshot),
        laneForced: flags.lane != null,
        // Verify tier seeded now; refined once the plan is captured (plan
        // footprint can force Full even if the initial lane heuristic said S/M).
        verifyTier: verifyTier({ lane: (flags.lane as "S" | "M" | "L") ?? classifyLane(task, snapshot) }),
        // Seed knownFiles with the pre-existing porcelain set so turn 2's
        // gitNewFiles diff reports only files NEW since the run started, not
        // every already-changed/uncommitted file in the working tree.
        stats: (() => {
          const st = { calls: 0, tokensIn: 0, tokensCached: 0, tokensOut: 0, gateRuns: 0, gateFails: 0, blockedEdits: 0, consecutiveFails: 0, consecutivePasses: 0, extensionCount: 0, warned50: false, gateDirty: false, warnedCost50: false, knownFiles: [], peakTurnCost: 0, gateCacheHits: 0, turns: 0, cost: 0 };
          try {
            st.knownFiles = gitNewFiles(cwd, new Set()).set;
          } catch {
            /* no git → empty */
          }
          return st;
        })(),
        baseline: baseline ? { ok: baseline.ok, head: tail(baseline.output, 2) } : null,
        baselineFull: null, // filled lazily only when the final full gate FAILS (T7)
        acceptance: { verdict: null, criteria: [] },
        acceptCmd,
        acceptResult: null,
        memoryCheck: null,
        trend,
        estRemaining: null,
        resumeCount: 0,
        prevThinking,
        status: "prepared",
        startedAt: new Date().toISOString(),
        endedAt: null,
      };
      activeRun = run;
      writeRun(run);
      // Ensure the agent-facing artifact dirs exist (.harness/temp + longterm)
      // before the agent starts, so it can file scratch/output artifacts there.
      ensureArtifactDirs(cwd);
      pi.setThinkingLevel(startThinking(run));

      const verifyText = verifyCmd
        ? `${verifyCmd}${detected?.kind === "syntax" ? " (syntax-only — also review your diff for correctness)" : ""}`
        : "(none — no verify gate: correctness rests on your final diff review)";
      const baselineText = baseline ? (baseline.ok ? "GREEN" : "RED") : "N/A (no verify command)";
      const baselineNote = baseline
        ? baseline.ok
          ? "do not regress it — it must stay green."
          : "the task is expected to fix it — the first GATE run after your edits will show it."
        : "none — there is no automated gate, so review your diff carefully before summarizing.";

      const prompt = readProtocol()
        .replaceAll("{{TASK}}", task + priorNote)
        .replaceAll("{{SNAPSHOT}}", snapshot)
        .replaceAll("{{VERIFY}}", verifyText)
        .replaceAll("{{MAXFAILS}}", String(run.budget.maxConsecutiveFails))
        .replaceAll("{{MAXTURNS}}", String(run.budget.maxTurns))
        .replaceAll("{{BASELINE}}", baselineText)
        .replaceAll("{{BASELINE_NOTE}}", baselineNote)
        .replaceAll("{{PERSONA}}", renderPersona("planning", run.persona?.domain ?? null));

      if (degraded) {
        ctx.ui.notify(
          "Harness: no verify command found — checked package.json scripts, tsconfig, pyproject.toml/setup.py, go.mod, Cargo.toml, pom.xml/build.gradle, *.csproj, Gemfile, composer.json (and runtimes on PATH). Add harness.json with a verifyCmd to enable a gate.",
          "warning",
        );
      } else {
        ctx.ui.notify(
          `Harness: ${verifyCmd} (${run.verifyLabel}) | thinking ${planLevel(run)}${run.planning?.thinkLevel ? " (user)" : " (AI predicts)"} → ${editLevel(run)} on declare → ${run.ladder.thinkingEscalated} on ${run.budget.maxConsecutiveFails} fails | budget ${run.budget.maxTurns} turns`,
          "info",
        );
      }
      if (run.budgetWarnings?.length) {
        ctx.ui.notify(`Harness budget config: ${run.budgetWarnings.join(" ")}`, "warning");
      }
      if (trend) {
        ctx.ui.notify(`Harness trend: median ${trend.median} turns over ${trend.n} recent runs — ${trend.reason}; consider maxTurns ${trend.suggestion}.`, "info");
      }
      ctx.ui.notify(`Harness: stage PLANNING — scoping requirements and task list. Operating discipline: ${activeCardNames(cfg, "planning").join(" + ") || "(none)"}.`, "info");

      // Kick off the agent and wait for it to actually settle. In RPC mode
      // (and some interactive paths) the agent starts asynchronously, so
      // waitForIdle() right after sendUserMessage returns immediately — wait
      // for the agent_settled EVENT instead, with a generous safety cap.
      try {
        pi.sendUserMessage(prompt + skillCardNote(cfg, "planning", run.stats));
      } catch (err) {
        finishRun(run, pi);
        ctx.ui.notify(`Harness: failed to start run — ${err instanceof Error ? err.message : String(err)}`, "error");
        return;
      }
      await waitForSettle();

      // Mark done before reporting so no late hook fires with a stale run.
      // A budget-stopped run stays "stopped" (and resumable via /resume).
      if (run.status !== "stopped") {
        if (!settledNaturally) {
          run.settleCap = true; // force-finalized by the settle cap
          tailSyncRun = run; // T1: arm the late-sync for the still-working tail
        }
        run.status = "done";
      }
      if (run.status === "stopped") {
        // The model was told to state its remaining-work estimate in the summary.
        run.estRemaining = parseRemainingEstimate(lastAssistantText(ctx));
      } else {
        // Completed: run the strong (full) gate once if the project has one —
        // unless the review stage already ran it via harness_review (and no
        // post-review edit reset stage to development).
        if (run.fullCmd && run.stage !== "review") {
          const fg = gateResult(run.fullCmd, run.verifyCwd ?? run.cwd, run.timeoutMs);
          run.stats.finalFull = { ok: fg.ok };
          fillLazyBaseline(run, fg);
        }
      }
      run.commitSubject = parseCommitSubject(lastAssistantText(ctx));
      maybeAutoCommit(run);
      writeRun(run);
      printReport(run, ctx);

      finishRun(run, pi);
    },
  });

  // ---- /harness-resume ------------------------------------------------------
  pi.registerCommand("harness-resume", {
    description: "Continue a budget-stopped run with more turns: /harness-resume [extraTurns]",
    handler: async (args, ctx) => {
      let run = activeRun;
      // True when the run continues the live session (vs crash recovery from
      // run.json). Used to slim the resume prompt: a live session already holds
      // the context, so a persisted plan can replace the re-printed snapshot.
      const inSession = !!(run && run.status === "stopped");
      if (!run || run.status !== "stopped") {
        // Crash recovery: the module state may be gone (pi restarted) — reload from run.json.
        try {
          const saved = JSON.parse(readFileSync(runPath(ctx.cwd), "utf8"));
          if (saved?.status === "stopped") {
            run = saved as RunState;
            activeRun = run;
          }
        } catch {
          /* none */
        }
        if (!run || run.status !== "stopped") {
          ctx.ui.notify("Harness: nothing to resume — no budget-stopped run found.", "warning");
          return;
        }
      }

      const parsed = Number.parseInt(args, 10);
      const extra = Number.isFinite(parsed) && parsed > 0 ? parsed : 10;
      // Self-sizing loop: use the model's own remaining-work estimate from the
      // last stop to size the budget, but bound it so an inflated estimate can't
      // balloon the run.
      const prevEst = run.estRemaining ?? 0;
      const sized = prevEst > 0 && prevEst > extra ? Math.min(prevEst, extra * 3) : extra;
      // Explicit user resume is a conscious override, so it is NOT capped by
      // absMaxTurns (that wall bounds only AUTOMATIC health-gated extension).
      // Without this, /harness-resume was a no-op when the run stopped at the
      // absolute wall — the exact case it exists to serve.
      run.budget.maxTurns = run.stats.turns + sized;
      run.resumeCount = (run.resumeCount ?? 0) + 1;
      run.estRemaining = null;
      run.status = "prepared";
      run.endedAt = null;
      writeRun(run);
      pi.setThinkingLevel(run.ladder.escalated ? run.ladder.thinkingEscalated : startThinking(run));

      let snapshot = buildSnapshot(run.cwd, { verifyCmd: run.verifyCmd, baseline: run.baseline, task: run.task });
      const planTasks = run.plan?.tasks?.length ? run.plan.tasks : null;
      const planBlock = planTasks
        ? `## Plan (${planTasks.length} tasks — continue from the first unfinished)\n` +
          `${run.plan?.goal ? `Goal: ${run.plan.goal}\n` : ""}` +
          `${run.plan?.anchors ? `Plan: ${run.plan.anchors}\n` : ""}` +
          planTasks.map((t) => `- [ ] ${t.text}${t.footprint && t.footprint !== "none" ? ` (footprint: ${t.footprint})` : ""}`).join("\n")
        : "";
      let taskNote = `${run.task}\n\nNOTE: you were stopped at the turn budget after ${run.stats.turns} turns. The harness resumed you with ${sized} more turns (budget now ${run.budget.maxTurns}). Continue from where you left off. Before editing, state your estimate as "Remaining: K turns". Scope already declared: ${run.scope.declared.join(", ") || "(none — declare it first)"}.`;
      if (planBlock) {
        // Slimming: a live session already holds the codebase context (session
        // history), so the persisted plan replaces the full snapshot re-print —
        // fewer resume tokens. On crash recovery (no session) we keep the full
        // snapshot and attach the plan as a targeting note instead.
        if (inSession) {
          snapshot = planBlock;
        } else {
          taskNote += `\n\n${planBlock}`;
        }
      }
      const prompt = readProtocol()
        .replaceAll("{{TASK}}", taskNote)
        .replaceAll("{{SNAPSHOT}}", snapshot)
        .replaceAll("{{VERIFY}}", run.verifyCmd ?? "(none)")
        .replaceAll("{{MAXFAILS}}", String(run.budget.maxConsecutiveFails))
        .replaceAll("{{MAXTURNS}}", String(run.budget.maxTurns))
        .replaceAll("{{BASELINE}}", run.baseline ? (run.baseline.ok ? "GREEN" : "RED") : "N/A")
        .replaceAll("{{BASELINE_NOTE}}", run.baseline ? (run.baseline.ok ? "keep it green" : "expected to fix") : "none")
        .replaceAll("{{PERSONA}}", renderPersona("planning", run.persona?.domain ?? null));

      const cfg = loadHarnessConfig(run.cwd);
      let card = skillCardNote(cfg, run.stage, run.stats);
      // P3-T2: quick-tier runs skip the verifier card even on mid-review resume
      // (consistent with the one-shot review-entry wiring above).
      if (run.stage === "review" && (run.verifyTier ?? "standard") === "quick") card = "";
      const discipline = activeCardNames(cfg, run.stage).join(" + ");
      ctx.ui.notify(`Harness: resumed +${sized} turns (budget ${run.budget.maxTurns}) — ${run.verifyLabel} | stage ${run.stage ?? "planning"} | discipline ${discipline || "(default)"}`, "info");
      try {
        pi.sendUserMessage(prompt + card);
      } catch (err) {
        finishRun(run, pi);
        ctx.ui.notify(`Harness: resume failed to start — ${err instanceof Error ? err.message : String(err)}`, "error");
        return;
      }
      settledNaturally = false;
      tailSyncRun = null; // a resume wins: don't late-sync into it
      await waitForSettle();

      // Status can't be "stopped" here by control flow (set to "prepared" above,
      // only "done" is assigned below), but the guards are kept as a defensive
      // floor against future status transitions — widen to keep tsc quiet.
      const st: string = run.status;
      if (st !== "stopped") {
        if (!settledNaturally) {
          run.settleCap = true; // force-finalized by the settle cap
          tailSyncRun = run; // T1: arm the late-sync for the still-working tail
        }
        run.status = "done";
      }
      if (st === "stopped") {
        run.estRemaining = parseRemainingEstimate(lastAssistantText(ctx));
      } else if (run.fullCmd && run.stage !== "review") {
        const fg = gateResult(run.fullCmd, run.verifyCwd ?? run.cwd, run.timeoutMs);
        run.stats.finalFull = { ok: fg.ok };
        fillLazyBaseline(run, fg);
      }
      run.commitSubject = parseCommitSubject(lastAssistantText(ctx));
      maybeAutoCommit(run);
      writeRun(run);
      printReport(run, ctx);
      finishRun(run, pi);
    },
  });

  // ---- /harness-reset (crash recovery) -----------------------------------
  pi.registerCommand("harness-reset", {
    description: "Clear harness state (crash recovery when a run died mid-way)",
    handler: async (_args, ctx) => {
      if (activeRun) {
        try {
          pi.setThinkingLevel(activeRun.prevThinking ?? "high");
        } catch {
          /* ignore */
        }
        activeRun = null;
      }
      tailSyncRun = null; // never late-sync into a cleared session
      try {
        rmSync(join(ctx.cwd, RUN_DIR), { recursive: true, force: true });
      } catch {
        /* ignore */
      }
      ctx.ui.notify("Harness state cleared", "info");
    },
  });

  // ---- /harness-gate2-pass | /harness-gate2-skip (Gate 2 clearance) ------
  const clearGate2 = (run: RunState | null, verdict: "passed" | "skipped") => {
    if (!run) return null;
    if (run.plan?.gate2 !== "pending") return "No pending Gate 2 to clear.";
    run.plan.gate2 = verdict;
    writeRun(run);
    return verdict === "passed" ? "Gate 2 cleared (plan reviewed). Re-run /run declare to build." : "Gate 2 skipped (user override). Re-run /run declare to build.";
  };
  pi.registerCommand("harness-gate2-pass", {
    description: "Mark the plan review (Gate 2) as passed so an L-lane boundary run can build",
    handler: async (_args, ctx) => {
      const msg = clearGate2(activeRun, "passed");
      ctx.ui.notify(msg ?? "No active run.", msg?.includes("No pending") ? "warning" : "info");
    },
  });
  pi.registerCommand("harness-gate2-skip", {
    description: "Skip the plan review (Gate 2) on judgment — user override for L-lane boundary runs",
    handler: async (_args, ctx) => {
      const msg = clearGate2(activeRun, "skipped");
      ctx.ui.notify(msg ?? "No active run.", msg?.includes("No pending") ? "warning" : "info");
    },
  });

  // ---- /harness-clean-temp (clear agent temp artifacts) ------------------
  pi.registerCommand("harness-clean-temp", {
    description: "Clear .harness/temp contents now (longterm is never touched)",
    handler: async (_args, ctx) => {
      const removed = clearTempDir(ctx.cwd);
      ctx.ui.notify(`Harness: cleared ${removed} item(s) from .harness/temp (longterm kept).`, removed > 0 ? "info" : "info");
    },
  });

  // ---- /harness-stats (trend from .harness/stats.json) -------------------
  pi.registerCommand("harness-stats", {
    description: "Show a recent-run trend (calls, cost, cache-hit %, turns, gate) from .harness/stats.json",
    handler: async (_args, ctx) => {
      const recs = loadRunStats(ctx.cwd, 12);
      if (!recs.length) {
        ctx.ui.notify("Harness: no stats recorded yet — run /run a few times first.", "info");
        return;
      }
      console.log(`\n=== HARNESS TREND (last ${recs.length}) ===`);
      console.log(renderTable(statsRows(recs)));
      console.log("=== END HARNESS TREND ===");
    },
  });

  // ---- harness-fork-green (gap #3): last-green rollback point ------------
  pi.registerCommand("harness-fork-green", {
    description: "Show the last-green rollback point (gap #3): newest cached green gate + latest recorded red gate",
    handler: async (_args, ctx) => {
      const lg = lastGreen(ctx.cwd);
      const rb = loadGateRollbacks(ctx.cwd, 1)[0];
      console.log(`\n=== HARNESS LAST-GREEN (gap #3) ===`);
      if (!lg) {
        console.log("no last-green rollback point on record — run a green gate first.");
      } else {
        console.log(`head:     ${lg.head}`);
        console.log(`verify:   ${lg.verifyCmd}`);
        console.log(`recorded: ${new Date(lg.ts).toISOString()}`);
        console.log(`rollback: git reset --hard ${lg.head}`);
      }
      if (rb) console.log(`latest red: ${rb.head.slice(0, 7) || "(none)"} — ${rb.reason} (${new Date(rb.ts).toISOString()})`);
      console.log("=== END HARNESS LAST-GREEN ===");
    },
  });

  // ---- harness_declare tool ----------------------------------------------
  pi.registerTool({
    name: "harness_declare",
    label: "Declare edit scope",
    description:
      "Declare the files you will modify in the current harness task. Call it ONCE before your first edit, listing every file you intend to change (relative paths). Edits to files outside the declared set are blocked while strict scope is on.",
    parameters: Type.Object({
      files: Type.Array(Type.String({ description: "Relative paths of files you will edit" })),
    }),
    async execute(_toolCallId, params: { files: string[] }, _signal, _onUpdate, ctx) {
      const run = activeRun;
      if (!run) return { content: [{ type: "text", text: "No active harness run." }], details: {} };
      const declared = [...new Set(params.files.map((f) => normalizeRel(String(f), run.cwd)))];
      // Artifact-filing STRICT rule: reject top-level memory/ declarations up
      // front so the agent learns the correction at declare time instead of at
      // the write gate (which also hard-blocks them). Memory belongs under
      // .harness/longterm/memory/ — never a top-level memory/ directory.
      const rejected = declared.filter(isForbiddenArtifactPath);
      if (rejected.length) {
        const kept = declared.filter((d) => !isForbiddenArtifactPath(d));
        declared.length = 0;
        declared.push(...kept);
      }
      // Validate existence so a typo'd/mis-named path surfaces immediately instead
      // of confusing the user when their edit is later blocked or silently scoped.
      const missing = declared.filter((d) => {
        try {
          return !existsSync(join(run.cwd, d));
        } catch {
          return true;
        }
      });
      run.scope.declared = declared;
      // Gate 2 soft-block (revised-plan A3b): for an L-lane boundary plan, refuse
      // to auto-proceed into development until the plan review is cleared (passed)
      // or the user overrides (skipped). The user can force through on judgment.
      if (run.plan?.gate2 === "pending" && gate2Required(run.lane, run.plan)) {
        writeRun(run);
        return {
          content: [
            {
              type: "text",
              text: `GATE 2 (plan review) required — this is an L-lane run with a boundary/risk plan. Declare scope first, but run the plan review (reviewer) before building. To proceed, use /harness-gate2-pass after review, or /harness-gate2-skip to override on judgment. Scope noted: ${declared.join(", ") || "(none)"}.`, 
            },
          ],
          details: { declared, missing, gate2: "pending" },
        };
      }
      // Declaring scope is the de facto end of the planning/task-list phase: drop
      // thinking from planLevel to editLevel so gated edits run cheap. Only flips
      // once; a later re-declare is a no-op.
      let planNote = "";
      if (!run.planning?.done) {
        run.planning.done = true;
        run.stage = "development";
        pi.setThinkingLevel(editLevel(run));
        ctx.ui.notify(`Harness: stage DEVELOPMENT — gate-driven edits (thinking ${editLevel(run)}).`, "info");
        if (planLevel(run) !== editLevel(run)) {
          planNote = ` Planning phase ended — thinking dropped from ${planLevel(run)} to ${editLevel(run)} for edits.`;
        }
      }
      writeRun(run);
      const warn = missing.length
        ? ` Warning: not found on disk: ${missing.join(", ")} (will be created on first edit if brand new).`
        : "";
      // Stage persona: switch from the Product Owner role to the Senior Developer
      // role for the editing phase, carrying the task-adaptive domain focus.
      const personaNote = ` ${renderPersona("development", run.persona?.domain ?? null)}`;
      const rejectedWarn = rejected.length
        ? ` Rejected top-level memory path(s): ${rejected.join(", ")} — memory files must live under .harness/longterm/memory/ (temp/scratch under .harness/temp/), never a top-level memory/ directory.`
        : "";
      return {
        content: [
          {
            type: "text",
            text: `Scope declared (${declared.length}): ${declared.join(", ") || "(none)"}. Edits outside these files are blocked while strict scope is on.${rejectedWarn}${warn}${planNote}${personaNote}`,
          },
        ],
        details: { declared, missing, rejected },
      };
    },
  });

  // ---- harness_review tool: Planning → Development → Review ---------------
  pi.registerTool({
    name: "harness_review",
    label: "Enter the review stage",
    description:
      "Signal that development is complete and enter the REVIEW stage. Runs the full verification gate and has you audit your diff for correctness + acceptance before summarizing. Call it once when all edits are done and the fast gate is green. Do NOT edit after calling this unless you then re-call it.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params: {}, _signal, _onUpdate, ctx) {
      const run = activeRun;
      if (!run) return { content: [{ type: "text", text: "No active harness run." }], details: {} };
      if (run.stage !== "development") {
        return {
          content: [
            {
              type: "text",
              text: run.stage === "review" ? "Already in the review stage." : "Cannot enter review yet — no scope declared (call harness_declare first).",
            },
          ],
          details: {},
        };
      }
      run.stage = "review";
      // Run the strong (full) gate now so the model sees the result and can fix.
      // Dedup: when fullCmd is unset the review gate == the edit-gate command, and
      // the last green edit-gate already verified this identical tree if nothing
      // dirtied it since — reuse that verdict instead of a redundant suite run.
      const gate = run.fullCmd ? run.fullCmd : run.verifyCmd ? run.verifyCmd : null;
      let verdict: string | null = null;
      if (gate) {
        if (!run.fullCmd && !run.stats.gateDirty && run.stats.consecutiveFails === 0) {
          run.stats.finalFull = { ok: true };
          verdict = "PASS";
        } else {
          const g = gateResult(gate, run.verifyCwd ?? run.cwd, run.timeoutMs);
          run.stats.gateRuns++;
          if (!g.ok) run.stats.gateFails++;
          run.stats.finalFull = { ok: g.ok };
          fillLazyBaseline(run, g);
          verdict = g.ok ? "PASS" : "FAIL";
        }
      }
      writeRun(run);
      ctx.ui.notify(
        `Harness: stage REVIEW — full gate ${verdict ?? "skipped (no gate)"}. Audit your diff, fix any failures, then summarize.`,
        verdict === "FAIL" ? "warning" : "info",
      );
      const tier = run.verifyTier ?? "standard";
      // Review lens (v1.13): optional reviewThinking config raises thinking for
      // the review stage only, so the diff audit doesn't run at the editing
      // floor. The harness still restores the original level at finishRun.
      const revCfg = loadHarnessConfig(run.cwd);
      const revLevel = String(revCfg.reviewThinking ?? "").trim();
      if (revLevel && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(revLevel)) {
        try {
          pi.setThinkingLevel(revLevel as ThinkingLevel);
        } catch {
          /* ignore */
        }
      }
      // Acceptance probe (v1.13): when acceptCmd is configured and the model
      // claims the task is done (met/partial), run the task-targeted probe once
      // per review entry — lazy, like baselineFull (T7).
      if (run.acceptCmd && (run.acceptance?.verdict === "met" || run.acceptance?.verdict === "partial")) {
        const ap = gateResult(run.acceptCmd, run.cwd, run.timeoutMs, "custom");
        run.acceptResult = { ok: ap.ok, head: ap.output };
        run.stats.gateRuns++;
        if (!ap.ok) run.stats.gateFails++;
      }
      // Failure-memory check (v1.13): advisory — verify a lesson landed this run
      // when a gate failed, instead of only nudging by prose.
      run.memoryCheck = checkFailureMemory(run.cwd, run.startedAt, run.stats.gateFails);
      writeRun(run);
      const accNote = run.acceptance?.verdict
        ? ` Acceptance: ${run.acceptance.verdict}${run.acceptResult ? ` — accept probe ${run.acceptResult.ok ? "PASS" : "FAIL"}` : ""}.`
        : "";
      const revNote = revLevel && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(revLevel) ? ` Review thinking: ${revLevel}.` : "";
      const memNote = run.memoryCheck && !run.memoryCheck.ok
        ? `\nHARNESS: ${run.memoryCheck.note} — append a one-line lesson to .harness/longterm/memory/failures.md before summarizing.`
        : "";
      // P3-T2: verifyTier is now real — standard/full runs get the verifier card
      // at review-entry (tests + review, +security/perf for full); quick-tier
      // runs skip it (the build-boundary gate + one-shot review line is their
      // check), saving ~430 tok on the common S-lane path.
      const reviewCard =
        (accNote + revNote + memNote) + (tier === "quick" ? "" : skillCardNote(loadHarnessConfig(run.cwd), "review", run.stats));
      return {
        content: [
          {
            type: "text",
            text: `${renderPersona("review", run.persona?.domain ?? null)} Review stage entered. Full gate: ${verdict ?? "none — no verify gate configured"}. Verify tier: ${run.verifyTier} (${tierMeaning(run.verifyTier)}). Review your complete diff for correctness and acceptance. If the gate failed, fix the ONE root cause, then you may call harness_review again; otherwise write your final summary.${reviewCard}`,
          },
        ],
        details: { fullGate: verdict, acceptProbe: run.acceptResult?.ok ?? null },
      };
    },
  });

  // ---- tool_call: budget stop + scope/safety enforcement -----------------
  pi.on("tool_call", (event, ctx) => {
    const run = activeRun;
    if (!run || run.status !== "running") return;

    if (shouldStop(run.stats.turns, run.budget.maxTurns)) {
      // Health-gated extension: let a healthy long run continue without a
      // stop/resume round-trip, bounded by absMaxTurns.
      const ext = extendBudget({
        turns: run.stats.turns,
        maxTurns: run.budget.maxTurns,
        absMaxTurns: run.budget.absMaxTurns,
        pendingEstimate: run.budget.pendingEstimate != null ? discountEstimate(run.budget.pendingEstimate, run.budget.estBias?.bias) : null,
        consecutiveFails: run.stats.consecutiveFails,
        maxConsecutiveFails: run.budget.maxConsecutiveFails,
        escalated: run.ladder.escalated,
        extensionCount: run.stats.extensionCount,
        maxExtensions: run.budget.maxExtensions ?? DEFAULT_CONFIG.maxExtensions,
      });
      if (ext.extend) {
        // Extend the ceiling and allow the tool through — the soft-budget ask
        // already told the model the ceiling may be right-sized. Each extension
        // is counted so a healthy-but-stuck loop can't extend indefinitely.
        run.budget.maxTurns = ext.newMaxTurns!;
        run.stats.extensionCount++;
        writeRun(run);
        return;
      }
      run.status = "stopped";
      flushRunSync(); // persist stopped state immediately so /harness-resume can resume
      // Final gate: re-verify the actual state so the report can say whether
      // the stopped run left the project valid. Uses the strong (full) gate when
      // the project has one.
      if (run.verifyCmd) {
        // Final gate: reuse the last green edit-gate when the tree is unchanged
        // (fullCmd unset = same command; gateDirty false = no event since it ran).
        if (!run.fullCmd && !run.stats.gateDirty && run.stats.consecutiveFails === 0) {
          run.stats.finalGate = { ok: true };
        } else {
          const fg = gateResult(run.fullCmd ?? run.verifyCmd, run.verifyCwd ?? run.cwd, run.timeoutMs);
          run.stats.finalGate = { ok: fg.ok };
          run.stats.gateRuns++;
          if (!fg.ok) run.stats.gateFails++;
        }
      }
      writeRun(run);
      return {
        block: true,
        reason: `HARNESS: turn budget (${run.budget.maxTurns}) reached — stop working and summarize what you have. The harness reports stats now.`,
        terminate: true,
      };
    }

    if (isToolCallEventType("bash", event)) {
      const cmd = String(event.input?.command ?? "");
      const cfg = activeRun ? loadHarnessConfig(activeRun.cwd) : {};
      const dt = dangerTier(cmd, cfg.dangerTiers);
      if (dt.tier === "allow") return; // explicitly allowed via dangerTiers
      if (dt.pattern) {
        return {
          block: true,
          reason: `HARNESS: blocked dangerous command (matches "${dt.pattern}")${dt.tier === "confirm" ? " — confirm tier is not interactive in this harness; treating as block. Allow it via harness.json dangerTiers." : ""}`,
        };
      }
      return;
    }

    if (event.toolName === "edit" || event.toolName === "write") {
      const p = String((event.input as { path?: unknown })?.path ?? "");
      if (!p) return;
      if (!insideProject(p, run.cwd)) {
        run.stats.blockedEdits++;
        writeRun(run);
        return { block: true, reason: `HARNESS: blocked — ${p} is outside the project root.` };
      }
      const rel = normalizeRel(p, run.cwd);
      // Artifact carve-out: any write under .harness/ (temp, longterm, or the
      // agent's memory files) is always allowed — no declare needed, no ignore
      // hit — so the agent can file memory/scratch/keep artifacts without
      // mid-run scope blocks. An edit after REVIEW still invalidates the review.
      if (isHarnessPath(rel)) {
        if (run.stage === "review") {
          run.stage = "development";
          writeRun(run);
        }
        return;
      }
      // Hard block (protocol STRICT rule): a top-level memory/ directory is
      // forbidden — memory files must live under .harness/longterm/memory/.
      // This runs before declare/scope so a mis-filed memory doc is refused even
      // if the agent declared it. Temp/scratch likewise belong under .harness/.
      if (isForbiddenArtifactPath(rel)) {
        run.stats.blockedEdits++;
        writeRun(run);
        return {
          block: true,
          reason:
            `HARNESS: blocked — ${rel} is a top-level memory/ path, which the protocol forbids. Memory files (plan/progress/decisions/knowledge/problems/failures) must live under .harness/longterm/memory/; temp/scratch under .harness/temp/. File it there instead.`,
        };
      }
      if (declareRequired(run.scope.declared, run.scope.strict)) {
        run.stats.blockedEdits++;
        writeRun(run);
        return {
          block: true,
          reason:
            "HARNESS: strict scope is on — call harness_declare with the file(s) you will modify BEFORE your first edit. Edits are blocked until you declare scope.",
        };
      }
      if (isIgnored(rel, DEFAULT_CONFIG.ignore)) {
        run.stats.blockedEdits++;
        writeRun(run);
        return { block: true, reason: `HARNESS: blocked — ${rel} matches an ignore pattern (${DEFAULT_CONFIG.ignore.join(", ")}).` };
      }
      if (!scopeAllowed(rel, run.scope.declared, run.scope.strict)) {
        run.stats.blockedEdits++;
        writeRun(run);
        return {
          block: true,
          reason: `HARNESS: blocked — ${rel} is not in your declared scope (${run.scope.declared.join(", ") || "none declared yet"}). Call harness_declare with this file, or ask the user.`,
        };
      }
      // An edit after entering REVIEW invalidates the review — drop back to
      // development so the completion gate re-verifies the new state.
      if (run.stage === "review") {
        run.stage = "development";
        writeRun(run);
      }
    }
  });

  // ---- tool_result: the verify gate --------------------------------------
  pi.on("tool_result", (event) => {
    const run = activeRun;
    if (!run || run.status !== "running") return;
    // Any bash (even read-only, conservatively) may have changed the tree in a
    // way bashMutates() didn't flag — mark dirty so the review-gate dedup never
    // reuses a stale-green result. The gate below clears it once it re-verifies.
    if (event.toolName === "bash") run.stats.gateDirty = true;
    // v1.13.1: edit-mismatch coach — when the edit tool can't find oldText, the
    // gate below still fires; this adds a byte-level diff hint to the same coach
    // rail so a whitespace/invisible-char mismatch is fixed in one shot.
    const editHint = editCoachForEvent(run, event);
    // Idea #4: budget bash tool output before it re-enters the next model call.
    // Truncation runs FIRST, on the tool's own content only; the gate coach is
    // appended below, AFTER — so it can never be eaten by the budget. The full
    // output is archived to .harness/temp/ so the model can read it on demand.
    let parts = Array.isArray(event.content) ? [...event.content] : [];
    let truncated = false;
    if (event.toolName === "bash") {
      const res = maybeTruncateBashOutput(run, event, parts);
      if (res !== null) {
        parts = [{ type: "text", text: res }];
        truncated = true;
      }
    }
    if (event.toolName !== "edit" && event.toolName !== "write") {
      // Gate bash results too when the command plausibly wrote to the project
      // (builds, installs, redirects, git mutations) so a command-line fix is
      // verified mid-run, not only at completion.
      const bcmd = String((event.input as { command?: string } | undefined)?.command ?? "");
      if (!(event.toolName === "bash" && bashMutates(bcmd))) {
        // No gate for this result — still return the patch when we truncated.
        return truncated ? { content: parts } : undefined;
      }
    }
    if (!run.verifyCmd) return truncated ? { content: parts } : undefined; // degraded mode — no gate

    const cfg = loadHarnessConfig(run.cwd);
    const changed = changedPaths(run.cwd);
    const isEdit = event.toolName === "edit" || event.toolName === "write";

    // T8 (skip-gate): a pure-doc/whitespace edit needs no per-edit gate; the
    // review/full gate always runs the suite regardless.
    if (isEdit && cfg.skipDocGate !== false && !editRequiresGate(changed)) {
      return truncated ? { content: parts } : undefined;
    }

    // T10 (monorepo): when all changed files resolve to one nested package and
    // perPackageGate is on, gate that package's suite instead of the root.
    let gateCmd = run.verifyCmd;
    let gateCwd = run.verifyCwd ?? run.cwd;
    if (cfg.perPackageGate) {
      const pkg = nearestPackageDir(changed, run.cwd);
      if (pkg) {
        const pv = detectVerify(pkg);
        if (pv?.command) {
          gateCmd = pv.command;
          gateCwd = pkg;
        }
      }
    }

    // T2 (selective tests): narrow the edit-gate to affected tests for recognized
    // runners; the review/full gate is never narrowed. Default-ON (D1): it falls
    // back to the full command whenever it can't safely narrow, so opt-OUT via
    // `selectiveTests: false` in harness.json stays the only control.
    const selectiveOn = cfg.selectiveTests !== false;
    if (selectiveOn && run.stage === "development") {
      const sel = testSelector(gateCmd, changed);
      if (sel.type === "selective") gateCmd = sel.cmd;
    }

    // T1 (cross-run gate cache): reuse a last-green verdict on the identical git
    // state so repeat/resume/clean-tree gates pay ~$0; never stale-green.
    let r;
    let cached = false;
    let gitState = null;
    if (cfg.cacheGreenGates !== false) {
      gitState = { verifyCmd: gateCmd, head: gitHead(gateCwd), porcelain: changedPaths(gateCwd) };
      const hit = cachedGreen(run.cwd, gitState);
      if (hit) {
        r = { ok: true, output: "cached green (tree unchanged since a prior green gate)", failures: [] };
        cached = true;
        run.stats.gateCacheHits = (run.stats.gateCacheHits ?? 0) + 1;
      } else {
        r = gateResult(gateCmd, gateCwd, run.timeoutMs);
        if (r.ok) recordGreen(run.cwd, gitState);
        else invalidateGreen(run.cwd, gitState);
      }
    } else {
      r = gateResult(gateCmd, gateCwd, run.timeoutMs);
    }
    if (!cached) run.stats.gateRuns++;
    run.stats.gateDirty = false; // the gate just re-verified the current tree
    let coach = cached ? "\nHARNESS: gate result reused from cache (tree unchanged since last green)." : "";
    if (r.ok) {
      run.stats.consecutiveFails = 0;
      // Reward a green streak: if thinking was escalated, drop it back down
      // after enough consecutive passes so cost isn't ratcheted up forever.
      run.stats.consecutivePasses = (run.stats.consecutivePasses ?? 0) + 1;
      const deEscalateAfter = run.budget.deEscalateAfter ?? DEFAULT_CONFIG.deEscalateAfter;
      if (run.ladder.escalated && run.stats.consecutivePasses >= deEscalateAfter) {
        // De-escalate to the edit level (--edit else thinkingStart): the
        // reactive ladder drops cost back down once the run is green again.
        // Task lane never sets the floor (P1 decouple).
        const floor = editLevel(run);
        try {
          pi.setThinkingLevel(floor);
        } catch {
          /* ignore */
        }
        run.ladder.escalated = false;
        run.stats.consecutivePasses = 0;
        coach = `\nHARNESS: ${deEscalateAfter} consecutive green gates — thinking dropped back to ${floor}.`;
      }
    } else {
      run.stats.gateFails++;
      run.stats.consecutiveFails++;
      run.stats.consecutivePasses = 0;
      // T3 (gap #3): record the red gate and surface the last-green rollback
      // point so a failed run never loses the known-good state (opt-in).
      if (cfg.autoFork) {
        recordGateFail(run.cwd, { head: gitState?.head ?? "", verifyCmd: gateCmd, reason: `edit-gate failed (gateFails=${run.stats.gateFails})` });
        const lg = lastGreen(run.cwd);
        if (lg) coach += `\nHARNESS: last green at ${lg.head.slice(0, 7)} (${lg.verifyCmd}) — rollback: git reset --hard ${lg.head}`;
      }
      // T6: persist the red output and auto-triage against prior failures so the
      // model gets a pre-filled known/new classification instead of re-debugging.
      recordGateFailure(run.cwd, { output: r.output });
      const triage = failureTriage(r.output, loadGateFailures(run.cwd, 20));
      if (shouldEscalate(run.stats.consecutiveFails, run.budget.maxConsecutiveFails, run.ladder.escalated)) {
        // Thinking-level ONLY — the harness never changes the model (e.g. flash→pro).
        // Enforced by the unit test that greps harness.ts for setModel. No setModel here.
        pi.setThinkingLevel(run.ladder.thinkingEscalated);
        run.ladder.escalated = true;
        // Corrective loop: don't just spend more tokens — steer the model toward
        // a smaller blast radius to regain a green baseline.
        coach = `\nHARNESS: ${run.stats.consecutiveFails} consecutive gate fails — thinking raised to ${run.ladder.thinkingEscalated}. Signal to NARROW SCOPE: revert the last edit or break the change into smaller steps to regain a green baseline.`;
      }
      // Failure-memory nudge: ride the existing gate-fail coach rail so the model
      // classifies the failure and persists a lesson instead of re-learning it next
      // session (discipline in code, not prose). Memory lives under .harness per protocol.
      coach += `\nHARNESS: gate failed — auto-triage: ${triage.kind === "known" ? "KNOWN (matches a prior failure) — apply its known fix" : "NEW"}. ${triage.kind === "known" ? "" : "Classify (known|new|transient); if new, append a one-line cause + prevention to .harness/longterm/memory/failures.md via your tools; if known, apply its Prevention Rule."}`;
    }
    // Mid-run budget progress feedback so the model can wrap up before the wall.
    const pct = run.stats.turns / Math.max(1, run.budget.maxTurns);
    if (pct >= 0.5 && !run.stats.warned50) {
      run.stats.warned50 = true;
      coach += `\nHARNESS: ${run.stats.turns}/${run.budget.maxTurns} turns used (50%) — prioritize remaining work.`;
    }
    // Cost soft-warning mirrors the turns% warning but on dollars: ladder-escalated
    // turns cost more per turn, so turns% alone understates spend. Warn once at 50%
    // of an optional --budget / maxCost ceiling. No hard stop — YAGNI until evidence.
    const maxCost = run.budget.maxCost;
    if (maxCost && !run.stats.warnedCost50 && run.stats.cost >= maxCost * 0.5) {
      run.stats.warnedCost50 = true;
      coach += `\nHARNESS: est. cost $${run.stats.cost.toFixed(4)} reached 50% of the $${maxCost} budget — prioritize remaining work.`;
    }
    // Soft budget: ask the model for its remaining-work estimate BEFORE the wall
    // so a healthy long run can be extended without a stop/resume round-trip.
    const softAt = Math.floor((run.budget.maxTurns ?? DEFAULT_CONFIG.maxTurns) * (run.budget.softBudgetPct ?? DEFAULT_CONFIG.softBudgetPct));
    if (!run.budget.softAsked && run.stats.turns >= softAt) {
      run.budget.softAsked = true;
      coach += `\nHARNESS: soft budget reached (${run.stats.turns}/${run.budget.maxTurns} turns). State your remaining-work estimate as "Remaining: K turns" in your next reply so the harness can right-size the ceiling.`;
    }
    // Surface files created since the run started so the model doesn't have to
    // rediscover them via reads (context engineering).
    if (run.stats.pendingNewFiles?.length) {
      coach += `\nHARNESS new files: ${run.stats.pendingNewFiles.join(", ")}.`;
      run.stats.pendingNewFiles = [];
    }
    if (editHint) coach += editHint;
    writeRun(run);

    const text = `\n[GATE ${r.ok ? "PASS" : "FAIL"} — ${run.verifyCmd}\n${r.output}]${coach}`;
    return { content: [...parts, { type: "text", text }] };
  });

/** Idea #4: shrink bash tool output to the configured token budget. Returns the
 *  new single-block text when truncated (full output archived under
 *  .harness/temp/), or null to keep the result as-is. Uses pi's own truncation
 *  note when present; otherwise summarizes head + tail + error lines.
 */
function maybeTruncateBashOutput(
  run: RunState,
  event: { toolCallId?: string; isError?: boolean },
  parts: readonly { type: string; text?: string }[],
): string | null {
  const cfg = loadHarnessConfig(run.cwd);
  // null/undefined → default; explicit 0/null in harness.json → disabled.
  const budget = cfg.toolOutputTokens !== undefined ? cfg.toolOutputTokens : DEFAULT_CONFIG.toolOutputTokens;
  if (typeof budget !== "number" || budget <= 0) return null;
  const full = parts
    .map((p) => (p.type === "text" && p.text ? p.text : ""))
    .join("\n")
    .trimEnd();
  if (!full) return null;
  const r = summarizeToolOutput(full, budget, { note: event.isError ? "isError" : "" });
  if (!r.truncated) return null;
  const logPath = join(run.cwd, ".harness", "temp", `tool-${event.toolCallId ?? Date.now()}.log`);
  try {
    mkdirSync(dirname(logPath), { recursive: true });
    writeFileSync(logPath, full);
  } catch {
    /* best-effort archive — truncation still applies */
  }
  return r.text;
}

  // ---- telemetry ----------------------------------------------------------
  pi.on("turn_start", () => {
    const run = activeRun;
    if (!run) return;
    run.stats.turns++;
    if (run.status === "prepared") run.status = "running";
    // T2: the budget's hard stop lives in tool_call; a text-only tail that
    // crosses the wall (no tools) settles naturally instead. Surface the
    // overage once rather than passing silently. No status flip here — that
    // would de-arm the guards while an in-flight tool call executes.
    if (run.status === "running" && shouldStop(run.stats.turns, run.budget.maxTurns) && !run.budgetOverage) {
      run.budgetOverage = true;
      console.log(
        `HARNESS: budget exceeded (${run.stats.turns}/${run.budget.maxTurns} turns) — text-only tail, no tool calls; the hard stop fires at the next tool call.`,
      );
      writeRun(run);
    }
    // Detect new files since the last turn (skip turn 1: the snapshot already
    // covers the initial state). One cheap git spawn per turn.
    if (run.stats.turns >= 2) {
      const { added, set } = gitNewFiles(run.cwd, new Set(run.stats.knownFiles ?? []));
      if (added.length) {
        run.stats.pendingNewFiles = added;
        run.stats.knownFiles = set;
      }
    }
    writeRun(run);
  });

/** T3: order-preserving union of plan task lists, keyed by task text. */
function mergePlanTasks(
  prev: { text: string; footprint: string }[] | undefined,
  next: { text: string; footprint: string }[],
): { text: string; footprint: string }[] {
  const out = [...(prev ?? [])];
  for (const t of next) {
    if (!out.some((o) => o.text === t.text)) out.push(t);
  }
  return out;
}

/** v1.13.1 edit-mismatch coach: when the edit tool reports an oldText miss,
 *  locate the intended block in the file and report the exact byte diff
 *  (indent count, CRLF vs LF, invisible chars) so the model fixes it blind-free.
 *  Returns an empty string unless this is an edit failure — zero overhead for
 *  the common (successful edit) path.
 */
function editCoachForEvent(
  run: RunState,
  event: { toolName?: string; content?: unknown; input?: unknown },
): string {
  try {
    if (event.toolName !== "edit") return "";
    const parts = Array.isArray(event.content) ? event.content : [];
    const text = parts
      .map((p) => (p && typeof p === "object" && "text" in p ? String((p as { text?: unknown }).text ?? "") : ""))
      .join("\n");
    if (!EDIT_MISS_RE.test(text)) return "";
    const input = (event.input ?? {}) as { path?: string; edits?: Array<{ oldText?: string; newText?: string }> };
    const rel = normalizeRel(String(input.path ?? ""), run.cwd);
    if (!rel || !Array.isArray(input.edits) || input.edits.length === 0) return "";
    const fileText = readFileSync(join(run.cwd, rel), "utf8");
    const bad = mismatchedEditIndices(fileText, input.edits);
    const out: string[] = [];
    for (const i of bad) {
      const h = editMismatchHint(fileText, input.edits[i]?.oldText ?? "");
      if (h) out.push(`\nHARNESS edit hint (${rel}, edit ${i}): ${h}`);
      if (out.length >= 2) break;
    }
    return out.join("");
  } catch {
    return "";
  }
}

  pi.on("message_end", (event) => {
    const run = activeRun;
    if (!run || run.status !== "running") return;
    if (event.message?.role !== "assistant") return;
    const text = contentText((event.message as { content?: unknown })?.content);
    // AI prediction (default planning level): the protocol asks the model to open
    // its first message with "Thinking: <level>". Capture it before scope is
    // declared, only if the user did not force --think, and apply it so the rest
    // of the planning phase runs at the predicted level. Capped in core.
    if (!run.planning?.done && run.planning?.thinkLevel == null) {
      const pred = parseThinkingPrediction(text);
      if (pred != null) {
        run.planning.thinkLevel = pred;
        pi.setThinkingLevel(planLevel(run));
        writeRun(run);
      }
    }
    // Lane triage (Phase 0): the protocol asks the model to open with
    // "Lane: <S|M|L>". Refine the seeded heuristic only if the user did NOT
    // force --lane, and before scope is declared. A --lane flag always wins.
    if (!run.planning?.done && !run.laneForced) {
      const lane = parseLanePrediction(text);
      if (lane != null && lane !== run.lane) {
        // Advisory only (P1 decouple): lane never changes thinking levels — it
        // feeds Gate 2, the verify tier, and the report.
        run.lane = lane;
        writeRun(run);
      }
    }
    // Task-adaptive persona: capture the model's "Persona: <domain>" self-choice
    // (validated taxonomy) before scope is declared. Only for non-trivial tasks
    // (like the tasklist) so trivial runs stay zero-overhead; a --persona flag
    // wins and is never overwritten.
    if (!run.planning?.done && run.persona?.domain == null && tasklistEnabled(planLevel(run))) {
      const p = parsePersona(text);
      if (p != null) {
        run.persona ??= { domain: null };
        run.persona.domain = p;
        writeRun(run);
      }
    }
    // Planning artifact (Option A): capture the model's structured plan (Goal /
    // Plan-anchors / priority Tasks with footprint tags) before scope is
    // declared. Only for non-trivial tasks (planLevel >= medium), so trivial
    // runs stay zero-overhead. Overwrite keeps the latest plan; a later empty
    // parse (a non-planning message) never clears a previously captured one.
    // Requirement-analysis stage: the model drafts its first-pass requirements and
    // self-reviews them through the first-principles lens (Question/Delete/
    // Simplify/Accelerate/Automate) BEFORE committing to a plan. The refined
    // list feeds run.plan.requirements and surfaces in the report.
    if (!run.planning?.done) {
      const reqs = parseRequirements(text);
      if (reqs.length) {
        run.plan ??= { goal: "", anchors: "", tasks: [], risky: false, requirements: [], gate2: null, progress: { done: 0, total: 0, remaining: 0, current: null } };
        // R1 (traceability): stable ordinals so plan tasks and the review can
        // cite each requirement (R1., R2.…) instead of matching raw text.
        run.plan.requirements = reqs.map((r, i) => `R${i + 1}. ${String(r).trim()}`);
        writeRun(run);
      }
    }
        if (!run.planning?.done && tasklistEnabled(planLevel(run))) {
      const p = parsePlan(text);
      if (p.tasks.length || p.goal || p.plan) {
        run.plan ??= { goal: "", anchors: "", tasks: [], risky: false, requirements: [], gate2: null, progress: { done: 0, total: 0, remaining: 0, current: null } }; // guard for crash-recovered runs
        run.plan.goal = p.goal || run.plan.goal;
        run.plan.anchors = p.plan || run.plan.anchors;
        // T3: merge, don't replace — a mid-run partial restate (fewer tasks)
        // must not truncate the recorded plan that resume/report consume.
        run.plan.tasks = mergePlanTasks(run.plan.tasks, p.tasks);
        run.plan.risky = run.plan.risky || p.risky;
        // Set Gate 2 to pending as soon as the plan is known to be boundary/risky
        // on an L-lane run — the reviewer must clear it before build.
        if (run.plan.gate2 == null && gate2Required(run.lane, run.plan)) {
          run.plan.gate2 = "pending";
        }
        // Re-select the verify tier from the actual plan footprint — a boundary
        // task forces Full regardless of the initial lane heuristic.
        run.verifyTier = verifyTier({ lane: run.lane, plan: run.plan });
        // Requirement-analysis done: a plan is committed now, so the initial
        // requirements stage hands off to planning (before development).
        if (run.stage === "requirements") run.stage = "planning";
        writeRun(run);
      }
    }
    // Acceptance closure (v1.13): capture the model's acceptance statement —
    // verdict (`Acceptance: met|partial|unmet`) and any `## Acceptance` criteria
    // checkboxes — from any message; latest wins. Feeds the report + auto-commit.
    {
      const acc = parseAcceptance(text);
      if (acc.verdict || acc.criteria.length) {
        run.acceptance = acc;
        writeRun(run);
      }
    }
    // Build-follows-plan progress (A4): update done/remaining/current from the
    // model's checkbox ticks on ANY message (planning or development) so the
    // report reflects the live task being worked.
    {
      const prog = parsePlanProgress(text);
      if (prog.total > 0) {
        run.plan ??= { goal: "", anchors: "", tasks: [], risky: false, requirements: [], gate2: null, progress: { done: 0, total: 0, remaining: 0, current: null } };
        run.plan.progress = prog;
      }
    }
    // Capture the model's live remaining-work estimate BEFORE the hard wall so a
    // healthy long run can be extended without a stop/resume round-trip. Only
    // trust it once the soft budget has asked for it (avoids a stale early
    // mid-work "Remaining" number driving the extension).
    const est = parseRemainingEstimate(text);
    if (est != null && run.budget.softAsked) run.budget.pendingEstimate = est;
    const u = (event.message as { usage?: { input?: number; output?: number; cacheRead?: number; cost?: { total?: number } } }).usage;
    if (!u) return;
    run.stats.calls++;
    run.stats.tokensIn += u.input ?? 0;
    run.stats.tokensCached += u.cacheRead ?? 0;
    run.stats.tokensOut += u.output ?? 0;
    run.stats.cost += u.cost?.total ?? 0;
    // Running peak turn cost — never drops early (expensive) turns like the old
    // 40-cap shift did, so the report's "peak turn cost" is accurate for long runs.
    run.stats.peakTurnCost = Math.max(run.stats.peakTurnCost ?? 0, u.cost?.total ?? 0);
    writeRun(run);
  });
}

