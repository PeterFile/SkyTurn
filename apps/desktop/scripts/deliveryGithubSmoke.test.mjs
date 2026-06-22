import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  SMOKE_PR_TITLE,
  buildSmokeBranchName,
  buildSmokePrBody,
  cleanupGithubSmoke,
  pollExactHeadGithubStatus,
  runGithubSmoke,
} from "./deliveryGithubSmoke.mjs";

test("real GitHub smoke is skipped by default before gh or git commands run", async () => {
  const commands = [];

  const result = await runGithubSmoke({
    env: {},
    cwd: "/tmp/skyturn-smoke",
    run: async (command, args) => {
      commands.push([command, args]);
      throw new Error("default smoke must not execute commands");
    },
    write: () => {},
  });

  assert.equal(result.status, "skipped");
  assert.match(result.reason, /SKYTURN_REAL_GITHUB_SMOKE=1/);
  assert.deepEqual(commands, []);
});

test("GitHub smoke plan uses disposable branch and required PR text", () => {
  const branch = buildSmokeBranchName({
    now: new Date("2026-06-22T07:08:09.000Z"),
    randomHex: () => "deadbeef",
  });
  const body = buildSmokePrBody({
    branch,
    headSha: "0123456789abcdef0123456789abcdef01234567",
    repo: "acme/skyturn",
    smokeFile: ".devflow/smoke/20260622T070809Z-deadbeef.md",
  });

  assert.equal(branch, "skyturn/smoke/20260622T070809Z-deadbeef");
  assert.equal(SMOKE_PR_TITLE, "test(delivery): verify disposable GitHub smoke");
  assert.match(body, /\*\*What changed\?\*\*/);
  assert.match(body, /\.devflow\/smoke\/20260622T070809Z-deadbeef\.md/);
  assert.match(body, /\*\*Why\?\*\*/);
  assert.match(body, /verify the real delivery remote chain/);
  assert.match(body, /\*\*Breaking changes\?\*\*\nNone\./);
  assert.match(body, /\*\*Server PR\*\*\nNone\./);
});

test("polling verifies checks and status for the exact head SHA", async () => {
  const headSha = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
  const calls = [];

  const result = await pollExactHeadGithubStatus({
    repo: "acme/skyturn",
    headSha,
    attempts: 1,
    intervalMs: 0,
    sleep: async () => {},
    run: async (command, args) => {
      calls.push([command, args]);
      const path = args.at(-1);
      if (path === `repos/acme/skyturn/commits/${headSha}/check-runs`) {
        return {
          stdout: JSON.stringify({
            total_count: 1,
            check_runs: [{ name: "ci", head_sha: headSha, status: "completed", conclusion: "success" }],
          }),
          stderr: "",
        };
      }
      if (path === `repos/acme/skyturn/commits/${headSha}/status`) {
        return {
          stdout: JSON.stringify({ sha: headSha, statuses: [] }),
          stderr: "",
        };
      }
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    },
  });

  assert.equal(result.headSha, headSha);
  assert.equal(result.apiVerified, true);
  assert.equal(result.checkRuns, 1);
  assert.equal(result.statuses, 0);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(([command, args]) => command === "gh" && args.includes("api")));
  assert.ok(calls.every(([, args]) => args.at(-1).includes(headSha)));
});

test("cleanup disabled does not close PRs or delete remote branches", async () => {
  const commands = [];

  const result = await cleanupGithubSmoke({
    cleanupEnabled: false,
    repo: "acme/skyturn",
    prNumber: 42,
    branch: "skyturn/smoke/20260622T070809Z-deadbeef",
    pushTarget: "origin",
    cwd: "/tmp/skyturn-smoke",
    run: async (command, args) => {
      commands.push([command, args]);
      throw new Error("cleanup is opt-in");
    },
  });

  assert.equal(result.status, "manual-cleanup-required");
  assert.equal(result.prClosed, false);
  assert.equal(result.branchDeleted, false);
  assert.deepEqual(commands, []);
});

test("cleanup deletes the remote branch only after the PR is closed", async () => {
  const commands = [];

  const result = await cleanupGithubSmoke({
    cleanupEnabled: true,
    repo: "acme/skyturn",
    prNumber: 42,
    branch: "skyturn/smoke/20260622T070809Z-deadbeef",
    pushTarget: "origin",
    cwd: "/tmp/skyturn-smoke",
    run: async (command, args) => {
      commands.push([command, args]);
      if (command === "gh" && args[0] === "pr" && args[1] === "close") return { stdout: "", stderr: "" };
      if (command === "gh" && args[0] === "pr" && args[1] === "view") return { stdout: "CLOSED\n", stderr: "" };
      if (command === "git" && args[0] === "push") return { stdout: "", stderr: "" };
      throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
    },
  });

  assert.equal(result.status, "cleaned");
  assert.equal(result.prClosed, true);
  assert.equal(result.branchDeleted, true);
  assert.deepEqual(commands, [
    ["gh", ["pr", "close", "42", "--repo", "acme/skyturn", "--comment", "Closing disposable SkyTurn smoke PR."]],
    ["gh", ["pr", "view", "42", "--repo", "acme/skyturn", "--json", "state", "--jq", ".state"]],
    ["git", ["push", "origin", ":refs/heads/skyturn/smoke/20260622T070809Z-deadbeef"]],
  ]);
});

