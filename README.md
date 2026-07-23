# SkyTurn

SkyTurn is a desktop development workflow platform for canvas-first task orchestration.

## Project State

- Human entrypoints: `README.md` and `Project.canvas`.
- `README.md` is the project contract. `Project.canvas` is the evidence-backed project cognition map.
- Agent mutation rules live in `.agents/canvas-protocol.md`; do not create progress, summary, handoff, or status-doc sprawl.
- Git, tests, artifacts, workflow events, and `RunEvidence` remain the fact source. Canvas cards point to facts; they do not replace them.

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
- Planner entry: ordinary Electron New Session and Canvas input are durably claimed by the workflow store, launched as backend-owned Hermes turns through `agent-bridge`, and returned to the renderer as authoritative `CanvasSession` projections.
- Agent bridge: Hermes and Codex CLI have real `experimental-run` adapters; run status is derived from `RunEvidence`, not agent prose.
- PTY transport: optional experimental Hermes status/inspect/takeover transport only. Ordinary input delivery and planner launch do not require PTY. It is not a terminal dashboard, completion evidence, or the default executor.
- Changes: the node modal `Changes` tab can use structured live Codex change events plus git-backed final reconciliation.
- Node interaction: selecting a node only binds the bottom composer to node-scoped actions. Details open through the node card **More** button, not selection.
- Node checkpoints: before/after checkpoints are user-visible workflow concepts at the node/run boundary. Node-scoped actions repair from the after checkpoint, create variants from the before checkpoint, or roll back the selected node and downstream nodes.
- Session target: New Session exposes Current branch by default and New worktree as explicit opt-in.
- Managed worktrees: desktop IPC calls `NodeGitWorktreeService` for create, adopt, and clean operations, and uses Node-side git evidence for compare.
- Delivery actions: the node modal **Changes** tab exposes explicit commit, push, create PR, exact-head check, squash merge request, post-merge main sync, and cleanup actions. The preload IPC and Electron main handlers call Node-only git/GitHub helpers. Commit records `workflow.commit.created`; push records `workflow.delivery.pushed`; PR creation records `workflow.pull_request.created`.
- Project memory: `.devflow` under the imported project root.

## Workflow Capability Map

Status terms in this document are strict:

- Implemented: code exists in the current checkout for the stated product path.
- Partial: code exists, but the product path still has fallback, missing UX, or hardening gaps.
- Experimental-run: a real local CLI can run, but the path depends on local credentials, CLI behavior, output stability, and failure handling that are not yet support-grade.
- Mock/degraded fallback: deterministic development or unavailable-runtime fallback. It is not real workflow completion evidence.
- Non-goal: do not design toward it for this MVP.

Implemented in the current code:

- New Session has separate execution target and branch controls. Current branch is the default. New worktree is explicit opt-in.
- Plan mode has gated Requirements, Design, and Tasks pages. Each page must be approved before the next one is accessible, and an approved plan can convert to a canvas.
- The node modal has exactly three content tabs: **Output**, **Changes**, and **Context**. Selecting a node targets the bottom composer; details open from the node card **More** button.
- **Context** displays node/session/worktree facts and `RunEvidence` facts, including status, exit code, checks, artifacts, and error/cancel/timeout reasons.
- **Changes** can show structured live run changes, git-backed final reconciliation, mismatch state, sanitized `diff2html` preview, and explicit delivery actions.
- Selected-node composer actions exist for repair, variant, and rollback. Repair starts from the after checkpoint, variant starts from the before checkpoint, and rollback targets the selected node plus downstream nodes.
- Electron main owns workflow IPC, git/worktree side effects, delivery gates, rollback safety checks, and run evidence lookup. Renderer code does not execute git, shell, filesystem, or SQLite side effects.
- Electron New Session and subsequent ordinary Canvas input keep one planner session/node identity while assigning each turn a distinct durable run identity. The backend owns launch, terminal reconciliation, intent application, scheduling, projection, and broadcast; the planner root remains dependency-free.
- Electron renderer state is installed only from authoritative `CanvasSession` values returned by workflow IPC or workflow events. Browser/mock mode retains its local development fallback.
- Completion evidence comes from `RunEvidence`, workflow events, git/worktree reconciliation, checks, artifacts, review evidence, and commit evidence. Agent prose and terminal text are output only.
- Hermes and Codex real CLI adapters are wired through `agent-bridge` as `experimental-run`. The real path is `experimental-run`, not `supported-run`.

Partial and still being hardened:

