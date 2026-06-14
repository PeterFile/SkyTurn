# SkyTurn Agent Instructions

## Product Boundary

- SkyTurn is a desktop development workflow platform.
- It is not a web page.
- It is not a full IDE.
- Keep the main UI minimal and canvas-first.
- Do not add file tabs.
- Do not add a global console or terminal dashboard.
- Do not build a code editor in this MVP.

## Product Model

- The product model is `Project -> Canvas Session Tab -> Canvas -> Node -> Node Modal`.
- `Open Project` imports a local folder as one project.
- `New Tab` creates a new task canvas session, not a file tab.
- A canvas is the visual task graph for one session.
- A node is one executable agent task, preferably bound to a run and worktree.
- The node modal contains exactly three content tabs: `Output`, `Changes`, and `Context`.

## Canvas Requirements

- Use `@xyflow/react` for the canvas.
- Do not implement a custom graph engine.
- The canvas must dominate the workspace.
- Node UI must remain compact.
- Do not show logs, prompts, configs, or code inline inside nodes.

## Orchestration And Agents

- Hermes-agent is the primary orchestrator.
- Codex, Gemini, ClaudeCode, OpenClaw, and Hermes must be integrated through adapter interfaces.
- `agent-runtime` is contract-only: no process execution, discovery implementation, Electron, filesystem execution, or UI logic.
- `agent-bridge` owns local Agent discovery, connection, run lifecycle, event stream, and run persistence; it must not do DAG orchestration.
- Codex CLI real execution must stay in `agent-bridge` adapters: use `codex exec --json` inside a git repository, default to read-only sandbox, do not use `--yolo`, and derive completion from process exit `RunEvidence`.
- Do not deeply couple the app to any single agent CLI internals.
- Use mock adapters first when local CLIs or Hermes APIs are unavailable.
- Each coding agent must load its own native config, skills, MCP, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, or equivalent files without polluting other agents.

## Project Memory

- Shared project memory goes under `.devflow` in the imported project root.
- Individual agents may write task-local outputs.
- Hermes/orchestrator owns shared memory consolidation.
- Do not let individual agents freely rewrite shared memory files such as `decisions.md`, `architecture.md`, or `memory/summaries.md`.

## Completion Evidence

- Git, worktree, and change detection are part of completion evidence.
- Do not mark a task or node complete only because an agent says it is done.
- Completion must be tied to run status, git changes, tests, or concrete verification evidence.
- Node status must be derived from `RunEvidence`; Agent text claiming success is only output.
- Do not mark tasks complete without concrete verification.
- Use `pnpm --filter @skyturn/desktop run demo:mvp` to verify the real Hermes-to-Codex MVP loop; it requires local Hermes/Codex credentials and must not be replaced by mock-only evidence.
- The bottom workflow input must create a running Hermes planning card that calls workflow-card tools; do not regress it into a local pending/mock node.

## Engineering Rules

- Make the smallest correct change.
- Keep service boundaries clean: Electron main owns filesystem, git, process execution, and editor launching; renderer owns UI and interaction state.
- Prefer typed interfaces for orchestration, persistence, git, worktrees, changesets, and editor adapters.
- Use `pnpm` for this monorepo. The root pins `pnpm@10.28.2`; Corepack-selected `pnpm@11.6.0` fails on the local Node `20.19.0` runtime.
- Keep root package scripts as `turbo run` delegators. Put actual build, typecheck, lint, test, and dev commands in the package-level `package.json` files.
- Workspace packages live under `apps/*` and `packages/*`. Internal imports must use `workspace:*` package dependencies, not cross-package relative paths.
- Browser-consumed workspace packages that emit ESM `dist` must use `.js` suffixes for local source imports/exports so compiled files resolve in Vite/Node ESM.
- Electron is pinned to `41.5.1` because newer Electron package metadata required Node `>=22.12.0`, while the initial local Node runtime was `20.19.0`.
- Desktop dev must get renderer host/port values from `apps/desktop/scripts/devServer.mjs`; do not hard-code `5173` in launcher code because Vite may need another local port.
- Update this file only for reusable project knowledge, not story-specific notes.
