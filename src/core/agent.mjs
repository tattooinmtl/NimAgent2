// The agent loop: send conversation to the model, execute any tool calls,
// feed results back, repeat until the model answers with plain text.

import { chatStream, completionStream } from "./provider.mjs";
import { renderTemplate } from "../integrations/router.mjs";
import { tools, runTool } from "../tools/index.mjs";
import {
  parseTextToolCalls, buildParamRegistry, hasToolIntent,
  stripThink, stripToolCallText, textToolInstructions, recoveryMessage,
} from "./toolcalls.mjs";
import {
  c, assistantPrefix, toolLine, toolResultLine, errorLine, warnLine,
  startStatus, stopStatus, startGenerationStatus, diffPreviewLine,
  streamWrite, streamNewline
} from "../ui.mjs";

// Re-serialize past assistant tool calls in the EXACT format the protocol
// instructions demand, so the model's own history reinforces the right shape
// instead of teaching it a divergent one.
function serializeToolCall(call) {
  const fn = call.function || {};
  let argsObj = {};
  try { argsObj = JSON.parse(fn.arguments || "{}"); } catch { /* leave empty */ }
  const params = Object.entries(argsObj)
    .map(([k, v]) => `<parameter=${k}>${typeof v === "string" ? v : JSON.stringify(v)}</parameter>`)
    .join("\n");
  return `<tool_call>\n<function=${fn.name || ""}>\n${params}\n</function>\n</tool_call>`;
}

function messagesWithTextTools(messages) {
  const normalized = messages.map((m) => {
    if (m.role === "tool") {
      const name = m.name ? ` (${m.name})` : "";
      return { role: "user", content: `Tool result${name}:\n${m.content || ""}` };
    }
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      const calls = m.tool_calls.map(serializeToolCall).join("\n");
      return { role: "assistant", content: [m.content, calls].filter(Boolean).join("\n") };
    }
    return m;
  });

  const instructions = textToolInstructions(tools);
  if (!normalized.length || normalized[0].role !== "system") {
    return [{ role: "system", content: instructions }, ...normalized];
  }
  return [
    { ...normalized[0], content: normalized[0].content + "\n" + instructions },
    ...normalized.slice(1),
  ];
}

// Transient provider errors that are worth retrying automatically.
const RETRYABLE = /429|50[234]|ResourceExhausted|workers are busy|Service Unavailable/i;
const MAX_RETRIES  = 5;
const BASE_DELAY   = 3000;  // 3s → 6s → 12s → 24s → 48s

function isRetryable(err) {
  return RETRYABLE.test(err.message || String(err));
}

// chatStream wrapper with exponential backoff. Retries up to MAX_RETRIES
// times on transient 429/503/ResourceExhausted errors, showing a countdown
// so the user knows why the agent paused.
async function chatStreamWithRetry({ model, messages, tools, signal, onToken, _templatePrompt }) {
  let attempt = 0;
  while (true) {
    try {
      if (_templatePrompt != null) {
        return await completionStream({ model, prompt: _templatePrompt, signal, onToken });
      }
      return await chatStream({ model, messages, tools, signal, onToken });
    } catch (e) {
      // Aborted by user (Ctrl-C / Esc) — propagate immediately, no retry.
      if (e.name === "AbortError" || signal?.aborted) throw e;
      if (!isRetryable(e) || attempt >= MAX_RETRIES) throw e;
      attempt++;
      const delay = BASE_DELAY * Math.pow(2, attempt - 1);
      const secs  = Math.round(delay / 1000);
      warnLine(`provider unavailable (${e.message.split("\n")[0].slice(0, 80)})`);
      warnLine(`retrying in ${secs}s… (attempt ${attempt}/${MAX_RETRIES})`);
      // Respect abort during the wait period.
      await new Promise((resolve, reject) => {
        const t = setTimeout(resolve, delay);
        signal?.addEventListener("abort", () => { clearTimeout(t); reject(new DOMException("aborted", "AbortError")); }, { once: true });
      });
    }
  }
}

