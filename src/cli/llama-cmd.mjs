// /llama — manage the bundled local llama.cpp server (see src/local/llama.mjs).

import { c, infoLine, warnLine, errorLine } from "../ui.mjs";
import { saveSettings, resolveModel } from "../core/config.mjs";
import * as llama from "../local/llama.mjs";
import { installProviderPreset } from "./models.mjs";

export async function llamaCommand(ctx, sub, subArg) {
  const cfg = llama.llamaConfig(ctx.settings);

  // Allow "/llama 3" as a shortcut for "/llama start 3".
  if (/^\d+$/.test(sub)) {
    subArg = sub;
    sub = "start";
  }

  // A bare number (or empty) given to start selects from the numbered list.
  function pickModel(arg) {
    const models = llama.listModels(ctx.settings);
    if (/^\d+$/.test(arg)) {
      const idx = parseInt(arg, 10) - 1;
      if (idx < 0 || idx >= models.length) {
        throw new Error(`no model #${arg} — run /llama list (1-${models.length})`);
      }
      return models[idx];
    }
    return arg; // fall through to name/substring resolution in startServer
  }

  switch (sub || "status") {
    case "list":
    case "ls":
    case "models": {
      const models = llama.listModels(ctx.settings);
      if (!models.length) {
        warnLine(`no .gguf models found in ${cfg.modelsDir}`);
        break;
      }
      infoLine(`models in ${cfg.modelsDir} — load with /llama start <number>:`);
      const running = llama.status();
      const width = String(models.length).length;
      models.forEach((m, i) => {
        const mark = running.running && running.model === m ? c.green("●") : " ";
        const num = c.cyan(String(i + 1).padStart(width));
        const def = m === cfg.defaultModel ? c.dim(" (default)") : "";
        const insp = llama.inspectModel(ctx.settings, m);
        const ctxLen = insp && insp.contextLength ? `${Math.round(insp.contextLength / 1024)}k ctx` : "?ctx";
        const think = insp && insp.thinking ? c.magenta(" 🧠") : "";
        console.log(`    ${mark} ${num}. ${m}${def}  ${c.dim(ctxLen)}${think}`);
      });
      break;
    }
    case "status": {
      const s = llama.status();
      if (s.running) {
        infoLine(`llama server running — ${s.model} @ ${s.url} (pid ${s.pid})`);
      } else {
        infoLine("llama server not running. Start with /llama start [model]");
        infoLine(`bin: ${cfg.exe}`);
      }
      break;
    }
    case "stop": {
      if (llama.stopServer()) infoLine("llama server stopped");
      else warnLine("no llama server running");
      break;
    }
    case "default":
    case "use":
    case "setup": {
      let target;
      try {
        target = pickModel(subArg);
      } catch (e) {
        errorLine(e.message);
        break;
      }
      if (!target) {
        warnLine("which model? run /llama list, then /llama default <number>");
        break;
      }
      ctx.settings.llama = { ...(ctx.settings.llama || {}), defaultModel: target };
      installProviderPreset(ctx, "local");
      ctx.settings.models["local/coder"] = {
        ...(ctx.settings.models["local/coder"] || {}),
        provider: "local",
        id: target,
        maxTokens: ctx.settings.models["local/coder"]?.maxTokens || 8192,
      };
      await saveSettings(ctx.settings);
      infoLine(`default local model set to ${target}`);
      if (!llama.status().running) {
        infoLine("starting local llama server ...");
        try {
          const info = await llama.startServer(ctx.settings, target, { onLog: (m) => warnLine(m) });
          ctx.settings.providers.local.baseUrl = info.url;
          ctx.settings.models["local/coder"].id = info.model;
          ctx.settings.models["local/coder"].contextWindowDetected = info.contextSize || undefined;
          await saveSettings(ctx.settings);
          ctx.model = resolveModel(ctx.settings, "local/coder");
          infoLine(`local model ready and selected — ${info.model} @ ${info.url}`);
        } catch (e) {
          errorLine(e.message);
        }
      } else {
        ctx.model = resolveModel(ctx.settings, "local/coder");
        infoLine("local provider selected; existing llama server is running");
      }
      break;
    }
    case "start":
    case "load": {
      let target;
      try {
        target = pickModel(subArg) || cfg.defaultModel;
      } catch (e) {
        errorLine(e.message);
        break;
      }
      if (!target) {
        warnLine("which model? run /llama list, then /llama start <number>");
        break;
      }
      infoLine(`starting llama server (${target}) — loading model, please wait…`);
      try {
        const info = await llama.startServer(ctx.settings, target, { onLog: (m) => warnLine(m) });
        const think = info.thinking ? " · thinking 🧠" : "";
        infoLine(`llama server ready — ${info.model} @ ${info.url} (${info.contextSize} ctx${think})`);
        installProviderPreset(ctx, "local");
        ctx.settings.providers.local.baseUrl = info.url;
        ctx.settings.llama = { ...(ctx.settings.llama || {}), defaultModel: info.model };
        ctx.settings.models["local/coder"] = {
          ...(ctx.settings.models["local/coder"] || {}),
          provider: "local",
          id: info.model,
          maxTokens: ctx.settings.models["local/coder"]?.maxTokens || 8192,
          contextWindowDetected: info.contextSize || undefined,
        };
        await saveSettings(ctx.settings);
        ctx.model = resolveModel(ctx.settings, "local/coder");
        infoLine("local provider selected: /model local/coder");
      } catch (e) {
        errorLine(e.message);
      }
      break;
    }
    default:
      errorLine(`unknown /llama subcommand "${sub}". Usage: /llama [list|default <number>|start [model]|stop|status]`);
  }
}
