# Design Plan — Scheduled / Timed Task Runner (`/cron`)

Status: proposal (2026-07-09). No code written. Feasibility + architecture +
pros/cons for a feature that lets a user set up a task ("do X"), a schedule
("at 3am / every 2 hours / once in 10 min"), and have NimAgent execute it
autonomously later.

## Verdict up front

**Feasible, and it fits the existing architecture well** — but the value and the
risk both live entirely in *how* the task is triggered and *what it's allowed to
do unattended*, not in the questionnaire or the storage. Build it in that order:
task store + headless executor first (safe, portable), OS-scheduler integration
second (the actual "wake at 3am" capability), notifications/polish last.

The single most important constraint: **a scheduled run has no human present, so
it must never be able to auto-approve the very actions we just gated behind human
confirmation** (registry edits, persistence, untrusted MCP, high-risk shell). The
safe default already exists — see below — and the design must preserve it.

## What the codebase already gives us (so we're not starting cold)

- **Headless one-shot mode already works**: `nim2 "do this"` loads config + key,
  runs a single agent turn to completion, exits ([main.mjs](../src/cli/main.mjs)
  one-shot block). A scheduled run is essentially this, invoked by a timer.
- **`runTurn()` is already headless-capable** ([agent.mjs](../src/core/agent.mjs)):
  it takes `confirmTool` as an optional callback. **When `confirmTool` is absent
  (exactly the headless case), every "ask" permission and every high-risk command
  is auto-denied** rather than silently run. That is the correct default for
  unattended execution and it's already there — we get fail-safe for free.
- **Sessions already persist** as JSONL under `<HOME>/sessions/<cwd-slug>/<ts>.jsonl`
  — the same mechanism gives us per-run task transcripts.
- **The command registry is declarative** ([commands.mjs](../src/cli/commands.mjs)):
  adding `/cron` is one entry with a handler.
- **Interactive questionnaire prompting already has a pattern**: the permission
  confirm uses `rl.question()` mid-session ([repl.mjs](../src/cli/repl.mjs)
  `confirmToolUse`). The setup wizard reuses this.
- **Goal mode** ([goal.mjs](../src/cli/goal.mjs)) is the closest existing
  autonomous concept (inject a directive, loop turns until done) and is a good
  model for how a task's instruction drives multiple turns.

So the plumbing is largely present. The new work is: a persistent task store, a
trigger mechanism, and a hardened permission profile for unattended runs.

## DECIDED — scheduling mechanism: cron semantics, in-process (2026-07-09)

**Chosen: cron.** Because NimAgent is cross-platform and Windows has no native
cron, "cron" here means cron *expression semantics* evaluated in-process by a
small dependency-free parser — **not** a shell-out to a Unix crontab. Identical
behaviour on Windows / Linux / macOS, one codebase, no OS-scheduler
fragmentation.

- Tasks are scheduled with standard 5-field cron strings (`0 3 * * *`), plus the
  usual aliases (`@daily`, `@hourly`, …). A one-off "in 10 minutes" is just
  sugar the questionnaire converts to a concrete time.
- A **scheduler tick** (fires once a minute) checks each enabled task's cron
  against the current minute and launches due tasks. It runs in two places
  sharing the same code: (a) in the background while the REPL is open, and (b) a
  standalone `nim2 sched` long-running process for headless/always-on use.
- Each due task is launched as a **separate child process** (`nim2 --run-task
  <id>`) so one task crashing can't take down the scheduler and each run's output
  redirects cleanly to its own log.

**Validated:** the cron parser/matcher was prototyped and unit-tested (20/20
cases: `*/step`, ranges, lists, name aliases, the day-of-month-OR-day-of-week
rule, `nextRun` look-ahead). The prototype was removed to keep the repo clean at
the planning stage and will be restored on build greenlight. So the feasibility
claim here is proven, not assumed.