// Map a batch of tool calls to the animated status shown while they run.
// Priority: writing > searching > reading > generic running.
function statusForTools(calls) {
  const names = calls.map((c) => c.function?.name);
  if (names.some((n) => n === "edit_file" || n === "write_file" || n === "apply_patch")) return "coding";
  if (names.some((n) => n === "project_inspect" || n === "git_status" || n === "git_diff")) return "reading";
  if (names.some((n) => n === "search" || n === "find_files")) return "searching";
  if (names.some((n) => n === "read_file" || n === "read_many_files" || n === "list_dir")) return "reading";
  return "running";
}

export function systemPrompt() {
  return [
    "You are NimAgent, a terminal-based coding agent.",
    "You help with software engineering tasks in the user's current working directory.",
    `Working directory: ${process.cwd()}`,
    `Platform: ${process.platform}`,
    "",
    "Use the provided tools to inspect projects, read files, patch code, manage project todos, inspect git, manage dev processes, run shell commands, and run tests.",
    "Prefer making concrete changes with tools over describing them.",
    "When you run shell commands, the shell is PowerShell on Windows.",
    "",
    "Guidelines:",
    "- Always read a file before editing it so you know the exact content.",
    "- Start unfamiliar projects with project_inspect, then read_many_files for key manifests/configs.",
    "- Use apply_patch for multi-hunk or multi-file edits; use edit_file for tiny exact replacements; use write_file only for new files or full rewrites.",
    "- For multi-step work, keep project_todo current: add tasks, mark active work in_progress, and close finished tasks.",
    "- Use git_status and git_diff before summarizing changes or committing.",
    "- Use git_commit only when the user explicitly asks you to commit.",
    "- Use start_process for long-running dev servers, process_status for logs, and stop_process when done.",
    "- File tools are workspace-scoped. Do not try to work outside the current directory unless the user changes cwd before launching NimAgent.",
    "- Use run_shell with dry_run=true to inspect risk before uncertain commands.",
    "- run_shell blocks obviously destructive commands unless allow_unsafe=true; set that only when the user explicitly authorized the exact action.",
    "- When searching, prefer specific patterns over broad ones to reduce noise.",
    "- After making changes, run relevant tests or linters to verify correctness.",
    "- Keep prose concise. After finishing, briefly summarize what you did.",
    "- If a tool call fails, read the error carefully and retry with corrected parameters.",
    "- For multi-file changes, make them one at a time and verify each step.",
    "- When a problem could be environmental (missing runtime, wrong version, PATH issue), diagnose with system_info, dev_env_report, and where_is before guessing.",
    "- Never end your reply right after requesting a tool — the tool result always comes back to you; keep working until the task is done, then summarize.",
  ].join("\n");
}

// Tools the user answered "always allow" for this session (permission "ask").
const alwaysAllowed = new Set();

// Resolve a tool call against the user's permission settings.
// States: "allow" (silent), "deny" (blocked with an error message the model
// sees), "ask" (interactive confirmation via the REPL). "*" sets the default
// for unlisted tools; no entry at all means allow.
async function checkPermission(name, summary, permissions, confirmTool) {
  const state = (permissions && (permissions[name] ?? permissions["*"])) || "allow";
  if (state === "deny") {
    return { allowed: false, message: `DENIED: the user's permission settings block the "${name}" tool. Do not retry it; use another approach or ask the user.` };
  }
  if (state !== "ask" || alwaysAllowed.has(name)) return { allowed: true };
  if (!confirmTool) {
    return { allowed: false, message: `DENIED: "${name}" requires interactive confirmation (permission "ask") but this session is non-interactive.` };
  }
  const answer = String((await confirmTool(name, summary)) || "").trim().toLowerCase();
  if (answer === "a" || answer === "always") {
    alwaysAllowed.add(name);
    return { allowed: true };
  }
  if (answer === "y" || answer === "yes") return { allowed: true };
  return { allowed: false, message: `DENIED: the user declined the "${name}" tool call.` };
}

