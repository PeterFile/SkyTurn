import { createHash } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { spawnPosixManagedProcess } from "./posixManagedProcess.js";
import { buildFdAnchoredCliLaunchPlan } from "./fdAnchoredCliLaunch.js";
import { hermesPmSandboxRules, resolveHermesPmState, revalidateHermesPmState, type HermesPmState } from "./hermesPmState.js";

const roots: string[] = [];
const darwinIt = process.platform === "darwin" ? it : it.skip;
const posixIt = process.platform === "win32" ? it.skip : it;

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("Hermes PM startup state", () => {
  it("derives PM state from the installed exec launcher rather than caller write paths", async () => {
    const fixture = await makeInstallation();
    expect(await discover(fixture)).toBeDefined();
  });

  it.each([
    ["malformed JSON", "{"],
    ["null metadata", "null"],
    ["wrong schema", '{"schema":2,"packages":{}}'],
    ["duplicate keys", '{"schema":1,"schema":1,"packages":{}}'],
    ["escaped duplicate keys", '{"schema":1,"packages":{},"pack\\u0061ges":{}}'],
    ["missing environment", '{"schema":1,"packages":{"venv":{}}}'],
    ["oversized metadata", " ".repeat(65_537)],
    ["invalid UTF-8", Buffer.from([0xff, 0xfe])],
  ])("rejects %s before granting writes", async (_name, source) => {
    const fixture = await makeInstallation();
    await writeFile(fixture.facts, source);
    await expect(discover(fixture)).rejects.toThrow();
  });

  it.each(["../escape/venv", "environments/not-a-generation/venv", "environments/" + "1".repeat(32) + "/code"])(
    "rejects a noncanonical environment %s", async (environment) => {
      const fixture = await makeInstallation();
      await writeFile(fixture.facts, JSON.stringify({ schema: 1, packages: { venv: { environment: join(fixture.state, environment) } } }));
      await expect(discover(fixture)).rejects.toThrow();
    },
  );

  it.each(["lock", "facts", "leases", "generation"] as const)("rejects a symlink at %s", async (field) => {
    const fixture = await makeInstallation();
    const path = fixture[field];
    const moved = join(fixture.root, `moved-${field}`);
    await rename(path, moved);
    await symlink(moved, path);
    await expect(discover(fixture)).rejects.toThrow();
  });

  it.each(["lock", "facts"] as const)("rejects a hard-linked %s", async (field) => {
    const fixture = await makeInstallation();
    await link(fixture[field], join(fixture.root, "alias"));
    await expect(discover(fixture)).rejects.toThrow();
  });

  it("rejects foreign-owned installation state without changing ownership", async () => {
    const fixture = await makeInstallation();
    vi.spyOn(process, "getuid").mockReturnValue(process.getuid!() + 1);
    await expect(discover(fixture)).rejects.toThrow();
  });

  it("rejects project overlap even when the install key and launcher agree", async () => {
    const fixture = await makeInstallation();
    await expect(discover({ ...fixture, project: fixture.install })).rejects.toThrow();
  });

  it("rejects an environment-selected home outside the launcher's own installation", async () => {
    const fixture = await makeInstallation();
    await expect(discover({ ...fixture, home: fixture.project })).rejects.toThrow();
  });

  it.each(["HERMES_RUNTIME_DIR", "HERMES_DATA_DIR_SUFFIX"])("never extends PM grants using %s", async (key) => {
    const fixture = await makeInstallation();
    await expect(resolveHermesPmState({
      executablePath: fixture.wrapper, projectRoot: fixture.project,
      hermesStateRoot: fixture.home, env: { [key]: fixture.project },
    })).rejects.toThrow();
  });

  it.each(["config.yaml", "a".repeat(64)])("rejects unexpected lease metadata %s", async (name) => {
    const fixture = await makeInstallation();
    await writeFile(join(fixture.leases, name), "", { mode: 0o600 });
    await expect(discover(fixture)).rejects.toThrow();
  });

  it("rejects symlinked UUID leases", async () => {
    const fixture = await makeInstallation();
    await symlink(fixture.facts, join(fixture.leases, "a".repeat(32)));
    await expect(discover(fixture)).rejects.toThrow();
  });

  it("fails closed above the retained empty-lease count bound", async () => {
    const fixture = await makeInstallation();
    for (let start = 0; start < 1024; start += 32) {
      await Promise.all(Array.from({ length: 32 }, (_, offset) => writeFile(
        join(fixture.leases, (start + offset).toString(16).padStart(32, "0")), "", { mode: 0o600 },
      )));
    }
    await expect(discover(fixture)).rejects.toThrow();
  });

  it("rejects missing install locks instead of repairing the installation", async () => {
    const fixture = await makeInstallation();
    await rm(fixture.lock);
    await expect(discover(fixture)).rejects.toThrow();
  });

  it("keeps unknown/legacy executables unchanged without PM state", async () => {
    const fixture = await makeInstallation();
    await writeFile(fixture.wrapper, '#!/bin/sh\nexit 0\n');
    expect(await discover(fixture)).toBeUndefined();
    await writeFile(fixture.wrapper, `#!/bin/sh\n'''exec' "$(dirname -- "$(realpath -- "$0")")"/'python' "$0" "$@"\n' '''\n`);
    expect(await discover(fixture)).toBeUndefined();
  });

  it("preserves legacy exec wrappers whose target is a symlink without PM grants", async () => {
    const fixture = await makeInstallation();
    const legacy = join(fixture.root, "legacy");
    const alias = join(fixture.root, "legacy-link");
    await writeFile(legacy, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    await symlink(legacy, alias);
    await writeFile(fixture.wrapper, `#!/bin/sh\nexec ${shellQuote(alias)} "$@"\n`);
    expect(await discover(fixture)).toBeUndefined();
  });

  it("never evaluates wrapper command substitutions", async () => {
    const fixture = await makeInstallation();
    const marker = join(fixture.root, "evaluated");
    await writeFile(fixture.wrapper, `#!/bin/sh\nexec $(touch ${shellQuote(marker)}) "$@"\n`);
    expect(await discover(fixture)).toBeUndefined();
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("preserves oversized unknown exec scripts without interpreting them or granting PM state", async () => {
    const fixture = await makeInstallation();
    await writeFile(fixture.wrapper, '#!/bin/sh\nexec /unknown "$@"\n#' + "x".repeat(65_537));
    expect(await discover(fixture)).toBeUndefined();
  });

  it("accepts the installed launcher directly and its own named profile", async () => {
    const fixture = await makeInstallation();
    const profile = join(fixture.home, "profiles/reviewer");
    await mkdir(profile, { recursive: true });
    expect(await resolveHermesPmState({
      executablePath: fixture.launcher, projectRoot: fixture.project,
      hermesStateRoot: profile, env: { HERMES_HOME: profile },
    })).toBeDefined();
  });

  it("rejects a launcher's mismatched source-root binding", async () => {
    const fixture = await makeInstallation();
    const source = await readFile(fixture.launcher, "utf8");
    await writeFile(fixture.launcher, source.replaceAll(fixture.install, fixture.project));
    await expect(discover(fixture)).rejects.toThrow();
  });

  it("checks venv configuration presence without reading its contents", async () => {
    const fixture = await makeInstallation();
    await writeFile(join(fixture.generation, "venv/pyvenv.cfg"), Buffer.from([0xff]));
    const state = (await discover(fixture))!;
    expect(state).toBeDefined();
    await expect(revalidateHermesPmState(state)).resolves.toBeUndefined();
  });

  it("generates only non-destructive lock and lease rules using SBPL-supported repetition", async () => {
    const fixture = await makeInstallation("home.+()[]");
    const state = (await discover(fixture))!;
    const rules = hermesPmSandboxRules(state);
    expect(rules).toContain(`(allow file-write-data (literal ${JSON.stringify(fixture.lock)}))`);
    expect(rules).toContain(`(allow file-write-create file-write-data (regex #"`);
    expect(rules).toContain(`(allow file-write-create (literal ${JSON.stringify(fixture.leases)}))`);
    expect(rules).toContain("[0-9a-f]".repeat(32) + '$"');
    expect(rules).not.toMatch(/file-write\*|file-write-unlink|file-link|\{32\}/);
    expect(rules).not.toContain("subpath");
    const match = /\(regex #"([^"]*)"\)/.exec(rules)!;
    // Pattern-shape checks do not establish native filesystem case behavior.
    const pattern = new RegExp(match[1]);
    expect(pattern.test(join(fixture.leases, "a".repeat(32)))).toBe(true);
    for (const path of [fixture.leases, fixture.lock, fixture.facts, join(fixture.leases, "a".repeat(32), "child"), join(fixture.leases, "a".repeat(32) + ".json"), join(fixture.leases, "A".repeat(32))]) {
      expect(pattern.test(path)).toBe(false);
    }
    await expect(revalidateHermesPmState(state)).resolves.toBeUndefined();
    await rm(join(fixture.generation, ".lease-managed"));
    const legacyGeneration = (await discover(fixture))!;
    expect(hermesPmSandboxRules(legacyGeneration)).toBe(`(allow file-write-data (literal ${JSON.stringify(fixture.lock)}))`);
  });

  it("rejects forged state tokens", () => {
    expect(() => hermesPmSandboxRules({} as HermesPmState)).toThrow();
  });

  it("adds validated PM rules to the existing Darwin read-only Hermes policy", async () => {
    const fixture = await makeInstallation();
    const state = (await discover(fixture))!;
    const plan = buildFdAnchoredCliLaunchPlan({
      agentKind: "hermes", platform: "darwin", sandbox: "read-only", args: ["acp"],
      env: {}, executablePath: fixture.wrapper, hermesStateRoot: fixture.home,
      worktreeFd: 3, hermesPmState: state,
    });
    expect(plan.wrapper?.args[1]).toContain(hermesPmSandboxRules(state));
    expect(plan.wrapper?.args[1]).toContain("(deny process-fork)");
    expect(plan.wrapper?.args[1]).toContain("(deny file-write*)");
    expect(plan.wrapper?.args[1]).toContain(`(literal ${JSON.stringify(join(fixture.home, "state.db"))})`);
  });

  it.each(["wrapper", "launcher", "python", "lock", "facts", "generation", "leases"] as const)(
    "rejects replacement of %s between discovery and launch", async (field) => {
      const fixture = await makeInstallation();
      const state = (await discover(fixture))!;
      await rename(fixture[field], fixture[field] + ".moved");
      if (field === "generation" || field === "leases") await mkdir(fixture[field]);
      else await writeFile(fixture[field], "replacement", { mode: 0o600 });
      await expect(revalidateHermesPmState(state)).rejects.toThrow();
    },
  );

  it("rejects a newly inserted symlink at an initially absent lease directory", async () => {
    const fixture = await makeInstallation();
    await rm(fixture.leases, { recursive: true });
    const state = (await discover(fixture))!;
    await symlink(fixture.project, fixture.leases);
    await expect(revalidateHermesPmState(state)).rejects.toThrow();
  });

  it("does not grant new lease writes if a legacy generation gains a marker before launch", async () => {
    const fixture = await makeInstallation();
    const marker = join(fixture.generation, ".lease-managed");
    await rm(marker);
    const state = (await discover(fixture))!;
    await writeFile(marker, "");
    await expect(revalidateHermesPmState(state)).rejects.toThrow();
  });

  it.each([
    ["codex", "darwin", "read-only"],
    ["codex", "linux", "read-only"],
    ["hermes", "darwin", "danger-full-access"],
    ["hermes", "linux", "read-only"],
    ["codex", "win32", "danger-full-access"],
  ] as const)("does not add PM rules to %s %s %s", async (agentKind, platform, sandbox) => {
    const fixture = await makeInstallation();
    const state = (await discover(fixture))!;
    const input = { agentKind, platform, sandbox, args: [], env: {}, executablePath: fixture.wrapper, worktreeFd: 3 };
    const original = buildFdAnchoredCliLaunchPlan(input);
    expect(buildFdAnchoredCliLaunchPlan({ ...input, hermesPmState: state })).toEqual(original);
  });

  posixIt("holds fixture inodes with real fcntl locks until the observer closes", async () => {
    const fixture = await makeInstallation();
    const holder = await holdFixtureLocks([fixture.lock, fixture.liveLease]);
    try {
      await holder.verify();
    } finally {
      await holder.close();
    }
  }, 15_000);

  for (const existing of [true, false]) {
    darwinIt(`preserves held PM inodes and confines new leases (lease directory exists: ${existing})`, async (context) => {
      const fixture = await makeInstallation();
      if (!existing) await rm(fixture.leases, { recursive: true });
      const worktree = await open(fixture.project, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY);
      let holder: Awaited<ReturnType<typeof holdFixtureLocks>> | undefined;
      let managed: Awaited<ReturnType<typeof spawnPosixManagedProcess>> | undefined;
      let output = "";
      let stderr = "";
      try {
        holder = await holdFixtureLocks(existing ? [fixture.lock, fixture.liveLease] : [fixture.lock]);
        managed = await spawnPosixManagedProcess({
          agentKind: "hermes",
          args: ["acp"],
          cleanupTimeoutMs: 200,
          env: { HERMES_HOME: fixture.home, TMPDIR: process.env.TMPDIR },
          executablePath: fixture.wrapper,
          platform: "darwin",
          preserveWorktreeFd: true,
          projectRoot: fixture.project,
          sandbox: "read-only",
          targetStdin: "null",
          worktreeFd: worktree.fd,
        });
        managed.child.stdout?.on("data", (chunk: Buffer) => { output += chunk.toString(); });
        managed.child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
        await withFixtureDeadline(managed.ready);
        const closed = await withFixtureDeadline(managed.closed);
        if (closed.exitCode === 71 && stderr.trim() === "sandbox-exec: sandbox_apply: Operation not permitted") {
          context.skip("The outer sandbox forbids sandbox_apply; run this native acceptance on the host.");
        }
        await holder.verify();
        expect({ closed, output }, stderr).toEqual({
          closed: { exitCode: 0, signalCode: null },
          output: `directory,lock-open,lock-retained,lease-open,lease-retained,${existing ? "stale-retained,live-retained" : "no-stale,no-live"},denials,aliases,fork`,
        });
        expect((await stat(fixture.newLease)).size).toBe(0);
        if (existing) {
          expect((await stat(fixture.staleLease)).size).toBe(0);
          expect((await stat(fixture.liveLease)).size).toBe(0);
        }
        expect((await lstat(join(fixture.leases, "c".repeat(32)))).isSymbolicLink()).toBe(true);
        expect((await lstat(join(fixture.leases, "f".repeat(32)))).isDirectory()).toBe(true);
        expect((await stat(fixture.protectedSibling)).nlink).toBe(1);
        expect(await readFile(fixture.protectedSibling, "utf8")).toBe("protected-sibling");
        expect(await readFile(fixture.facts, "utf8")).toBe(fixture.factsSource);
        // The create grant can make future aliases/directories. They cannot write
        // protected targets, and discovery must reject them on the next launch.
        await expect(discover(fixture)).rejects.toThrow();
      } finally {
        const cleanup = await Promise.allSettled([
          managed?.terminateAndReap(), holder?.close(),
        ]);
        await worktree.close();
        for (const result of cleanup) {
          if (result.status === "rejected") throw result.reason;
        }
      }
    }, 15_000);
  }
});

function discover(fixture: Awaited<ReturnType<typeof makeInstallation>>) {
  return resolveHermesPmState({
    executablePath: fixture.wrapper,
    projectRoot: fixture.project,
    hermesStateRoot: fixture.home,
    env: { HERMES_HOME: fixture.home },
  });
}

async function makeInstallation(homeName = "home") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "skyturn-hermes-pm-")));
  roots.push(root);
  const project = join(root, "project");
  const home = join(root, homeName);
  const install = join(home, "hermes-agent");
  const launcher = join(install, ".hermes/bin/hermes");
  const python = join(home, "tools/python-test/bin/python3");
  const key = createHash("sha256").update(install).digest("hex").slice(0, 16);
  const state = join(home, "installs", key);
  const generation = join(state, "environments", "1".repeat(32));
  const leases = join(generation, ".leases");
  const liveLease = join(leases, "b".repeat(32));
  const staleLease = join(leases, "2".repeat(32));
  const newLease = join(leases, "a".repeat(32));
  const protectedSibling = join(generation, "protected-sibling");
  const facts = join(state, "facts.json");
  const lock = join(state, ".install.lock");
  const wrapper = join(root, "hermes");
  const probe = join(root, "probe.cjs");
  const factsSource = JSON.stringify({ schema: 1, packages: { venv: { environment: join(generation, "venv") } } });
  for (const directory of [project, join(install, ".hermes/bin"), join(home, "tools/python-test/bin"), leases, join(generation, "venv")]) {
    await mkdir(directory, { recursive: true });
  }
  await writeFile(lock, "", { mode: 0o600 });
  await writeFile(facts, factsSource, { mode: 0o600 });
  await writeFile(join(generation, ".lease-managed"), "");
  await writeFile(join(generation, "venv/pyvenv.cfg"), "home = ignored\n");
  await writeFile(staleLease, "", { mode: 0o600 });
  await writeFile(liveLease, "", { mode: 0o600 });
  await writeFile(protectedSibling, "protected-sibling", { mode: 0o600 });
  const code = `import os, re, sys\nos.environ.pop('PYTHONHOME', None)\nos.environ.pop('PYTHONPATH', None)\nsys.path.insert(0, '${install}')\nimport hermes_bootstrap\nfrom hermes_cli.main import main\nsys.exit(main())\n`;
  await writeFile(launcher, `#!/bin/sh\nexec ${shellQuote(python)} -I -c ${shellQuote(code)} "$@"\n`, { mode: 0o755 });
  await writeFile(wrapper, `#!/bin/sh\nexec ${shellQuote(launcher)} "$@"\n`, { mode: 0o755 });
  await writeFile(python, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(probe)} "$@"\n`, { mode: 0o755 });
  const denied = [
    facts, join(state, "publication.json"), join(state, "selected.json"), join(state, ".install.lock-other"),
    join(home, "config.yaml"), join(home, "credentials.json"), join(install, "code.py"),
    join(generation, "venv/code.py"), join(generation, ".lease-managed"),
    join(leases, "config.yaml"), join(leases, "a".repeat(32) + "-extra"), join(leases, "a".repeat(64)),
    join(leases, "a".repeat(32) + "\n"), join(leases, "a".repeat(32) + "\r"),
    join(leases, "a".repeat(33)), join(leases, "G".repeat(32)), protectedSibling,
    join(state, "environments", "3".repeat(32), ".leases", "4".repeat(32)),
    join(project, "write"), join(root, "claims", "a".repeat(64)),
  ];
  await mkdir(join(root, "claims"));
  await mkdir(join(state, "environments", "3".repeat(32), ".leases"), { recursive: true });
  await writeFile(probe, `
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const out = [];
const lock = ${JSON.stringify(lock)};
const lease = ${JSON.stringify(newLease)};
const live = ${JSON.stringify(liveLease)};
const stale = ${JSON.stringify(staleLease)};
function denied(label, operation) {
  try { operation(); } catch (e) {
    if (e.code === 'EPERM') return;
    throw new Error(label + ' failed with ' + (e.code || 'unknown error'));
  }
  throw new Error(label + ' unexpectedly allowed');
}
try {
  try { fs.mkdirSync(${JSON.stringify(leases)}); } catch (e) { if (e.code !== 'EEXIST') throw e; }
  out.push('directory');
  fs.closeSync(fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_RDWR, 0o600));
  out.push('lock-open');
  denied('lock unlink', () => fs.unlinkSync(lock));
  denied('lock delete', () => fs.rmSync(lock));
  denied('lock rename', () => fs.renameSync(lock, ${JSON.stringify(join(state, "moved-lock"))}));
  out.push('lock-retained');
  fs.closeSync(fs.openSync(lease, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR, 0o600));
  fs.closeSync(fs.openSync(lease, 'r+'));
  out.push('lease-open');
  // Exercise an existing uppercase alias only when this filesystem proves identity.
  const uppercase = ${JSON.stringify(join(leases, "A".repeat(32)))};
  if (fs.existsSync(uppercase)) {
    const lowerIdentity = fs.statSync(lease, { bigint: true });
    const upperIdentity = fs.statSync(uppercase, { bigint: true });
    if (upperIdentity.dev === lowerIdentity.dev && upperIdentity.ino === lowerIdentity.ino) {
      const fd = fs.openSync(uppercase, 'r+');
      try {
        const opened = fs.fstatSync(fd, { bigint: true });
        if (opened.dev !== lowerIdentity.dev || opened.ino !== lowerIdentity.ino) throw new Error('uppercase alias identity changed');
      } finally { fs.closeSync(fd); }
      denied('uppercase alias unlink', () => fs.unlinkSync(uppercase));
    }
  }
  denied('lease release', () => fs.unlinkSync(lease));
  denied('lease rename', () => fs.renameSync(lease, ${JSON.stringify(join(leases, "0".repeat(32)))}));
  denied('lock replacement', () => fs.renameSync(lease, lock));
  out.push('lease-retained');
  if (fs.existsSync(stale)) {
    fs.closeSync(fs.openSync(stale, 'r+'));
    denied('stale prune', () => fs.unlinkSync(stale));
    out.push('stale-retained');
  } else out.push('no-stale');
  if (fs.existsSync(live)) {
    fs.closeSync(fs.openSync(live, 'r+'));
    denied('live lease unlink', () => fs.unlinkSync(live));
    denied('live lease delete', () => fs.rmSync(live));
    denied('live lease rename', () => fs.renameSync(live, ${JSON.stringify(join(leases, "1".repeat(32)))}));
    denied('live lease replacement', () => fs.renameSync(lease, live));
    out.push('live-retained');
  } else out.push('no-live');
  for (const [index, p] of ${JSON.stringify(denied)}.entries()) {
    denied('protected write [' + index + ']', () => fs.closeSync(fs.openSync(p, 'a')));
  }
  out.push('denials');
  const protectedSibling = ${JSON.stringify(protectedSibling)};
  const alias = ${JSON.stringify(join(leases, "c".repeat(32)))};
  fs.symlinkSync(protectedSibling, alias);
  denied('symlink target write', () => fs.closeSync(fs.openSync(alias, 'a')));
  denied('hardlink', () => fs.linkSync(protectedSibling, ${JSON.stringify(join(leases, "d".repeat(32)))}));
  denied('sibling rename', () => fs.renameSync(protectedSibling, ${JSON.stringify(join(leases, "e".repeat(32)))}));
  const directory = ${JSON.stringify(join(leases, "f".repeat(32)))};
  fs.mkdirSync(directory);
  denied('UUID directory descendant', () => fs.closeSync(fs.openSync(directory + '/child', 'a')));
  out.push('aliases');
  if (spawnSync('/usr/bin/true').error?.code !== 'EPERM') throw new Error('fork unexpectedly allowed');
  out.push('fork');
  process.stdout.write(out.join(','));
} catch (error) {
  process.stderr.write(String(error));
  process.exitCode = 82;
}
`);
  return { root, project, home, install, launcher, python, wrapper, state, generation, leases, facts, factsSource, lock, liveLease, staleLease, newLease, protectedSibling };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function withFixtureDeadline<T>(operation: Promise<T>): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Confined fixture did not close within its deadline.")), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function holdFixtureLocks(paths: string[]): Promise<{
  verify(): Promise<void>;
  close(): Promise<void>;
}> {
  const child = spawn("python3", ["-I", "-B", "-c", `