**Honest limitation (same as real cron):** an in-process scheduler only fires
while *something* is running the tick — the REPL, or the `nim2 sched` process.
If the machine is off or neither is running at the scheduled minute, that firing
is missed (real cron has the same "machine was off" gap). Making `nim2 sched`
survive reboots is an OS-autostart concern deferred to a later phase (a Task
Scheduler / systemd / launchd entry that just launches `nim2 sched` — a fixed
command, not per-task registration). This keeps the earlier security concern
(scheduled-task registration as a persistence vector) down to a single,
explicit, human-initiated autostart entry rather than one per task.

The original option analysis that led here is retained below for context.

## (Background) the options that were weighed

### Option A — In-process timers (only while the REPL is open)
`setTimeout`/`setInterval` registered when `nim2` starts, firing task runs in the
same process.

- **Pros:** trivial; fully cross-platform; no OS integration; no new security
  surface (a human is sitting at the REPL).
- **Cons:** dies the moment you close the terminal or reboot. "Run at 3am
  tomorrow" is impossible unless the app happens to be open then. This is really
  just a reminder-while-you-watch — low value for the stated use case.

### Option B — OS scheduler integration (Windows Task Scheduler / cron / launchd)
At setup, register an OS task that runs `nim2 --run-task <id>` headless at the
scheduled time. The OS wakes NimAgent.

- **Pros:** survives app close and reboot; *real* scheduling; the OS handles the
  hard parts (persistence, missed-run policy, wake-from-sleep). On Windows
  (primary platform) `schtasks /create` via `spawnSync` is straightforward.
- **Cons:** platform-specific (three backends eventually); every run is headless,
  so the permission/security problem is front-and-center; the API key must be
  reachable headless; output has nowhere to go but a log; **registering an OS
  scheduled task is itself a persistence mechanism** — the exact category we just
  flagged as high-risk in the security work. That's not a blocker (it's
  human-initiated and visible), but the registration must only ever install a
  fixed `nim2 --run-task <id>` command, never anything arbitrary.

### Option C — A NimAgent daemon
A long-lived `nim2 --daemon` holding an in-process scheduler (cron-like) that
fires tasks.

- **Pros:** one cross-platform codebase for all scheduling logic; full control
  over repeat/missed-run/queueing.
- **Cons:** the daemon itself has to be kept alive across reboots — which needs
  OS autostart, so you're back to Option B's platform integration *plus* a
  process to babysit. More moving parts for the same result.

### Recommended: Option D — task store + pluggable trigger backend
Separate **what/when** (portable JSON) from **how it's triggered** (swappable):

- A portable **task store** and a headless **executor** (`nim2 --run-task <id>`).
- A **trigger backend** interface with two implementations to start:
  `os-scheduler` (schtasks now; cron/launchd later) and `in-process` (for
  near-term one-offs while the REPL is open, so "remind me in 10 minutes" works
  without touching the OS).
- Default to `os-scheduler` for anything that must survive app close; use
  `in-process` only as a convenience for short, same-session timers.

This keeps the risky/platform-specific part behind one seam and lets us ship the
safe core first.

## Data model (`<HOME>/tasks.json`)

```jsonc
{
  "id": "t_ab12",
  "name": "nightly-dep-audit",
  "instruction": "Run the dependency audit and write findings to audit.md",
  "cwd": "C:/projects/foo",           // where the agent runs
  "schedule": {
    "type": "cron | once",            // cron is the headline; once = run one time
    "cron": "0 3 * * *",              // 5-field cron (or @daily etc.)
    "at": "2026-07-10T03:00:00"       // only for type:"once"
  },
  "model": "nvidia/glm-5.2",
  "permissionProfile": "read-only",    // ALWAYS explicit — the questionnaire has
                                        // no pre-selected answer; see below
  "budget": {                          // 2-tier — see budget section
    "tier": "capped | unlimited",
    "currency": "USD | CAD",           // user's chosen unit, when tier=capped
    "amount": 0.50,                    // per-run cap in that currency
    "capUsd": 0.50                     // computed USD equivalent, used at runtime
  },
  "enabled": true,
  "createdAt": "...", "lastRun": "...", "nextRun": "...",
  "runCount": 3,
  "lastResult": "ok | error | denied | budget", "lastCostUsd": 0.12  // actual spend always logged in USD (provider currency)
}
```

## The `/cron` questionnaire (interactive setup)

