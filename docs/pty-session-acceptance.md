# PTY session acceptance

Status: PR7 acceptance record for the stacked PTY session slice. This document records the current verified behavior and boundary. It does not claim that SkyTurn has a production interactive PTY runtime.

PTY is scoped to Hermes planner status, inspection, and explicit takeover transport. It is not a terminal dashboard, not a node completion source, and not the Codex default executor.

## Current architecture boundary

`packages/project-core` and `packages/agent-runtime` define contracts and feature gates only. They expose transport types, terminal session/event shapes, adapter capabilities, and `ptyInteractiveSessions` gating. They do not spawn local processes, open PTYs, run git, or own UI state.

`packages/agent-bridge` owns the PTY lifecycle when a PTY factory is injected. It defines `PtyProcessFactory`, creates `PtyTerminalSessionManager`, starts Hermes planner PTY transport, emits terminal lifecycle/output/progress events, redacts secret-like terminal text, and records terminal exit evidence for exit, cancel, timeout, and failure paths. It still does not do DAG orchestration and does not replace `codex exec --json`.

`apps/desktop/electron` owns the desktop terminal runtime, IPC, and workflow session binding. It exposes `terminal:start`, `terminal:write`, `terminal:resize`, `terminal:cancel`, `terminal:snapshot`, and `terminal:event`. It binds the Hermes planner terminal to the workflow `CanvasSession`, starts a planner terminal when the workflow session path can, and augments renderer-facing canvas sessions with `hermesPlannerTerminalSessionId` when a live terminal exists.

The renderer `Terminal Inspector` is read-only and hidden by default. It only renders after the top bar toggle is used, only for an active canvas session, and only reads `terminal.snapshot` plus `terminal.onEvent`. Renderer code does not call `terminal.start` or `terminal.write`, and it does not put terminal logs inside node cards or node modal tabs. Future takeover controls must stay explicit and planner-scoped.

## Verified behavior

PTY startup is feature-gated. When `SKYTURN_ENABLE_PTY_INTERACTIVE` is not `1`, terminal start returns:

```json
{
  "ok": false,
  "status": "unsupported",
  "reasonCode": "PTY_INTERACTIVE_DISABLED"
}
```

No PTY factory is called in this path.

When the feature is enabled but no PTY factory is installed or injected, terminal start returns:

```json
{
  "ok": false,
  "status": "degraded",
  "reasonCode": "PTY_MANAGER_UNAVAILABLE"
}
```

This is the default desktop runtime state in this checkout. `apps/desktop/electron/main.ts` creates `createTerminalRuntime` without a `ptyFactory`.

Injected fake-factory tests exercise the real `agent-bridge` manager and transport path. The tests run through `createTerminalRuntime`, `createHermesPlannerPtyTransport`, and `createPtyTerminalSessionManager`; they cover session start, event broadcast, snapshot capture, stdin write, resize, cancel, timeout evidence, output redaction, output-before-final ordering, and duplicate terminal-event suppression. These tests prove the transport wiring, not a production PTY backend.

Snapshots and terminal events are keyed by the real `terminalSessionId`. Tests assert that a started Hermes terminal such as `hermes-planner-canvas-session-1` is not the same value as `canvas-session-1`. Renderer filtering uses `hermesPlannerTerminalSessionId` and the event `terminalSessionId`; it does not use `CanvasSession.id` as a terminal snapshot key.

`hermesPlannerTerminalSessionId` is optional renderer-facing augmentation. Electron main adds it to materialized canvas sessions only when `terminalRuntime.hermesPlannerTerminalSessionId(sessionId)` returns a live terminal id, and workflow responses continue to pass through that materializer.

Generated `skyturn-ipc:*` handles are workflow IPC identities, not Hermes resume handles. Electron main may store `skyturn-ipc:${sessionId}` as a workflow opaque handle, but `explicitHermesSessionHandle` strips that value before launching Hermes. The default PTY launch test asserts that Hermes args are `["chat", "--cli", "--source", "skyturn"]`, with no `--resume` and no `skyturn-ipc:*` argument.

⚠️ The Hermes PTY transport is still experimental. Local CLI behavior, terminal output, credentials, and future Hermes resume guarantees can change. Treat PTY event text as runtime output, not workflow completion evidence.