test("polling failure after PR creation reports manual cleanup when cleanup is disabled", async () => {
  const { commands, lines, branch, headSha, prUrl } = await assertSmokePrFailure({
    cleanupEnabled: false,
  });

  assert.ok(lines.includes("STATUS: failed"));
  assert.ok(lines.includes(`PR: ${prUrl}`));
  assert.ok(lines.includes(`Branch: ${branch}`));
  assert.ok(lines.includes(`Head SHA: ${headSha}`));
  assert.ok(lines.some((line) => line === `Manual cleanup required: close PR #42 and delete remote branch ${branch}.`));
  assert.ok(!commands.some(([command, args]) => command === "gh" && args[0] === "pr" && args[1] === "close"));
  assert.ok(!commands.some(([command, args]) => command === "git" && args[0] === "push" && args[1] === "origin" && args[2] === `:refs/heads/${branch}`));
  assert.ok(commands.some(([command, args]) => command === "git" && args[0] === "worktree" && args[1] === "remove"));
});

test("polling failure after PR creation runs automatic cleanup when cleanup is enabled", async () => {
  const { commands, branch } = await assertSmokePrFailure({
    cleanupEnabled: true,
  });

  assert.ok(commands.some(([command, args]) => command === "gh" && args[0] === "pr" && args[1] === "close" && args[2] === "42"));
  assert.ok(commands.some(([command, args]) => command === "gh" && args[0] === "pr" && args[1] === "view" && args[2] === "42"));
  assert.ok(commands.some(([command, args]) => command === "git" && args[0] === "push" && args[1] === "origin" && args[2] === `:refs/heads/${branch}`));
  assert.ok(commands.some(([command, args]) => command === "git" && args[0] === "worktree" && args[1] === "remove"));
});

test("PR creation failure after push reports branch cleanup when cleanup is disabled", async () => {
  const { commands, error, lines, branch, headSha } = await assertSmokeCreateFailure({
    cleanupEnabled: false,
  });

  assert.ok(lines.includes("STATUS: failed"));
  assert.ok(lines.includes("PR: not-created"));
  assert.ok(lines.includes(`Branch: ${branch}`));
  assert.ok(lines.includes(`Head SHA: ${headSha}`));
  assert.ok(lines.some((line) => line.includes(`Manual cleanup required: delete remote branch ${branch} from origin for acme/skyturn.`)));
  assert.match(error.message, /Manual cleanup required: delete remote branch/);
  assert.match(error.message, /acme\/skyturn/);
  assert.match(error.message, /origin/);
  assert.equal(error.githubSmoke.cleanup.status, "manual-cleanup-required");
  assert.match(error.githubSmoke.cleanup.message, /acme\/skyturn/);
  assert.match(error.githubSmoke.cleanup.message, /origin/);
  assert.ok(!commands.some(([command, args]) => command === "git" && args[0] === "push" && args[1] === "origin" && args[2] === `:refs/heads/${branch}`));
  assert.ok(commands.some(([command, args]) => command === "git" && args[0] === "worktree" && args[1] === "remove"));
});

test("PR creation failure after push deletes remote branch when cleanup is enabled", async () => {
  const { commands, error, branch } = await assertSmokeCreateFailure({
    cleanupEnabled: true,
  });

  assert.equal(error.githubSmoke.cleanup.status, "cleaned");
  assert.equal(error.githubSmoke.cleanup.branchDeleted, true);
  assert.ok(commands.some(([command, args]) => command === "git" && args[0] === "push" && args[1] === "origin" && args[2] === `:refs/heads/${branch}`));
  assert.ok(commands.some(([command, args]) => command === "git" && args[0] === "worktree" && args[1] === "remove"));
});