Runs in the REPL, reusing `rl.question`. Steps, each validated, with a final
review-and-confirm before anything is registered:

1. **Task** — the natural-language instruction the agent will execute.
2. **When** — one-off ("in 10m", "at 3am tomorrow") vs recurring (cron).
3. **Cron** — if recurring: a cron expression, validated live, echoed back in
   plain English ("every day at 03:00") so the user can confirm they got it right.
4. **Where** — working directory (defaults to current).
5. **Model** — defaults from settings.
6. **Budget** — the 2-tier choice (see below): a money cap in USD or CAD
   (user's choice of currency), or unlimited.
7. **Permission profile** — the safety scope (see below). No pre-selected
   answer — the user must type one of `read-only` / `workspace-write` /
   `shell-safe` explicitly; blank/Enter does not silently pick one for them.
8. **Review** — print the full task summary + the exact schedule (+ next fire
   time) + the budget + *what it will and won't be allowed to do*, and require an
   explicit `y` to create it.

Cancellable at any step (blank/Esc). On confirm: write to `tasks.json`, then
register with the chosen trigger backend. Sibling subcommands:
`/cron list | show <id> | disable <id> | delete <id> | log <id> | run <id>`
(`run` = fire once now, for testing).

### `/cron-budget` — dedicated budget management (added per user request)

Editing a task's money cap, or the underlying rates, shouldn't require re-running
the whole setup questionnaire. `/cron-budget` is a sibling command scoped
entirely to money:

- `/cron-budget` — summary view: the FX rate, the pricing table (per model), and
  every task's budget tier + cap + spend-to-date, in one place.
- `/cron-budget set <task-id> <amount> <USD|CAD>` — change one task's cap
  in-place (recomputes `capUsd`); `/cron-budget set <task-id> unlimited` switches
  it to Tier 2 — this still prints the "no ceiling" warning and asks for `y`,
  same as the questionnaire would.
- `/cron-budget fx <rate>` — view or set `settings.fx.usdToCad` (the static,
  manually-maintained conversion rate described above).
- `/cron-budget pricing <model> <inputPer1M> <outputPer1M>` — view or override a
  model's USD-per-1M-token rate; view-only when no values are given.

This keeps rate/cap tuning a one-line command instead of a multi-step
re-confirmation, while cap changes and the tier-2 switch still get their own
explicit confirmation — editing a cap is still a deliberate action, just a
shorter one. Spend *reporting* (as opposed to rate/cap *editing*) lives in
`/cron-total` below, so each command has one job.

### `/cron-total` — spend reporting across all tasks (added per user request)

Answers "how much has this whole feature cost me," pulled from each run's
logged `lastCostUsd` (see the mandatory-logging item below) — no separate
accounting system, just a sum over what's already recorded:

- `/cron-total` — grand total spend across every cron task, all-time, shown in
  both USD and CAD (using the current FX rate), plus a per-task breakdown line
  (`nightly-dep-audit: $3.20 / 12 runs`).
- `/cron-total <task-id>` — total for one task only.
- `/cron-total today | week | month` — same totals, scoped to a time window —
  the natural follow-up question after "what's my total" is "what did I spend
  *this week*," so it's worth having from the start rather than bolting it on
  later.

Unlimited-tier tasks show up here too, and loudly — this is the command most
likely to surface "oh, that one task cost more than I expected," so an
unlimited task's line is flagged the same way it is in `/cron list`.

## DECIDED — budget: 2-tier (money cap | unlimited) (2026-07-09)

Per-task budget has exactly two tiers:

- **Tier 1 — `capped`:** a set amount of **money** (USD). Enforced by converting
  token usage to a dollar figure via a configured price rate, and stopping the
  run once the cap is reached. This is the safe default for unattended tasks —
  the user thinks in dollars, not tokens.
- **Tier 2 — `unlimited`:** no budget ceiling. For trusted, cost-insensitive
  tasks. Chosen explicitly at setup and shown clearly in the review step and in
  `/cron list`, because it's the one that can spend without bound.

### Token → money conversion (USD or CAD cap)

The user sets their cap in **whichever currency they think in — USD or CAD** —
per task. Providers quote prices in USD, so the mechanics split into two rates:

1. **Provider pricing** — a `pricing` block in settings, keyed by model, in USD
   **per 1M tokens** (the unit providers quote), with a fallback default:

   ```jsonc
   "pricing": {
     "default":          { "inputPer1M": 0.50, "outputPer1M": 1.50 },
     "nvidia/glm-5.2":   { "inputPer1M": 0.20, "outputPer1M": 0.60 },
     "openai/gpt-4.1":   { "inputPer1M": 2.00, "outputPer1M": 8.00 }
   }
   ```

   Cost of a run in USD = `promptTokens/1e6 * inputPer1M + completionTokens/1e6 * outputPer1M`,
   summed across the run's turns. NimAgent already tracks `prompt_tokens` /
   `completion_tokens` per response (`Session.addCost`), so the accounting
   inputs already exist — this only adds the rate table and the multiply.

2. **FX rate** — a single `settings.fx.usdToCad` number (e.g. `1.35`), edited by
   the user like any other setting. This is a **static, manually-maintained
   rate, not a live-fetched one** — deliberately, so the budget check never
   makes a network call. Converting the task's cap to USD once (at task
   creation, and again if the task is edited) is enough: `capUsd = currency ===
   "CAD" ? amount / fxUsdToCad : amount`. The run then compares accumulated USD
   cost against `capUsd` — no per-check conversion needed. A live-FX option
   (fetched periodically, cached) is a reasonable Phase-3 add if the static rate
   turns out to drift too much, but isn't needed to ship this.

