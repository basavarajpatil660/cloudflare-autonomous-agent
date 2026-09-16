# Security Policy

## Reporting a vulnerability

Please do not open a public issue for security problems.

Report privately through [GitHub Security Advisories](https://github.com/basavarajpatil660/cloudflare-autonomous-agent/security/advisories/new), or by email to the address on the maintainer's GitHub profile. Include a description, reproduction steps, and the impact as you understand it. You can expect an initial response within seven days.

## Before you deploy

This agent holds a GitHub token and can create, modify and delete repositories. Treat a deployment as production infrastructure.

**Both entry points fail closed.** Neither defaults to open:

- Telegram messages are rejected unless the sender's chat ID is in `TELEGRAM_ALLOWED_CHAT_IDS`.
- The HTTP API returns `401` until `AGENT_API_SECRET` is set, and every route requires the `X-Agent-Secret` header.

This matters because a Telegram bot username is discoverable and a `workers.dev` URL is guessable. Without these gates, a stranger could issue goals that run against your GitHub token — and the confirmation button for destructive actions would be delivered to *their* chat, not yours.

**Recommended practice:**

- Use a fine-grained GitHub token scoped to the specific repositories the agent should access. Add `delete_repo` only if you want the agent to be able to delete repositories.
- Populate `BLOCKED_REPOS` in `agent-router/src/worker.js` with anything you cannot afford to lose. It is enforced regardless of instruction.
- Set `TELEGRAM_WEBHOOK_SECRET` and pass the same value as `secret_token` to Telegram's `setWebhook`, so the worker can reject deliveries that did not come from Telegram.
- Keep `DEPLOY_SHARED_SECRET` identical on both workers and generated randomly, for example `openssl rand -hex 32`.
- Never commit `.dev.vars`. Use `wrangler secret put` in production.

## Existing safeguards

- Destructive GitHub tools require the target to be named in the current message — never in replayed memory — plus an explicit deletion word, plus a Telegram confirmation button.
- `deploy_project` authenticates to `agent-deployer` with a shared secret compared in constant time.
- File paths are restricted to a safe character set in both workers, rejecting traversal and malformed paths before any API call.
- `agent-deployer` holds no model access, no memory and no Telegram integration. It writes exactly the bytes it is given.

## Scope

In scope: authentication bypass, secret disclosure, prompt injection leading to unauthorised tool execution, path traversal, and subrequest exhaustion causing silent failure.

Out of scope: vulnerabilities in third-party model providers or APIs, and issues that require an already-compromised Cloudflare account or GitHub token.
