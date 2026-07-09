// MCP (Model Context Protocol) client — proxy-tool architecture.
//
// Instead of registering every MCP tool into the model's context (10k+ tokens
// per server), we register ONE `mcp` proxy tool (~200 tokens). The model uses it
// to search/describe/call tools on demand. Servers connect LAZILY on first call,
// tool metadata is cached to <HOME>/mcp-cache.json so search/describe work with
// no live connection, and idle servers disconnect after a timeout.
//
// Optional `directTools` promotes selected tools to first-class NimAgent tools
// (named mcp__<server>__<tool>) registered from the cache.
//
// Transports: stdio (command/args/env) and StreamableHTTP (url/headers).

import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import fs from "node:fs";
import path from "node:path";
import { HOME } from "../core/config.mjs";
import { tools, impl } from "../tools/index.mjs";

const CACHE_PATH = path.join(HOME, "mcp-cache.json");
const RPC_TIMEOUT = 30000;

let servers = {}; // { name: def }
let settings = { idleTimeout: 10, directTools: false };
const connections = new Map(); // name -> conn

// ---- metadata cache --------------------------------------------------------

function readCache() {
  try {
    return JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  } catch {
    return {};
  }
}

function cacheTools(name, toolList) {
  const cache = readCache();
  cache[name] = { tools: toolList, cachedAt: new Date().toISOString() };
  try {
    fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2));
  } catch {
    /* cache is best-effort */
  }
}

function cachedTools(name) {
  return readCache()[name]?.tools || null;
}

// ---- transports ------------------------------------------------------------

function connectStdio(name, def) {
  const env = { ...process.env, ...(def.env || {}) };
  const opts = { env, cwd: def.cwd || process.cwd(), stdio: ["pipe", "pipe", "pipe"] };

  // On Windows, npx/uvx/etc. are .cmd shims that bare spawn() can't resolve
  // (ENOENT). We run through the shell so PATHEXT finds them — but as a single
  // quoted command STRING (no args array) to avoid the DEP0190 warning that
  // fires when args are passed under shell:true.
  let command = def.command;
  let args = def.args || [];
  if (process.platform === "win32") {
    const quoted = args.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(" ");
    command = quoted ? `${def.command} ${quoted}` : def.command;
    args = [];
    opts.shell = true;
  }

  const proc = spawn(command, args, opts);
  const conn = { name, transport: "stdio", proc, pending: new Map(), nextId: 1, tools: [] };

  const failAll = (msg) => {
    conn.dead = true;
    for (const { reject } of conn.pending.values()) reject(new Error(msg));
    conn.pending.clear();
  };

  // A failed spawn emits 'error' asynchronously — handle it so it never crashes
  // the agent; the server is simply marked dead and pending calls reject.
  proc.on("error", (err) => failAll(`MCP server "${name}" failed to start: ${err.message}`));
  proc.stdin.on("error", () => {}); // ignore EPIPE if the child died mid-write
  proc.on("exit", () => failAll(`MCP server "${name}" exited`));

  const rl = createInterface({ input: proc.stdout });
  rl.on("line", (line) => handleStdioMessage(conn, line));
  proc.stderr.on("data", (d) => {
    if (def.debug) process.stderr.write(`[mcp:${name}] ${d}`);
  });
  conn.rl = rl;
  return conn;
}

function handleStdioMessage(conn, line) {
  line = line.trim();
  if (!line) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // ignore non-JSON (some servers log to stdout)
  }
  if (msg.id != null && conn.pending.has(msg.id)) {
    const { resolve, reject } = conn.pending.get(msg.id);
    conn.pending.delete(msg.id);
    if (msg.error) reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    else resolve(msg.result);
  }
  // server->client requests/notifications are ignored in v1
}

function connectHttp(name, def) {
  return {
    name,
    transport: "http",
    url: def.url,
    headers: def.headers || {},
    nextId: 1,
    tools: [],
  };
}

// Parse a StreamableHTTP SSE body, returning the JSON-RPC payload for `id`.
function parseSse(text, id) {
  let last = null;
  for (const block of text.split(/\n\n/)) {
    const dataLines = block
      .split(/\n/)
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice(5).trim());
    if (!dataLines.length) continue;
    try {
      const obj = JSON.parse(dataLines.join("\n"));
      if (obj.id === id) return obj;
      last = obj;
    } catch {
      /* skip */
    }
  }
  return last;
}

// ---- JSON-RPC --------------------------------------------------------------

function rpc(conn, method, params) {
  if (conn.transport === "http") return rpcHttp(conn, method, params);
  const id = conn.nextId++;
  return new Promise((resolve, reject) => {
    if (conn.dead) return reject(new Error("MCP server not running"));
    conn.pending.set(id, { resolve, reject });
    conn.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    const timer = setTimeout(() => {
      if (conn.pending.has(id)) {
        conn.pending.delete(id);
        reject(new Error(`MCP "${method}" timed out`));
      }
    }, RPC_TIMEOUT);
    timer.unref?.();
  });
}

