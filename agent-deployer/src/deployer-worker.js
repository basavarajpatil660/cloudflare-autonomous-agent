// deployer-worker.js — v1.5
// A small, single-purpose Cloudflare Worker that exists ONLY to push a
// finished multi-file project (+ optional README) to a GitHub repo in one
// batched request, using its own separate Cloudflare Free-plan subrequest
// budget (50/invocation, same limit as the main agent-router worker).
//
// v1.5 changes (robustness pass):
//   1. A timed-out or failed GitHub call no longer crashes the request.
//      budgetedFetch aborts after GITHUB_TIMEOUT_MS by THROWING, and
//      nothing caught it: the Worker died with a bare 500 and the caller
//      lost the list of files that HAD landed. Every GitHub call site now
//      returns a normal { ok: false, error }, so the failed file goes into
//      filesSkipped like any other failure, and a last-resort catch in
//      fetch() always answers with JSON.
//   2. Repo names are validated as a strict "owner/name" before any call.
//      A model-supplied name with a space or an extra slash used to reach
//      GitHub, which normalises names on create, so the repo got created
//      under a slightly different name than the one the writes targeted
//      (and every write then 404'd).
//   3. New repos are always created under the token's own account. If the
//      caller named a different owner (a hallucinated "username/..." is
//      the usual cause) the old code created a stray repo under the real
//      account and then 404'd every write to the wrong one. The create
//      response's full_name is now checked; on a mismatch the deploy stops
//      and names the repo to retry with.
//   4. Request validation: a null body, a null entry in "files", a
//      non-string README body or a non-string commit message used to throw
//      a TypeError (bare 500). They are now clean 400s.
//   5. isUnsafePath also rejects "//" inside a path.
//
// v1.4 changes (subrequest-limit audit, done across BOTH workers):
//   1. REAL subrequest accounting instead of a static file cap. Verified
//      against developers.cloudflare.com/workers/platform/limits: the
//      Free plan allows 50 EXTERNAL subrequests per invocation. v1.2
//      tried to respect that with a fixed MAX_FILES_PER_DEPLOY=20 derived
//      from worst-case math, which is wrong in BOTH directions:
//        - too strict on a fresh repo (1 subrequest/file, so ~45 files
//          would actually fit) — legitimate deploys were rejected;
//        - too loose on an existing repo, because the math assumed ZERO
//          retries. Each retry adds 2 more subrequests (the retry always
//          re-checks the SHA), so 4 transient 403s on a 20-file update
//          deploy = 43 + 8 = 51, over the cap, and the run dies partway
//          through the loop with no report of what did land.
//      This worker now counts every fetch it makes and stops the write
//      loop while it still has budget to RESPOND, reporting exactly which
//      files were written and which were skipped.
//   2. Partial deploys are now reported, not silently lost. The response
//      gains `filesSkipped` (additive, backward compatible). agent-router
//      surfaces it and tells the model to re-call deploy_project with
//      only the remaining paths.
//   3. CPU fix: utf8ToBase64 built its binary string one character at a
//      time. The Free plan allows 10ms CPU per invocation, and
//      MAX_FILE_SIZE is 300,000 chars — a single large file meant
//      hundreds of thousands of string allocations and could exhaust the
//      CPU limit before the subrequest limit was anywhere near reached.
//      Now chunked via String.fromCharCode.apply.
//   4. Added an explicit timeout to every GitHub call. A hung connection
//      previously held the whole deploy open indefinitely.
//
// v1.3 changes: structural detection of the README sha-race (422 sent
//   without a sha) instead of parsing GitHub's error wording.
//
// v1.2 changes:
//   1. writeOneFile skips the GET-for-SHA check on a freshly created repo
//      (every file is guaranteed new), halving that loop's cost.
//   2. Short stagger between successive writes to reduce how often
//      GitHub's secondary rate limiting engages at all.
//   3. Constant-time shared-secret comparison.
//
// v1.1 changes: settle delay after repo creation, plus a bounded retry on
//   transient 403/404/409 failures.
//
// WHY THIS EXISTS:
// Cloudflare caps a Workflow INSTANCE (not each step — the whole run
// shares one pool) at 50 external subrequests on the Free plan. The main
// agent-router worker spends most of that on LLM provider calls, so the
// "create repo + push N files + write README" step gets its own fresh
// 50-subrequest budget here, called from agent-router as ONE subrequest.
//
// WHAT THIS WORKER DOES NOT DO:
// No LLM reasoning, no Telegram, no memory, no scratch storage. It takes
// exact paths and exact contents and writes them. Nothing more.
//
// REQUIRED SECRETS (via `wrangler secret put <NAME>` on THIS worker):
//   GITHUB_TOKEN          — same token as agent-router
//   DEPLOY_SHARED_SECRET  — random string, identical on both workers
//                           (sent by agent-router as X-Deploy-Secret)
// OPTIONAL VARIABLES (plain `vars` in wrangler.jsonc, not secrets):
//   GITHUB_DEFAULT_OWNER  — used when a repo arrives without "owner/"
//   SUBREQUEST_LIMIT      — override the assumed 50 (set to 10000 if you
//                           ever move this worker to a Paid plan)

var CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-Deploy-Secret"
};

// Hard ceiling on batch size. Kept in sync with DEPLOYER_MAX_FILES in
// agent-router's worker.js so the caller can reject an oversized batch
// locally instead of spending subrequests reading files back for a
// request this worker would refuse anyway.
var MAX_FILES_PER_DEPLOY = 20;
var MAX_FILE_SIZE = 3e5;

// Cloudflare Free plan: 50 external subrequests per invocation.
var SUBREQUEST_LIMIT = 50;
// Held back so this worker can always finish its bookkeeping and return a
// useful JSON body describing what happened, instead of being killed
// mid-loop with the caller getting nothing.
var SUBREQUEST_RESERVE = 4;

var REPO_SETTLE_DELAY_MS = 1200;
var WRITE_RETRY_DELAY_MS = 1200;
var WRITE_STAGGER_DELAY_MS = 150;
var GITHUB_TIMEOUT_MS = 2e4;

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", ...CORS_HEADERS } });
}

// v1.4 CPU fix — see changelog item 3. Chunked conversion instead of
// per-byte string concatenation.
function bytesToBinaryString(bytes) {
  const CHUNK = 8192;
  let binary = "";
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return binary;
}

function utf8ToBase64(str) {
  return btoa(bytesToBinaryString(new TextEncoder().encode(str)));
}

function fillOwner(repo, env) {
  if (repo && !String(repo).includes("/")) return `${env.GITHUB_DEFAULT_OWNER || ""}/${repo}`;
  return repo;
}

function ghHeaders(env) {
  return { "User-Agent": "AgentDeployer", Accept: "application/vnd.github+json", Authorization: `Bearer ${env.GITHUB_TOKEN}` };
}

// v1.4: single accounting point for every external call this worker makes.
// `budget.spent` is what makes the write loop able to stop deliberately
// rather than be killed by the runtime mid-file.
function createBudget(env) {
  const limit = Number(env.SUBREQUEST_LIMIT) > 0 ? Number(env.SUBREQUEST_LIMIT) : SUBREQUEST_LIMIT;
  return { limit, spent: 0, reserve: SUBREQUEST_RESERVE };
}
function budgetRemaining(budget) {
  return budget.limit - budget.reserve - budget.spent;
}
async function budgetedFetch(budget, url, init) {
  budget.spent += 1;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GITHUB_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init || {}, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// Path-traversal + filename-charset guard, same rule as agent-router's
// checkToolPolicy. A path like "[README.md](https://readme.md/)" (markdown
// link syntax carried through from the goal text into a real filename)
// used to pass, get spliced raw into the GitHub Contents API URL, and
// produce a confusing GitHub-side 422 instead of a fast local rejection.
function isUnsafePath(path) {
  if (typeof path !== "string" || !path.trim()) return true;
  if (/(^|\/)\.\.(\/|$)/.test(path)) return true;
  if (path.startsWith("/") || path.endsWith("/")) return true;
  if (path.includes("//")) return true;
  if (!/^[a-zA-Z0-9._\-\/]+$/.test(path)) return true;
  return false;
}

// v1.5: strict "owner/name". Owners are letters, digits, "-" and "_"; repo
// names also allow ".". Spaces, extra slashes and query characters never
// reach a URL.
function isValidRepoName(repo) {
  if (typeof repo !== "string") return false;
  if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9._-]+$/.test(repo)) return false;
  const name = repo.split("/")[1];
  return name !== "." && name !== "..";
}

