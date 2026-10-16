# Project file snapshots backend contract

The desktop `workflow:appendUserInput` IPC accepts optional project-file descriptors for an existing Canvas session. The backend freezes file text in SQLite before starting its Hermes planner turn. No composer control or reference chip is exposed by this backend slice.

## Submit descriptors through the existing IPC

```json
{
  "sessionId": "session-id",
  "inputId": "stable-input-id",
  "text": "Use the attached notes to refine this task.",
  "references": [{ "kind": "file", "path": "docs/notes.txt" }]
}
```

Each descriptor must contain exactly `kind: "file"` and `path`. Paths are relative to the opened project root. The caller cannot supply file content or `resolvedReferences`; no general file-reading IPC is added. Omitted and empty `references` preserve the existing text trimming, payload shape, and input idempotency behavior. `null` and other non-array values are rejected.

## Read bounded text before claiming the input

The limits are 8 files, 1,024 characters per path, 32 KiB per file, and 64 KiB total. Files must contain strict UTF-8 text. BOM, CRLF, tabs, and boundary whitespace are preserved exactly. Invalid UTF-8, binary controls, oversized content, and sensitive content are rejected without truncation or redaction.

Traversal, absolute paths, duplicate paths, symlinks, hardlinks, directories, and special files are rejected. Sensitive names use the shared NFKC-folded component guard and its narrow named report exceptions. Git, SkyTurn, credential, and native agent configuration directories are denied, including nested occurrences.

Electron main authorizes the opened project and session, anchors the project directory with a descriptor, and uses `@skyturn/agent-bridge/bounded-file-reader` for each file. All descriptors and snapshots must pass validation before `claimUserInput` writes an input event or any planner start is attempted. Safe reading requires the existing POSIX native helper. An unavailable reader fails closed; there is no Windows path-reader fallback.

## Replay the original snapshot

The existing `workflow.user_input` event stores optional `references` and `resolvedReferences` in its payload. Each resolved entry contains `kind`, `path`, exact `text`, and UTF-8 `byteLength`. No table or schema migration is added.

Resolved snapshots remain backend-owned. Electron main removes the entire `resolvedReferences` field from user-input events at the shared workflow response and broadcast boundary, including events inside public projections. Public append acknowledgements retain the original input text, ordered descriptors, event identity, and delivery metadata. Other events and exact typed run output are unchanged. The existing `workflow:events` API retains its metadata-only redaction. Projection never mutates authoritative events or their stored snapshots.

A retry with the same session and `inputId` must match the exact input text and ordered descriptors. It looks up and validates the durable event before reading files, then reuses the original snapshot after file edits, deletion, or store reopen. A different text or descriptor list under the same identity fails. Existing planner segments and the durable delivered event prevent a delivered input from starting another planner turn.

Main builds the planner goal from the durable event, JSON-quotes the file data, labels it as untrusted reference data rather than instructions, and passes it through the actual `buildHermesWorkflowPrompt` builder. File content does not become workflow policy or executable authority.

## Validate in this checkout

Use the pinned pnpm version and this checkout's generated workspace exports. The focused backend suite covers parsing, descriptor-relative reads, SQLite claim/reopen behavior, immutable replay, prompt construction with a stubbed planner launch, and IPC transport:

```sh
node --check apps/desktop/scripts/projectReferenceRuntime.test.mjs
node --test apps/desktop/scripts/projectReferenceRuntime.test.mjs
```

The runtime suite requires this checkout's built packages and native file reader, plus a SQLite binary matching the Node runtime. Missing generated outputs or an unavailable native ABI block it; source aliases and foreign package outputs are unsupported. A stubbed planner launch does not establish real Hermes consumption. Desktop execution and real-agent acceptance remain separate validation gates.

New Session, node actions, renderer drafts, exact-run references, additional agent kinds, and Pi adapters are outside this backend contract.
