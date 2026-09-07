import { execFileSync } from "node:child_process";
import { fstatSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createMemoryGovernance, type MemoryAuthority, type MemoryProposal } from "./node";

const roots: string[] = [];
const author: MemoryAuthority = { actorId: "planner", role: "hermes", sessionId: "s1", runId: "r1", evidenceId: "e1" };
const reviewer: MemoryAuthority = { ...author, actorId: "human", role: "reviewer" };
async function project() {
  const root = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "memory-governance-")));
  roots.push(root);
  execFileSync("git", ["init", "--quiet", root]);
  await fs.mkdir(join(root, ".devflow", "memory"), { recursive: true });
  await fs.writeFile(join(root, ".devflow", "decisions.md"), "Original\r\n");
  const service = () => createMemoryGovernance(root, (operation) => operation === "propose" ? author : reviewer);
  const proposal = async (id = "p1", body = "Approved\n"): Promise<MemoryProposal> => ({
    id, document: "decisions.md", body, reason: "Consolidate verified findings",
    baseRevision: (await service().read("decisions.md")).revision,
    source: { sessionId: "s1", runId: "r1", evidenceId: "e1" },
  });
  return { root, service, proposal, file: join(root, ".devflow", "decisions.md"),
    history: join(root, ".devflow", ".memory-governance", "decisions.json") };
}
const decision = (id = "d1", action: "approve" | "reject" = "approve") => ({ id, action, reason: "Reviewed evidence" });
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))); });

it("persists approval and identical history across reopen without changing other memory", async () => {
  const p = await project();
  await fs.writeFile(join(p.root, ".gitignore"), "custom\n");
  await fs.writeFile(join(p.root, ".devflow", "architecture.md"), "Existing architecture\r\n");
  await p.service().propose(await p.proposal());
  const approved = await p.service().decide("decisions.md", "p1", decision());
  const history = await fs.readFile(p.history);
  expect(await fs.readFile(p.file, "utf8")).toBe("Approved\n");
  expect(await p.service().list("decisions.md")).toEqual([approved]);
  expect(await fs.readFile(p.history)).toEqual(history);
  expect((await p.service().list("decisions.md"))[0].decision?.authority.actorId).toBe("human");
  expect(await fs.readFile(join(p.root, ".gitignore"), "utf8")).toBe("custom\n");
  expect(await fs.readFile(join(p.root, ".devflow", "architecture.md"), "utf8")).toBe("Existing architecture\r\n");
});

it("rejects without changing exact bytes and records the rejection", async () => {
  const p = await project();
  const before = await fs.readFile(p.file);
  await p.service().propose(await p.proposal());
  await p.service().decide("decisions.md", "p1", decision("no", "reject"));
  expect(await fs.readFile(p.file)).toEqual(before);
  expect((await p.service().list("decisions.md"))[0].decision?.action).toBe("reject");
});

it("allows one independent racing approval and rejects stale bases including restored-content ABA", async () => {
  const p = await project();
  const old = await p.proposal("old");
  await p.service().propose(await p.proposal("a", "A"));
  await p.service().propose(await p.proposal("b", "B"));
  const results = await Promise.allSettled(["a", "b"].map(id => p.service().decide("decisions.md", id, decision(id))));
  expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
  const loser = results[0].status === "fulfilled" ? "b" : "a";
  await expect(p.service().decide("decisions.md", loser, decision(loser))).rejects.toThrow(/stale/i);
  await p.service().propose(await p.proposal("restore", "Original\r\n"));
  await p.service().decide("decisions.md", "restore", decision("restore"));
  await expect(p.service().propose(old)).rejects.toThrow(/stale/i);
  expect((await p.service().read("decisions.md")).revision).not.toBe(old.baseRevision);
  expect(await p.service().list("decisions.md")).toHaveLength(3);
});

it("rejects untrusted actor, spoofed payload, source mismatch, unknown paths, and oversized bodies", async () => {
  const p = await project();
  const proposal = await p.proposal();
  await expect(createMemoryGovernance(p.root, () => reviewer).propose(proposal)).rejects.toThrow();
  for (const change of [{ actor: "hermes" }, { document: "../secret" }, { body: "x".repeat(16385) },
    { source: { ...proposal.source, runId: "other" } }]) {
    await expect(p.service().propose({ ...proposal, ...change })).rejects.toThrow();
  }
  await p.service().propose(proposal);
  await expect(createMemoryGovernance(p.root, () => author).decide("decisions.md", "p1", decision())).rejects.toThrow();
  await expect(p.service().decide("decisions.md", "p1", { ...decision(), actor: "human" })).rejects.toThrow();
  await expect(p.service().read("../secret" as never)).rejects.toThrow();
  expect(await fs.readFile(p.file, "utf8")).toBe("Original\r\n");
});

it("fails closed on actual file changes and malformed persisted approval authority", async () => {
  const p = await project();
  await p.service().propose(await p.proposal());
  const saved = await fs.readFile(p.history, "utf8");
  await fs.writeFile(p.file, "External edit");
  await expect(p.service().decide("decisions.md", "p1", decision())).rejects.toThrow();
  expect(await fs.readFile(p.file, "utf8")).toBe("External edit");
  await fs.writeFile(p.file, "Original\r\n");
  for (const malformed of ["{", saved.replace('"decision":null', '"decision":{"action":"approve"}'),
    saved.replace('"role":"hermes"', '"role":"reviewer"'), saved.replace('"version":1', '"version":1,"actor":"human"'),
    saved.replace('"pending":null', '"pending":"p1"'), saved.replace('"version":1', '"version":0,"version":1'),
    JSON.stringify({ ...JSON.parse(saved), entries: Array(33).fill(JSON.parse(saved).entries[0]) })]) {
    await fs.writeFile(p.history, malformed);
    await expect(p.service().list("decisions.md")).rejects.toThrow();
    expect(await fs.readFile(p.file, "utf8")).toBe("Original\r\n");
  }
});

