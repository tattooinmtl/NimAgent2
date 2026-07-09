// Interactive REPL: readline loop, interrupt handling, tab completion for
// slash commands, the agent turn runner, and goal-mode auto-continuation.

import readline from "node:readline";
import {
  c, banner, infoLine, warnLine, shutdown,
  promptTop, promptBottom, statusBar, setPersonaIndicator,
} from "../ui.mjs";
import { runTurn } from "../core/agent.mjs";
import { Session } from "../core/config.mjs";
import { disconnectAll } from "../integrations/mcp.mjs";
import { disconnectBridge } from "../integrations/bridge.mjs";
import { classifyIntent, killSidecar } from "../integrations/router.mjs";
import * as llama from "../local/llama.mjs";
import { applySkill, restoreSessionMessages, reportMissingKey } from "./helpers.mjs";
import { activeModelBlockedByHealth } from "./models.mjs";
import { dispatchCommand, commandNames } from "./commands.mjs";
import { nextGoalStep } from "./goal.mjs";

export async function startRepl(ctx, { resumeMode = false } = {}) {
  banner(ctx.model.key);
  if (ctx.loadedExtensions.length || ctx.skills.length || ctx.mcpInfo.servers) {
    infoLine(
      `loaded ${ctx.loadedExtensions.length} extension(s), ${ctx.skills.length} skill(s), ${ctx.mcpInfo.servers} MCP server(s)` +
        (ctx.skills.length ? " — " + ctx.skills.map((s) => s.command).join(" ") : "")
    );
    console.log("");
  }

  // First-run onboarding: guide the user to configure a key if none is set.
  if (reportMissingKey(ctx.model)) console.log("");

  // --resume: rebuild the conversation from the last session before prompting.
  if (resumeMode) {
    const lastSession = await Session.findLast();
    if (!lastSession) {
      warnLine("--resume: no previous session found for this directory");
    } else {
      restoreSessionMessages(lastSession.records, ctx.messages);
      infoLine(`resumed ${ctx.messages.length} message(s) from ${lastSession.file}`);
      console.log("");
    }
  }

  // Tab completion: slash commands + skill commands.
  const completions = () => [...commandNames(), ...ctx.skills.map((s) => s.command)];
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: c.cyan("› "),
    completer: (line) => {
      if (!line.startsWith("/")) return [[], line];
      const hits = completions().filter((x) => x.startsWith(line));
      return [hits.length ? hits : [], line];
    },
  });
  ctx.rl = rl;

  // Ctrl-C interrupt: wired to BOTH process and rl (rl.pause() mutes rl's
  // SIGINT on Windows, so the process-level handler covers generation time).
  const handleInterrupt = () => {
    if (ctx.currentAbort) ctx.currentAbort.abort();
    else rl.close();
  };
  process.on("SIGINT", handleInterrupt);
  rl.on("SIGINT", handleInterrupt);

  // ESC detection via raw mode, only while readline is paused (during
  // generation) so echoing is never affected. Raw-mode Ctrl-C = 0x03.
  const canRaw = process.stdin.isTTY && typeof process.stdin.setRawMode === "function";
  ctx.canRaw = canRaw;
  if (canRaw) {
    readline.emitKeypressEvents(process.stdin);
    process.stdin.on("data", (chunk) => {
      if (ctx.currentAbort && (chunk[0] === 0x1b || chunk[0] === 0x03)) {
        ctx.currentAbort.abort();
      }
    });
  }
  const startInterruptWatch = () => { if (canRaw) { process.stdin.setRawMode(true); process.stdin.resume(); } };
  const stopInterruptWatch = () => { if (canRaw) { process.stdin.setRawMode(false); } };

  // Permission "ask" confirmation: hand the terminal back to readline
  // mid-turn, ask, then restore the generation interrupt watch.
  ctx.confirmToolUse = async function confirmToolUse(name, summary) {
    stopInterruptWatch();
    rl.resume();
    const q = c.yellow(`  allow ${name}${summary ? ` (${String(summary).slice(0, 80)})` : ""}? [y/N/a=always] `);
    const answer = await new Promise((resolve) => rl.question(q, resolve));
    rl.pause();
    startInterruptWatch();
    return answer;
  };

  function clearPendingInput() {
    if (typeof rl.line === "string") rl.line = "";
    if (typeof rl.cursor === "number") rl.cursor = 0;
    if (process.stdout.isTTY) {
      readline.clearLine(process.stdout, 0);
      readline.cursorTo(process.stdout, 0);
    }
  }

  function showPrompt() {
    clearPendingInput();
    statusBar(ctx.model, ctx.session);
    promptTop();
    rl.prompt();
  }

  // Run one agent turn, then keep going while goal mode queues continuations.
  async function runAgentTurns() {
    rl.pause();
    startInterruptWatch();
    let keepGoing = true;
    while (keepGoing) {
      ctx.currentAbort = new AbortController();
      await runTurn({
        model: ctx.model,
        messages: ctx.messages,
        session: ctx.session,
        maxIterations: ctx.maxIterations,
        diffPreview: ctx.diffPreview,
        persona: ctx.activePersona,
        signal: ctx.currentAbort.signal,
        permissions: ctx.settings.permissions,
        confirmTool: ctx.confirmToolUse,
      });
      const aborted = ctx.currentAbort.signal.aborted;
      ctx.currentAbort = null;

      keepGoing = false;
      if (!aborted) {
        const continuation = nextGoalStep(ctx);
        if (continuation) {
          infoLine(`goal iteration ${ctx.goal.iterations} — continuing (Esc/Ctrl-C to interrupt, /goal pause to stop)`);
          ctx.messages.push({ role: "user", content: continuation });
          await ctx.session.append({ type: "user", content: continuation });
          keepGoing = true;
        } else if (ctx.goal?.status === "complete" && !ctx.goal.announced) {
          ctx.goal.announced = true;
          infoLine(`🏁 goal complete after ${ctx.goal.iterations} iteration(s)`);
        }
      }
    }
    stopInterruptWatch();
    console.log("");
    clearPendingInput();
    rl.resume();
  }

  let multiLine = "";

  rl.on("line", async (input) => {
    const line = input.trim();

    // Multi-line continuation
    if (line.endsWith("\\") && !line.startsWith("/")) {
      multiLine += line.slice(0, -1) + "\n";
      process.stdout.write(c.dim("… "));
      return;
    }

    const fullLine = multiLine + line;
    multiLine = "";
    if (!fullLine) return showPrompt();

    promptBottom();

    if (fullLine.startsWith("/")) {
      const parts = fullLine.split(/\s+/);
      const cmdName = parts[0].slice(1);
      const arg = parts.slice(1).join(" ");

      // Skill commands (from skills/*/SKILL.md) run a turn with skill instructions.
      if (ctx.skillByCommand.has(parts[0])) {
        await applySkill(ctx.skillByCommand.get(parts[0]), arg, ctx.messages, ctx.session);
        await runAgentTurns();
        return showPrompt();
      }

      const result = await dispatchCommand(ctx, cmdName, arg, parts);
      if (result?.closed) return;
      if (result?.startTurn) {
        if (result.prompt) {
          ctx.messages.push({ role: "user", content: result.prompt });
          await ctx.session.append({ type: "user", content: result.prompt });
        }
        if (!activeModelBlockedByHealth(ctx)) await runAgentTurns();
      }
      return showPrompt();
    }

    // Plain input → the agent.
    ctx.messages.push({ role: "user", content: fullLine });
    await ctx.session.append({ type: "user", content: fullLine });
    if (ctx.routerCfg.enabled && ctx.routeMode === "auto" && !ctx.routePinned) {
      ctx.activePersona = await classifyIntent({ message: fullLine, settings: ctx.settings });
      setPersonaIndicator(ctx.activePersona);
    }
    if (activeModelBlockedByHealth(ctx)) {
      return showPrompt();
    }
    await runAgentTurns();
    showPrompt();
  });

  rl.on("close", async () => {
    disconnectAll();
    disconnectBridge();
    killSidecar();
    if (llama.status().running) {
      llama.stopServer();
      infoLine("stopped local llama server");
    }
    console.log(c.dim("\n  bye 👋"));
    await shutdown(0);
  });

  showPrompt();
}
