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
- controlled local delivery commit, push, and pull request creation for eligible workflow lanes
- node checkpoint, rollback safety-gate, and rollback side-effect coordination
- Agent bridge IPC, local process execution, and run event persistence
- editor launching through explicit preload methods

Renderer owns:

- home input
- Fast/Plan mode selection
- project workspace
- canvas session tabs
- `@xyflow/react` canvas
- selected-node context for the bottom composer
- node modal
- local interaction state and browser/mock fallback paths

Renderer does not directly run shell commands.

Renderer must not import `better-sqlite3`, Node git/worktree implementations, `fs`, `child_process`, or other local side-effect modules. It consumes workflow projections and changeset results through the preload API.

Selecting a canvas node is a context change, not navigation. It binds the bottom composer to node-scoped actions and must not open details. Node details open through the node card **More** button, and the modal still has only `Output`, `Changes`, and `Context`.

`agent-bridge` does not schedule DAGs, confirm Hermes plans, consolidate shared memory, or decide UI policy. It only connects SkyTurn to local Agents and records run events/evidence.

Delivery push, pull request creation, exact-head check polling, squash merge request, post-merge main sync, and cleanup request are explicit user actions through the renderer toolbar, preload IPC, Electron main, and Node-only git/GitHub helpers. PR creation does not complete a task by itself: `workflow.delivery.pushed` and `workflow.pull_request.created` are recorded events, but Flow Kernel lane completion is not derived from them. `workflow.pull_request.checks_recorded` records exact-head check evidence, and only passed checks for the current head can satisfy check/gate lanes. Merge, sync, and cleanup must be later user-confirmed actions; branch deletion is default-off and separately confirmed.

Checkpoint grain is the node/run boundary. SkyTurn exposes before/after checkpoints as workflow concepts: repair starts from the after checkpoint, variant starts from the before checkpoint, and rollback returns the selected node plus downstream graph to the selected node's before checkpoint when the safety gate allows it. Hermes-style tool-level filesystem checkpoints may exist under the adapter as a lower-level safety net, but they are not the product UI model.

Codex rollback is thread/history-only. It can help an adapter move its conversation state, but it does not restore repository files or graph state by itself. SkyTurn coordinates the graph layer, adapter thread/history layer, and filesystem/worktree layer through workflow events and Electron main side effects.

Rollback is a cascade. The selected node and every downstream node are marked rolled back or inactive, prior evidence and history remain visible, and rolled-back or inactive nodes are not schedulable. Push, PR creation, merge, and main sync are remote side-effect boundaries that block rollback. A local commit is not remote, but rollback across it requires exact commit evidence, worktree/branch identity checks, clean safety conditions, and explicit confirmation. Rollback must not close PRs, delete remote branches, merge, sync main, or delete local branches automatically.

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

Project writes are limited to the user-selected root and `.devflow` helper files. Electron also writes private claims and authoritative run events under its app-private `userData` state boundary.

Authoritative Agent run events live under `<userData>/run-claims/<projectSha256>/<runSha256>.events.ndjson`. Renderer streams and `.devflow/runs/<runId>/events.ndjson` are sanitized, non-authoritative observability mirrors; reload, Output recovery, evidence, artifact gates, and scheduling read only the private log.