- Current-branch real loop beyond Phase 1: Current branch is the default main path, runs against the imported project root, and records real `RunEvidence`. Browser/mock fallback remains for development, and failure-repair, artifact, worktree, and delivery product paths still need later-phase hardening.
- Artifact evidence: `RunEvidence` can carry artifacts and the MVP demo captures a screenshot artifact, but artifact capture/registration is still lane- and script-specific.
- Failure-to-repair main path: kernel and selected-node foundations exist, but failed node to repair node to regression verification is not yet the default desktop loop.
- Worktree product loop: create, compare, adopt, clean, and rollback backend boundaries exist, but New worktree is not the current mainline and the compare/adopt/cleanup experience is not complete.
- PTY planner transport: contracts, feature gates, IPC, snapshots, and fake-factory tests exist, but the default desktop runtime has no production PTY factory.

Not done or explicit non-goals:

- SkyTurn is not an IDE, file-tab workspace, code editor, terminal dashboard, or general no-code workflow builder.
- New worktree is not the default development path and should not be treated as the current mainline.
- PR creation, green checks, merge, sync, and cleanup do not automatically chain. Each remote or destructive step needs an explicit user action and backend gate.
- Mock/browser fallback is for deterministic development tests only. It is not real completion evidence.
- No local adapter is documented as `supported-run`.

## Four-Track Delivery Plan

1. Current branch main path: Phase 1 makes ordinary Electron planner turns backend-owned and consumes authoritative Node-side projection, `RunEvidence`, and workflow events. Later work must not move this authority back into the renderer.
2. Failure repair and regression: productize the path from failed node to repair node to regression verification. Failed nodes keep evidence and history; repair starts from the after checkpoint, variant starts from the before checkpoint, and rollback covers the selected node plus downstream nodes behind safety gates.
3. New worktree candidate path: keep New worktree as explicit opt-in for variants and double-track validation. Compare, adopt, and clean must stay behind managed worktree identity checks, artifact/log isolation, and user confirmation.
4. Explicit delivery gates: commit, push, PR creation, exact-head checks, merge request, post-merge main sync, and cleanup stay separate actions. Checks success must not auto-merge, merge must not auto-sync or auto-clean, and cleanup must not delete branches by default.

## Verification Surfaces

The real New Session product acceptance path is `pnpm --filter @skyturn/desktop run acceptance:new-session-ui`. It initializes a temporary Git project, opens it through the UI, creates a session through real controls, waits for Hermes and downstream execution evidence, submits a second ordinary Canvas input, restarts Electron, and compares the rendered nodes, edges, statuses, and input replay with the reopened SQLite projection. PTY is disabled unless explicitly enabled. The command requires local Hermes/Codex credentials and remains `experimental-run`, not `supported-run`.

`pnpm --filter @skyturn/desktop run demo:mvp` remains the lower-level Hermes-to-Codex runtime acceptance. Neither command makes the later failure-repair, New worktree, or delivery tracks complete.

Browser-only and mock paths still exist for development and tests. Desktop `workflow:worktree:create`, `workflow:worktree:adopt`, and `workflow:worktree:clean` now call `@skyturn/git-worktree/node` and record terminal workflow events from real git/filesystem side effects. The current worktree adopt UI asks for confirmation and sends `strategy: "merge"`; cherry-pick exists in backend contracts but is not exposed in the UI. The full product UI for comparing, adopting, and cleaning managed worktrees is still not complete.

Delivery can create a controlled local commit, push the delivery branch, create a pull request, poll exact-head PR checks, request squash merge, request post-merge main sync, and request cleanup through explicit user actions. PR creation is delivery evidence, not task completion. `workflow.delivery.pushed` and `workflow.pull_request.created` are recorded in the event stream, but the Flow Kernel reducer does not complete lanes from those events. `workflow.pull_request.checks_recorded` records exact-head status; only passed checks for the current PR head can satisfy check/gate lanes. Merge, sync, and cleanup remain user-confirmed follow-up actions, and branch deletion is default-off with separate confirmation.

Rollback is a local workflow recovery action, not remote cleanup. If the selected node or any downstream node has pushed, created a PR, merged, or synced main, rollback is blocked. A local commit is still local, but rollback across it needs exact commit evidence, branch/worktree identity checks, and explicit user confirmation. Rollback must never automatically close PRs, delete local or remote branches, merge, sync main, or hide prior evidence.

Real GitHub disposable PR smoke belongs to acceptance/test coverage for the delivery remote path. It is not default behavior for an imported user project.
