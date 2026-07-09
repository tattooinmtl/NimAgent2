// Goal mode — pi-goal style autonomous task completion.
//
// /goal <objective> [--tokens 100k] puts the session into goal mode: a
// persistence directive is injected, and whenever a turn ends without the
// model calling the goal_complete tool, the REPL queues a continuation
// prompt automatically — until completion, pause, the iteration cap, or the
// token budget. Goals are session-scoped (they don't persist across runs).

import { c, infoLine, warnLine, errorLine } from "../ui.mjs";
import { tools, impl } from "../tools/index.mjs";
import { parseTokenBudget } from "./helpers.mjs";

const MAX_GOAL_ITERATIONS = 25;
const MAX_OBJECTIVE_CHARS = 4000;

export function goalDirective(goal) {
  return [
    "# Active goal",
    `Objective: ${goal.objective}`,
    "Work autonomously toward this objective across turns. Verify your work before finishing.",
    "When (and only when) the objective is fully achieved and verified, call the goal_complete tool",
    "with a concrete summary of what was done. Do not claim completion in prose without calling it.",
  ].join("\n");
}

// Register the goal_complete tool once; it reads the live goal off ctx.
export function registerGoalTool(ctx) {
  if (!tools.find((t) => t.function?.name === "goal_complete")) {
    tools.push({
      type: "function",
      function: {
        name: "goal_complete",
        description:
          "Mark the active goal as complete. Call ONLY when the objective is fully achieved and verified. Requires a concrete summary of what was accomplished.",
        parameters: {
          type: "object",
          properties: {
            summary: { type: "string", description: "What was accomplished and how it was verified" },
          },
          required: ["summary"],
        },
      },
    });
  }
  impl.goal_complete = ({ summary }) => {
    const goal = ctx.goal;
    if (!goal || goal.status !== "active") {
      return "No active goal — nothing to complete.";
    }
    const text = String(summary || "").trim();
    if (text.length < 20) {
      throw new Error("summary is too short — describe concretely what was accomplished and how it was verified");
    }
    goal.status = "complete";
    goal.summary = text;
    goal.completedAt = new Date().toISOString();
    return `Goal marked complete: ${goal.objective.slice(0, 120)}`;
  };
}

export function goalStatusLine(ctx) {
  const g = ctx.goal;
  if (!g) return "no goal set";
  const spent = ctx.session.totalTokens - g.tokensAtStart;
  const budget = g.budgetTokens ? ` / ${Math.round(g.budgetTokens / 1000)}k budget` : "";
  return `[${g.status}] "${g.objective.slice(0, 80)}" — iteration ${g.iterations}, ${Math.round(spent / 1000)}k tokens${budget}`;
}

function printGoalStatus(ctx) {
  if (!ctx.goal) {
    infoLine("no goal set — start one with /goal <objective> [--tokens 100k]");
    return;
  }
  infoLine(goalStatusLine(ctx));
  if (ctx.goal.status === "complete" && ctx.goal.summary) {
    console.log(c.dim("    " + ctx.goal.summary.slice(0, 300)));
  }
}

export async function goalCommand(ctx, arg) {
  const trimmed = String(arg || "").trim();
  const sub = trimmed.split(/\s+/)[0]?.toLowerCase() || "";
  const rest = trimmed.slice(sub.length).trim();

  switch (sub) {
    case "":
    case "status":
      printGoalStatus(ctx);
      return { startTurn: false };

    case "pause":
      if (!ctx.goal || ctx.goal.status !== "active") { warnLine("no active goal to pause"); return { startTurn: false }; }
      ctx.goal.status = "paused";
      infoLine("goal paused — /goal resume to continue");
      return { startTurn: false };

    case "resume":
      if (!ctx.goal) { warnLine("no goal to resume — /goal <objective>"); return { startTurn: false }; }
      if (ctx.goal.status === "complete") { warnLine("goal is already complete — start a new one with /goal <objective>"); return { startTurn: false }; }
      ctx.goal.status = "active";
      infoLine("goal resumed");
      return { startTurn: true, prompt: continuationPrompt(ctx.goal) };

    case "clear":
      ctx.goal = null;
      infoLine("goal cleared");
      return { startTurn: false };

    case "edit": {
      if (!ctx.goal) { warnLine("no goal to edit — /goal <objective>"); return { startTurn: false }; }
      if (!rest) { errorLine("usage: /goal edit <new objective>"); return { startTurn: false }; }
      ctx.goal.objective = rest.slice(0, MAX_OBJECTIVE_CHARS);
      infoLine("goal objective updated (counters preserved)");
      return { startTurn: false };
    }

    default: {
      // /goal <objective> [--tokens N]
      let objective = trimmed;
      let budgetTokens = null;
      const budgetMatch = objective.match(/\s--tokens\s+(\S+)\s*$/i);
      if (budgetMatch) {
        budgetTokens = parseTokenBudget(budgetMatch[1]);
        if (budgetTokens == null) { errorLine(`could not parse token budget "${budgetMatch[1]}" (try 100k, 1m, 250000)`); return { startTurn: false }; }
        objective = objective.slice(0, budgetMatch.index).trim();
      }
      if (!objective) { errorLine("usage: /goal <objective> [--tokens 100k]"); return { startTurn: false }; }
      ctx.goal = {
        objective: objective.slice(0, MAX_OBJECTIVE_CHARS),
        status: "active",
        iterations: 0,
        startedAt: new Date().toISOString(),
        tokensAtStart: ctx.session.totalTokens,
        budgetTokens,
        summary: null,
      };
      ctx.messages.push({ role: "system", content: goalDirective(ctx.goal) });
      infoLine(`goal set${budgetTokens ? ` (budget ${Math.round(budgetTokens / 1000)}k tokens)` : ""} — the agent will keep working until goal_complete`);
      return { startTurn: true, prompt: `Begin working toward the goal now: ${ctx.goal.objective}` };
    }
  }
}

function continuationPrompt(goal) {
  return [
    `GOAL CONTINUATION (iteration ${goal.iterations + 1}): the goal is not yet complete.`,
    `Objective: ${goal.objective}`,
    "Continue working. If everything is genuinely done and verified, call goal_complete with a summary.",
  ].join("\n");
}

// Called by the REPL after each turn. Returns a continuation prompt when the
// goal loop should run another turn, or null to stop.
export function nextGoalStep(ctx) {
  const g = ctx.goal;
  if (!g || g.status !== "active") return null;

  g.iterations++;
  if (g.iterations >= MAX_GOAL_ITERATIONS) {
    g.status = "paused";
    warnLine(`goal paused after ${MAX_GOAL_ITERATIONS} iterations — /goal resume to keep going`);
    return null;
  }
  if (g.budgetTokens) {
    const spent = ctx.session.totalTokens - g.tokensAtStart;
    if (spent >= g.budgetTokens) {
      g.status = "budget_limited";
      warnLine(`goal hit its token budget (${Math.round(spent / 1000)}k) — /goal resume to continue anyway`);
      return null;
    }
  }
  return continuationPrompt(g);
}
