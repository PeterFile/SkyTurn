import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const SMOKE_PR_TITLE = "test(delivery): verify disposable GitHub smoke";

const defaultPollAttempts = 6;
const defaultPollIntervalMs = 5_000;
const commandOutputLimit = 8 * 1024 * 1024;

export function buildSmokeBranchName(options = {}) {
  const now = options.now ?? new Date();
  const randomHex = options.randomHex ?? (() => randomBytes(4).toString("hex"));
  const timestamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const suffix = String(randomHex()).trim().toLowerCase();
  if (!/^[0-9a-f]{6,16}$/.test(suffix)) throw new Error("Smoke branch random suffix must be 6-16 hex characters.");
  return `skyturn/smoke/${timestamp}-${suffix}`;
}

export function buildSmokePrBody({ branch, headSha, repo, smokeFile }) {
  return [
    "**What changed?**",
    `Added disposable smoke marker \`${smokeFile}\` on \`${branch}\` for \`${repo}\`.`,
    "",
    "**Why?**",
    `verify the real delivery remote chain against exact head SHA \`${headSha}\`: commit, push, PR creation, and GitHub checks/status polling.`,
    "",
    "**Breaking changes?**",
    "None.",
    "",
    "**Server PR**",
    "None.",
  ].join("\n");
}

export async function runGithubSmoke(options = {}) {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const run = options.run ?? runCommand;
  const write = options.write ?? ((line) => console.log(line));

  if (env.SKYTURN_REAL_GITHUB_SMOKE !== "1") {
    const reason = "Set SKYTURN_REAL_GITHUB_SMOKE=1 to run the real disposable GitHub PR smoke.";
    write(`SKIPPED: ${reason}`);
    return { status: "skipped", reason };
  }

  const hardFailure = env.SKYTURN_GITHUB_SMOKE_REQUIRE_AUTH === "1" || env.SKYTURN_GITHUB_SMOKE_HARD_FAIL === "1";
  const preflight = await githubSmokePreflight({ cwd, run, hardFailure });
  if (preflight.status === "skipped") {
    write(`SKIPPED: ${preflight.reason}`);
    return preflight;
  }

  const repoRoot = await gitOutput(run, cwd, ["rev-parse", "--show-toplevel"]);
  const repo = await resolveGithubRepo({ env, cwd: repoRoot, run });
  const baseBranch = await resolveBaseBranch({ env, repo, cwd: repoRoot, run });
  const pushTarget = resolvePushTarget({ env, repo });
  const branch = buildSmokeBranchName({
    now: options.now ?? new Date(),
    randomHex: options.randomHex,
  });
  const smokeId = branch.split("/").at(-1);
  const smokeFile = `.devflow/smoke/${smokeId}.md`;
  const worktreePath = resolve(dirname(repoRoot), `${basename(repoRoot)}.worktrees`, `github-smoke-${smokeId}`);
  let prNumber = null;
  let prUrl = null;
  let headSha = null;
  let pushedBranch = null;
  let createdPullRequest = null;

  try {
    await mkdir(dirname(worktreePath), { recursive: true });
    await git(run, repoRoot, ["fetch", "--no-tags", pushTarget, `refs/heads/${baseBranch}`]);
    await git(run, repoRoot, ["worktree", "add", "--detach", "--", worktreePath, "FETCH_HEAD"]);
    await writeSmokeMarker({ worktreePath, smokeFile, repo, baseBranch, branch });
    await git(run, worktreePath, ["add", "--", smokeFile]);
    await git(run, worktreePath, ["commit", "-m", SMOKE_PR_TITLE], { env: smokeCommitEnv(env) });

    headSha = await gitOutput(run, worktreePath, ["rev-parse", "HEAD"]);
    await git(run, worktreePath, ["push", pushTarget, `HEAD:refs/heads/${branch}`]);
    pushedBranch = { repo, baseBranch, branch, pushTarget, headSha };

    const body = buildSmokePrBody({ branch, headSha, repo, smokeFile });
    const created = await gh(run, worktreePath, [
      "pr",
      "create",
      "--repo",
      repo,
      "--base",
      baseBranch,
      "--head",
      branch,
      "--title",
      SMOKE_PR_TITLE,
      "--body",
      body,
    ]);
    prUrl = pullRequestUrlFromOutput(created.stdout);
    prNumber = pullRequestNumberFromUrl(prUrl);
    createdPullRequest = { repo, baseBranch, branch, pushTarget, prUrl, prNumber, headSha };

    const poll = await pollExactHeadGithubStatus({
      repo,
      headSha,
      run,
      cwd: worktreePath,
      attempts: positiveInteger(env.SKYTURN_GITHUB_SMOKE_POLL_ATTEMPTS, defaultPollAttempts),
      intervalMs: positiveInteger(env.SKYTURN_GITHUB_SMOKE_POLL_INTERVAL_MS, defaultPollIntervalMs),
    });
    const cleanup = await cleanupGithubSmoke({
      cleanupEnabled: env.SKYTURN_GITHUB_SMOKE_CLEANUP === "1",
      repo,
      prNumber,
      branch,
      pushTarget,
      cwd: worktreePath,
      run,
    });

    const status = cleanup.status === "cleaned" ? "cleaned" : "created";
    const result = {
      status,
      repo,
      baseBranch,
      branch,
      prUrl,
      prNumber,
      headSha,
      poll,
      cleanup,
    };
    printSmokeResult(result, write);
    return result;
  } catch (error) {
    let failure = null;
    if (createdPullRequest) {
      failure = await handleCreatedPullRequestFailure({
        cleanupEnabled: env.SKYTURN_GITHUB_SMOKE_CLEANUP === "1",
        createdPullRequest,
        cwd: worktreePath,
        run,
        error,
      });
    } else if (pushedBranch) {
      failure = await handlePushedBranchFailure({
        cleanupEnabled: env.SKYTURN_GITHUB_SMOKE_CLEANUP === "1",
        pushedBranch,
        cwd: worktreePath,
        run,
        error,
      });
    } else {
      throw error;
    }
    printSmokeFailure(failure, write);
    attachGithubSmokeFailure(error, failure);
    throw error;
  } finally {
    await git(run, repoRoot, ["worktree", "remove", "--force", "--", worktreePath]).catch(async () => {
      await rm(worktreePath, { recursive: true, force: true });
    });
  }
}

