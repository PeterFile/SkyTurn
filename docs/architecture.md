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
- `packages/agent-runtime`: agent adapter contracts and MVP mocks.
- `packages/git-worktree`: git/worktree/changeset/editor contracts and MVP mocks.
- `packages/project-memory`: `.devflow` directory/file helpers.
- `packages/persistence`: workspace state and renderer host adapters.

## Process Boundary

Electron main process owns:

- folder import dialog
- `.devflow` filesystem creation
- future git commands
- future worktree commands
- future process execution
- future editor launching

Renderer owns:

- home input
- Fast/Plan mode selection
- project workspace
- canvas session tabs
- `@xyflow/react` canvas
- node modal
- local interaction state

Renderer does not directly run shell commands.

## Persistence

The MVP uses a typed workspace store in `packages/persistence`.

In Electron, the store is file-backed through preload IPC and writes JSON under Electron `userData`. In browser-only verification, the same interface falls back to `localStorage`.

The persisted state includes projects, canvas session tabs, graph nodes, graph edges, run/status data embedded in nodes, and mocked changesets.

SQLite can replace this later behind the same repository boundary. Do not wire UI code directly to SQLite.

## Security Boundary

Electron uses a preload API and keeps renderer Node access disabled:

- `contextIsolation: true`
- `nodeIntegration: false`
- IPC methods expose specific operations only.

Folder writes are limited to the user-selected project root and `.devflow` helper files.
