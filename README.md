# NimAgent V2

*Vice Summer Edition 2026*

A from-scratch terminal coding agent for Windows. Talks to **OpenAI-compatible**
providers (NVIDIA NIM, local llama.cpp, Ollama, OpenRouter, …), runs a
tool-calling agent loop with per-tool permissions, persistent memory, and goal
mode — all with **zero npm dependencies** (pure Node ≥ 20 + built-in `fetch`).

```
███╗   ██╗██╗███╗   ███╗      █████╗  ██████╗ ███████╗███╗   ██╗████████╗   ██╗   ██╗██████╗
████╗  ██║██║████╗ ████║     ██╔══██╗██╔════╝ ██╔════╝████╗  ██║╚══██╔══╝   ██║   ██║╚════██╗
██╔██╗ ██║██║██╔████╔██║████╗███████║██║  ███╗█████╗  ██╔██╗ ██║   ██║      ██║   ██║ █████╔╝
██║╚██╗██║██║██║╚██╔╝██║╚═══╝██╔══██║██║   ██║██╔══╝  ██║╚██╗██║   ██║      ╚██╗ ██╔╝██╔═══╝
██║ ╚████║██║██║ ╚═╝ ██║     ██║  ██║╚██████╔╝███████╗██║ ╚████║   ██║       ╚████╔╝ ███████╗
╚═╝  ╚═══╝╚═╝╚═╝     ╚═╝     ╚═╝  ╚═╝ ╚═════╝ ╚══════╝╚═╝  ╚═══╝   ╚═╝        ╚═══╝  ╚══════╝
                                                      v i c e   s u m m e r   e d i t i o n   2 0 2 6
```

## Install

```powershell
# Requires Git and Node.js 20+
git clone https://github.com/tattooinmtl/NimAgent2.git
cd NimAgent2
.\install\install.ps1
npm start
```

NimAgent ships **with no API keys** — supply your own. First run writes a clean
`settings.json` into `agent/` (git-ignored). A free NVIDIA NIM key (the default
provider) is available at <https://build.nvidia.com>:

```powershell
node bin\nimagent.mjs --set-key nvidia nvapi-xxxxxxxx   # persist a key, then exit
$env:NIMAGENT_NVIDIA_KEY = "nvapi-xxxxxxxx"             # or an env var (overrides the file)
# …or inside the REPL:  /apikey nvidia nvapi-xxxxxxxx
```

Secrets policy: the repo contains **no keys and no user data** — only
[`settings.example.json`](settings.example.json) and [`.env.example`](.env.example)
with empty placeholders. `agent/`, `.env`, and `vendor/` are git-ignored.

## Usage

```powershell
npm start                              # interactive REPL
node bin\nimagent.mjs "fix the bug"    # one-shot mode
node bin\nimagent.mjs --model local/coder --resume
node bin\nimagent.mjs install <pkg>    # package manager (install|uninstall|list|search)
```

## Commands

Tab completes `/commands`. `/help` shows this grouped menu with usage strings.

| Category | Commands |
|---|---|
| Session | `/help` `/status` `/clear` `/compact [now]` `/resume` `/cost` `/cwd` `/config` `/version` `/exit` |
| Agent | `/goal` `/effort` `/route` `/diff` `/memory` `/tools` `/perm` |
| Models & Providers | `/model` `/models` `/default` `/doctor` `/addmodel` `/providers` `/provider` `/apikey` `/addprovider` `/llama` |
| Packages & Integrations | `/packages` `/install` `/uninstall` `/mcp` `/bridge` |

Unknown commands get a nearest-match suggestion. Multi-line input: end a line
with `\`.

### Goal mode

```
/goal migrate every fetch() call to the new client --tokens 200k
/goal pause | resume | edit <objective> | clear | status
```

Sets an objective the agent keeps working toward **across turns automatically**
— when a turn ends without the objective being met, NimAgent queues a
continuation until the model calls the `goal_complete` tool with a verified
summary, the iteration cap (25) is hit, or the token budget runs out.

### Effort

```
/effort            show current tier
/effort off|low|medium|high|xhigh
```

Sets the reasoning-effort tier sent to the provider (persisted; `xhigh` is sent
as `high` to OpenAI-compatible APIs).

### Tool permissions

| State | Behavior |
|---|---|
| `allow` | Permits the action silently (default) |
| `deny` | Blocks the action with an error message the model sees |
| `ask` | Prompts you for confirmation (`y` / `N` / `a` = always this session) |

`/perm <tool|*> <allow|deny|ask>` — persisted in `settings.json`. In one-shot
mode `ask` behaves as `deny`.

## Tools the agent can use

- **Files & code** — `read_file`, `read_many_files`, `write_file`, `edit_file`,
  `apply_patch`, `list_dir`, `find_files` (fd), `search` (ripgrep), `jq_query`
- **Shell & processes** — `run_shell` (PowerShell), `run_test`,
  `start_process` / `process_status` / `stop_process`
- **Project & git** — `project_inspect`, `project_todo`, `git_status`,
  `git_diff`, `git_commit`, `create_markdown_report`
- **System diagnostics** — `system_info` (OS/CPU/RAM/GPU/disks),
  `dev_env_report` (~85 toolchains probed in parallel across 16 categories,
  incl. broken-PATH detection), `where_is`
- **Memory** — `memory_save` / `memory_search` / `memory_list` /
  `memory_forget`, stored in `agent/memory.jsonl`; recent memories are injected
  into the system prompt at startup
- **Goal** — `goal_complete` (goal mode's completion gate)
- **Web (extensions, no API keys)** — `web_search` (DuckDuckGo), `web_fetch`
  (page → text), `youtube_transcript` (title + description + full timestamped
  transcript; the agent "watches" videos by reading them)
- **Extensions** — `move_file`, `copy_file`, `delete_path`, `make_dir`, plus
  anything you drop in `extensions/` or install from the package registry
- **MCP** — one `mcp` proxy tool reaches any configured MCP server lazily

### Robust tool calling on any provider

Providers without native OpenAI tool calling (e.g. NVIDIA NIM) use a text
protocol. The parser (`src/core/toolcalls.mjs`) tolerates the canonical format
plus what models actually emit — GLM `<arg_key>/<arg_value>`, Qwen
JSON-in-`<tool_call>`, bare `<function=…>`, unclosed envelopes, hybrids — with
schema-aware argument coercion. Unparseable or truncated tool calls trigger a
corrective retry instead of silently ending the turn.

## Layout

```
NimAgent2/
  bin/nimagent.mjs        thin launcher
  src/
    cli/                  REPL, command registry, goal mode, model picker
    core/                 agent loop, tool-call parser, provider client, config
    tools/                tool schemas + implementations
    integrations/         MCP proxy, NimTools bridge, package registry, router
    local/                llama.cpp server manager, GGUF reader
    ui.mjs  paths.mjs     terminal UI, vendored-binary resolution
  extensions/  prompts/  skills/  themes/  templates/
  tests/                  zero-dependency suites — npm test
  install/  scripts/  schema/  packages/  router/
  vendor/                 rg/fd/jq (fetched by installer, git-ignored)
  agent/                  your home: settings, sessions, memory (git-ignored)
```

## Tests

```powershell
npm test               # toolcalls + router + tools suites
$env:RUN_LIVE = "1"; npm test   # + live sidecar suite (needs Python)
```

## Local models (llama.cpp)

Point `llama.modelsDir` at a folder of `.gguf` files, then `/llama list`,
`/llama start 1`, `/model local/coder`. `contextSize: 0` reads the trained
context from the GGUF header.

## License

MIT — © Erik Boivin / Global Warning Networks
