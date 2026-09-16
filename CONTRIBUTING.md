# Contributing

Thanks for your interest in the project. Issues and pull requests are welcome.

## Before you start

For anything beyond a small fix, open an issue first so the approach can be discussed. That avoids wasted work on changes that will not be merged.

## Development setup

```bash
git clone https://github.com/basavarajpatil660/cloudflare-autonomous-agent.git
cd cloudflare-autonomous-agent
npm install

cp agent-router/.dev.vars.example agent-router/.dev.vars
cp agent-deployer/.dev.vars.example agent-deployer/.dev.vars
# fill in your own credentials, then:
npm run dev:router
```

Both workers are plain JavaScript with no build step. `npm run check` runs a syntax check on both.

## Guidelines

**Watch the subrequest budget.** This is the project's tightest constraint. The free plan allows 50 external subrequests per Workflow instance, shared across every step. If your change adds a `fetch`, route it through the existing accounting so it is counted, and say in the pull request how many subrequests it adds in the worst case.

**Do not add silent success paths.** A substantial part of this codebase exists to stop the agent reporting work it did not do. If you add a step that can fail, it must surface that failure rather than returning a plausible result. Look at how `deployMissing`, the row-count check and intent-only detection are handled.

**Explain non-obvious code in comments.** Many of the guards here look arbitrary until you know the failure that caused them. If you fix a real bug, write down what broke — that context is worth more than the diff.

**Keep `agent-deployer` minimal.** It is the component with write access to repositories, and it is deliberately small enough to audit fully. It should not gain model access, memory or new dependencies.

**Keep the workers in sync.** `DEPLOYER_MAX_FILES` in `agent-router` must match `MAX_FILES_PER_DEPLOY` in `agent-deployer`. If you change the deploy response shape, keep it additive so an older router still works with a newer deployer.

## Pull requests

- One logical change per pull request.
- Describe what was broken and how you confirmed the fix. Real test output is better than a description of it.
- Note any new configuration variable and add it to `.dev.vars.example` and the README.
- Do not commit secrets, real chat IDs, tokens or personal repository names.

## Reporting bugs

Include the goal you sent, what you expected, what happened, and relevant `wrangler tail` output with secrets removed. For failed agent runs, the Workflow step history in the Cloudflare dashboard is usually the fastest route to a cause.