async function assertSmokePrFailure({ cleanupEnabled }) {
  const tempRoot = await mkdtemp(join(tmpdir(), "skyturn-github-smoke-test-"));
  const repoRoot = join(tempRoot, "skyturn");
  const branch = "skyturn/smoke/20260622T070809Z-deadbeef";
  const headSha = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
  const prUrl = "https://github.com/acme/skyturn/pull/42";
  const commands = [];
  const lines = [];

  try {
    await assert.rejects(
      runGithubSmoke({
        env: {
          SKYTURN_REAL_GITHUB_SMOKE: "1",
          SKYTURN_GITHUB_SMOKE_REPO: "acme/skyturn",
          SKYTURN_GITHUB_SMOKE_REMOTE: "origin",
          SKYTURN_GITHUB_SMOKE_BASE_BRANCH: "main",
          SKYTURN_GITHUB_SMOKE_CLEANUP: cleanupEnabled ? "1" : "0",
          SKYTURN_GITHUB_SMOKE_POLL_ATTEMPTS: "1",
          SKYTURN_GITHUB_SMOKE_POLL_INTERVAL_MS: "1",
        },
        cwd: repoRoot,
        now: new Date("2026-06-22T07:08:09.000Z"),
        randomHex: () => "deadbeef",
        write: (line) => lines.push(line),
        run: async (command, args) => {
          commands.push([command, args]);
          if (command === "gh" && args[0] === "--version") return { stdout: "gh version 2.0.0\n", stderr: "" };
          if (command === "gh" && args[0] === "auth" && args[1] === "status") return { stdout: "", stderr: "" };
          if (command === "git" && args[0] === "rev-parse" && args[1] === "--show-toplevel") return { stdout: `${repoRoot}\n`, stderr: "" };
          if (command === "git" && args[0] === "fetch") return { stdout: "", stderr: "" };
          if (command === "git" && args[0] === "worktree" && args[1] === "add") return { stdout: "", stderr: "" };
          if (command === "git" && args[0] === "add") return { stdout: "", stderr: "" };
          if (command === "git" && args[0] === "commit") return { stdout: "", stderr: "" };
          if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") return { stdout: `${headSha}\n`, stderr: "" };
          if (command === "git" && args[0] === "push" && args[2] === `HEAD:refs/heads/${branch}`) return { stdout: "", stderr: "" };
          if (command === "gh" && args[0] === "pr" && args[1] === "create") return { stdout: `${prUrl}\n`, stderr: "" };
          if (command === "gh" && args[0] === "api") throw new Error("polling API failed");
          if (command === "gh" && args[0] === "pr" && args[1] === "close") return { stdout: "", stderr: "" };
          if (command === "gh" && args[0] === "pr" && args[1] === "view") return { stdout: "CLOSED\n", stderr: "" };
          if (command === "git" && args[0] === "push" && args[2] === `:refs/heads/${branch}`) return { stdout: "", stderr: "" };
          if (command === "git" && args[0] === "worktree" && args[1] === "remove") return { stdout: "", stderr: "" };
          throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
        },
      }),
      /polling API failed/,
    );
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }

  return { commands, lines, branch, headSha, prUrl };
}

async function assertSmokeCreateFailure({ cleanupEnabled }) {
  const tempRoot = await mkdtemp(join(tmpdir(), "skyturn-github-smoke-test-"));
  const repoRoot = join(tempRoot, "skyturn");
  const branch = "skyturn/smoke/20260622T070809Z-deadbeef";
  const headSha = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";
  const commands = [];
  const lines = [];
  let error;

  try {
    await runGithubSmoke({
      env: {
        SKYTURN_REAL_GITHUB_SMOKE: "1",
        SKYTURN_GITHUB_SMOKE_REPO: "acme/skyturn",
        SKYTURN_GITHUB_SMOKE_REMOTE: "origin",
        SKYTURN_GITHUB_SMOKE_BASE_BRANCH: "main",
        SKYTURN_GITHUB_SMOKE_CLEANUP: cleanupEnabled ? "1" : "0",
      },
      cwd: repoRoot,
      now: new Date("2026-06-22T07:08:09.000Z"),
      randomHex: () => "deadbeef",
      write: (line) => lines.push(line),
      run: async (command, args) => {
        commands.push([command, args]);
        if (command === "gh" && args[0] === "--version") return { stdout: "gh version 2.0.0\n", stderr: "" };
        if (command === "gh" && args[0] === "auth" && args[1] === "status") return { stdout: "", stderr: "" };
        if (command === "git" && args[0] === "rev-parse" && args[1] === "--show-toplevel") return { stdout: `${repoRoot}\n`, stderr: "" };
        if (command === "git" && args[0] === "fetch") return { stdout: "", stderr: "" };
        if (command === "git" && args[0] === "worktree" && args[1] === "add") return { stdout: "", stderr: "" };
        if (command === "git" && args[0] === "add") return { stdout: "", stderr: "" };
        if (command === "git" && args[0] === "commit") return { stdout: "", stderr: "" };
        if (command === "git" && args[0] === "rev-parse" && args[1] === "HEAD") return { stdout: `${headSha}\n`, stderr: "" };
        if (command === "git" && args[0] === "push" && args[2] === `HEAD:refs/heads/${branch}`) return { stdout: "", stderr: "" };
        if (command === "gh" && args[0] === "pr" && args[1] === "create") throw new Error("gh pr create failed");
        if (command === "git" && args[0] === "push" && args[2] === `:refs/heads/${branch}`) return { stdout: "", stderr: "" };
        if (command === "git" && args[0] === "worktree" && args[1] === "remove") return { stdout: "", stderr: "" };
        throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
      },
    });
  } catch (caught) {
    error = caught;
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }

  assert.match(error.message, /gh pr create failed/);
  return { commands, error, lines, branch, headSha };
}
