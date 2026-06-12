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

## MVP Scope

- Desktop shell: Electron + React + TypeScript + Vite.
- Canvas engine: `@xyflow/react`.
- Orchestrator boundary: Hermes-agent adapter first, mocked for the MVP.
- Agent backends: Hermes, Codex CLI, Gemini, Claude Code, and OpenClaw through contract-only adapter interfaces.
- Agent bridge: local discovery, mock run streaming, durable run events, and RunEvidence-backed node status.
- Project memory: `.devflow` under the imported project root.
- Completion evidence: run status, changeset data, worktree metadata, and verification output.

## Current Verification

The MVP shell currently uses deterministic mock adapters for agent orchestration, bridge runs, git changesets, worktrees, and editor launches. Real CLI execution is intentionally behind `supportLevel`; unverified local CLIs are `detected-only`, not `supported-run`.

Codex CLI has an explicit `experimental-run` adapter in `packages/agent-bridge`. It follows Hermes' Codex skill boundary: run `codex exec --json` inside a git repository, persist SkyTurn events, and derive completion from process exit evidence rather than Codex prose. The desktop UI should keep using mock runs unless real local execution is intentionally wired in.
