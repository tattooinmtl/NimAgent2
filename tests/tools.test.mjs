// Test script: exercise the 3 new capabilities (jq, enhanced search, enhanced find_files)
// Run:  node test-tools.mjs

import fs from "node:fs";
import path from "node:path";
import { runTool } from "../src/tools/index.mjs";
import { resolvePackage } from "../src/integrations/registry.mjs";
import { loadSettings, resolveModel } from "../src/core/config.mjs";
import { buildChatBody } from "../src/core/provider.mjs";

let pass = 0, fail = 0;

async function assert(label, result, check) {
  try {
    const ok = check(result);
    if (ok) { console.log(`  ✓ ${label}`); pass++; }
    else { console.log(`  ✗ ${label}\n    got: ${String(result).slice(0, 120)}`); fail++; }
  } catch (e) {
    console.log(`  ✗ ${label}\n    error: ${e.message}`); fail++;
  }
}

async function resultOf(fn) {
  try {
    return await fn();
  } catch (e) {
    return "ERROR: " + e.message;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Test 1: jq_query ──────────────────────────────────────────────
console.log("\nTest 1: jq_query");

await assert("reads top-level string field",
  await runTool("jq_query", { filter: ".name", path: "package.json", raw: true }),
  r => r.trim() === "nimagent"
);

await assert("extracts object keys",
  await runTool("jq_query", { filter: 'keys', path: "package.json" }),
  r => r.includes("name") && r.includes("type")
);

await assert("error on bad filter",
  await runTool("jq_query", { filter: "{{{broken", path: "package.json" }),
  r => r.toLowerCase().includes("error") || r.toLowerCase().includes("exit")
);

// ── Test 2: enhanced search (case_insensitive + context) ─────────
console.log("\nTest 2: search — case_insensitive + context");

await assert("case-insensitive finds mixed-case matches",
  await runTool("search", { pattern: "spawnsync", case_insensitive: true, path: "src" }),
  r => r.includes("spawnSync") && !r.includes("(no matches)")
);

await assert("context=1 includes surrounding lines",
  await runTool("search", { pattern: "function clip", context: 1, path: "src/tools/index.mjs" }),
  r => {
    const lines = r.split("\n");
    return lines.length > 1 && lines.some(l => l.includes("function clip")) && lines.some(l => !l.includes("function clip"));
  }
);

await assert("context=0 shows match line without dash-separated context",
  await runTool("search", { pattern: "function clip", context: 0, path: "src/tools/index.mjs" }),
  r => !r.split("\n").some(l => l.startsWith("src/tools.mjs-"))
);

// ── Test 3: enhanced find_files (extension + respect_gitignore) ──
console.log("\nTest 3: find_files — extension + respect_gitignore");

await assert("extension filter returns only .mjs files",
  await runTool("find_files", { pattern: ".", path: "src", extension: "mjs", max_depth: 1 }),
  r => r.split("\n").every(f => f.endsWith(".mjs"))
);

await assert("extension filter with comma-separated extensions",
  await runTool("find_files", { pattern: ".", path: ".", extension: "mjs,json", max_depth: 2 }),
  r => r.split("\n").some(f => f.endsWith(".mjs")) && r.split("\n").some(f => f.endsWith(".json"))
);

await assert("type=d finds directories",
  await runTool("find_files", { pattern: ".", path: ".", type: "d", max_depth: 1 }),
  r => r.split("\n").some(f => f === "src" || f === "bin" || f === "bin/")
);

// ── Test 4: package registry + manifests ─────────────────────────
console.log("\nTest 4: package registry");

const sampleRegistry = {
  version: 1,
  packages: [
    { name: "alpha", type: "skill", version: "1.0.0", url: "x" },
    { name: "beta", type: "mcp", version: "2.1.0", url: "y" },
  ],
};

await assert("resolvePackage finds a package by name",
  resolvePackage(sampleRegistry, "beta"),
  r => r && r.type === "mcp" && r.version === "2.1.0"
);

await assert("resolvePackage returns null for unknown name",
  resolvePackage(sampleRegistry, "missing"),
  r => r === null
);

await assert("seed manifests declare required fields per type",
  fs.readdirSync("packages", { withFileTypes: true }).filter(e => e.isDirectory()),
  dirs => dirs.every(d => {
    const m = JSON.parse(fs.readFileSync(`packages/${d.name}/nimpkg.json`, "utf8"));
    if (!m.name || !["skill", "extension", "mcp"].includes(m.type)) return false;
    if (m.type === "extension" && !m.entry) return false;
    if (m.type === "mcp" && !m.mcp) return false;
    return true;
  })
);

// ── Test 5: agent-grade editing and safety ───────────────────────
console.log("\nTest 5: agent-grade tools — patch, safety, todos");

const originalCwd = process.cwd();
const tmp = fs.mkdtempSync(path.join(originalCwd, ".tmp-tools-"));
try {
  process.chdir(tmp);

  await assert("apply_patch adds a file",
    await runTool("apply_patch", {
      patch: [
        "*** Begin Patch",
        "*** Add File: sample.txt",
        "+one",
        "+two",
        "+three",
        "+four",
        "*** End Patch",
      ].join("\n"),
    }),
    r => r.includes("added sample.txt") && fs.existsSync("sample.txt")
  );

  await assert("apply_patch updates multiple hunks",
    await runTool("apply_patch", {
      patch: [
        "*** Begin Patch",
        "*** Update File: sample.txt",
        "@@",
        "-one",
        "+ONE",
        "@@",
        "-four",
        "+FOUR",
        "*** End Patch",
      ].join("\n"),
    }),
    r => r.includes("updated sample.txt") && fs.readFileSync("sample.txt", "utf8").includes("ONE")
  );

  await assert("workspace guard blocks escaping paths",
    await resultOf(() => runTool("read_file", { path: "../package.json" })),
    r => r.includes("escapes workspace")
  );

  await assert("run_shell blocks destructive commands by default",
    await runTool("run_shell", { command: "Remove-Item -Recurse .", timeout_ms: 1000 }),
    r => r.includes("BLOCKED")
  );

  await assert("project_todo persists tasks",
    await resultOf(async () => {
      await runTool("project_todo", { action: "clear" });
      await runTool("project_todo", { action: "add", title: "ship safer tools" });
      await runTool("project_todo", { action: "done", id: "T001" });
      return await runTool("project_todo", { action: "list" });
    }),
    r => r.includes("T001 [done] ship safer tools") && fs.existsSync(".nimagent/todos.json")
  );
} finally {
  process.chdir(originalCwd);
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── Test 6: project inspection and managed processes ─────────────
console.log("\nTest 6: project context and process management");

await assert("project_inspect detects Node project scripts",
  await runTool("project_inspect", { path: ".", max_depth: 1 }),
  r => r.includes("stack:") && r.includes("Node.js") && r.includes("npm run test")
);

await assert("read_many_files reads multiple files",
  await runTool("read_many_files", { paths: ["package.json", "prompts/default.md"], limit_per_file: 20 }),
  r => r.includes("--- package.json ---") && r.includes("--- prompts/default.md ---")
);

await assert("run_shell dry_run reports risk without executing",
  await runTool("run_shell", { command: "npm install", dry_run: true }),
  r => r.includes("DRY RUN") && r.includes("risk: caution")
);

const started = await runTool("start_process", {
  name: "test-managed-process",
  command: "node -e \"console.log('managed-ready'); setTimeout(()=>{}, 5000)\"",
});
const pid = String(started).match(/started (P\d+)/)?.[1];
await sleep(300);

await assert("start_process returns a managed id",
  started,
  r => Boolean(pid) && r.includes("test-managed-process")
);

await assert("process_status includes recent logs",
  await runTool("process_status", { id: pid }),
  r => r.includes("managed-ready") || r.includes("test-managed-process")
);

await assert("stop_process stops managed process",
  await runTool("stop_process", { id: pid }),
  r => r.includes("stopping") || r.includes("already")
);

// ── Test 7: provider/model config ────────────────────────────────
console.log("\nTest 7: provider and reasoning config");

await assert("resolveModel carries configured reasoning tier",
  resolveModel({
    reasoning: "high",
    providers: { openai: { baseUrl: "https://api.openai.com/v1", apiKey: "x" } },
    models: { "openai/test": { provider: "openai", id: "test-model", maxTokens: 1234 } },
  }, "openai/test"),
  r => r.reasoning === "high" && r.providerName === "openai"
);

const loadedSettings = await loadSettings();
await assert("NVIDIA GLM 5.2 is the built-in default model",
  resolveModel(loadedSettings, "nvidia/glm-5.2"),
  r => r.id === "z-ai/glm-5.2" && loadedSettings.defaultModel === "nvidia/glm-5.2"
);

await assert("NVIDIA uses Pi-style text tools, not native provider functions",
  resolveModel(loadedSettings, "nvidia/glm-5.2"),
  r => r.nativeTools === false && r.provider.api === "openai-completions"
);

await assert("NVIDIA request body never sends native tool payloads",
  buildChatBody({
    model: resolveModel(loadedSettings, "nvidia/glm-5.2"),
    messages: [
      { role: "user", content: "hello" },
      { role: "assistant", content: "", tool_calls: [{ id: "x", type: "function", function: { name: "read_file", arguments: "{\"path\":\"README.md\"}" } }] },
      { role: "tool", tool_call_id: "x", content: "result" },
    ],
    tools: [{ type: "function", function: { name: "read_file", parameters: { type: "object", properties: {} } } }],
  }),
  r => !("tools" in r) && !("tool_choice" in r) && !r.messages.some(m => m.role === "tool" || m.tool_calls)
);

// ── Summary ───────────────────────────────────────────────────────
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