export async function runTurn({ model, messages, session, maxIterations = 30, diffPreview = true, persona = null, signal = null, permissions = null, confirmTool = null }) {
  // If a persona is active, swap the system message and iteration budget.
  // Falls back to the defaults above when persona is null (existing behaviour).
  if (persona) {
    maxIterations = persona.maxIterations ?? maxIterations;
    if (messages.length > 0 && messages[0].role === "system") {
      messages[0] = { role: "system", content: persona.systemPrompt() };
    }
  }
  // Template-aware path: render messages through Jinja2 then use /v1/completions.
  // Active when the resolved model's provider has a chatTemplate configured.
  const useTemplate = Boolean(model.chatTemplate);
  const useNativeTools = model.nativeTools !== false;
  const useTextTools = !useNativeTools;

  // Schema registry for the tolerant text-tool parser, and a budget of
  // corrective retries when the model emits a malformed/truncated tool call.
  const paramRegistry = buildParamRegistry(tools);
  const MAX_PARSE_RECOVERIES = 3;
  let parseRecoveries = 0;

  for (let i = 0; i < maxIterations; i++) {
    let resp;
    let streamedContent = false;
    let tokenCount = 0;
    try {
      // While the model is producing its first token, show the framed token
      // meter (the yellow-bounded bottom panel). As soon as text arrives we
      // tear the panel down and stream the answer inline, token by token.
      startGenerationStatus(() => tokenCount);

      if (useTemplate) {
        // Render the full message history through the provider's Jinja2 template,
        // then send as a raw prompt to /v1/completions.
        let prompt;
        try {
          prompt = await renderTemplate(model.chatTemplate, messages, tools);
        } catch (e) {
          stopStatus();
          errorLine(`Template render failed: ${e.message}`);
          return;
        }
        resp = await chatStreamWithRetry({
          model,
          messages: null,   // not used in template path
          tools: null,
          signal,
          _templatePrompt: prompt,
          onToken(token) {
            tokenCount++;
            if (!streamedContent) { stopStatus(); assistantPrefix(); streamedContent = true; }
            streamWrite(token);
          },
        });
      } else {
        const providerMessages = useTextTools ? messagesWithTextTools(messages) : messages;
        resp = await chatStreamWithRetry({
          model,
          messages: providerMessages,
          tools: useNativeTools ? tools : null,
          signal,
          onToken: useTextTools ? undefined : function onToken(token) {
            tokenCount++;
            if (!streamedContent) {
              stopStatus();
              assistantPrefix();
              streamedContent = true;
            }
            streamWrite(token);
          },
        });
      }

      if (!streamedContent) stopStatus();
      else streamNewline();
    } catch (e) {
      if (!streamedContent) stopStatus();
      else streamNewline();
      if (e.name === "AbortError" || signal?.aborted) {
        warnLine("interrupted");
        return;
      }
      errorLine(e.message || String(e));
      session.append({ type: "error", message: e.message || String(e) });
      return;
    }

    const msg = resp.message;

    // Template/text-tool paths: parse tool-call text (canonical XML, GLM
    // arg_key/arg_value, Qwen JSON, hybrid/unclosed forms) into OpenAI
    // tool_calls, then strip the tool syntax + <think> blocks from content.
    let rawContent = "";
    if ((useTemplate || useTextTools) && msg.content) {
      rawContent = stripThink(msg.content);
      const toolCalls = parseTextToolCalls(rawContent, paramRegistry);
      if (toolCalls.length) {
        msg.tool_calls = toolCalls;
        msg.content = stripToolCallText(rawContent).trim();
      } else {
        msg.content = rawContent.trim();
      }
    }

    messages.push(msg);
    session.append({ type: "assistant", message: msg, usage: resp.usage });
    if (resp.usage) session.addCost(resp.usage);

    const calls = msg.tool_calls || [];

    // Content already streamed above; only print here if nothing was streamed
    // (e.g. a tool-only response that carried no content tokens).
    if (msg.content && msg.content.trim() && !streamedContent) {
      assistantPrefix();
      console.log(msg.content.trim());
    }

    if (calls.length === 0) {
      // The model tried to call a tool but the text couldn't be parsed, or the
      // response was cut off mid-call by the token limit. Don't end the turn —
      // tell the model what happened and let it re-emit the call.
      const truncated = resp.finishReason === "length";
      const attempted = (useTemplate || useTextTools) && hasToolIntent(rawContent);
      if ((attempted || (truncated && useTextTools)) && parseRecoveries < MAX_PARSE_RECOVERIES) {
        parseRecoveries++;
        warnLine(
          truncated
            ? `response truncated by token limit — asking the model to re-emit (${parseRecoveries}/${MAX_PARSE_RECOVERIES})`
            : `malformed tool call — asking the model to re-emit (${parseRecoveries}/${MAX_PARSE_RECOVERIES})`
        );
        messages.push({ role: "user", content: recoveryMessage() });
        continue;
      }
      if (truncated) warnLine("response was truncated by the max_tokens limit");
      return; // model is done
    }

    // Print each tool call (and any edit diff) up front, then animate a single
    // action status (reading / searching / coding / running) while the whole
    // batch executes in parallel, then print the results in call order.
    const parsed = calls.map((call) => {
      let args = {};
      try {
        args = JSON.parse(call.function?.arguments || "{}");
      } catch {
        /* leave empty */
      }
      const name = call.function?.name;
      toolLine(name, argSummary(name, args));
      if (name === "edit_file" && diffPreview) {
        diffPreviewLine(args.path, args.old_string, args.new_string);
      }
      return { call, name, args };
    });

    // Resolve permissions sequentially BEFORE parallel execution so "ask"
    // confirmations don't interleave on the terminal.
    for (const p of parsed) {
      p.permission = await checkPermission(p.name, argSummary(p.name, p.args), permissions, confirmTool);
      if (!p.permission.allowed) warnLine(`${p.name}: ${p.permission.message.split(":")[0].toLowerCase()} by permissions`);
    }

    startStatus(statusForTools(calls));
    const toolResults = await Promise.all(
      parsed.map(async ({ call, name, args, permission }) => {
        let result;
        if (!permission.allowed) {
          result = permission.message;
        } else {
          try {
            result = await runTool(name, args);
          } catch (e) {
            result = "ERROR: " + e.message;
          }
        }
        return { call, name, args, result };
      })
    );
    stopStatus();

    // Print results and push tool messages in original call order
    // (API requires matching tool_call_id order).
    for (const { call, name, args, result } of toolResults) {
      toolResultLine(result);
      session.append({ type: "tool", name, args, result, tool_call_id: call.id });
      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: typeof result === "string" ? result : JSON.stringify(result),
      });
    }
  }
  errorLine(`Stopped after ${maxIterations} tool iterations.`);
}

