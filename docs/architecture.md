# Architecture

## Stack

- Electron owns the desktop shell.
- React owns renderer UI state and interaction.
- TypeScript owns shared type contracts.
- Vite builds the renderer.
- `@xyflow/react` renders task graphs.
- pnpm workspaces define package boundaries.
- Turborepo runs package tasks through the dependency graph.

## Monorepo Boundary

- `apps/desktop`: Electron shell, preload IPC, renderer entry, Vite config.
- `packages/ui-canvas`: canvas-first React workspace, session tabs, nodes, node modal.
- `packages/project-core`: shared domain contracts.
- `packages/planner`: Fast and Plan session creation.
- `packages/orchestrator`: Hermes orchestration contracts and DAG scheduling.
- `packages/agent-runtime`: contract-only Agent adapter interfaces and support metadata.
- `packages/agent-bridge`: local Agent discovery, connection, run lifecycle, event stream, and run evidence persistence.
- `packages/git-worktree`: browser-safe git/worktree/changeset/editor contracts and Node-only git/worktree implementations.
- `packages/project-memory`: `.devflow` directory/file helpers.
- `packages/persistence`: workspace state adapters and the Node-only SQLite workflow store.

## Process Boundary

Electron main process owns:

- folder import dialog
- `.devflow` filesystem creation
- git branch facts and git-backed changeset reconciliation
- workflow SQLite access through Node-only persistence APIs
- managed worktree create, adopt, and clean side effects through `NodeGitWorktreeService`
- managed worktree comparison through Node-side git evidence collection
- controlled local delivery commit creation for eligible workflow commit lanes
- Agent bridge IPC, local process execution, and run event persistence
- editor launching through explicit preload methods

Renderer owns:

- home input
- Fast/Plan mode selection
- project workspace
- canvas session tabs
- `@xyflow/react` canvas
- node modal
- local interaction state and browser/mock fallback paths

Renderer does not directly run shell commands.

Renderer must not import `better-sqlite3`, Node git/worktree implementations, `fs`, `child_process`, or other local side-effect modules. It consumes workflow projections and changeset results through the preload API.

`agent-bridge` does not schedule DAGs, confirm Hermes plans, consolidate shared memory, or decide UI policy. It only connects SkyTurn to local Agents and records run events/evidence.

## Persistence

SkyTurn currently has two persistence layers with different jobs:

- Workspace shell state: a typed store in `packages/persistence` persists opened projects, tabs, and renderer workspace state. Electron writes JSON under Electron `userData`; browser-only verification falls back to `localStorage`.
- Workflow facts: `@skyturn/persistence/workflow-store` is Node-only and stores workflow sessions, events, lanes, segments, evidence, and projections in `.devflow/skyturn-workflow.sqlite`.

The SQLite workflow store is already used by Electron workflow IPC and by the real Hermes-to-Codex path. The renderer still has legacy/browser fallback paths for local canvas behavior, so SQLite is the workflow fact source for the real desktop path but not the only state object in the application.

## Security Boundary

Electron uses a preload API and keeps renderer Node access disabled:

- `contextIsolation: true`
- `nodeIntegration: false`
- IPC methods expose specific operations only.

Folder writes are limited to the user-selected project root and `.devflow` helper files.

Agent run events are durable data under `.devflow/runs/<runId>/events.ndjson`. Renderer streams can update UI, but reloads must recover Output from the persisted event log.
