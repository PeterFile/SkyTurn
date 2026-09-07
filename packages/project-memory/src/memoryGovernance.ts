import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { dirname, isAbsolute, join, parse, resolve, sep } from "node:path";

const documents = { "decisions.md": "decisions", "architecture.md": "architecture", "memory/summaries.md": "summaries" } as const;
const BODY_LIMIT = 16 * 1024;
const HISTORY_LIMIT = 4 * 1024 * 1024;
const ENTRY_LIMIT = 32;
export type MemoryDocument = keyof typeof documents;
type Source = { sessionId: string; runId: string; evidenceId: string };
export type MemoryAuthority = Source & { actorId: string; role: "hermes" | "orchestrator" | "reviewer" };
export interface MemoryProposal {
  id: string;
  document: MemoryDocument;
  baseRevision: string;
  body: string;
  reason: string;
  source: Source;
}
type Decision = { id: string; action: "approve" | "reject"; reason: string };
export type MemoryEntry = { proposal: MemoryProposal; author: MemoryAuthority;
  decision: (Decision & { authority: MemoryAuthority; generation: number | null }) | null };
type State = { version: 1; lineage: string; initial: string | null; entries: MemoryEntry[]; pending: string | null };
type Operation = "propose" | Decision["action"];

function check(condition: unknown, message = "Invalid memory data"): asserts condition {
  if (!condition) throw new Error(message);
}
function object(value: unknown, keys: string): Record<string, unknown> {
  check(value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype);
  const names = keys.split(" ");
  check(Reflect.ownKeys(value).length === names.length && names.every(key => Object.getOwnPropertyDescriptor(value, key)?.value !== undefined));
  return value as Record<string, unknown>;
}
function text(value: unknown, limit: number): string {
  check(typeof value === "string" && Buffer.byteLength(value) <= limit && Buffer.from(value).toString("utf8") === value);
  return value;
}
function identity(value: unknown): string {
  check(typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value));
  return value;
}
function documentName(value: unknown): MemoryDocument {
  check(typeof value === "string" && Object.hasOwn(documents, value), "Unsupported memory document");
  return value as MemoryDocument;
}
function source(value: unknown): Source {
  const s = object(value, "sessionId runId evidenceId");
  return { sessionId: identity(s.sessionId), runId: identity(s.runId), evidenceId: identity(s.evidenceId) };
}
function authority(value: unknown): MemoryAuthority {
  const a = object(value, "actorId role sessionId runId evidenceId");
  check(a.role === "hermes" || a.role === "orchestrator" || a.role === "reviewer");
  return { actorId: identity(a.actorId), role: a.role,
    ...source({ sessionId: a.sessionId, runId: a.runId, evidenceId: a.evidenceId }) };
}
function proposal(value: unknown): MemoryProposal {
  const p = object(value, "id document baseRevision body reason source");
  return { id: identity(p.id), document: documentName(p.document), baseRevision: text(p.baseRevision, 128),
    body: text(p.body, BODY_LIMIT), reason: text(p.reason, 1024), source: source(p.source) };
}
function decision(value: unknown): Decision {
  const d = object(value, "id action reason");
  check(d.action === "approve" || d.action === "reject");
  return { id: identity(d.id), action: d.action, reason: text(d.reason, 1024) };
}
function owns(p: MemoryProposal, a: MemoryAuthority) {
  check(a.role === "hermes" || a.role === "orchestrator", "Only Hermes/orchestrator may propose");
  check(Object.entries(p.source).every(([key, value]) => a[key as keyof Source] === value), "Source authority mismatch");
}
function revision(s: State, generation: number, body: string | null) {
  return `${s.lineage}:${generation}:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`;
}
function replay(s: State) {
  let body = s.initial, before = body, generation = 0;
  const approved = s.entries.filter(e => e.decision?.action === "approve")
    .sort((a, b) => a.decision!.generation! - b.decision!.generation!);
  const revisions = new Map([[revision(s, 0, body), -1]]);
  for (const e of approved) {
    check(e.decision!.generation === generation + 1 && e.proposal.baseRevision === revision(s, generation, body));
    before = body;
    body = e.proposal.body;
    generation++;
    revisions.set(revision(s, generation, body), s.entries.indexOf(e));
  }
  s.entries.forEach((e, index) => check(revisions.has(e.proposal.baseRevision) && revisions.get(e.proposal.baseRevision)! < index));
  check(s.pending === null || s.pending === approved.at(-1)?.proposal.id);
  return { body, before, generation };
}
function decode(raw: string, document: MemoryDocument): State {
  const value = object(JSON.parse(raw), "version lineage initial entries pending");
  check(value.version === 1 && typeof value.lineage === "string" && /^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.lineage));
  check(Array.isArray(value.entries) && value.entries.length <= ENTRY_LIMIT);
  const ids = new Set<string>(), decisions = new Set<string>();
  const entries = value.entries.map((item): MemoryEntry => {
    const e = object(item, "proposal author decision");
    const p = proposal(e.proposal), a = authority(e.author);
    owns(p, a);
    check(p.document === document && !ids.has(p.id));
    ids.add(p.id);
    let disposition: MemoryEntry["decision"] = null;
    if (e.decision !== null) {
      const d = object(e.decision, "id action reason authority generation");
      const input = decision({ id: d.id, action: d.action, reason: d.reason }), reviewer = authority(d.authority);
      check(reviewer.role === "reviewer" && !decisions.has(input.id));
      check(input.action === "reject" ? d.generation === null : Number.isInteger(d.generation) && Number(d.generation) > 0 && Number(d.generation) <= ENTRY_LIMIT);
      decisions.add(input.id);
      disposition = { ...input, authority: reviewer, generation: d.generation as number | null };
    }
    return { proposal: p, author: a, decision: disposition };
  });
  const state: State = { version: 1, lineage: value.lineage, initial: value.initial === null ? null : text(value.initial, BODY_LIMIT),
    entries, pending: value.pending === null ? null : identity(value.pending) };
  check(encode(state) === raw, "Noncanonical memory history");
  replay(state);
  return state;
}
function encode(state: State) { return `${JSON.stringify(state)}\n`; }
function hasCode(error: unknown, code: string) { return (error as NodeJS.ErrnoException)?.code === code; }
async function syncDirectory(path: string) {
  if (process.platform === "win32") return; // Node cannot portably fsync Windows directories.
  const handle = await fs.open(path, "r");
  try { await handle.sync(); } finally { await handle.close(); }
}
async function directory(path: string, create = false) {
  let current = parse(path).root;
  for (const part of path.slice(current.length).split(sep).filter(Boolean)) {
    const parent = current;
    current = join(current, part);
    if (create) {
      try { await fs.mkdir(current); } catch (error) { if (!hasCode(error, "EEXIST")) throw error; }
    }
    check((await fs.lstat(current)).isDirectory(), "Unsafe memory directory");
    if (create) await syncDirectory(parent);
  }
}
async function read(path: string, limit: number, sync = false): Promise<string | null> {
  await directory(dirname(path));
  let stat;
  try { stat = await fs.lstat(path); } catch (error) { if (hasCode(error, "ENOENT")) return null; throw error; }
  check(stat.isFile() && stat.nlink === 1 && stat.size <= limit, "Unsafe memory file");
  const access = sync && process.platform === "win32" ? constants.O_RDWR : constants.O_RDONLY;
  const handle = await fs.open(path, access | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const actual = await handle.stat();
    check(actual.isFile() && actual.nlink === 1 && actual.dev === stat.dev && actual.ino === stat.ino && actual.size <= limit);
    const buffer = Buffer.alloc(limit + 1);
    let used = 0;
    while (used < buffer.length) {
      const { bytesRead } = await handle.read(buffer, used, buffer.length - used, used);
      if (!bytesRead) break;
      used += bytesRead;
    }
    check(used <= limit, "Memory read limit exceeded");
    const result = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(buffer.subarray(0, used));
    if (sync) await handle.sync();
    return result;
  } finally { await handle.close(); }
}
async function replace(path: string, before: string | null, after: string, limit: number) {
  check(Buffer.byteLength(after) <= limit, "Memory history capacity exceeded");
  check(await read(path, limit) === before, "Filesystem CAS mismatch");
  const temporary = `${path}.memory-next`;
  const handle = await fs.open(temporary, "wx", 0o600);
  try { await handle.writeFile(after); await handle.sync(); } finally { await handle.close(); }
  check(await read(path, limit) === before, "Filesystem CAS mismatch");
  await fs.rename(temporary, path);
  await syncDirectory(dirname(path));
}