function argSummary(name, args) {
  switch (name) {
    case "read_file":
    case "read_many_files":
    case "write_file":
    case "edit_file":
    case "list_dir":
      return args.path || (Array.isArray(args.paths) ? `${args.paths.length} file(s)` : "");
    case "apply_patch":
      return "patch";
    case "find_files":
      return (args.pattern || ".") + (args.path ? ` in ${args.path}` : "");
    case "search":
      return c.dim(`/${args.pattern}/`) + (args.path ? ` in ${args.path}` : "") + (args.glob ? ` ${args.glob}` : "");
    case "run_shell":
      return args.command || "";
    case "run_test":
      return args.command || "npm test";
    case "jq_query":
      return c.dim(args.filter || "") + (args.path ? ` ${args.path}` : "");
    case "project_inspect":
      return args.path || ".";
    case "git_status":
      return "status";
    case "git_diff":
      return (args.staged ? "--staged " : "") + (args.stat ? "--stat " : "") + (args.path || "");
    case "git_commit":
      return args.message || "";
    case "project_todo":
      return [args.action, args.id, args.title].filter(Boolean).join(" ");
    case "start_process":
      return args.name || args.command || "";
    case "process_status":
    case "stop_process":
      return args.id || "";
    case "web_search":
      return args.query || "";
    case "web_fetch":
      return args.url || "";
    case "youtube_transcript":
      return args.url || "";
    case "memory_save":
      return (args.text || "").slice(0, 60);
    case "memory_search":
      return args.query || "";
    case "memory_list":
      return "";
    case "memory_forget":
      return args.id || "";
    case "system_info":
      return "";
    case "dev_env_report":
      return Array.isArray(args.tools) && args.tools.length ? args.tools.join(", ") : "all toolchains";
    case "where_is":
      return args.name || "";
    case "create_markdown_report":
      return args.filename || "";
    case "move_file":
    case "copy_file":
      return args.from && args.to ? `${args.from} → ${args.to}` : "";
    case "delete_path":
    case "make_dir":
      return args.path || "";
    default:
      return "";
  }
}