import fcntl, json, os, select, sys
fds = []
try:
    for path in sys.argv[1:]:
        fd = os.open(path, os.O_RDWR)
        fds.append(fd)
        fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
    print(json.dumps([[str(os.fstat(fd).st_dev), str(os.fstat(fd).st_ino)] for fd in fds]), flush=True)
    if not select.select([sys.stdin], [], [], 15)[0]:
        raise SystemExit(83)
    if sys.stdin.readline() != "close\\n":
        raise SystemExit(84)
finally:
    for fd in fds:
        os.close(fd)
`, ...paths], { env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(0, 4096); });
  child.on("error", () => undefined);
  child.stdin?.on("error", () => undefined);
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    if (closing) return closing;
    closing = (async () => {
      const timeout = setTimeout(() => child.kill("SIGKILL"), 3_000);
      try {
        try { child.stdin?.end("close\n"); } catch { /* Still await actual close. */ }
        expect(await closed, stderr).toEqual({ code: 0, signal: null });
      } finally {
        clearTimeout(timeout);
      }
    })();
    return closing;
  };
  let handedOff = false;
  try {
    const identities = await readHolderIdentities(child, closed);
    expect(identities).toHaveLength(paths.length);
    handedOff = true;
    return {
      close,
      async verify() {
        for (let index = 0; index < paths.length; index++) {
          const metadata = await stat(paths[index], { bigint: true });
          expect([metadata.dev.toString(), metadata.ino.toString()]).toEqual(identities[index]);
        }
        // A distinct, bounded process must still be unable to lock these paths.
        // spawnSync owns its child through termination/reap before returning.
        const probe = spawnSync("python3", ["-I", "-B", "-c", `
