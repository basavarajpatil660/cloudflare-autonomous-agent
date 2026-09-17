<div align="center">

<img src="assets/logo.png" width="120" height="120" alt="Cloudflare Autonomous Agent logo" />

### Cloudflare Autonomous Agent

A goal-following AI agent that runs entirely on Cloudflare's free tier. You send it a task in Telegram, it plans and executes the steps on its own using a set of tools, and reports back when it is done.

[![Workers](https://img.shields.io/badge/runtime-Cloudflare%20Workers-f38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Workflows](https://img.shields.io/badge/orchestration-Cloudflare%20Workflows-f38020?logo=cloudflare&logoColor=white)](https://developers.cloudflare.com/workflows/)
[![Telegram](https://img.shields.io/badge/telegram-bot-26A5E4?logo=telegram&logoColor=white)](https://core.telegram.org/bots)
[![Tools](https://img.shields.io/badge/tools-53-blue)](#tools)
[![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![GitHub](https://img.shields.io/badge/github-basavarajpatil660-181717?logo=github&logoColor=white)](https://github.com/basavarajpatil660)

</div>

It is built from two Cloudflare Workers:

- **`agent-router`** — the agent itself. Classifies the goal, runs the tool loop, calls model providers, verifies its own output, and talks to Telegram.
- **`agent-deployer`** — a small, single-purpose worker that pushes a finished multi-file project to a GitHub repository in one batched request.

The split exists for a specific reason, covered under [Subrequest budget](#subrequest-budget).

## What it does

Given a goal such as *"build a three page site for a bakery, write the files, and push them to a repo called corner-bakery"*, the agent will:

1. Classify the goal as a coding or general task.
2. Run a tool loop — writing files, searching the web, running code in a sandbox, taking screenshots — until the goal is met.
3. Check its own work: verify generated code actually runs, confirm the requested number of files or rows were really produced, and scan written CSS/HTML for generic template patterns.
4. Push the result to GitHub and deliver files or a summary back to the Telegram chat.

It runs on Cloudflare Workflows rather than a plain fetch handler, so a run is durable and is not bound by the roughly 30-second limit of a normal request.

## Design notes

A few decisions are worth explaining, because they are the result of specific failures rather than preference.

**It fails loudly instead of claiming success.** Language models will happily report that they finished a task they only described. Several checks exist purely to catch this: intent-only detection (an answer that announces a plan but wrote no files), row-count verification against what the goal asked for, a deploy check that confirms a push actually succeeded, and sandbox verification that refuses to present code as working when it did not run. Each of these throws a visible error rather than delivering a confident but false result.

**Destructive actions are gated twice.** `github_delete_repo` and `github_delete_file` require the target to be named in the current message — never in replayed memory — and also pause for a Telegram confirmation button. This exists because an early version deleted a repository that only appeared in prior conversation context.

**Memory is time-scoped.** Old goals are not replayed into unrelated new ones. After a configurable idle gap the next message is treated as a fresh session, and short casual messages skip memory injection entirely.

## Architecture

```
Telegram ──▶ agent-router (Cloudflare Workflow)
                │
                ├─▶ model providers   (fallback chains, free tiers)
                ├─▶ GitHub API        (read, write, repo management)
                ├─▶ Workers KV        (memory, stats, file index)
                ├─▶ Judge0            (code sandbox)
                ├─▶ Tavily            (web search)
                │
                └─▶ agent-deployer ──▶ GitHub API (batched multi-file push)
```

`agent-router` holds all reasoning. `agent-deployer` has no model access, no memory and no Telegram integration — it receives exact paths and exact bytes and writes them. That keeps the component holding write access to your repositories small enough to audit in one sitting.

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the request flow, agent loop and verification passes in detail.

## Subrequest budget

This is the main constraint the project is designed around, and the reason for the two-worker split.

On the Cloudflare **free plan**, a Worker or Workflow gets **50 external subrequests per invocation**, and the limit applies **per Workflow instance, not per step** — every step in a run draws from one shared pool. Internal Cloudflare services such as KV, D1 and R2 have a separate 1,000 per invocation budget and do not count against the 50.

Every external call shares that 50: each model call, each GitHub request, each Telegram message, each web search. An agent loop of 30 iterations spends at least 30 of them on model calls before doing any real work.

The project handles this in three ways:

- **Explicit accounting.** Every external `fetch` is counted. A reserve is held back so a run that exhausts its budget can still report what happened instead of going silent mid-notification.
- **Batching.** Tool-call logging is buffered and flushed as a single request rather than one per call. Model tool definitions are filtered by goal relevance so unused integrations are not serialised into every request.
- **A separate budget for deploys.** Pushing a project to GitHub is the most subrequest-heavy step, so it runs in `agent-deployer` with its own fresh 50, invoked from `agent-router` as a single subrequest.

Be aware of the ceiling this leaves. A large multi-file build genuinely may not fit in 50 external subrequests. When that happens the run fails with a message naming the real limit rather than an opaque "Too many subrequests" error. Raising the limit requires a paid plan and the `limits.subrequests` setting in `wrangler.jsonc`.

## Security

Read this before deploying. The agent operates with a GitHub token and can create and delete repositories.

- **Both entry points fail closed.** Telegram requests are rejected unless the sender's chat ID is listed in `TELEGRAM_ALLOWED_CHAT_IDS`. The HTTP API is disabled entirely until `AGENT_API_SECRET` is set. Neither defaults to open.
- **Scope the GitHub token narrowly.** Use a fine-grained token limited to the repositories the agent should touch. Only add `delete_repo` if you actually want the agent to be able to delete repositories.
- **Use `BLOCKED_REPOS`.** The set at the top of `agent-router/src/worker.js` names repositories the agent must never write to or delete, regardless of instruction. Populate it with anything you cannot afford to lose.
- **Set `TELEGRAM_WEBHOOK_SECRET`.** Telegram will then sign each webhook delivery, and the worker rejects anything that did not come from Telegram.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Requirements

- A Cloudflare account (the free plan is sufficient)
- Node.js 18 or newer, and [Wrangler](https://developers.cloudflare.com/workers/wrangler/)
- A Telegram bot token from [@BotFather](https://t.me/BotFather)
- A GitHub personal access token
- At least one model provider API key per chain (see [Model providers](#model-providers))

## Setup

### 1. Clone and install

```bash
git clone https://github.com/<your-username>/cloudflare-autonomous-agent.git
cd cloudflare-autonomous-agent
npm install
```

### 2. Deploy `agent-deployer` first

`agent-router` needs its URL.

```bash
cd agent-deployer
cp .dev.vars.example .dev.vars   # local development only

wrangler secret put GITHUB_TOKEN
wrangler secret put DEPLOY_SHARED_SECRET   # openssl rand -hex 32

# Set GITHUB_DEFAULT_OWNER in wrangler.jsonc, then:
wrangler deploy
```

Note the deployed URL, for example `https://agent-deployer.<your-subdomain>.workers.dev`.

### 3. Create the KV namespace

```bash
cd ../agent-router
wrangler kv namespace create AGENT_MEMORY
```

Paste the returned `id` into `agent-router/wrangler.jsonc`.

### 4. Configure and deploy `agent-router`

Edit `wrangler.jsonc` and set `GITHUB_DEFAULT_OWNER` and `AGENT_FILES_REPO`, then set the secrets:

```bash
wrangler secret put TELEGRAM_BOT_TOKEN
wrangler secret put TELEGRAM_ALLOWED_CHAT_IDS   # e.g. 123456789
wrangler secret put AGENT_API_SECRET            # openssl rand -hex 32
wrangler secret put GITHUB_TOKEN
wrangler secret put DEPLOYER_WORKER_URL
wrangler secret put DEPLOY_SHARED_SECRET        # same value as agent-deployer

# At least one coding provider and one general provider
wrangler secret put OPENROUTER_API_KEY
wrangler secret put GOOGLE_AI_API_KEY

wrangler deploy
```

To find your Telegram chat ID, message the bot once and read the worker logs with `wrangler tail` — the rejected chat ID is logged.

### 5. Register the Telegram webhook

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://agent-router.<your-subdomain>.workers.dev/telegram/webhook",
    "secret_token": "<TELEGRAM_WEBHOOK_SECRET>"
  }'
```

If you set `secret_token`, store the same value as the `TELEGRAM_WEBHOOK_SECRET` secret on `agent-router`.

### 6. Verify

Send your bot a message such as `write a short notes.txt explaining what a REST API is and send me the file`. You should get an acknowledgement, then the file.

## Configuration

Full variable reference: [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

### Required

| Name | Where | Purpose |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | router | Bot token from BotFather |
| `TELEGRAM_ALLOWED_CHAT_IDS` | router | Comma-separated chat IDs permitted to use the agent |
| `AGENT_API_SECRET` | router | Shared secret for the HTTP API (`X-Agent-Secret`) |
| `GITHUB_TOKEN` | both | GitHub personal access token |
| `DEPLOY_SHARED_SECRET` | both | Must be identical on both workers |
| `DEPLOYER_WORKER_URL` | router | Deployed URL of `agent-deployer` |
| `GITHUB_DEFAULT_OWNER` | both | Owner used for bare repo names |
| `AGENT_FILES_REPO` | router | Internal storage repo for written files |

These four are set in `wrangler.jsonc` under `vars`, not as secrets — edit them before your first deploy:

```jsonc
"vars": {
  "GITHUB_DEFAULT_OWNER": "your-github-username",
  "AGENT_FILES_REPO": "your-github-username/agent-files",
  "MEMORY_SESSION_GAP_MINUTES": "20",
  "MEMORY_HISTORY_LIMIT": "5"
}
```

### Optional

`TELEGRAM_WEBHOOK_SECRET`, `TAVILY_API_KEY` (web search), `JUDGE0_API_KEY` (code sandbox), `SCREENSHOT_API_KEY` (visual review), `RESEND_API_KEY` and `NOTIFY_EMAIL` (failure email), `SHEET_WEBHOOK_URL` (logging), plus credentials for the Spotify, Discord, YouTube, Gmail and Calendar tools. Any tool whose credentials are missing simply reports that it is unavailable.

If you use `SHEET_WEBHOOK_URL`, note that tool-call logs are sent **batched** as `{ "batch": [ ... ] }`. A handler expecting a single flat object needs to loop over `batch`.

## Model providers

The agent uses fallback chains rather than a single provider, so a rate-limited or failing provider does not end the run. Chains are defined at the top of `agent-router/src/worker.js` and are straightforward to edit.

- **Coding chain** — NVIDIA NIM, NagaAI, OpenRouter
- **General chain** — Google AI (Gemma), Cerebras, Groq, OpenRouter
- **Classifier and reviewer** — Cerebras, Groq

At most three providers are attempted per logical call, which bounds how much of the subrequest budget one flaky provider can consume.

## HTTP API

All routes require the `X-Agent-Secret` header.

| Method | Route | Description |
|---|---|---|
| `POST` | `/agent` | Start a run. Body: `{ "chatId", "goal" }` |
| `POST` | `/agent/confirm` | Approve or reject a pending action |
| `GET` | `/status/<instanceId>` | Workflow instance status |
| `GET` | `/stats` | Cumulative tool-call counts |
| `POST` | `/telegram/webhook` | Telegram webhook (uses its own secret) |

```bash
curl -X POST https://agent-router.<your-subdomain>.workers.dev/agent \
  -H "X-Agent-Secret: <AGENT_API_SECRET>" \
  -H "Content-Type: application/json" \
  -d '{"chatId": 123456789, "goal": "write a hello world python script"}'
```

## Tools

The agent has 53 tools. Broadly:

- **Files** — write (including chunked appends for large files), read, list, delete, archive as zip, send to Telegram
- **GitHub** — read and write files, repository management, branches, commits, issues, pull requests, releases, collaborators, search
- **Web** — fetch a URL, search, news search
- **Execution** — run code in a sandbox, diff two texts, render HTML to a screenshot with optional vision review
- **Memory** — store and recall values across runs
- **Integrations** — Spotify, Discord, YouTube, Gmail (read-only), Google Calendar (read-only)

Actions with side effects outside GitHub pause for a Telegram confirmation button before running.

## Techniques worth knowing about

A few implementation details are more interesting than "it uses tools," and are easy to miss reading the source cold.

**It refuses to lie about its own success.** Language models will confidently report finishing work they only described. Four separate checks exist purely to catch this — a deploy that never actually succeeded, a file with fewer rows than the goal asked for, an answer that only announces a plan with nothing written, code that still fails sandbox verification after its retry budget — and each one throws a visible error instead of letting a plausible-sounding false result through. This is enforced at the same points regardless of which model produced the answer.

**The design-cliché check reads the files, not the model's description of them.** A model can accurately describe a page that still uses the exact template pattern the prompt told it to avoid. The scanner extracts the class name behind every `border-radius` + `box-shadow` rule from the written CSS, then counts how many real HTML elements use that class — counting occurrences in the CSS text finds nothing, since a correctly written shared stylesheet only ever defines the rule once.

**Old conversation memory cannot leak into what the model treats as the current request.** Everything the model acts on is passed through a function that strips any injected memory block before goal-detection logic runs on it, and destructive tools separately require their target to be named in that stripped, current-turn text — never satisfied by something that only appears in replayed history. This exists because an earlier version misread stale memory as the active request and deleted a real repository as a result.

**Large files are built incrementally, not generated in one shot.** A single tool call is bounded by the model's own output token limit, so a large CSV or dataset is written through repeated calls that each append to the same file rather than one call holding the whole thing. Chunk boundaries are checked so two appended sections can never land concatenated onto a single line.

**Long answers are chunked without breaking mid-format.** Telegram's per-message length limit means a long final answer has to be split. Splitting prefers the nearest newline instead of a hard character cut, and if a split would land inside an open code fence, the fence is closed at the end of that chunk and reopened with the same language tag at the start of the next — so every delivered message is independently valid on its own.

## Limitations

- A large multi-file build can exceed the free-plan subrequest budget. It fails with a clear message rather than silently.
- Free-tier model providers are rate-limited and occasionally unavailable. Fallback chains reduce but do not remove the impact.
- The code sandbox has no third-party packages. Code importing `pandas`, `numpy` and similar is skipped during verification rather than reported as broken.
- Screenshots use a data-URL method with a practical page-size limit of roughly 6 KB encoded.
- Designed and tested for single-user deployments. There is no multi-tenancy.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT. See [LICENSE](LICENSE).