// v1.5: turns a thrown fetch error (timeout abort, network failure) into
// text safe to put in a JSON response.
function describeFetchError(e) {
  if (e && e.name === "AbortError") return `no response from GitHub within ${GITHUB_TIMEOUT_MS / 1000}s`;
  return String((e && e.message) || e);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Constant-time comparison so the check's duration doesn't leak how many
// leading characters of a guessed secret were correct.
function timingSafeEqualStr(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

async function ensureRepoExists(repo, createIfMissing, env, budget) {
  try {
    const headers = ghHeaders(env);
    const checkRes = await budgetedFetch(budget, `https://api.github.com/repos/${repo}`, { headers });
    if (checkRes.status === 404) {
      if (!createIfMissing) return { ok: false, error: `Repo "${repo}" does not exist and create_repo was not set to true.` };
      const [, repoName] = repo.split("/");
      const createRes = await budgetedFetch(budget, "https://api.github.com/user/repos", {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ name: repoName, private: true, auto_init: true })
      });
      if (!createRes.ok) {
        const errText = await createRes.text().catch(() => "");
        return { ok: false, error: `Error creating repo "${repo}": ${createRes.status} ${errText.slice(0, 200)}` };
      }
      // v1.5: POST /user/repos always creates under the token's own
      // account, whatever owner the caller named. If GitHub put it
      // somewhere else, stop now instead of 404-ing every write.
      const createdData = await createRes.json().catch(() => null);
      const actual = createdData && createdData.full_name;
      if (actual && String(actual).toLowerCase() !== repo.toLowerCase()) {
        return { ok: false, error: `Asked to create "${repo}", but new repos are always created under the account that owns GITHUB_TOKEN, so GitHub created "${actual}" instead. Nothing was written. Re-call deploy with repo "${actual}" (it exists now) to push the files there.` };
      }
      return { ok: true, created: true };
    }
    if (!checkRes.ok) return { ok: false, error: `Error checking repo "${repo}": ${checkRes.status}` };
    return { ok: true, created: false };
  } catch (e) {
    return { ok: false, error: `Could not reach GitHub while checking or creating "${repo}": ${describeFetchError(e)}` };
  }
}

// skipShaCheck: true only for the main file loop on a freshly created repo,
// where no file can already exist. Halves that loop's subrequest cost.
//
// Retries cover the transient 403/404/409 that GitHub returns when an
// auto_init commit hasn't settled or secondary rate limiting engages, and
// the 422 sha-race on the README. Every retry re-checks the SHA, so a
// retry costs 2 subrequests, not 1 — which is exactly why the budget is
// now counted rather than assumed.
// v1.5: network failures and the GITHUB_TIMEOUT_MS abort throw. Catch them
// here so one bad call becomes a normal failed-file result instead of
// killing the whole request and losing the report of what already landed.
async function writeOneFile(repo, path, content, message, env, skipShaCheck, budget, attempt = 0) {
  try {
    return await attemptWrite(repo, path, content, message, env, skipShaCheck, budget, attempt);
  } catch (e) {
    return { ok: false, error: `Error writing ${path}: ${describeFetchError(e)}` };
  }
}