it.each(["before", "after", "mismatch"])("recovers interrupted apply at %s only with exact recorded bytes", async stage => {
  const p = await project();
  await p.service().propose(await p.proposal());
  await fs.mkdir(`${p.file}.memory-next`);
  await expect(p.service().decide("decisions.md", "p1", decision())).rejects.toThrow();
  await fs.rmdir(`${p.file}.memory-next`);
  if (stage !== "before") await fs.writeFile(p.file, stage === "after" ? "Approved\n" : "External edit");
  if (stage === "mismatch") {
    await expect(p.service().list("decisions.md")).rejects.toThrow();
    expect(await fs.readFile(p.file, "utf8")).toBe("External edit");
  } else {
    expect((await p.service().list("decisions.md"))[0].decision?.action).toBe("approve");
    expect(await fs.readFile(p.file, "utf8")).toBe("Approved\n");
    expect(JSON.parse(await fs.readFile(p.history, "utf8")).pending).toBeNull();
  }
});

it.each(["", "decisions.md", "memory", ".memory-governance", ".memory-governance/decisions.json"])("rejects symlink %s", async (relative, context) => {
  const p = await project();
  await p.proposal();
  const target = join(p.root, "outside");
  const path = join(p.root, ".devflow", relative);
  const directory = !relative.endsWith(".md") && !relative.endsWith(".json");
  if (directory) await fs.mkdir(target); else await fs.writeFile(target, "Outside bytes");
  await fs.rm(path, { recursive: true });
  try { await fs.symlink(target, path, directory ? "junction" : "file"); }
  catch (error) {
    if (process.platform === "win32" && (error as NodeJS.ErrnoException).code === "EPERM") { context.skip(); return; }
    throw error;
  }
  await expect(p.service().read(relative === "memory" ? "memory/summaries.md" : "decisions.md")).rejects.toThrow();
  if (!directory) expect(await fs.readFile(target, "utf8")).toBe("Outside bytes");
});

it("never deletes an abandoned lock or a colliding staging file", async () => {
  const p = await project();
  await p.service().propose(await p.proposal());
  const lock = join(p.root, ".devflow", ".memory-governance", "lock");
  await fs.mkdir(lock);
  await expect(p.service().list("decisions.md")).rejects.toThrow();
  expect((await fs.lstat(lock)).isDirectory()).toBe(true);
  await fs.rmdir(lock); // Test operator has established that no process owns this fixture lock.
  await fs.writeFile(`${p.history}.memory-next`, "Unrelated bytes");
  await expect(p.service().decide("decisions.md", "p1", decision())).rejects.toThrow();
  expect(await fs.readFile(`${p.history}.memory-next`, "utf8")).toBe("Unrelated bytes");
  expect(await fs.readFile(p.file, "utf8")).toBe("Original\r\n");
});

it.each(["directory", "hardlink", "oversized"])("rejects unexpected document type or size: %s", async kind => {
  const p = await project();
  await fs.unlink(p.file);
  if (kind === "directory") await fs.mkdir(p.file);
  if (kind === "oversized") await fs.writeFile(p.file, "x".repeat(16385));
  if (kind === "hardlink") {
    const outside = join(p.root, "outside");
    await fs.writeFile(outside, "External bytes");
    await fs.link(outside, p.file);
  }
  await expect(p.service().read("decisions.md")).rejects.toThrow();
});

it("re-syncs recovered approval history before changing the document", async () => {
  const p = await project();
  await p.service().propose(await p.proposal());
  await fs.mkdir(`${p.file}.memory-next`);
  await expect(p.service().decide("decisions.md", "p1", decision())).rejects.toThrow();
  await fs.rmdir(`${p.file}.memory-next`);
  const historyInode = (await fs.stat(p.history)).ino;
  const handle = await fs.open(p.history, "r"), prototype = Object.getPrototypeOf(handle), original = prototype.sync;
  await handle.close();
  const fault = vi.spyOn(prototype, "sync").mockImplementation(function (this: { fd: number }) {
    if (fstatSync(this.fd).ino === historyInode) throw new Error("History sync failed");
    return original.call(this);
  });
  try { await expect(p.service().list("decisions.md")).rejects.toThrow("History sync failed"); }
  finally { fault.mockRestore(); }
  expect(await fs.readFile(p.file, "utf8")).toBe("Original\r\n");
  await p.service().list("decisions.md");
  expect(await fs.readFile(p.file, "utf8")).toBe("Approved\n");
});

it("does not recover malformed reviewer authority or revision lineage as approval", async () => {
  const p = await project();
  await p.service().propose(await p.proposal());
  await fs.mkdir(`${p.file}.memory-next`);
  await expect(p.service().decide("decisions.md", "p1", decision())).rejects.toThrow();
  await fs.rmdir(`${p.file}.memory-next`);
  const intent = await fs.readFile(p.history, "utf8");
  for (const malformed of [intent.replace('"role":"reviewer"', '"role":"hermes"'),
    intent.replace('"generation":1', '"generation":2'), intent.replace(/:0:/, ":1:")]) {
    await fs.writeFile(p.history, malformed);
    await expect(p.service().list("decisions.md")).rejects.toThrow();
    expect(await fs.readFile(p.file, "utf8")).toBe("Original\r\n");
  }
});
