# Agent Adapters

Hermes-agent is the primary orchestrator/project manager. Other local Agents are worker adapters behind contracts.

`packages/agent-runtime` is contract-only. Real discovery and execution live in `packages/agent-bridge`.

## Adapter Kinds

- `hermes`
- `codex`
- `gemini`
- `claude-code`
- `openclaw`

## Contract

Agents are integrated through typed adapter interfaces. They must not leak native configuration into other agents.

Every descriptor includes `supportLevel`:

- `mock-only`: framework/UI integration only.
- `detected-only`: executable discovery works, but real CLI execution is not claimed.
- `experimental-run`: execution works through an unstable CLI/API path.
- `supported-run`: execution path has test coverage and is treated as supported.

Unverified CLIs must stay `detected-only`.

Each adapter is responsible for loading its own native context, for example:

- `AGENTS.md`
- `CLAUDE.md`
- `GEMINI.md`
- MCP configuration
- local skills
- agent-specific config files

Adapter contracts expose discovery, health, start, send, cancel, and event sink shapes. They do not import Electron, `child_process`, filesystem execution, or UI code.

## Hermes Boundary

Hermes creates or confirms task graphs. Individual agents may write task-local outputs, but Hermes/orchestrator owns consolidation into shared memory files under `.devflow`.

## Current Support

| Agent | Support level | Notes |
| --- | --- | --- |
| Hermes | `detected-only` | Orchestrator contract only in the MVP. |
| Codex CLI | `detected-only` by discovery; `experimental-run` when `createCodexCliAdapter` is registered | Uses `codex exec --json` inside a git repository. Default sandbox is read-only. |
| Gemini | `detected-only` | Executable discovery only. |
| Claude Code | `detected-only` | Executable discovery only. |
| OpenClaw | `detected-only` | Executable discovery only. |

## MVP Mocking

The MVP uses planner mocks for Fast/Plan sessions and `agent-bridge` mock runs for durable run events.

Real CLI calls belong inside `agent-bridge` adapters only. They must stay `experimental-run` until the CLI contract, event parsing, cancellation, persistence, and evidence mapping are covered by tests.
