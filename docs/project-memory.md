# Project memory governance (M1)

Use `createMemoryGovernance` from `@skyturn/project-memory/node` in a trusted Node backend. The existing browser root keeps its default-file helpers and has no dependency on the service. The package still builds CommonJS with Node16 resolution; the `node` export condition supports both Node `require` and ESM import.

## Propose, review, and restore one document

Construct the service with an absolute project root and a backend-owned `resolveAuthority(operation)` closure. It returns `actorId`, `role`, `sessionId`, `runId`, and `evidenceId`. Only `hermes` or `orchestrator` can propose; only a `reviewer` can explicitly approve or reject. The proposal's source identities must match the resolved authority. Never build this resolver from agent payloads. M2 must resolve these identities and permissions from actual backend session/run/evidence facts; M1 has no Agent, desktop, UI, or IPC integration.

`read(document)` returns `{ body, revision }`; an absent file has `body: null`. Only `decisions.md`, `architecture.md`, and `memory/summaries.md` under `.devflow` are accepted. First access records the existing UTF-8 body without changing it or initializing any default files. `.gitignore` and other project content remain untouched.

Call `propose({ id, document, baseRevision, body, reason, source: { sessionId, runId, evidenceId } })`, then `decide(document, proposalId, { id, action: "approve" | "reject", reason })`. Actor and privilege fields are not accepted in either payload. Every object rejects unknown keys. Proposal and decision identities are unique within one document's history; retries use `list(document)` to inspect the persisted result rather than resubmit an identity.

`list(document)` returns all proposals, their author identities, and any disposition with reviewer audit identities. Pending approvals are recovered before results return. Rejection preserves exact body bytes. Revision tokens include a random history lineage, approval generation, and content/existence hash; approval also compares the actual file bytes. A restoration is a new proposal containing the earlier body, a new identity, and the current base revision, followed by a separate approval. This advances the generation even when restoring identical old content, preventing stale ABA approval. There is no history deletion API or file-deletion restoration.

## Recover interrupted approvals without guessing

Each document has a bounded canonical JSON envelope in `.devflow/.memory-governance/{decisions,architecture,summaries}.json`. One exclusive `mkdir` lock in that directory serializes all service instances/processes. A busy lock fails immediately; the caller may retry the operation after the owner finishes. Every persisted envelope is strictly parsed, including source ownership, reviewer role, unique identities, revision chain, and pending-intent consistency, before it can authorize any apply.

Approval first persists the complete history with a pending write-ahead intent, then atomically replaces the one document, then persists the completed history. Each replacement uses an exclusively created adjacent `.memory-next` file. Reopen re-syncs a pending history and accepts only the exact recorded before or after body: it applies the former or finalizes the latter. Any other body, malformed record, capacity overflow, or unsafe path fails closed. A completed history also refuses external body divergence. Keep that external edit and reconcile it manually; the service cannot import it automatically.

This is a logically recoverable apply, not an atomic commit across history and document. Errors can leave a durable approval pending even when the call throws. Ordinary failures release the owned lock; process termination can leave it behind. The service never guesses that a lock is stale and never deletes it automatically. After establishing that all owners are stopped, an operator may remove only the abandoned empty `lock` directory and retry. Retain and inspect any colliding `.memory-next` files; move them aside only after establishing ownership and preserving their bytes. Do not edit/delete history to unblock recovery. A mismatched body requires deliberate operator reconciliation to the exact pending before/after bytes before retry.

Replacement files are flushed with `FileHandle.sync`; on POSIX, containing directories are also synced after creation, rename, and lock removal. Recovery re-syncs the recorded intent and matching document before completing history. These guarantees depend on the local filesystem honoring those operations; this is not a hardware power-loss guarantee. Windows syncs files but skips directory sync because Node has no portable directory-flush contract: power loss can lose namespace changes. Recovery's sync on Windows requires write access. Network filesystems and noncooperating writers are unsupported.

## Keep the boundary small

Bodies and existing documents are limited to 16 KiB of valid UTF-8, reasons to 1 KiB, and each identity to 80 ASCII identifier characters. There are at most 32 proposals and a 4 MiB envelope per document; capacity exhaustion fails closed with no pruning. Missing and empty bodies have distinct revisions. Reads allocate at most the relevant bound plus one byte; paths come only from the fixed allowlist. Symlink components/files, hardlinked files, and unexpected file types are rejected before reading content.

This is an API ownership guard, not authentication of arbitrary on-disk edits or same-UID / `workspace-write` / `danger-full-access` filesystem isolation. Direct writers with filesystem access can fabricate valid records, race the check-to-rename interval, or remove the lineage. All writers must cooperate with the lock; preexisting or observed external changes fail closed. No secrets, credential files, native configuration, or agent output logs are read.

## Validate the package

Run `pnpm --filter @skyturn/project-memory test`, then that package's `build` and `typecheck`. Tests initialize isolated temporary Git repositories under `TMPDIR`; set a per-process HDD `TMPDIR` in the prescribed runtime root. They use real files and independent service instances, plus one file-sync fault injection. Windows may skip only symlink creation denied by the host. Supervisor owns dependency installation and root gates.

After building, run both `node -e 'require("@skyturn/project-memory/node")'` and `node --input-type=module -e 'import { createMemoryGovernance } from "@skyturn/project-memory/node"'` from the package directory. A browser bundle of the package root must resolve without Node builtins; bundling the `/node` subpath for browsers must fail its export condition.