The task's own record keeps the user's original `{ currency, amount }` (so
`/cron list` shows "$25 CAD", not a USD figure they never typed) alongside the
computed `capUsd` used for enforcement.

### `/pricing-update` — refresh the pricing table from real providers (added per user request)

**Feasibility check first, because it changes the design:** there is no single
API that returns "current LLM pricing." Providers split cleanly into two camps,
and `/pricing-update` has to treat them differently rather than pretend one
mechanism covers both:

| Provider (as configured in NimAgent) | Live, machine-readable pricing? |
|---|---|
| **OpenRouter** | **Yes.** `GET /api/v1/models` returns per-model `pricing.prompt` / `pricing.completion` (price per token) for every model it proxies — including many OpenAI/Anthropic/Google/xAI models, since OpenRouter resells them. This is the one genuinely live, structured source. *(Documented from general knowledge of the API's shape — verify the exact response format against the live endpoint during implementation, not assumed from this planning pass.)* |
| **OpenAI, Anthropic, xAI (Grok), Google direct, Mistral, Groq, DeepSeek** | **No public pricing API.** Pricing lives on a marketing webpage. Scraping HTML is fragile (breaks silently on redesign) and legally/ethically grayer than calling a documented API — not recommended as the primary path. |
| **Together AI, Fireworks** | **Partial.** Their `/models` endpoints sometimes carry per-model price metadata (compute-marketplace style), inconsistently across models — worth attempting, falling back like the group above when absent. |
| **NVIDIA NIM** | Per your note — you're on the free tier, so the number is performative for actual spend, but the table should still carry a row in the same shape as everyone else for consistency. NVIDIA does list hosted per-model pricing at build.nvidia.com for non-free usage; treat it as low-priority to fetch live, default to `$0` while a free-tier key is detected. |
| **Ollama, local llama.cpp, gwn** | Self-hosted / free — always `$0`, no fetch needed. |
| **"Cursor"** | **Not a fit as stated.** Cursor is an IDE product, not one of NimAgent's configured chat-completion providers (the provider list is openai/nvidia/openrouter/groq/deepseek/google/xai/mistral/together/fireworks/ollama/local/gwn — no `cursor` entry). If you meant something else by it (e.g. a specific model you access *through* one of these providers), flag it and I'll fold it in; otherwise it's dropped from this list. |

**Design given that split:**

1. `/pricing-update` reads which providers are actually configured (present in
   `settings.providers` with a real key — same check `applyEnvKeyOverrides`
   already does), so it only fetches for providers you actually use.
2. For **OpenRouter**: live-fetch `/models`, convert its per-token price to our
   per-1M-token unit, update `settings.pricing` for every matching model.
3. For providers **without** a live API: the honest options are (a) maintain a
   small **bundled reference table shipped inside NimAgent**, hand-updated
   whenever list prices change, refreshed only by upgrading NimAgent itself — no
   network call, or (b) pull from a **community-maintained open-source pricing
   dataset** (e.g. the kind of `model_prices.json` a few agent projects publish
   on GitHub, aggregating OpenAI/Anthropic/Google/etc. list prices) fetched over
   the network like OpenRouter's. Option (b) gets closer to "real, current
   numbers" for providers with no official API, at the cost of trusting an
   unofficial third party for a number that directly gates spending. **This is
   a real decision, not a detail** — see the question below.
4. Every entry gets `source` (`"openrouter-live"` / `"community-dataset"` /
   `"bundled"` / `"free-tier"`) and `fetchedAt`, so `/cron-budget` and
   `/pricing-update status` can show *where a number came from and how old it
   is* — never a silent, unattributed figure.
5. Output is a diff, not a silent overwrite: `gpt-4.1: $2.00 → $2.10 / 1M in
   (source: openrouter-live, fetched just now)`, applied only after the usual
   confirm.
6. A provider with no available source at all keeps its existing table entry
   untouched and prints a warning — never errors out the whole command over one
   unreachable provider.

**Open question this raises:** for providers with no official pricing API
(OpenAI, Anthropic, xAI direct, Google direct — the majority), do you want
`/pricing-update` to (a) pull from an unofficial community-maintained pricing
dataset over the network, accepting that trust dependency for a figure that
gates spending, or (b) stick to a bundled table inside NimAgent that only moves
when NimAgent itself is updated, with `/pricing-update` in that case only truly
*fetching* for OpenRouter (and Together/Fireworks where available) and just
reporting "using bundled/dated reference" for the rest?

### `/usage-<provider>` — real billed-usage reconciliation (added per user request)

This is a **different feature from everything above**, worth being precise about:
everything in the budget design so far *estimates* a run's cost from its own
token counts × our pricing table — that estimate is what gates a running task in
real time. What's being asked for now is pulling the provider's own **actual
billed number** after the fact, to check the estimate against reality. Same
per-provider capability split as pricing, but sharper — and this time the gap
matters for security, not just data availability:

| Provider | Real usage/cost via API? |
|---|---|
| **OpenRouter** | **Yes — cleanly.** A `generation` lookup returns the actual billed cost for a specific request, using the *same* API key already configured for chat completions. No extra credential. |
| **OpenAI** | Yes, but via the **Usage API**, which needs an **Admin/Organization API key** — a fundamentally different, more powerful credential than the per-project key NimAgent uses today. That key can typically see usage across your whole org, not just this app. |
| **Anthropic (Claude)** | Same shape as OpenAI: a **Usage & Cost** endpoint exists, gated behind an **Admin API key**, not the regular key. |
| **xAI (Grok)** | No confirmed public usage/billing API as of this writing. |
| **Google (Gemini direct)** | No simple API-key path at all — billing lives in **Google Cloud Billing**, which is project/service-account based, a much heavier integration than "add an endpoint call." Realistically out of scope. |
| **NVIDIA NIM** | Free tier today, so there's no bill to reconcile against — this command would just show locally-logged token counts, labeled `$0 (free tier)`. |
| **Groq, DeepSeek, Mistral, Together, Fireworks** | Inconsistent/unconfirmed; best-effort, honest "not available" where there's nothing to call. |

**Why this can't become the live budget gate:** provider usage/billing data is
typically **delayed** (minutes to hours, sometimes a daily batch) — it cannot
stop a task mid-run the way our own token-count estimate can. So this is a
**reconciliation layer**, not a replacement for the enforcement mechanism
already designed above; both are needed, doing different jobs.

**The credential question is the real decision here.** For OpenRouter, this is
free — reuse the key you already have. For OpenAI and Anthropic, *reconciling
real spend requires storing a more privileged Admin/Org key*, separate from the
regular API key, purely for this reporting feature. That's a meaningfully
bigger ask than anything else in this plan — it should be **opt-in, stored in
its own settings field (never reused as the chat-completions key), and clearly
labeled with what that credential can see/do** when the user sets it up.

**Command surface:** two ways to shape this, worth picking deliberately rather
than defaulting:

- **One command per provider** (as you suggested: `/usage-openai`,
  `/usage-claude`, `/usage-nim`, …) — reads naturally, but each new provider
  NimAgent adds later needs its own new command registered.
- **One parameterized command** (`/usage <provider>`, e.g. `/usage openai`) —
  same behavior, scales to any configured provider automatically, no new
  command needed when a provider is added later. Could still alias
  `/usage-openai` → `/usage openai` if the per-provider spelling is what feels
  natural to type.

### Enforcement point (the one code change this needs in the core loop)

A run is a single `runTurn` call that internally loops tool-call iterations. To
stop *mid-run* when the money cap is hit, `runTurn` gets one small optional hook:
a `budget` callback checked at the top of each tool-iteration. If cumulative cost
≥ cap, `runTurn` stops gracefully and returns a `budget` result (same shape goal
mode already uses for its token budget — so there's precedent in the codebase).
`unlimited` passes no callback and behaves exactly as today. This is the only
change to shared code; everything else is new, isolated modules.

Edge note: enforcement is *between* tool iterations, so a single in-flight model
response can overshoot the cap slightly before the next check catches it. For a
per-run dollar cap that's acceptable; the cap is a ceiling-ish, not a hard
transactional limit. Documented, not hidden.

### Optional later: a rolling spend ceiling

Phase-3 idea, not required now: a global daily/monthly spend cap across *all*
scheduled tasks (not just per-run), so a fleet of cheap tasks can't add up to a
surprise. Per-run caps ship first.

## Security model — the part that actually matters

A scheduled run executes with **no human to answer a prompt**. Everything here is
about not letting "unattended" become "unrestricted."

1. **Preserve the existing fail-safe.** Headless `runTurn` already auto-denies
   "ask" tools and high-risk commands when `confirmTool` is absent. Scheduled
   runs MUST keep `confirmTool` null (or a policy object that only ever denies).
   **A scheduled task must never auto-approve** registry/persistence/firewall/boot
   commands or untrusted MCP servers — doing so would silently undo the
   confirmation gates just added. This is the hard line.
2. **Explicit, captured-at-setup permission profile**, stored per task and
   enforced at run time. No default is pre-selected in the questionnaire — the
   user must actively choose one for every task:
   - `read-only`: read/search/inspect, no writes, no shell, no test running.
   - `workspace-write`: + file writes within cwd, still no shell/tests.
   - `shell-safe`: + `run_shell`/`run_test`/`start_process` (the destructive/
     registry/persistence gate from item 1 still applies underneath — no override).
   - There is deliberately **no** "allow everything" profile for scheduled tasks.
3. **The OS task only ever runs a fixed command** — `nim2 --run-task <id>` —
   never a task-supplied string. The instruction lives in `tasks.json`, gated by
   the profile; it never becomes shell.
4. **Money budget + global kill switch.** Silent scheduled LLM calls cost money;
   every task carries a budget (Tier 1 money cap by default; Tier 2 `unlimited`
   only when explicitly chosen), and a global `/cron pause-all` disables
   execution without deleting definitions. `unlimited` tasks are visually flagged
   wherever tasks are listed so they can't hide.
5. **Mandatory logging.** Every run writes a full transcript to
   `<HOME>/task-runs/<id>/<ts>.jsonl` plus a one-line result. Unattended work you
   can't inspect afterward is unacceptable.
6. **Overlap guard.** A per-task lock file so a slow run can't overlap its next
   trigger.
7. **API key reachability.** Headless runs need the key from env/settings; document
   that a scheduled task inherits whatever key the executor can load, and keep the
   minimal-env discipline we applied to MCP servers.

## Phased implementation

New code is isolated modules (`cron.mjs`, `tasks.mjs`, `scheduler.mjs`, a
`remote-task` command); the only shared-code touch is the small budget hook in
`runTurn`.

- **Phase 1 — safe core + cron engine:** the validated `cron.mjs` (restored),
  task store (`tasks.json` CRUD), the `/cron` questionnaire (permission profile
  always explicitly chosen, never defaulted), `/cron-budget` and `/cron-total`,
  and the `nim2 --run-task <id>` executor enforcing whichever profile + 2-tier
  budget the task was created with, plus logging. Scheduler tick runs in the background
  while the REPL is open (covers "in 10 minutes / at 3am while I'm working").
  Pricing table, FX rate, and the `runTurn` budget hook land here. Fully
  testable with the mock provider — no OS integration, near-zero new risk. This
  is the meaningful deliverable.
- **Phase 2 — always-on + management:** the standalone `nim2 sched` process so
  tasks fire when the REPL is closed, `/cron list|show|disable|delete|log|run`,
  the overlap lock, and the `pause-all` kill switch. Optionally a single
  human-initiated OS-autostart entry that just launches `nim2 sched` (one fixed
  command — not per-task registration).
- **Phase 3 — breadth + polish:** `workspace-write` / `shell-safe` profiles;
  missed-run policy ("run if the tick was down at fire time"); a rolling
  global spend ceiling across all tasks; completion notifications (desktop toast
  / webhook / optional email).

## Pros / cons of building this at all

**Pros**
- Natural extension of the existing one-shot + goal-mode capabilities.
- High utility: nightly audits, periodic report generation, "kick this off at
  3am," scheduled maintenance.
- The safe core (Phase 1) is low-risk and mostly reuses what exists.

**Cons / risks**
- Unattended LLM execution is inherently riskier — no human circuit-breaker, and
  the model is nondeterministic. Mitigated by deny-by-default profiles, budgets,
  logging, and the kill switch, but never fully eliminated.
- Silent cost accrual from scheduled calls — the money cap is the primary guard,
  but `unlimited` tasks trade that guard away by design.
- Cron-in-process only fires while the REPL or `nim2 sched` is running; a missed
  minute is genuinely missed (same as real cron when the machine is off).
- It's a persistence mechanism by nature — has to stay strictly human-initiated
  and visible, and it slightly enlarges the app's security surface right after we
  worked to shrink it.

## Decisions locked / still open

**Locked (this session):**

- Scheduling mechanism → **cron semantics, in-process** (parser validated 20/20).
- Budget → **2-tier: money cap, user's choice of USD or CAD, or unlimited.**
- Command name → **`/cron`** — accurate now that the mechanism itself is cron
  semantics, not just a naming choice.
- Default permission profile → **none — always forced.** The questionnaire
  never pre-selects `read-only`/`workspace-write`/`shell-safe`; the user must
  type one explicitly for every task, every time.
- Companion commands → **`/cron-budget`** (view/edit the FX rate, pricing
  table, and per-task caps) and **`/cron-total`** (spend reporting: grand
  total, per-task, and today/week/month breakdowns) — both requested this
  session, both scoped to Phase 1.

**Still open (confirm before build):**

1. Price table source — for providers with **no** official pricing API
   (OpenAI, Anthropic, xAI, Google direct — the majority), pull from an
   unofficial community-maintained dataset over the network, or ship a bundled
   table that only moves when NimAgent updates? (`/pricing-update` genuinely
   live-fetches for OpenRouter either way.)
2. Real usage reconciliation (`/usage-<provider>`) — for OpenAI and Anthropic
   specifically, this requires storing a separate, more privileged
   **Admin/Organization API key** (not the regular key). Confirm you're OK with
   that credential ask before it's built; OpenRouter needs no extra credential
   and NVIDIA is free-tier ($0), so those two are unaffected either way.
3. `/usage` command shape — one command per provider (`/usage-openai`,
   `/usage-claude`, …) or one parameterized command (`/usage <provider>`)?
4. `nim2 sched` autostart — is Phase-1 "fires while the REPL is open" enough for
   your use, or is always-on (Phase 2) needed from the start?

**Note:** "Cursor" was mentioned as a provider to price/track, but it isn't one
of NimAgent's configured chat-completion providers (an IDE product, not an API
NimAgent calls) — dropped from the pricing/usage tables above unless you meant
something more specific by it.
