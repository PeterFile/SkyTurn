# SkyTurn

SkyTurn is a desktop development workflow platform for canvas-first task orchestration.

## Commands

```bash
pnpm install
pnpm test
pnpm typecheck
pnpm build
pnpm dev
```

## Monorepo Layout

```text
apps/
  desktop/              # Electron + React desktop shell
packages/
  ui-canvas/            # xyflow canvas, nodes, modal, workspace UI
  project-core/         # Project / Session / Canvas / Node / Run types
  planner/              # Fast and Plan session factories
  orchestrator/         # Hermes orchestration contracts and DAG scheduling
  agent-runtime/        # Contract-only Agent adapter interfaces and metadata
  agent-bridge/         # Local Agent discovery, run lifecycle, event stream, persistence
  git-worktree/         # Git, worktree, changeset, editor adapter contracts
  project-memory/       # .devflow structure helpers
  persistence/          # workspace state and renderer host persistence adapters
```

## Current Scope

- Desktop shell: Electron + React + TypeScript + Vite.
- Canvas engine: `@xyflow/react`.
- Workflow source of truth: SQLite workflow events under `.devflow/skyturn-workflow.sqlite`, exposed through Electron main / Node-only persistence APIs.
- Orchestration: Hermes produces `WorkflowIntent`; `workflow-kernel` validates, compiles, gates, schedules, and projects lanes/edges.
- Agent bridge: Hermes and Codex CLI have real `experimental-run` adapters; run status is derived from `RunEvidence`, not agent prose.
- Changes: the node modal `Changes` tab can use structured live Codex change events plus git-backed final reconciliation.
- Session target: New Session exposes Current branch by default and New worktree as explicit opt-in.
- Managed worktrees: desktop IPC calls `NodeGitWorktreeService` for create, adopt, and clean operations, and uses Node-side git evidence for compare.
- Delivery actions: the node modal **Changes** tab exposes explicit commit, push, and create PR actions. The preload IPC and Electron main handlers call Node-only git/GitHub helpers. Commit records `workflow.commit.created`; push records `workflow.delivery.pushed`; PR creation records `workflow.pull_request.created`.
- Project memory: `.devflow` under the imported project root.

## Current Verification

The real Hermes-to-Codex path has passed `pnpm --filter @skyturn/desktop run demo:mvp` on this machine, and the Electron UI has run a real workflow against a temporary git project. These paths depend on local Hermes/Codex credentials and remain `experimental-run`, not `supported-run`.

Browser-only and mock paths still exist for development and tests. Desktop `workflow:worktree:create`, `workflow:worktree:adopt`, and `workflow:worktree:clean` now call `@skyturn/git-worktree/node` and record terminal workflow events from real git/filesystem side effects. The current worktree adopt UI asks for confirmation and sends `strategy: "merge"`; cherry-pick exists in backend contracts but is not exposed in the UI. The full product UI for comparing, adopting, and cleaning managed worktrees is still not complete.

Delivery can create a controlled local commit, push the delivery branch, and create a pull request through explicit user actions. PR creation is delivery evidence, not task completion. `workflow.delivery.pushed` and `workflow.pull_request.created` are recorded in the event stream, but the Flow Kernel reducer does not complete lanes from those events today. CI exact-head gating, merge, post-merge sync, and delivery cleanup remain next steps, and merge/cleanup must stay later user-confirmed actions.

Real GitHub disposable PR smoke belongs to acceptance/test coverage for the delivery remote path. It is not default behavior for an imported user project.
