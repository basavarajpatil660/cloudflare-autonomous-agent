# Architecture

This document describes how a run actually executes, and why the structure is the way it is.

## Two workers

| | `agent-router` | `agent-deployer` |
|---|---|---|
| Role | The agent | Batched GitHub push |
| Model access | Yes | None |
| Memory | Workers KV | None |
| Telegram | Yes | None |
| Triggered by | Telegram, HTTP API | `agent-router` only |

`agent-deployer` exists for two reasons. It gets its own subrequest budget, and it is small enough to audit completely — which matters because it is the component holding write access to your repositories. It receives exact paths and exact bytes and writes them. It cannot be instructed to do anything else.

## Request flow

```
Telegram message
      │
      ▼
POST /telegram/webhook
      │  webhook secret check (if configured)
      │  chat ID allowlist check
      ▼
AGENT_WORKFLOW.create()          durable, not bound by the ~30s fetch limit
      │
      ▼
needsToolPipeline(goal)?
      │
      ├── no ──▶ simple path: one model call, no tools, no memory, no critique
      │
      └── yes ─▶ classifyGoal() ──▶ "coding" or "general"
                        │
                        ▼
                 load memory (skipped for casual or idle-gap messages)
                        │
                        ▼
                 agent loop (up to MAX_TOOL_ITERATIONS)
                        │
                        ▼
                 verification passes
                        │
                        ▼
                 deliver to Telegram
```

The lightweight path matters more than it looks. Routing "what is 15% of 340?" through the full pipeline wasted a classifier call, a memory load and a critique pass — and injecting old memory into unrelated short messages was the direct cause of a repository being deleted because it appeared in replayed context rather than the actual request.

## The agent loop

Each iteration is one `step.do()`, so Cloudflare memoizes it. A step that already completed is not re-executed on replay.

```
┌─────────────────────────────────────────────┐
│ call model with tool definitions            │
│   └─ up to 3 providers, then give up        │
├─────────────────────────────────────────────┤
│ tool calls returned?                        │
│   yes ─▶ execute each through the guardrails│
│          append results, next iteration     │
│   no  ─▶ this is the final answer           │
├─────────────────────────────────────────────┤
│ checkBudget()                               │
│   subrequests / tool calls / wall clock     │
└─────────────────────────────────────────────┘
```

Before a final answer is accepted it is tested against the goal:

- **Intent-only** — the model announced a plan but wrote nothing. Nudged, then failed if it persists.
- **Structurally incomplete** — the goal implies N files, fewer were written.
- **Archive missing** — a zip was requested and never built.
- **Deploy missing** — a repo push was requested and no push succeeded.
- **Screenshot missing** — a design goal finished without visual verification. A nudge only, not a failure.

Any of these sends the loop back around with a specific instruction rather than accepting the answer.

### State and Workflow replay

Cloudflare re-invokes the Workflow's `run()` function on each step advancement, and only `step.do()`-wrapped code is memoized. Anything mutated as a side effect outside a step is lost on replay.

Everything durable is therefore threaded through step **return values**: the provider index, tool call counts, files written, and the subrequest spend. This was a real bug — per-iteration state was once mutated as a side effect, and progress silently vanished mid-run.

## Verification passes

After the loop, and only where relevant to the goal:

1. **Code verification** — runnable code blocks are executed in Judge0. A block is a pass only when the status is `Accepted`; a compile error is a failure. If it still fails after the retry budget, the run errors rather than presenting broken code as working.
2. **Design cliché scan** — written CSS and HTML are checked for patterns the design prompt forbids. This inspects the files on disk, not the model's description of them, because a model will confidently describe work that does not match what it wrote. The card check extracts a class name from each `border-radius` + `box-shadow` rule and counts how many HTML elements actually use it — counting CSS occurrences finds nothing, since a correct stylesheet defines a shared class exactly once.
3. **Row count** — if the goal named a row or record count, the written file is counted against it. A shortfall triggers bounded revisions and then a hard failure. This is gated on the goal actually requesting a file, so conversational mentions of a number do not trigger it.
4. **Self-critique** — a reviewer model compares the answer to the goal. Skipped when a deploy already succeeded, to avoid redeploying a shipped repository.

## Subrequest accounting

The free plan allows **50 external subrequests per Workflow instance** — per instance, not per step. Internal services (KV, D1, R2) have a separate 1,000 budget and do not compete for the 50.

Every external `fetch` increments a counter. Because the counter must survive replay, each step resets a delta at its start and returns the delta in its outcome; the accumulated total lives in `runState` alongside the other durable values.

`checkBudget()` stops the run while a reserve is still intact. Without that reserve, exhaustion surfaced at the next `fetch` after the budget ran out — which was usually the final Telegram notification, producing a run that completed all its work and then went completely silent.

Rough cost per run:

| Operation | External subrequests |
|---|---|
| Model call | 1 (up to 3 with provider fallback) |
| `write_file` | 1–2 |
| `deploy_project` | 1, regardless of file count |
| `github_write` | 2–3 |
| Telegram message | 1 |
| Tool-call logging | 1 total, batched |
| Final delivery | 1–5 |

## Deploy path

```
agent-router                          agent-deployer
     │                                      │
     │ files already in the in-run cache    │
     │ (no read-back needed)                │
     │                                      │
     ├── POST /deploy ────────────────────▶ │ ensureRepoExists()
     │   X-Deploy-Secret                    │ per-file write, budgeted
     │                                      │ README write
     │ ◀──────────── filesWritten,  ────────┤
     │               filesSkipped           │
```

The deployer counts its own subrequests and stops deliberately while it can still respond, returning `filesSkipped` for anything not written — whether it failed or was never attempted. `agent-router` surfaces that list so the remaining files can be pushed in a second call instead of the deploy being reported as complete.

Cost differs by repository state: a freshly created repo needs one subrequest per file, since no file can already exist. An existing repo needs two, because each write first reads the current SHA. A retry always re-reads the SHA, so it costs two more. This is why the budget is counted rather than derived from a fixed file cap — a static cap is simultaneously too strict for fresh repos and too loose for retry-heavy updates.

## Memory

Stored in Workers KV, scoped per chat.

- `history:<chatId>` — recent goals and results, capped in both count and character length
- `custom:<chatId>:<key>` — values stored by the `set_memory` tool
- `fileindex:<chatId>` — files written via `write_file`
- `stats:tool-calls` — cumulative tool counts served by `/stats`

Two rules keep old context from leaking into new work. After `MEMORY_SESSION_GAP_MINUTES` of inactivity, the next goal is treated as a new session and no history is injected. Short casual messages skip memory entirely. Both exist because replayed context was once mistaken for the current request.

Writes are batched into a single flush at the end of a run rather than issued per call.
