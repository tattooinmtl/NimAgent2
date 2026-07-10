# Extending NimAgent

NimAgent has three extension points, plus a package format for distributing them,
plus cosmetic/runtime config (themes, providers):

| What | Adds | Lives at | Needs restart |
|---|---|---|---|
| **Extension** | New tools the model can call | `extensions/<name>.js` + config entry | no — `create_tool` hot-loads |
| **Skill** | A `/slash-command` that injects instructions | `skills/<name>/SKILL.md` | yes |
| **MCP server** | External tool server via the `mcp` proxy tool | `nimagent.config.json` or `.mcp.json` | yes |
| **Package** | Any of the above, zipped for the registry | `nimpkg.json` + payload | — |
| **Theme** | Terminal color palette | `themes/<name>.json` + config entry | yes |
| **Provider/model** | A new OpenAI-compatible LLM backend | `/addprovider`, `/addmodel` (persisted) | no |

All paths are relative to the NimAgent install root (the folder containing
`nimagent.config.json`), **not** the workspace you run `nim2` in.

## Creating a tool on the spot (no restart)

Just ask: *"create a tool that does X"*. The agent has a built-in `create_tool`
tool that writes an extension's source to `extensions/<name>.js`, **hot-loads
it into the running session immediately** (the new tool is callable on the
very next turn), and persists it to `nimagent.config.json` so it survives
restarts. Asking again with the same name replaces the old version — old tool
names from that file are dropped first, so the agent can iterate on a broken
tool without leaving stale duplicates behind.

This is the fast path for anything you'd otherwise hand-write as an extension
(see below) — the agent already knows the `{ name, tools, impl }` contract and
will write it correctly from the description alone.

## Extensions (custom tools, written by hand)

An extension is a single ESM JavaScript file that default-exports:

```js
export default {
  name: "my-extension",          // shown in the startup banner
  tools: [ /* OpenAI function-tool schemas */ ],
  impl:  { /* toolName: fn */ },
};
```

Each entry in `tools` is a standard OpenAI-style function tool schema, and each
key in `impl` must match a tool name:

```js
// extensions/word-count.js
export default {
  name: "word-count",
  tools: [
    {
      type: "function",
      function: {
        name: "word_count",
        description: "Count words and lines in a text file.",
        parameters: {
          type: "object",
          properties: { path: { type: "string", description: "File to count" } },
          required: ["path"],
        },
      },
    },
  ],
  impl: {
    async word_count({ path: p }) {
      const fs = await import("node:fs");
      const text = fs.readFileSync(p, "utf8");
      return `${text.split(/\s+/).filter(Boolean).length} words, ${text.split("\n").length} lines`;
    },
  },
};
```

Rules of the contract (see `registerExtensions` in `src/tools/index.mjs`):

- `impl` functions receive the parsed arguments object; they may be sync or
  async. Whatever they **return is stringified and fed back to the model** as
  the tool result. A thrown error becomes an error message the model sees.
- Extensions load once at startup. A file that fails to import is reported in
  the banner as `name (failed: <message>)` and skipped — the rest still load.
  (`create_tool` above hot-loads instead, without a restart.)
- NimAgent does not sandbox extensions; scope your own paths. Copy the
  `resolve()` helper from `extensions/file-tools.js` to keep file access inside
  the workspace.
- Tool names are subject to permissions like any built-in:
  `/perm word_count ask`.
- Zero-dependency policy: prefer `node:` built-ins. There is no `node_modules`
  in the install root.

To activate, add the file path to `nimagent.config.json` and restart:

```json
{ "extensions": ["extensions/file-tools.js", "extensions/word-count.js"] }
```

## Skills (slash commands)

A skill is a folder under `skills/` containing a `SKILL.md` with YAML-ish
frontmatter followed by instructions:

```markdown
---
name: release-notes
command: /release-notes
description: Draft release notes from recent git history.
---

# Release Notes

When invoked, run `git log` since the last tag via run_shell, group commits
by type, and draft markdown release notes...
```

