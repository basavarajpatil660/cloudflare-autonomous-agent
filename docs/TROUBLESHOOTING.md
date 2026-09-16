# Troubleshooting

## The bot does not respond

The chat is probably not allowlisted — the agent fails closed by design. Run `wrangler tail` from `agent-router/` and message the bot. A rejected chat is logged with its ID:

```
[telegram] rejected goal from non-allowlisted chat 123456789
```

Add that ID to `TELEGRAM_ALLOWED_CHAT_IDS` and redeploy.

If nothing is logged at all, the webhook is not registered. Check:

```bash
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

If you set a `secret_token` on the webhook, the same value must be stored as `TELEGRAM_WEBHOOK_SECRET` on the worker, or every delivery is silently dropped.

## `401` from the HTTP API

Either `AGENT_API_SECRET` is not set — the API stays disabled until it is — or the `X-Agent-Secret` header does not match. The error body distinguishes the two cases.

## "Ran out of Cloudflare subrequest budget"

The run needed more external API calls than a free-plan Workflow instance allows. This is a real ceiling, not a bug. Options:

- Split the goal across separate messages.
- Reduce the file count in a single build.
- Move to a paid plan and raise `limits.subrequests` in `wrangler.jsonc`.

A run reaching this point stops deliberately, with reserve intact, so the message reaches you.

## Deploy wrote only some files

The response names the remainder. The deployer stops before exhausting its own budget and returns `filesSkipped` for anything not written — failed or never attempted. Ask the agent to deploy just those paths; it should not pass `create_repo` on the second call.

## "repo has no owner prefix and GITHUB_DEFAULT_OWNER is not configured"

Set `GITHUB_DEFAULT_OWNER` in `wrangler.jsonc`, or use fully-qualified `owner/name` repository names. Without this the name resolves to `/name`, which lets repository creation succeed while every file write fails permanently — so it is blocked up front instead.

## Repository created but empty

Usually GitHub's `auto_init` commit not having settled. `REPO_SETTLE_DELAY_MS` and the transient-error retry cover this. If it persists, check that `GITHUB_TOKEN` has write access and that the resolved owner is correct.

## Code verification keeps failing

The sandbox has no third-party packages. Code importing `pandas`, `numpy`, `matplotlib` and similar is skipped rather than reported as broken. Verification only runs when the goal explicitly asks to run, test or verify — otherwise code is written without execution.

Also check that the model emitted a properly fenced block with a language tag. Block extraction requires exact triple-backtick plus language plus newline; without it, verification never runs.

## Model provider errors

At most three providers are tried per call. If all fail the run errors with the last message. Free tiers are rate-limited — `GROQ_API_KEY` in particular hits token-per-minute ceilings on long conversations. Adding a provider to the chain is the practical fix.

## Tool logs stopped appearing

Logs are batched and sent once per run as `{ "batch": [ ... ] }`. A handler written for a single flat object needs to loop over `batch`.

## Diagnosing a failed run

The Workflow step history in the Cloudflare dashboard is the fastest route to a cause. Each iteration is a named step, so you can see exactly where execution stopped and what the last successful step returned. `wrangler tail` gives live logs; `GET /stats` gives cumulative tool counts, useful as a before-and-after delta to confirm whether a specific tool actually ran.