function attachGithubSmokeFailure(error, failure) {
  if (!error || typeof error !== "object") return;
  error.githubSmoke = failure;
  const cleanupMessage = failure.cleanup?.message;
  if (error instanceof Error && cleanupMessage && !error.message.includes(cleanupMessage)) {
    error.message = `${error.message}. ${cleanupMessage}`;
  }
}

async function handlePushedBranchFailure({ cleanupEnabled, pushedBranch, cwd, run, error }) {
  const { repo, branch, pushTarget } = pushedBranch;
  let cleanup;
  try {
    cleanup = await cleanupGithubSmokeBranch({
      cleanupEnabled,
      repo,
      branch,
      pushTarget,
      cwd,
      run,
    });
  } catch (cleanupError) {
    cleanup = {
      status: "cleanup-failed",
      prClosed: false,
      branchDeleted: false,
      message: `Automatic cleanup failed: ${errorMessage(cleanupError)}. Manual cleanup required: delete remote branch ${branch} from ${pushTarget} for ${repo}.`,
    };
  }

  return {
    status: "failed",
    ...pushedBranch,
    prUrl: "not-created",
    prNumber: null,
    cleanup,
    error: errorMessage(error),
  };
}

async function handleCreatedPullRequestFailure({ cleanupEnabled, createdPullRequest, cwd, run, error }) {
  const { repo, branch, pushTarget, prNumber } = createdPullRequest;
  let cleanup;
  try {
    cleanup = await cleanupGithubSmoke({
      cleanupEnabled,
      repo,
      prNumber,
      branch,
      pushTarget,
      cwd,
      run,
    });
  } catch (cleanupError) {
    cleanup = {
      status: "cleanup-failed",
      prClosed: false,
      branchDeleted: false,
      message: `Automatic cleanup failed: ${errorMessage(cleanupError)}. Manual cleanup required: close PR #${prNumber} and delete remote branch ${branch}.`,
    };
  }

  return {
    status: "failed",
    ...createdPullRequest,
    cleanup,
    error: errorMessage(error),
  };
}