async function attemptWrite(repo, path, content, message, env, skipShaCheck, budget, attempt = 0) {
  const headers = ghHeaders(env);
  let sha;
  if (!skipShaCheck) {
    const fileRes = await budgetedFetch(budget, `https://api.github.com/repos/${repo}/contents/${path}`, { headers });
    if (fileRes.ok) {
      const fileData = await fileRes.json();
      sha = fileData.sha;
    }
  }
  const putBody = { message: message || `Deploy ${path} via agent-deployer`, content: utf8ToBase64(content) };
  if (sha) putBody.sha = sha;
  const putRes = await budgetedFetch(budget, `https://api.github.com/repos/${repo}/contents/${path}`, {
    method: "PUT",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(putBody)
  });
  if (!putRes.ok) {
    const errText = await putRes.text().catch(() => "");
    // Structural detection of the README sha-race: if this was a 422 and
    // we sent no sha at all, that is the shape of a GitHub read-after-write
    // propagation delay regardless of the exact error wording. The text
    // match stays only as a secondary signal for the rarer case where a
    // sha WAS sent but GitHub still reports it missing.
    const sentWithoutSha = !sha;
    const errMentionsSha = /"sha"\s*wasn['\u2019]?t supplied/i.test(errText);
    const isShaRaceCondition = putRes.status === 422 && (sentWithoutSha || errMentionsSha);
    const isTransientStatus = [403, 404, 409].includes(putRes.status);
    const maxAttempt = isShaRaceCondition ? 2 : 1;
    // v1.4: a retry costs 2 more subrequests. Only take it if the budget
    // genuinely has room, otherwise report honestly and let the caller
    // re-drive the remaining files in a fresh invocation.
    const canAffordRetry = budgetRemaining(budget) >= 2;
    if (attempt < maxAttempt && (isTransientStatus || isShaRaceCondition) && canAffordRetry) {
      await sleep(WRITE_RETRY_DELAY_MS);
      return writeOneFile(repo, path, content, message, env, false, budget, attempt + 1);
    }
    const raceNote = isShaRaceCondition ? " (looks like a GitHub read-after-write propagation delay on a freshly created repo — retry the deploy in a few seconds)" : "";
    const budgetNote = !canAffordRetry && (isTransientStatus || isShaRaceCondition) ? " (a retry was available but skipped to stay inside this worker's Cloudflare subrequest budget — re-call deploy for the remaining files)" : "";
    return { ok: false, error: `Error writing ${path}: ${putRes.status} ${errText.slice(0, 300)}${raceNote}${budgetNote}` };
  }
  const putData = await putRes.json();
  return { ok: true, path, htmlUrl: putData.content && putData.content.html_url };
}

async function handleDeploy(request, env) {
  if (!env.GITHUB_TOKEN) return json({ error: "GITHUB_TOKEN is not configured on this worker." }, 500);
  if (!env.DEPLOY_SHARED_SECRET) return json({ error: "DEPLOY_SHARED_SECRET is not configured on this worker — refusing all requests until it is set." }, 500);
  const providedSecret = request.headers.get("X-Deploy-Secret") || "";
  if (!timingSafeEqualStr(providedSecret, env.DEPLOY_SHARED_SECRET)) {
    return json({ error: "Unauthorized — missing or incorrect X-Deploy-Secret header." }, 401);
  }
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body." }, 400);
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return json({ error: "Request body must be a JSON object." }, 400);
  let { repo, files, readme, create_repo: createRepo, message } = body;
  if (typeof message !== "string") message = void 0;
  if (!repo || typeof repo !== "string") return json({ error: '"repo" (string, "owner/name" or just "name") is required.' }, 400);
  repo = repo.trim();
  if (!Array.isArray(files) || !files.length) return json({ error: '"files" (non-empty array of {path, content}) is required.' }, 400);
  if (files.length > MAX_FILES_PER_DEPLOY) return json({ error: `Too many files (${files.length}) — max ${MAX_FILES_PER_DEPLOY} per deploy. Split the project across two deploy calls.` }, 400);
  for (const f of files) {
    if (!f || typeof f !== "object") return json({ error: 'Every entry in "files" must be an object with "path" and "content".' }, 400);
    if (isUnsafePath(f.path)) return json({ error: `Unsafe or missing path: "${f.path}"` }, 400);
    if (typeof f.content !== "string") return json({ error: `File "${f.path}" is missing string content.` }, 400);
    if (f.content.length > MAX_FILE_SIZE) return json({ error: `File "${f.path}" is too large (${f.content.length} chars, max ${MAX_FILE_SIZE}).` }, 400);
  }
  if (readme && (typeof readme !== "object" || (readme.content !== void 0 && typeof readme.content !== "string"))) return json({ error: '"readme" must be { path, content } with string content.' }, 400);
  if (readme && isUnsafePath(readme.path || "README.md")) return json({ error: "Unsafe README path." }, 400);

  repo = fillOwner(repo, env);
  // Defense-in-depth: a bare repo name plus an unset GITHUB_DEFAULT_OWNER
  // yields a malformed "/name". That still lets repo CREATION succeed (the
  // empty owner segment is ignored when extracting the name) while every
  // subsequent file write 404s permanently — confirmed live as a repo
  // containing only the auto_init README. Reject it loudly up front
  // instead of walking into a guaranteed-to-fail write loop.
  if (!repo.includes("/") || repo.startsWith("/") || repo.endsWith("/")) {
    return json({ error: `Resolved repo "${repo}" is not a valid "owner/name" — the caller sent a bare repo name and GITHUB_DEFAULT_OWNER is not configured on this worker. Set GITHUB_DEFAULT_OWNER as a variable in this worker's wrangler.jsonc, or always pass a fully-qualified "owner/repo" string.` }, 400);
  }
  if (!isValidRepoName(repo)) {
    return json({ error: `"${repo}" is not a valid "owner/name". Owners use letters, digits, "-" and "_"; repo names also allow ".". No spaces or extra slashes.` }, 400);
  }

  const budget = createBudget(env);
  const repoResult = await ensureRepoExists(repo, !!createRepo, env, budget);
  if (!repoResult.ok) return json({ success: false, error: repoResult.error, subrequestsUsed: budget.spent }, 200);

  // Let a brand-new repo's auto_init commit settle before writing to it.
  if (repoResult.created) await sleep(REPO_SETTLE_DELAY_MS);

  // A fresh repo skips the per-file SHA GET, so each file costs 1; an
  // existing repo costs 2. Reserve room for the README write (which always
  // does the SHA check, and may retry) so a long file list can't starve it.
  const perFileCost = repoResult.created ? 1 : 2;
  const readmeReserve = readme && readme.content ? 4 : 0;

  const written = [];
  const errors = [];
  const filesSkipped = [];
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    if (budgetRemaining(budget) - readmeReserve < perFileCost) {
      // Stop deliberately, with budget left to report. Everything from
      // here on is named in filesSkipped so the caller can finish the job
      // in a second call rather than guessing what landed.
      for (let j = i; j < files.length; j++) filesSkipped.push(files[j].path);
      break;
    }
    if (i > 0) await sleep(WRITE_STAGGER_DELAY_MS);
    const result = await writeOneFile(repo, f.path, f.content, message, env, repoResult.created, budget);
    if (result.ok) {
      written.push({ path: result.path, url: result.htmlUrl });
    } else {
      errors.push(result.error);
      // FIX (failed-files-unaccounted): a file that FAILED its write was
      // previously reported only as prose inside `errors`, never in a
      // machine-readable list — so it appeared in neither filesWritten nor
      // filesSkipped and the caller had no way to re-drive it short of
      // parsing an error string. From the caller's point of view the
      // required action is identical to a budget-skipped file (re-call
      // /deploy with this path), so it belongs in the same list.
      filesSkipped.push(f.path);
    }
  }

  let readmeResult = null;
  if (readme && readme.content) {
    if (budgetRemaining(budget) < 2) {
      readmeResult = { error: "README not written — this worker's Cloudflare subrequest budget was exhausted by the file writes. Re-call deploy with just the README." };
      errors.push(readmeResult.error);
    } else {
      if (written.length > 0) await sleep(WRITE_STAGGER_DELAY_MS);
      const readmePath = readme.path || "README.md";
      // README always does the SHA check even on a fresh repo: auto_init
      // has already created a README.md, so this is very likely an update.
      const result = await writeOneFile(repo, readmePath, readme.content, `Add ${readmePath} via agent-deployer`, env, false, budget);
      readmeResult = result.ok ? { path: result.path, url: result.htmlUrl } : { error: result.error };
      if (!result.ok) errors.push(result.error);
    }
  }

  if (filesSkipped.length) {
    errors.push(`${filesSkipped.length} file(s) did not make it into the repo (either the write failed, or this worker reached its Cloudflare subrequest budget of ${budget.limit} per invocation — ${budget.spent} used). Re-call /deploy with only these paths, and without create_repo: ${filesSkipped.join(", ")}`);
  }

  const repoUrl = `https://github.com/${repo}`;
  return json({
    success: errors.length === 0,
    repo,
    repoUrl,
    repoCreated: repoResult.created,
    filesWritten: written,
    // Additive field (v1.4). Older agent-router builds simply ignore it;
    // current ones surface it and re-drive the remaining paths.
    filesSkipped: filesSkipped.length ? filesSkipped : void 0,
    readme: readmeResult,
    subrequestsUsed: budget.spent,
    errors: errors.length ? errors : void 0
  }, 200);
}

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") return new Response(null, { headers: CORS_HEADERS });
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/deploy") {
      try {
        return await handleDeploy(request, env);
      } catch (e) {
        // Last resort. Expected failures are handled where they happen, so
        // reaching this means a bug. Still answer with JSON, not a bare 500.
        return json({ success: false, error: `Unexpected deployer error: ${String((e && e.message) || e)}` }, 500);
      }
    }
    if (request.method === "GET" && url.pathname === "/") {
      return json({ status: "ok", worker: "agent-deployer", version: "1.5", usage: "POST /deploy with X-Deploy-Secret header" });
    }
    return json({ error: "Not found. POST /deploy is the only endpoint." }, 404);
  }
};