async function rpcHttp(conn, method, params) {
  const id = conn.nextId++;
  const headers = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...conn.headers,
  };
  if (conn.sessionId) headers["Mcp-Session-Id"] = conn.sessionId;
  const res = await fetch(conn.url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const sid = res.headers.get("mcp-session-id");
  if (sid) conn.sessionId = sid;
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}`);
  const ct = res.headers.get("content-type") || "";
  const data = ct.includes("text/event-stream") ? parseSse(await res.text(), id) : await res.json();
  if (!data) return undefined;
  if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
  return data.result;
}

async function notify(conn, method, params) {
  const body = JSON.stringify({ jsonrpc: "2.0", method, params });
  if (conn.transport === "http") {
    const headers = { "Content-Type": "application/json", ...conn.headers };
    if (conn.sessionId) headers["Mcp-Session-Id"] = conn.sessionId;
    await fetch(conn.url, { method: "POST", headers, body }).catch(() => {});
  } else if (!conn.dead) {
    conn.proc.stdin.write(body + "\n");
  }
}

// ---- lifecycle -------------------------------------------------------------

function touch(conn) {
  conn.lastUsed = Date.now();
  if (conn.idleTimer) clearTimeout(conn.idleTimer);
  const mins = settings.idleTimeout;
  if (mins && mins > 0) {
    conn.idleTimer = setTimeout(() => disconnect(conn.name), mins * 60 * 1000);
    conn.idleTimer.unref?.();
  }
}

async function ensureConnected(name) {
  let conn = connections.get(name);
  if (conn && !conn.dead) {
    touch(conn);
    return conn;
  }
  const def = servers[name];
  if (!def) throw new Error(`unknown MCP server: ${name}`);
  conn = def.url ? connectHttp(name, def) : connectStdio(name, def);
  connections.set(name, conn);
  await rpc(conn, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "NimAgent", version: "0.1.0" },
  });
  await notify(conn, "notifications/initialized", {});
  const list = await rpc(conn, "tools/list", {});
  conn.tools = list?.tools || [];
  cacheTools(name, conn.tools);
  touch(conn);
  return conn;
}

function disconnect(name) {
  const conn = connections.get(name);
  if (!conn) return;
  if (conn.idleTimer) clearTimeout(conn.idleTimer);
  try {
    conn.proc?.kill();
  } catch {
    /* already gone */
  }
  connections.delete(name);
}

export function disconnectAll() {
  for (const name of [...connections.keys()]) disconnect(name);
}

export async function reconnectServer(name) {
  disconnect(name);
  return ensureConnected(name);
}

// ---- tool discovery helpers ------------------------------------------------

// Tools for a server, preferring a live connection, then the disk cache, then a
// one-time connect to populate the cache.
async function toolsForServer(name) {
  if (!servers[name]) return null;
  const conn = connections.get(name);
  if (conn && !conn.dead) return conn.tools;
  const cached = cachedTools(name);
  if (cached) return cached;
  try {
    return (await ensureConnected(name)).tools;
  } catch {
    return [];
  }
}

const norm = (s) => String(s).toLowerCase().replace(/[-_:]/g, "");

// Find which server owns a tool name (bare or server::tool, hyphen/underscore
// insensitive). Loads each server's tools (cache or connect) as needed.
async function findToolOwner(toolName) {
  for (const name of Object.keys(servers)) {
    const list = await toolsForServer(name);
    for (const t of list || []) {
      if (
        t.name === toolName ||
        `${name}::${t.name}` === toolName ||
        norm(t.name) === norm(toolName) ||
        norm(`${name}${t.name}`) === norm(toolName)
      ) {
        return { server: name, tool: t };
      }
    }
  }
  return null;
}

function oneline(s) {
  return String(s || "").split(/\r?\n/)[0].trim();
}

function extractText(result) {
  const parts = [];
  for (const c of result.content || []) {
    if (c.type === "text") parts.push(c.text);
    else if (c.type === "resource" && c.resource?.text) parts.push(c.resource.text);
    else parts.push(`[${c.type}]`);
  }
  return parts.join("\n");
}

function formatToolResult(result) {
  if (!result) return "(no result)";
  const text = extractText(result);
  if (result.isError) return "ERROR: " + (text || JSON.stringify(result));
  return text || JSON.stringify(result);
}

// ---- the proxy tool --------------------------------------------------------

const proxyToolDef = {
  type: "function",
  function: {
    name: "mcp",
    description:
      "Proxy to MCP server tools — discover and call them without bloating context. " +
      "Usage: mcp({}) for status; mcp({server:'name'}) lists a server's tools; " +
      "mcp({search:'words'}) finds tools; mcp({describe:'tool'}) shows a tool's schema; " +
      "mcp({connect:'name'}) force-connects; mcp({tool:'name', args:'{...}'}) calls a tool " +
      "(args is a JSON STRING, not an object). Servers connect lazily on first call.",
    parameters: {
      type: "object",
      properties: {
        search: { type: "string", description: "Search tool names/descriptions across all servers (space = OR)" },
        server: { type: "string", description: "List the tools exposed by this server" },
        describe: { type: "string", description: "Show the full input schema for this tool name" },
        connect: { type: "string", description: "Force-connect this server now" },
        tool: { type: "string", description: "Name of the tool to call" },
        args: { type: "string", description: "Arguments for the tool, as a JSON string e.g. '{\"q\":\"x\"}'" },
      },
    },
  },
};

async function mcpProxy(a = {}) {
  const names = Object.keys(servers);
  if (names.length === 0) {
    return "No MCP servers configured. Add one to nimagent.config.json `mcpServers`, a project .mcp.json, or `nimagent install` an mcp package.";
  }

  // call a tool
  if (a.tool) {
    const owner = await findToolOwner(a.tool);
    if (!owner) return `tool "${a.tool}" not found. Try mcp({ search: "..." }).`;
    let parsed = {};
    if (a.args) {
      try {
        parsed = typeof a.args === "string" ? JSON.parse(a.args) : a.args;
      } catch (e) {
        return `args must be a JSON string: ${e.message}`;
      }
    }
    const conn = await ensureConnected(owner.server);
    const result = await rpc(conn, "tools/call", { name: owner.tool.name, arguments: parsed });
    return formatToolResult(result);
  }

  if (a.connect) {
    const conn = await ensureConnected(a.connect);
    return `connected ${a.connect} — ${conn.tools.length} tool(s).`;
  }

  if (a.describe) {
    const owner = await findToolOwner(a.describe);
    if (!owner) return `tool "${a.describe}" not found.`;
    return `${owner.server}::${owner.tool.name}\n` + JSON.stringify(owner.tool, null, 2);
  }

  if (a.server) {
    if (!servers[a.server]) return `unknown server "${a.server}". Configured: ${names.join(", ")}`;
    const list = (await toolsForServer(a.server)) || [];
    const state = connections.get(a.server) && !connections.get(a.server).dead ? "connected" : "cached/idle";
    return (
      `${a.server} (${state}):\n` +
      (list.length ? list.map((t) => `  ${t.name} — ${oneline(t.description)}`).join("\n") : "  (no tools)")
    );
  }

  if (a.search != null) {
    const terms = a.search.toLowerCase().replace(/[-_]/g, " ").split(/\s+/).filter(Boolean);
    const hits = [];
    for (const name of names) {
      for (const t of (await toolsForServer(name)) || []) {
        const hay = `${t.name} ${t.description || ""}`.toLowerCase().replace(/[-_]/g, " ");
        if (terms.length === 0 || terms.some((term) => hay.includes(term))) {
          hits.push(`  ${name}::${t.name} — ${oneline(t.description)}`);
        }
      }
    }
    return hits.length ? hits.join("\n") : "(no matching tools)";
  }

  // default: status
  const lines = names.map((n) => {
    const conn = connections.get(n);
    const cached = cachedTools(n);
    const state = conn && !conn.dead ? "connected" : cached ? "idle (cached)" : "not connected";
    const count = conn && !conn.dead ? conn.tools.length : cached ? cached.length : "?";
    return `  ${n}: ${state}, ${count} tool(s)`;
  });
  return (
    `MCP servers:\n${lines.join("\n")}\n\n` +
    `Discover with mcp({ search: "..." }), then call with mcp({ tool: "name", args: "{...}" }).`
  );
}

// Expose the proxy for the REPL /mcp command.
export function mcpStatus() {
  return mcpProxy({});
}

// ---- direct tools ----------------------------------------------------------

function registerDirectTool(server, t) {
  const fullName = `mcp__${server}__${t.name}`;
  if (tools.find((x) => x.function?.name === fullName)) return;
  tools.push({
    type: "function",
    function: {
      name: fullName,
      description: t.description || `${t.name} (via ${server} MCP server)`,
      parameters: t.inputSchema || { type: "object", properties: {} },
    },
  });
  impl[fullName] = async (args) => {
    const conn = await ensureConnected(server);
    const result = await rpc(conn, "tools/call", { name: t.name, arguments: args || {} });
    return formatToolResult(result);
  };
}

// ---- entry point -----------------------------------------------------------

// Register the proxy tool (and any cached direct tools). Does NOT connect any
// server — connections are lazy. Returns counts for the startup banner.
export function registerMcpProxy(mcpCfg) {
  servers = mcpCfg.servers || {};
  settings = mcpCfg.settings || { idleTimeout: 10, directTools: false };

  const names = Object.keys(servers);
  if (names.length === 0) return { servers: 0, directTools: 0 };

  if (!tools.find((t) => t.function?.name === "mcp")) {
    tools.push(proxyToolDef);
    impl.mcp = mcpProxy;
  }

  let direct = 0;
  for (const [name, def] of Object.entries(servers)) {
    const want = def.directTools !== undefined ? def.directTools : settings.directTools;
    if (!want) continue;
    const cached = cachedTools(name);
    if (!cached) continue; // populated on first proxy use; appears next run
    for (const t of cached) {
      if (Array.isArray(want) && !want.includes(t.name)) continue;
      if (Array.isArray(def.excludeTools) && def.excludeTools.includes(t.name)) continue;
      registerDirectTool(name, t);
      direct++;
    }
  }

  return { servers: names.length, directTools: direct };
}
