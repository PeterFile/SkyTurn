# MVP Verification Plan

Status: historical scaffold verification. This file records the original MVP build-out and early mock verification. It is not the current capability source. For current workflow/runtime facts, use `README.md`, `docs/natural-workflow-design.md`, `docs/flow-kernel-v1-acceptance.md`, and the code paths under `apps/desktop/electron`, `packages/persistence/src/workflowStore.ts`, `packages/workflow-kernel`, `packages/agent-bridge`, and `packages/git-worktree/src/node.ts`.

## Current State

- Repository contents inspected on 2026-06-10.
- Existing files before implementation: `AGENTS.md`, `goal.md`.
- No existing package manager, framework, source tree, or Git repository metadata was present at this project root.
- Selected package manager: `pnpm`, pinned to `10.28.2` because Corepack-selected `pnpm 11.6.0` fails on local Node `20.19.0`.
- Build orchestration: Turborepo, with root scripts delegating to `turbo run`.
- Selected stack: Electron + React + TypeScript + Vite + `@xyflow/react`.

## Implementation Order

1. Repository rules
   - Create a repository-level `AGENTS.md` that preserves the product boundary and agent rules.

2. App scaffold
   - Add workspace `package.json` files, TypeScript configs, Vite config, Electron main/preload files, and React entrypoint.
   - Keep Electron security defaults explicit: `contextIsolation: true`, `nodeIntegration: false`, and renderer access only through preload APIs.

3. Typed domain model
   - Define `Project`, `CanvasSession`, `CanvasNode`, `CanvasEdge`, `Run`, `Changeset`, worktree metadata, agent kinds, and modal tabs.
   - Keep modal tabs constrained to `Output`, `Changes`, and `Context`.

4. Service boundaries
   - Add adapter interfaces for Hermes, Codex, Gemini, ClaudeCode, OpenClaw, git, worktrees, changesets, editors, and persistence.
   - Keep `agent-runtime` contract-only and put discovery/run/event persistence in `agent-bridge`.
   - Use deterministic mock implementations for MVP.

5. Home flow
   - Minimal input box.
   - Fast/Plan mode selection.
   - `Open Project` imports a folder, not a file.

6. Workspace flow
   - Project workspace with top canvas session tabs.
   - `+ New Tab` opens a task input for a new task canvas session.
   - No file tabs.
   - No global Agent Console.

7. Fast path
   - Create a new session.
   - Mock Hermes orchestration produces a graph.
   - Enter the `@xyflow/react` canvas.

8. Plan path
   - Create a Kiro-style planning view with rendered Markdown sections: requirements, design, tasks.
   - Confirmation converts tasks into graph nodes.

9. Canvas and nodes
   - Canvas dominates the workspace.
   - Left sidebar is collapsible.
   - Bottom input bar is reduced home input.
   - Nodes show title, assigned agent, short progress label, and status light.
   - Status colors: completed green, failed red, retrying yellow, running animated three-color, pending neutral.

10. Node modal
    - Clicking a node opens a modal.
    - Modal content tabs are exactly `Output`, `Changes`, and `Context`.
    - Actions: Stop, Retry, Reassign, Insert Before, Open Worktree in VSCode, Open Worktree in Cursor, Open Worktree in Zed.
    - Output streams only selected-node output.
    - Changes is supplied through `ChangesetService`.
    - Context shows brief, session goal, dependencies, agent, worktree path, branch, base commit, and constraints.

11. `.devflow` helpers
    - Provide code-level helpers to create/document the required `.devflow` structure in an imported project.
    - Individual task outputs stay task-local; shared memory consolidation belongs to Hermes/orchestrator.

12. Agent bridge
    - Discover local Agents with explicit `supportLevel`.
    - Stream mock run output through versioned run events.
    - Run Codex CLI only through the explicit `experimental-run` adapter.
    - Persist run events to `.devflow/runs/<runId>/events.ndjson`.
    - Persist readable node output to `.devflow/tasks/<nodeId>/output.md`.
    - Derive node status from `RunEvidence`, not Agent prose.

13. Verification
    - Run install.
    - Run tests.
    - Run TypeScript typecheck.
    - Run production build.
    - Start the app locally and inspect the rendered UI.

## Verification Matrix