/** Construct only in a trusted Node backend. The resolver must never read privilege from the payload. */
export function createMemoryGovernance(projectRoot: string, resolveAuthority: (operation: Operation) => MemoryAuthority | Promise<MemoryAuthority>) {
  check(isAbsolute(projectRoot), "Expected absolute project root");
  const root = resolve(projectRoot), memory = join(root, ".devflow"), history = join(memory, ".memory-governance");
  async function locked<T>(name: MemoryDocument, action: (s: State, save: () => Promise<void>) => Promise<T>): Promise<T> {
    const document = documentName(name);
    await directory(root);
    await directory(history, true);
    const lock = join(history, "lock");
    await fs.mkdir(lock); // EEXIST is busy, including abandoned locks; never guess ownership.
    try {
      await syncDirectory(history);
      const file = join(memory, document), statePath = join(history, `${documents[document]}.json`);
      await directory(dirname(file), true);
      let raw = await read(statePath, HISTORY_LIMIT);
      const state: State = raw === null ? { version: 1, lineage: randomUUID(), initial: await read(file, BODY_LIMIT), entries: [], pending: null } : decode(raw, document);
      const save = async () => {
        const next = encode(state);
        await replace(statePath, raw, next, HISTORY_LIMIT);
        raw = next;
      };
      const current = replay(state);
      if (state.pending !== null) {
        check(await read(statePath, HISTORY_LIMIT, true) === raw, "Recovery history CAS mismatch");
        await syncDirectory(history);
        const actual = await read(file, BODY_LIMIT, true);
        check(actual === current.before || actual === current.body, "Recovery CAS mismatch");
        if (actual !== current.body) await replace(file, actual, current.body!, BODY_LIMIT);
        await syncDirectory(dirname(file));
        state.pending = null;
        await save();
      } else check(await read(file, BODY_LIMIT) === current.body, "External memory change; reconciliation required");
      if (raw === null) await save();
      return await action(state, save);
    } finally { await fs.rmdir(lock); await syncDirectory(history); }
  }
  return {
    read: (document: MemoryDocument) => locked(document, async state => {
      const current = replay(state);
      return { body: current.body, revision: revision(state, current.generation, current.body) };
    }),
    list: (document: MemoryDocument) => locked(document, async state => state.entries),
    async propose(input: unknown) {
      const p = proposal(input), a = authority(await resolveAuthority("propose"));
      owns(p, a);
      return locked(p.document, async (state, save) => {
        const current = replay(state);
        check(p.baseRevision === revision(state, current.generation, current.body), "Stale memory proposal");
        check(state.entries.length < ENTRY_LIMIT && !state.entries.some(e => e.proposal.id === p.id), "Duplicate proposal or history capacity exceeded");
        const entry: MemoryEntry = { proposal: p, author: a, decision: null };
        state.entries.push(entry);
        await save();
        return entry;
      });
    },
    async decide(document: MemoryDocument, proposalId: string, input: unknown) {
      const d = decision(input), id = identity(proposalId), a = authority(await resolveAuthority(d.action));
      check(a.role === "reviewer", "Trusted reviewer required");
      return locked(document, async (state, save) => {
        const entry = state.entries.find(e => e.proposal.id === id), current = replay(state);
        check(entry && entry.decision === null && !state.entries.some(e => e.decision?.id === d.id), "Unknown proposal or duplicate decision");
        if (d.action === "approve") check(entry.proposal.baseRevision === revision(state, current.generation, current.body), "Stale memory proposal");
        entry.decision = { ...d, authority: a, generation: d.action === "approve" ? current.generation + 1 : null };
        state.pending = d.action === "approve" ? id : null;
        await save(); // Durable approval intent precedes the only managed document replacement.
        if (state.pending !== null) {
          await replace(join(memory, document), current.body, entry.proposal.body, BODY_LIMIT);
          state.pending = null;
          await save();
        }
        return entry;
      });
    },
  };
}
