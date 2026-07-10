# NimAgent V2.1 — Implemented & Tested Features

Status as of 2026-07-09. Two evidence tiers, kept separate so nothing here is
overclaimed:

- **Automated** — covered by `npm test` (zero-dependency custom runner,
  `tests/run-all.mjs`). Re-run anytime; 87/87 passing as of this writing.
- **Live-verified** — exercised against a real running `nim2` process this
  session (either the actual configured model, or a local mock OpenAI-compatible
  HTTP server for behavior that's model-dependent), with output inspected and,
  where possible, cross-checked against an independent source (e.g. `wc -w`).

Anything not in one of those two buckets is implemented but **not** claimed as
tested here — see the closing section.

## Automated test suite (87/87 passing)

`npm test` — 3 suites, 0 failed:

### `router.test.mjs` (19 tests)
- `runTurn` back-compat with no persona
- `PERSONAS.coding` / `PERSONAS.assistant` structure and field requirements
- Coding persona has a higher iteration budget than assistant
- Persona system prompts are distinct and context-aware (contain cwd)
- JS heuristic intent classifier: 10 cases (5 coding-shaped, 5 assistant-shaped
  prompts) all classify correctly
- `classifyIntent` robustness on empty and very long input
- `DEFAULT_SETTINGS` retains all original keys after merge

### `toolcalls.test.mjs` (25 tests)
Tolerant text-protocol tool-call parser (`src/core/toolcalls.mjs`), covering
every shape models actually emit in practice:
- Canonical `<tool_call><function=...>` format
- GLM `<arg_key>/<arg_value>` format, including unclosed envelopes
- Qwen JSON-in-`<tool_call>` format
- Bare `<function=...>` without a wrapper
- Legacy JSON body inside a function tag
- Multiple sequential tool calls in one response
- String-typed args are never coerced (a JSON blob written via `write_file`
  stays a literal string)
- HTML/XML-looking content inside a string arg survives intact
- `<think>` blocks stripped before tool-call parsing
- Plain-text (non-tool-call) responses correctly yield zero calls
- `invoke`-style call syntax
- Tool-intent detection (positive and negative)
- Tool-call-syntax stripping (closed + unclosed blocks)
- **Live `<think>` stream splitter** (`createThinkSplitter`, added this
  session): no-think passthrough, a complete think block in one chunk, the
  opening tag split across chunk boundaries, the closing tag split across
  chunk boundaries, multiple think blocks in one response, and an unclosed
  trailing think block (simulates a truncated response) correctly classified
  as reasoning rather than leaked as visible text
- **`extractThink`** (non-streaming counterpart): captures + strips a closed
  block, no-ops when there's no block, and — same as the splitter — treats an
  unclosed trailing block as reasoning rather than a leaked raw tag
- **`stripThink`**: now also drops an unclosed trailing block instead of
  leaking the tag into stored conversation history

### `tools.test.mjs` (43 tests across 10 groups)
- **jq_query**: top-level field extraction, object-key extraction, error on
  bad filter
- **search**: case-insensitive matching, context lines (both `context=1` and
  `context=0`)
- **find_files**: extension filter (single and comma-separated), directory-type
  filter
- **package registry**: `resolvePackage` lookup (found/not-found), seed
  manifest field validation per package type
- **agent-grade editing/safety**: `apply_patch` (single- and multi-hunk),
  workspace-escape guard, `run_shell` destructive-command blocking by default,
  `project_todo` persistence
- **project context & processes**: `project_inspect` Node-project detection,
  `read_many_files`, `run_shell` dry-run risk reporting, `start_process` /
  `process_status` / `stop_process` lifecycle
- **provider/model config**: reasoning-tier propagation, NVIDIA GLM 5.2 as
  built-in default, NVIDIA's text-tool (not native) protocol, confirming no
  native tool payload ever reaches that provider
- **code navigation**: `find_symbol` (definition, class-kind filter, references
  mode, regex-injection rejection, missing-symbol handling), `deps` (npm
  detection, list, unknown-manager rejection)
- **coverage/security**: `test_coverage` auto-detection + dry-run, `security_scan`
  finding planted secrets (values redacted) and reporting clean on `src/`
- **LSP client**: JSON-RPC framing across chunk boundaries, language→server
  mapping, graceful failure on a missing server, rejection of unsupported
  extensions

## Live-verified this session (manual, against a running process)

### Self-extension (`create_tool`, `/extend`, `docs/EXTENDING.md`)
- Asked a fresh `nim2` one-shot process to create a `word_count` tool and use
  it on `README.md`. It wrote `extensions/word_count.js`, hot-loaded it into
  the same running process with **no restart**, called it, and reported 991
  words — independently cross-checked with `wc -w README.md` (991, exact
  match). Config persistence (`nimagent.config.json` → `extensions`) and
  clean replace-on-redefine were confirmed by inspection. Test artifact
  removed afterward.
- Confirmed skill auto-discovery picks up the new `/extend` skill (10 skills
  loaded) and the base system prompt now answers "how do I extend you"
  correctly without any tool calls (previously it flailed: an empty
  `memory_search` call, then a blind `find_files` grep).

### Live reasoning display (`/thinking`, collapsed by default)
Verified end-to-end against a local mock OpenAI-compatible SSE server
(purpose-built for this test, `<think>...</think>` content deliberately split
across awkward chunk boundaries — including mid-tag — to exercise the
boundary-safety logic over a real HTTP stream, not just in-process) across
all four combinations:

| Provider path | `showThinking` | Result |
|---|---|---|
| Buffered (`nativeTools:false`, matches the default NVIDIA GLM config) | off | `▸ Thinking (~9 words) — /thinking last to view` then clean answer, zero raw tag leakage |
| Buffered | on | `▾ Thinking` header, full dimmed reasoning text correctly reassembled from split chunks, then the answer |
| Live-streamed (`nativeTools:true`) | off | Same collapsed summary, confirmed working under real per-token streaming |
| Live-streamed | on | Same dimmed live-reasoning display under real per-token streaming |

Also verified `/thinking last` inside a genuine multi-turn interactive REPL
session (paced stdin, not one-shot): after a turn with hidden reasoning, `/thinking
last` correctly reprinted the stored reasoning text.

Test settings/providers were added to `agent/settings.json` for this only,
backed up beforehand, and fully restored afterward (confirmed via diff — no
residual mock provider entries or setting changes).

## Implemented but not covered by either tier

These exist in the codebase and are exercised only by ordinary end-user usage
— no automated test, no live check this session. Listed so this document
doesn't imply more coverage than it has:

- File/edit tools in isolation: `write_file`, `edit_file`, `list_dir` (`apply_patch`
  *is* covered; these siblings aren't)
- `git_status`, `git_diff`, `git_commit`
- `run_test` (as a standalone tool, separate from the coverage-detection tests)
- `memory_save` / `memory_search` / `memory_list` / `memory_forget`
- `rag_search` / `rag_index`
- `system_info`, `dev_env_report`, `where_is`, `create_markdown_report`
- REPL slash commands generally: `/model`, `/addprovider`, `/addmodel`,
  `/apikey`, `/perm`, `/goal`, `/effort`, `/route`, `/llama`, `/install`,
  `/uninstall`, `/mcp`, `/bridge`, `/context`, `/compact`
- Themes (`themes/*.json` → `theme` config) — mechanism documented in
  `docs/EXTENDING.md`, not exercised this session
- The `nimtools` bridge (hermes backend) — `bridge.enabled: false` by default,
  not exercised
- The package registry's actual network install/uninstall round-trip
  (`resolvePackage` and manifest validation *are* unit-tested; a live
  download+extract+install+uninstall cycle against a real registry is not)
