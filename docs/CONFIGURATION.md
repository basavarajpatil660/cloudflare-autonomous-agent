# Configuration reference

Secrets are set with `wrangler secret put <NAME>` from inside the relevant worker directory. Non-sensitive values go in that worker's `wrangler.jsonc` under `vars`. For local development, copy `.dev.vars.example` to `.dev.vars`.

## agent-router

### Required

| Name | Type | Description |
|---|---|---|
| `TELEGRAM_BOT_TOKEN` | secret | Bot token from BotFather. |
| `TELEGRAM_ALLOWED_CHAT_IDS` | secret | Comma-separated chat IDs permitted to use the agent. **The agent refuses every Telegram request while this is empty.** |
| `AGENT_API_SECRET` | secret | Shared secret for the HTTP API, sent as `X-Agent-Secret`. **The HTTP API returns 401 until this is set.** |
| `GITHUB_TOKEN` | secret | Personal access token. Scope `repo`; add `delete_repo` only if the agent should be able to delete repositories. |
| `GITHUB_DEFAULT_OWNER` | var | Owner used when a tool receives a bare repo name. Without it, such calls are blocked with a configuration error. |
| `AGENT_FILES_REPO` | var | Internal storage repo for written files, as `owner/name`. |
| `DEPLOYER_WORKER_URL` | secret | Deployed URL of `agent-deployer`. |
| `DEPLOY_SHARED_SECRET` | secret | Must be byte-identical to the same secret on `agent-deployer`. |

### Bindings

| Binding | Type | Required | Purpose |
|---|---|---|---|
| `AGENT_WORKFLOW` | Workflow | Yes | Durable execution. Class `AgentWorkflow`. |
| `AGENT_MEMORY` | KV | Yes | Memory, stats, file index. |
| `AI` | Workers AI | No | Vision review of screenshots. Remove the block to disable. |

### Model providers

At least one from each chain is required.

| Name | Chain |
|---|---|
| `NVIDIA_API_KEY` | coding |
| `NAGA_API_KEY` | coding |
| `OPENROUTER_API_KEY` | coding and general |
| `GOOGLE_AI_API_KEY` | general |
| `CEREBRAS_API_KEY` | general, classifier, reviewer |
| `GROQ_API_KEY` | general, classifier, reviewer |

At most three providers are attempted per logical call. This caps how much of the subrequest budget one failing provider can consume.

### Optional

| Name | Type | Effect if unset |
|---|---|---|
| `TELEGRAM_WEBHOOK_SECRET` | secret | Webhook deliveries are not verified as coming from Telegram. Setting it is recommended. |
| `TAVILY_API_KEY` | secret | `web_search` and `web_search_news` report as unavailable. |
| `JUDGE0_API_KEY` | secret | Falls back to the public Judge0 endpoint, which is rate-limited. |
| `JUDGE0_API_HOST` | secret | Defaults to `judge0-ce.p.rapidapi.com`. |
| `SCREENSHOT_API_KEY` | secret | `html_to_screenshot` is removed from the tool list entirely. |
| `SHEET_WEBHOOK_URL` | secret | Tool-call logging is disabled. |
| `RESEND_API_KEY`, `RESEND_FROM`, `NOTIFY_EMAIL` | secret | No failure emails; failures still reach Telegram. |
| `MEMORY_SESSION_GAP_MINUTES` | var | Defaults to 30. |
| `MEMORY_HISTORY_LIMIT` | var | Defaults to 5. |
| `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REFRESH_TOKEN` | secret | Spotify tools report as unavailable. |
| `DISCORD_BOT_TOKEN` | secret | Discord tool reports as unavailable. |
| `YOUTUBE_API_KEY` | secret | YouTube search reports as unavailable. Transcripts still work. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN` | secret | Gmail and Calendar tools report as unavailable. |

### Logging format

When `SHEET_WEBHOOK_URL` is set, tool-call logs are buffered and sent once per run as:

```json
{ "batch": [ { "timestamp": "...", "action": "tool:write_file", "goal": "...", "status": "success", "detail": "..." } ] }
```

A handler written for a single flat object must loop over `batch`. Run-level entries are still sent individually.

## agent-deployer

| Name | Type | Required | Description |
|---|---|---|---|
| `GITHUB_TOKEN` | secret | Yes | Same token as `agent-router`. |
| `DEPLOY_SHARED_SECRET` | secret | Yes | Byte-identical to the router's value. The worker refuses all requests until set. |
| `GITHUB_DEFAULT_OWNER` | var | Recommended | Fallback owner for bare repo names. |
| `SUBREQUEST_LIMIT` | var | No | Defaults to 50. Raise only on a paid plan with a higher configured limit. |

## Tunable constants

These are in source rather than configuration because changing them has correctness implications.

**`agent-router/src/worker.js`**

| Constant | Default | Notes |
|---|---|---|
| `MAX_TOOL_ITERATIONS` | 30 | Loop ceiling. Each iteration costs at least one subrequest. |
| `MAX_TOOL_CALLS_PER_RUN` | 35 | Cumulative tool calls. |
| `SUBREQUEST_LIMIT` | 50 | Free-plan external subrequests per Workflow instance. |
| `SUBREQUEST_RESERVE` | 8 | Held back so a failing run can still report. |
| `MAX_LLM_ATTEMPTS_PER_CALL` | 3 | Provider fallback ceiling per logical call. |
| `MAX_DELIVERY_CHUNKS` | 5 | Telegram messages for one final answer. |
| `MAX_CONTENT_SIZE` | 200000 | Per-file character limit. |
| `DEPLOYER_MAX_FILES` | 20 | **Must equal `MAX_FILES_PER_DEPLOY` in the deployer.** |
| `BLOCKED_REPOS` | empty | Repositories the agent may never write to or delete. |

**`agent-deployer/src/deployer-worker.js`**

| Constant | Default | Notes |
|---|---|---|
| `MAX_FILES_PER_DEPLOY` | 20 | **Must equal `DEPLOYER_MAX_FILES` in the router.** |
| `MAX_FILE_SIZE` | 300000 | Per-file character limit. |
| `SUBREQUEST_RESERVE` | 4 | Held back so a partial deploy can still be reported. |
| `REPO_SETTLE_DELAY_MS` | 1200 | Wait after repo creation before writing. |
| `WRITE_STAGGER_DELAY_MS` | 150 | Gap between writes, to reduce GitHub secondary rate limiting. |