async function cleanupGithubSmokeBranch({ cleanupEnabled, repo, branch, pushTarget, cwd, run }) {
  if (!cleanupEnabled) {
    return {
      status: "manual-cleanup-required",
      prClosed: false,
      branchDeleted: false,
      message: `Manual cleanup required: delete remote branch ${branch} from ${pushTarget} for ${repo}.`,
    };
  }

  assertRepoName(repo);
  assertSmokeBranch(branch);
  await git(run, cwd, ["push", pushTarget, `:refs/heads/${branch}`]);
  return {
    status: "cleaned",
    prClosed: false,
    branchDeleted: true,
  };
}

export async function pollExactHeadGithubStatus({
  repo,
  headSha,
  run,
  cwd = process.cwd(),
  attempts = defaultPollAttempts,
  intervalMs = defaultPollIntervalMs,
  sleep = delay,
}) {
  assertRepoName(repo);
  assertCommitSha(headSha);
  const maxAttempts = positiveInteger(attempts, defaultPollAttempts);
  const waitMs = positiveInteger(intervalMs, defaultPollIntervalMs);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const checkRuns = await ghJson(run, cwd, ["api", `repos/${repo}/commits/${headSha}/check-runs`]);
    const status = await ghJson(run, cwd, ["api", `repos/${repo}/commits/${headSha}/status`]);
    const checkCount = Number(checkRuns.total_count ?? checkRuns.check_runs?.length ?? 0);
    const statusCount = Array.isArray(status.statuses) ? status.statuses.length : 0;

    assertExactCheckRunHead(checkRuns, headSha);
    if (status.sha !== headSha) {
      throw new Error(`GitHub status API returned ${status.sha || "no SHA"} instead of exact head ${headSha}.`);
    }

    if (checkCount > 0 || statusCount > 0 || attempt === maxAttempts) {
      return {
        apiVerified: true,
        observedChecksOrStatuses: checkCount > 0 || statusCount > 0,
        headSha,
        attempts: attempt,
        checkRuns: checkCount,
        statuses: statusCount,
      };
    }

    await sleep(waitMs);
  }

  throw new Error("unreachable GitHub smoke polling state");
}

export async function cleanupGithubSmoke({ cleanupEnabled, repo, prNumber, branch, pushTarget, cwd, run }) {
  if (!cleanupEnabled) {
    return {
      status: "manual-cleanup-required",
      prClosed: false,
      branchDeleted: false,
      message: `Manual cleanup required: close PR #${prNumber} and delete remote branch ${branch}.`,
    };
  }

  assertRepoName(repo);
  assertPositivePrNumber(prNumber);
  assertSmokeBranch(branch);
  await gh(run, cwd, ["pr", "close", String(prNumber), "--repo", repo, "--comment", "Closing disposable SkyTurn smoke PR."]);
  const state = (await gh(run, cwd, ["pr", "view", String(prNumber), "--repo", repo, "--json", "state", "--jq", ".state"])).stdout.trim();
  if (state !== "CLOSED") {
    return {
      status: "pr-close-unverified",
      prClosed: false,
      branchDeleted: false,
      message: `PR #${prNumber} state is ${state || "unknown"}; remote branch ${branch} was not deleted.`,
    };
  }

  await git(run, cwd, ["push", pushTarget, `:refs/heads/${branch}`]);
  return {
    status: "cleaned",
    prClosed: true,
    branchDeleted: true,
  };
}