- Frontmatter is simple `key: value` lines only (no nesting, no multiline).
  `name` defaults to the folder name, `command` defaults to `/<name>`.
- The `description` is listed in the system prompt and in `/help`; the **body
  is injected as a system message only when the user runs the command** — so
  put trigger hints in the description and the full playbook in the body.
- Extra files in the skill folder (templates, examples) are copied along by
  the installer; reference them by path in the body.
- Skills are discovered at startup: every `skills/*/SKILL.md` is found
  automatically when `autoDiscoverSkills` is `true` (the default config), or
  list folders explicitly under `skills` in `nimagent.config.json`.

## MCP servers

Add a standard MCP server definition either to `nimagent.config.json`:

```json
{ "mcpServers": { "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] } } }
```

…or to a project-local `.mcp.json` in the workspace (the vendor-neutral
standard; it wins on name collisions). The agent reaches every server through
the single lazy `mcp` proxy tool, so added servers cost almost no context.

## Themes (color palette)

A theme is a JSON file in `themes/` describing the terminal UI palette:

```json
{
  "name": "forge-yellow",
  "description": "Molten-forge palette: yellow at the top cooling into dark orange and purple.",
  "accent": [255, 176, 0],
  "prompt": "cyan",
  "logoGradient": [[255, 214, 0], [255, 176, 0], [206, 64, 120], [150, 32, 210]],
  "ui": { "user": "cyan", "assistant": "magenta", "tool": "green", "error": "red", "warn": "yellow", "dim": "gray" }
}
```

- `accent` is `[r, g, b]`. `logoGradient` is a list of `[r, g, b]` stops applied
  top-to-bottom across the startup banner. `ui.*` and `prompt` accept either
  ANSI color names (`cyan`, `magenta`, …) or hex/rgb.
- Purely cosmetic — no tool/capability implications. Activate with
  `"theme": "themes/<name>.json"` in `nimagent.config.json`; restart to apply.

## Providers / models (connect a new LLM backend)

Not a file-based plugin — a runtime-registered config entry. Any
OpenAI-compatible chat-completions endpoint works:

```text
/addprovider myhost https://api.example.com/v1 sk-xxxx
/addmodel mykey myhost some-model-id 32768
/model mykey
```

`/addprovider <name> <baseUrl> [apiKey]` registers the endpoint;
`/addmodel <key> <provider> <model-id> [maxTokens]` points a model key at it
(the provider must already exist). Both persist to `settings.json`
immediately — no restart needed, switch with `/model <key>` right away.
`/apikey <provider> <key>` updates credentials later.

## Packaging for the registry (`nimpkg`)

To distribute via `node bin\nimagent.mjs install <name>` (or `/install`), zip
your payload with a `nimpkg.json` manifest at the zip root (or one level down):

```json
{
  "name": "word-count",
  "type": "extension",            // "skill" | "extension" | "mcp"
  "version": "1.0.0",
  "description": "Word/line counting tool.",
  "entry": "word-count.js"        // extension only: file copied to extensions/<name>.js
}
```

- `type: "skill"` — the zip must contain `SKILL.md`; the whole payload is
  copied to `skills/<name>/`. No config edit needed.
- `type: "extension"` — `entry` is copied to `extensions/<name>.js` and added
  to the config's `extensions` array automatically.
- `type: "mcp"` — the manifest's `"mcp": { ... }` block is written to
  `mcpServers.<name>` in the config.

The hosting side is a static `registry.json`:

```json
{ "packages": [ { "name": "word-count", "type": "extension", "version": "1.0.0",
    "description": "…", "url": "word-count.zip", "sha256": "<hex>" } ] }
```

`url` may be absolute or relative to the registry base. If `sha256` is present
it is verified after download. Registry resolution order:
`--registry` arg → `NIMAGENT_REGISTRY` env → `registry` in config → the default.
Installs are tracked in `agent/packages.json` so `uninstall` undoes exactly
what was added.