import fcntl, os, sys
for path in sys.argv[1:]:
    fd = os.open(path, os.O_RDWR)
    try:
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            pass
        else:
            raise SystemExit(82)
    finally:
        os.close(fd)
print("held", end="")
`, ...paths], { env: process.env, encoding: "utf8", timeout: 5_000, killSignal: "SIGKILL" });
        expect(probe.error).toBeUndefined();
        expect(probe.status, probe.stderr).toBe(0);
        expect(probe.stdout).toBe("held");
      },
    };
  } finally {
    if (!handedOff) await close();
  }
}

function readHolderIdentities(child: ChildProcess, closed: Promise<unknown>): Promise<string[][]> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    let settled = false;
    const timeout = setTimeout(() => finish(new Error("Fixture lock holder readiness timed out.")), 5_000);
    const finish = (error?: Error, identities?: string[][]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdout?.off("data", onData);
      if (error) reject(error);
      else resolve(identities!);
    };
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      if (buffer.length > 4096) return finish(new Error("Fixture lock holder output exceeded its bound."));
      if (!buffer.endsWith("\n")) return;
      try { finish(undefined, JSON.parse(buffer)); }
      catch { finish(new Error("Fixture lock holder returned invalid identities.")); }
    };
    child.stdout?.on("data", onData);
    void closed.then(() => finish(new Error("Fixture lock holder closed before readiness.")));
  });
}