async function githubSmokePreflight({ cwd, run, hardFailure }) {
  const ghVersion = await tryRun(run, "gh", ["--version"], { cwd });
  if (!ghVersion.ok) return skipOrThrow("GitHub CLI is unavailable; install gh or provide it on PATH.", hardFailure);
  const ghAuth = await tryRun(run, "gh", ["auth", "status"], { cwd });
  if (!ghAuth.ok) return skipOrThrow("GitHub CLI is not authenticated; run gh auth login for a disposable smoke account.", hardFailure);
  return { status: "ready" };
}

function skipOrThrow(reason, hardFailure) {
  if (hardFailure) throw new Error(reason);
  return { status: "skipped", reason };
}

async function resolveGithubRepo({ env, cwd, run }) {
  const repo = env.SKYTURN_GITHUB_SMOKE_REPO?.trim();
  if (repo) {
    assertRepoName(repo);
    return repo;
  }
  const inferred = await ghOutput(run, cwd, ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]);
  assertRepoName(inferred);
  return inferred;
}

async function resolveBaseBranch({ env, repo, cwd, run }) {
  const configured = (env.SKYTURN_GITHUB_SMOKE_BASE_BRANCH || env.SKYTURN_GITHUB_SMOKE_BASE || "").trim();
  if (configured) {
    assertBranchName(configured);
    return configured;
  }
  const branch = await ghOutput(run, cwd, ["repo", "view", repo, "--json", "defaultBranchRef", "--jq", ".defaultBranchRef.name"]);
  assertBranchName(branch);
  return branch;
}

function resolvePushTarget({ env, repo }) {
  const remote = (env.SKYTURN_GITHUB_SMOKE_REMOTE || "").trim();
  if (remote) {
    if (!/^[A-Za-z0-9._-]+$/.test(remote)) throw new Error("SKYTURN_GITHUB_SMOKE_REMOTE must be a git remote name.");
    return remote;
  }
  if (env.SKYTURN_GITHUB_SMOKE_REPO?.trim()) return `https://github.com/${repo}.git`;
  return "origin";
}

async function writeSmokeMarker({ worktreePath, smokeFile, repo, baseBranch, branch }) {
  const smokePath = join(worktreePath, smokeFile);
  await mkdir(dirname(smokePath), { recursive: true });
  await writeFile(smokePath, [
    "# SkyTurn GitHub Smoke",
    "",
    `Repository: ${repo}`,
    `Base: ${baseBranch}`,
    `Branch: ${branch}`,
    `Created: ${new Date().toISOString()}`,
    "",
    "This disposable file verifies the real delivery remote chain.",
    "",
  ].join("\n"), "utf8");
}

function smokeCommitEnv(env) {
  return {
    ...env,
    GIT_AUTHOR_NAME: env.GIT_AUTHOR_NAME || "SkyTurn Smoke",
    GIT_AUTHOR_EMAIL: env.GIT_AUTHOR_EMAIL || "skyturn-smoke@example.invalid",
    GIT_COMMITTER_NAME: env.GIT_COMMITTER_NAME || "SkyTurn Smoke",
    GIT_COMMITTER_EMAIL: env.GIT_COMMITTER_EMAIL || "skyturn-smoke@example.invalid",
  };
}

async function ghJson(run, cwd, args) {
  const output = await ghOutput(run, cwd, args);
  try {
    return JSON.parse(output || "{}");
  } catch (error) {
    throw new Error(`GitHub API returned invalid JSON: ${sanitizeOutput(error.message)}.`);
  }
}

async function ghOutput(run, cwd, args) {
  return (await gh(run, cwd, args)).stdout.trim();
}

async function gitOutput(run, cwd, args) {
  return (await git(run, cwd, args)).stdout.trim();
}

async function gh(run, cwd, args, options = {}) {
  return capture(run, "gh", args, { cwd, ...options });
}

async function git(run, cwd, args, options = {}) {
  return capture(run, "git", args, { cwd, ...options });
}

async function capture(run, command, args, options = {}) {
  const result = await run(command, args, options);
  return {
    stdout: String(result?.stdout ?? ""),
    stderr: String(result?.stderr ?? ""),
  };
}

async function tryRun(run, command, args, options = {}) {
  try {
    await capture(run, command, args, options);
    return { ok: true };
  } catch (error) {
    return { ok: false, reason: sanitizeOutput(error.message || String(error)) };
  }
}

