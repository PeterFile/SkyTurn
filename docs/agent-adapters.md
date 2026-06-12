# Agent Adapters

Hermes-agent is the primary orchestrator/project manager.

MVP adapters live in `packages/agent-runtime/src/index.ts`.

## Adapter Kinds

- `hermes`
- `codex`
- `gemini`
- `claude-code`

## Contract

Agents are integrated through typed adapter interfaces. They must not leak native configuration into other agents.

Each adapter is responsible for loading its own native context, for example:

- `AGENTS.md`
- `CLAUDE.md`
- `GEMINI.md`
- MCP configuration
- local skills
- agent-specific config files

## Hermes Boundary

Hermes creates or confirms task graphs. Individual agents may write task-local outputs, but Hermes/orchestrator owns consolidation into shared memory files under `.devflow`.

## MVP Mocking

The MVP uses `mockHermesAdapter` to produce deterministic Fast and Plan sessions and deterministic node output streams.

Real CLI calls should be added behind the adapter contract after local Hermes-agent and agent CLI APIs are verified.
