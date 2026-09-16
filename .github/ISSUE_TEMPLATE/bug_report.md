---
name: Bug report
about: Report something that does not work as described
labels: bug
---

**What happened**
A clear description of the behaviour.

**The goal you sent**
The exact message or API request. Remove anything private.

**Expected behaviour**

**Logs**
Relevant `wrangler tail` output with secrets removed. For a failed run, the Workflow step history from the Cloudflare dashboard is usually the most useful.

**Environment**
- Cloudflare plan: free / paid
- Which worker: agent-router / agent-deployer / both
- Model providers configured:

**Subrequest budget**
If the run failed with a budget error, roughly how many files or steps did the goal involve?