export async function runCommand(command, args, options = {}) {
  try {
    const result = await execFileAsync(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      encoding: "utf8",
      maxBuffer: commandOutputLimit,
      shell: false,
    });
    return {
      stdout: String(result.stdout ?? ""),
      stderr: String(result.stderr ?? ""),
    };
  } catch (error) {
    const failure = error;
    const detail = sanitizeOutput(String(failure.stderr || failure.stdout || failure.message || "").trim());
    throw new Error(`${command} ${args[0] || ""} failed: ${detail || "command failed"}.`);
  }
}

function assertExactCheckRunHead(checkRuns, headSha) {
  const runs = Array.isArray(checkRuns.check_runs) ? checkRuns.check_runs : [];
  for (const run of runs) {
    if (run.head_sha !== headSha) {
      throw new Error(`GitHub check run ${run.name || "unknown"} targets ${run.head_sha || "no SHA"} instead of exact head ${headSha}.`);
    }
  }
}

function pullRequestUrlFromOutput(output) {
  const match = output.match(/https?:\/\/[A-Za-z0-9.-]+\/[^/\s]+\/[^/\s]+\/pull\/\d+/);
  if (!match) throw new Error("GitHub CLI did not return a pull request URL.");
  return match[0];
}

function pullRequestNumberFromUrl(url) {
  const match = url.match(/\/pull\/(\d+)$/);
  const number = match ? Number(match[1]) : NaN;
  assertPositivePrNumber(number);
  return number;
}

function assertRepoName(repo) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error(`Invalid GitHub repo: ${repo}.`);
}

function assertCommitSha(sha) {
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error(`Invalid git commit SHA: ${sha}.`);
}

function assertPositivePrNumber(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`Invalid pull request number: ${value}.`);
}

function assertBranchName(branch) {
  if (!branch || /[\0\r\n]/.test(branch) || branch.startsWith("-") || branch.endsWith("/") || branch.includes("..")) {
    throw new Error(`Invalid branch name: ${branch}.`);
  }
}

function assertSmokeBranch(branch) {
  if (!/^skyturn\/smoke\/[0-9]{8}T[0-9]{6}Z-[0-9a-f]{6,16}$/.test(branch)) {
    throw new Error(`Refusing to cleanup non-smoke branch: ${branch}.`);
  }
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function sanitizeOutput(value) {
  return String(value)
    .replace(/-----BEGIN [^-]+PRIVATE KEY-----[\s\S]*?-----END [^-]+PRIVATE KEY-----/g, "[REDACTED_PRIVATE_KEY]")
    .replace(/\b(token|secret|password|api[_-]?key|authorization|cookie)\b\s*[:=]\s*\S+/gi, "$1=[REDACTED]")
    .replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@[^\s]+/g, "[REDACTED_URL]");
}

function printSmokeResult(result, write) {
  write(`STATUS: ${result.status}`);
  write(`PR: ${result.prUrl}`);
  write(`Branch: ${result.branch}`);
  write(`Head SHA: ${result.headSha}`);
  write(`Exact-head polling: checks=${result.poll.checkRuns}, statuses=${result.poll.statuses}, observed=${result.poll.observedChecksOrStatuses}`);
  if (result.cleanup.status === "manual-cleanup-required") write(result.cleanup.message);
}

function printSmokeFailure(result, write) {
  write(`STATUS: ${result.status}`);
  write(`PR: ${result.prUrl}`);
  write(`Branch: ${result.branch}`);
  write(`Head SHA: ${result.headSha}`);
  write(`Failure: ${result.error}`);
  write(`Cleanup: ${result.cleanup.status}`);
  if (result.cleanup.message) write(result.cleanup.message);
}

function errorMessage(error) {
  return sanitizeOutput(error instanceof Error ? error.message : String(error));
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runGithubSmoke().catch((error) => {
    console.error(`FAILED: ${sanitizeOutput(error.message || String(error))}`);
    process.exitCode = 1;
  });
}
