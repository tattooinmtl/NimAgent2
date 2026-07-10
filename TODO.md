# NimAgent — What's Left To Do

Status as of 2026-07-09, distilled from `SomeNewIdeas.md` vs what's actually implemented.

## Already done (don't redo)

- ✅ Semantic code intelligence — `lsp` (definition, references, hover, symbols, diagnostics) + `find_symbol`
- ✅ Dependency analysis — `deps`
- ✅ Test coverage — `test_coverage` (auto-detects vitest/jest/pytest/go/cargo/dotnet)
- ✅ Security scanning — `security_scan`
- ✅ Web/docs access — `web_search`, `web_fetch`
- ✅ Reporting — `create_markdown_report`
- ✅ Self-extension — `create_tool` + `/extend` skill + `docs/EXTENDING.md` (uncommitted, see housekeeping)

## Housekeeping (do first)

- [ ] Commit the pending V2.2 work: `create_tool` / extension hot-loading, streaming
      thinking display (`getLastThinking`, turn stream router), `skills/extend-nimagent/`,
      config/prompt/README updates. ~440 lines uncommitted across 12 files.
- [ ] Decide whether `SomeNewIdeas.md` should be kept, trimmed, or deleted now that
      this file tracks the remainder.

## Remaining feature ideas (from SomeNewIdeas.md)

### High value — not doable well with current tools

- [ ] **Interactive debugger** — DAP-based tool: set breakpoints, step over/in/out,
      inspect variables and call stack. Biggest gap left; `start_process` + logging
      is the only workaround today.
- [ ] **Automated refactoring** — the `lsp` tool reads but doesn't mutate. Add
      `rename` (workspace-wide via LSP `textDocument/rename`) and code actions
      (extract function, organize imports).
- [ ] **Performance profiling** — one-shot profiler invocation per language
      (cProfile, `node --cpu-prof`, perf, cargo flamegraph) + flamegraph/summary output.

### Medium value — partially covered by run_shell today

- [ ] **Package manager orchestration** — install/outdated/audit abstraction over
      npm/pip/cargo/dotnet, with auto-detection via `project_inspect`.
- [ ] **Test generation** — stub generation from function signatures (LSP symbols
      already give the signatures; needs the generation half).
- [ ] **CI/CD integration** — trigger pipelines, poll status (GitHub Actions first).
- [ ] **Collaboration** — issue tracker / PR / code-review integration (`gh` wrapper
      is probably enough).
- [ ] **Container tooling** — Docker/K8s helpers beyond raw shell commands.

### Low value / deferred

- [ ] Visualization beyond Mermaid-in-markdown (dependency graph rendering, charts).
- [ ] Session replay & external-change conflict detection (git pull vs unsaved edits).
- [ ] Watch-mode test running.

## Explicitly rejected (per SomeNewIdeas.md analysis)

- Standalone "code explanation" tool — the agent already does this by reading code.
- Real-time multi-agent shared state — out of scope for now.