| Requirement | Evidence Target | Status |
| --- | --- | --- |
| Install/start commands documented | `README.md`, `package.json` scripts | Done |
| TypeScript build/typecheck passes | `pnpm typecheck`, `pnpm build` | Done |
| Home has Open Project, Fast, Plan, input | Playwright snapshot on `http://127.0.0.1:5173/` | Done |
| Workspace has session tabs and `+ New Tab` | Playwright workspace snapshot | Done |
| Fast creates mock graph and enters canvas | Domain tests and Playwright workspace screenshot | Done |
| Plan renders Markdown and converts tasks | Playwright Plan flow snapshot and converted canvas snapshot | Done |
| `@xyflow/react` renders nodes/edges | `packages/ui-canvas/src/App.tsx` and Playwright canvas snapshot | Done |
| Node status lights render | CSS/source and visible sidebar/node status lights | Done |
| Node modal has exactly Output/Changes/Context | Playwright node modal snapshot | Done |
| Mock agent execution streams output | Playwright Output tab snapshot | Done |
| Agent discovery reports `supportLevel` | `packages/agent-bridge/src/index.test.ts` and UI sidebar | Done |
| Codex CLI adapter is explicit experimental run support | `packages/agent-bridge/src/index.test.ts` | Done |
| Run events use NDJSON-compatible schema | `packages/project-core/src/index.test.ts`, `packages/agent-bridge/src/index.test.ts` | Done |
| Run output is persisted under `.devflow` | `packages/agent-bridge/src/index.test.ts` | Done |
| Node completion uses `RunEvidence` | `packages/project-core/src/index.test.ts`, UI status mapping | Done |
| Changes tab uses `ChangesetService` | `packages/git-worktree/src/index.ts` and Playwright Changes tab snapshot | Done |
| Context tab has node/session/worktree metadata | Playwright Context tab snapshot | Done |
| `.devflow` structure helper exists | `packages/project-memory/src/index.ts`, `apps/desktop/electron/main.ts`, unit tests | Done |
| Architecture docs exist | `docs/product-model.md`, `docs/architecture.md`, `docs/agent-adapters.md`, `docs/git-worktree-design.md`, this file | Done |
| UI is not an IDE/file editor/terminal dashboard | Playwright workspace screenshot | Done |

## Verification Evidence

- `pnpm install`: expected after monorepo migration.
- `pnpm test`: package tests across project-core, planner, project-memory, agent-runtime, agent-bridge, git-worktree, and orchestrator.
- `pnpm typecheck`: package and desktop TypeScript checks.
- `pnpm build`: package builds, Vite renderer build, and Electron build.
- `pnpm --filter @skyturn/desktop dev:renderer`: starts Vite at `http://127.0.0.1:5173/`.
- Persistence: Electron file-backed workspace IPC exists; browser verification uses the same store interface with `localStorage` fallback.
- Playwright verified:
  - Home page has task input, Fast/Plan mode, and `Open Project`.
  - `Open Project` browser fallback imported `SkyTurn Demo` and created a Fast canvas session.
  - Canvas rendered `@xyflow/react` nodes and edges.
  - Node click opened a modal with exactly `Output`, `Changes`, and `Context` content tabs.
  - `Changes` showed mocked diff data through `ChangesetService`.
  - `Context` showed brief, session goal, dependencies, assigned agent, worktree path, branch, base commit, requirements/design/tasks source, and constraints.
  - `+ New Tab` created a Plan session with rendered Markdown sections and converted tasks into graph nodes.
- `pnpm --filter @skyturn/desktop dev:electron`: builds Electron and launches against the Vite dev server.

## Verification Notes

- Vite build emits a chunk-size warning for the renderer bundle. This is acceptable for the MVP shell; code splitting can wait until real adapter modules are added.
- Browser verification uses the renderer URL when Electron inspection is unavailable. Electron startup is verified separately through `pnpm --filter @skyturn/desktop dev:electron`.

## Known Risk

- Real Hermes-agent, Gemini, ClaudeCode, and OpenClaw CLI integrations are `detected-only` until their local APIs are verified.
- Codex CLI has an explicit `experimental-run` adapter, but it is not wired as the default desktop run path.
- Real git worktree creation is modeled behind interfaces first; destructive operations are not part of the MVP shell.
