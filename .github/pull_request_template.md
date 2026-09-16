## What this changes

## Why

If this fixes a bug, describe what was actually broken.

## How it was verified

Real output is better than a description of it.

## Subrequest impact

- [ ] Adds no external `fetch` calls
- [ ] Adds calls, and they are routed through the existing accounting

Worst-case additional subrequests per run:

## Checklist

- [ ] `npm run check` passes
- [ ] New configuration is documented in `.dev.vars.example` and `docs/CONFIGURATION.md`
- [ ] No secrets, tokens, real chat IDs or personal repository names committed
- [ ] `DEPLOYER_MAX_FILES` and `MAX_FILES_PER_DEPLOY` still match, if touched
- [ ] Failure paths surface errors rather than returning a plausible result