## Validation commands

Run install first in a fresh worktree:

```sh
corepack pnpm install --frozen-lockfile
```

PR6 validated this stack with:

```sh
corepack pnpm run build
corepack pnpm --filter @skyturn/agent-bridge run test
corepack pnpm --filter @skyturn/desktop run test
corepack pnpm --filter @skyturn/ui-canvas run test
```

Expected PR6 result shape:

- root build passes all 11 packages;
- `@skyturn/agent-bridge` tests pass, including PTY manager and Hermes PTY transport coverage;
- `@skyturn/desktop` tests pass, including terminal IPC/runtime and workflow IPC source checks;
- `@skyturn/ui-canvas` tests pass, including Terminal Inspector source checks;
- focused typechecks exit 0.

Focused typechecks for this area:

```sh
corepack pnpm --filter @skyturn/agent-runtime run typecheck
corepack pnpm --filter @skyturn/agent-bridge run typecheck
corepack pnpm --filter @skyturn/desktop run typecheck
corepack pnpm --filter @skyturn/ui-canvas run typecheck
```

The real Hermes-to-Codex MVP check is still:

```sh
corepack pnpm --filter @skyturn/desktop run demo:mvp
```

That command is the real desktop workflow acceptance path. It requires local Hermes/Codex runtime and credentials. If it fails because the local runtime, credentials, or time budget are unavailable, record it as not verified for the PR. Do not report it as a pass unless the command actually completes with evidence-backed success.

## PR7 validation log

PR7 is docs-only. Re-run results for this checkout on 2026-07-01:

- `corepack pnpm install --frozen-lockfile`: failed before dependency linking because the default pnpm store tried to write `/Volumes/HDD/MyStorage/pnpm-store`, which is outside this worktree's writable sandbox.
- `corepack pnpm install --frozen-lockfile --store-dir /tmp/skyturn-pty-pnpm-store`: pass. `better-sqlite3` built locally for Node `20.19.0`; install completed with existing native compile warnings.
- `corepack pnpm run build`: pass. Turbo reported 11 successful packages. The run replayed cache and kept the existing Vite large chunk warning.
- `corepack pnpm --filter @skyturn/agent-bridge run test`: pass, 70 tests.
- `corepack pnpm --filter @skyturn/desktop run test`: pass, 88 tests.
- `corepack pnpm --filter @skyturn/ui-canvas run test`: pass, 211 tests.
- `git diff --check`: pass. `git diff --no-index --check -- /dev/null docs/pty-session-acceptance.md` produced no whitespace warnings for the new untracked file.
- `corepack pnpm --filter @skyturn/desktop run demo:mvp`: not verified in PR7. It was attempted twice and failed both times before evidence-backed completion at Electron screenshot capture:

```text
Electron .../.devflow/acceptance/capture.cjs http://127.0.0.1:5173/ .../.devflow/acceptance/react-app.png exited null
ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL ... Exit status 1
```

Do not treat this PR7 docs slice as a real Hermes-to-Codex MVP pass.

## Remaining runtime limitation

There is still no production PTY factory or native PTY dependency in this stack. The default desktop runtime remains degraded when no `ptyFactory` is installed or injected.

Real interactive Hermes PTY needs a future backend such as `node-pty` or an equivalent PTY provider. That future slice must include Electron native rebuild, packaging, runtime loading, failure-mode handling, and platform coverage. Until then, SkyTurn must not claim production interactive PTY support.

## Rollback and safety boundary

Terminal text is not completion evidence. Node completion still comes from `RunEvidence`, workflow events, checks, git changes, artifacts, review evidence, commit evidence, or concrete verification evidence.

Rollback keeps evidence and history readable. Rolled-back or inactive nodes are not schedulable, and rollback must preserve the event trail instead of deleting the past.

Push, PR creation, merge, and main sync remain explicit gates. Rollback must not automatically close PRs, delete remote branches, merge, sync main, or delete local branches. A local commit is not a remote side effect, but rollback across it still requires exact commit evidence and an explicit safety gate.

🔒 PTY output can include credentials or private project data. Keep terminal output read-only in the renderer, keep redaction in the bridge path, and prefer least-privilege execution policies for any future production PTY backend.
