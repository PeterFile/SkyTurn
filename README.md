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
  agent-runtime/        # Codex / Gemini / ClaudeCode / Hermes adapter contracts
  git-worktree/         # Git, worktree, changeset, editor adapter contracts
  project-memory/       # .devflow structure helpers
  persistence/          # workspace state and renderer host persistence adapters
```

## MVP Scope

- Desktop shell: Electron + React + TypeScript + Vite.
- Canvas engine: `@xyflow/react`.
- Orchestrator boundary: Hermes-agent adapter first, mocked for the MVP.
- Agent backends: Codex, Gemini, ClaudeCode, and Hermes through adapter interfaces.
- Project memory: `.devflow` under the imported project root.
- Completion evidence: run status, changeset data, worktree metadata, and verification output.

## Current Verification

The MVP shell currently uses deterministic mock adapters for agent orchestration, git changesets, worktrees, and editor launches. Real CLI integration is intentionally behind interfaces until Hermes-agent and local agent APIs are verified.
