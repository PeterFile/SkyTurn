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

Descriptors may also include `readiness`:

- `readiness.level: "unavailable"` means the CLI executable was not found or was not executable.
- `readiness.level: "detected-only"` means SkyTurn found the executable but has not registered an execution adapter for it.
- `readiness.level: "experimental-run"` means SkyTurn registered a runnable adapter. This is still not `supported-run`.
- `readiness.cli.version` comes from a bounded `--version` probe.
- `readiness.auth.status` is `available` only when a credential is safely detectable without exposing secret material. Environment variables can prove auth for configured agents. Codex can also be marked available from a local `auth.json` token shape under an injected config root, injected auth path, `$CODEX_HOME`, or the default Codex home. SkyTurn reads only enough shape to prove presence and does not return tokens, email, account IDs, or file contents. Hermes local auth remains `unknown` unless environment evidence is available.

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

Hermes CLI and Hermes PTY output redact native session announcements before publishing output or progress. The internal streaming redactor recognizes the case-sensitive plain-text field `session_id` at the start of a CR/LF-delimited line, with optional spaces or tabs before the field and between the field and `:`. After the colon, it preserves whitespace and replaces the first non-whitespace token with one `[redacted]` marker, including quotes or punctuation within that token. It preserves the remaining safe text, whitespace, line endings, stream identity, and order. Empty values stay empty; truncated or arbitrarily long tokens never release value bytes. Tokens are suppressed immediately without buffering a line or growing a discovered-secret list, within the existing bounded carry and linear-work limits.

This Hermes-only rule also applies to fresh runs without an input resume handle. JSON object keys and inline prose do not trigger it; other agents retain their existing behavior. Known input-handle redaction remains active. The rule protects future emitted output through the existing public boundary, including authoritative events, task output, and the observability mirror. It does not discover native sessions, establish resume mappings, rewrite historical output, change stdout workflow parsing, or alter completion evidence.

### Read-Only Startup Compatibility

A detected Hermes executable is not proof that its launcher can initialize under SkyTurn's read-only policy. A managed launcher can require installation-state writes before making any model request. Treat an installation-state failure separately from authentication or model failure; do not make the installation tree, tools directory, configuration, or credential files writable to get past startup.

An explicitly authorized acceptance environment can use a separately prepared developer virtual environment and a fixed launcher through the existing executable-resolution boundary. Pin the source revision and dependencies, retain normal Hermes bootstrap/recovery checks, and use the virtual environment's own interpreter rather than resolving it to the base Python executable. Prepare dependencies outside the agent run and disable lazy installation; this does not disable activation or recovery checks. Keep the isolated Hermes state root outside the fixture project, and let the user authenticate that environment without copying credentials from the main profile.

Validate this path in stages: unchanged production sandbox denies project/install/runtime/configuration/credential-test writes and fork; bootstrap succeeds; a real AgentBridge run persists successful terminal evidence in its private store; the desktop workflow then passes its own interaction gates. A nested sandbox startup failure is not a Hermes runtime verdict. A passing help command is not a model test, and a passing read-only model turn is not a complete Hermes-to-Codex MVP run. This is an experimental acceptance path, not a bundled runtime installer or proof that the default managed launcher is compatible.

The existing full MVP commit lane uses `danger-full-access` to write Git metadata. Permission to create a test commit in a disposable repository does not by itself authorize that host-trust mode. Keep the explicit product safety gate; if the mode is declined, preserve the incomplete full-MVP result rather than relaxing the policy or relabeling a reduced suite as full acceptance.

## Rollback Boundary

Adapters may expose native recovery capabilities, but SkyTurn owns product rollback semantics.

Codex rollback is thread/history-only. It can help rewind or fork Codex conversation context, but it is not a repository rollback, a graph rollback, or proof that files are safe. SkyTurn must coordinate graph state, adapter thread/history state, and filesystem/worktree state through workflow events and Electron main side effects.

Hermes-style tool-level filesystem checkpoints can exist as a lower-level safety net for adapter execution. They are not the user-visible checkpoint model. The product model exposes before/after checkpoints at the node/run boundary.

## Current Support

| Agent | Support level | Notes |
| --- | --- | --- |
| Hermes CLI | `detected-only` by discovery; `experimental-run` when `createHermesCliAdapter` is registered | Uses `hermes chat -q` from the resolved project/worktree path. |
| Codex CLI | `detected-only` by discovery; `experimental-run` when `createCodexCliAdapter` is registered | Uses `codex exec --json` inside a git repository. Default sandbox is read-only. |
| Gemini | `detected-only` | Executable discovery only. |
| Claude Code | `detected-only` | Executable discovery only. |
| OpenClaw | `detected-only` | Executable discovery only. |

There is no current `supported-run` local adapter. If a future doc says the real Hermes/Codex path is supported, it must point to updated code and validation that promoted the adapter level.

Hermes planner PTY transport is a separate experimental transport boundary for planner status, inspection, and explicit takeover. It is not the Codex executor path, not a terminal dashboard, and not proof that a workflow node completed.

## Mock And Real Run Boundaries

Browser/mock fallback paths still use planner mocks and `agent-bridge` mock runs for deterministic contract tests and non-desktop verification. Those paths are not evidence that a real local Agent executed.

The current desktop workflow path registers Hermes and Codex real adapters behind `experimental-run`. Real CLI calls belong inside `agent-bridge` adapters only, and they remain experimental until the CLI contract, auth/readiness, event parsing, cancellation, persistence, timeout handling, structured changes, and evidence mapping are stable enough to treat as `supported-run`.

Mock output, browser fallback state, agent prose, or terminal text can help UI tests and diagnosis, but none of them can complete a real workflow node. Real completion must come from `RunEvidence`, workflow events, git/worktree evidence, tests, checks, artifacts, review evidence, commit evidence, or other concrete verification evidence.

Runtime failure events use stable categories where possible:

- `cli-missing`
- `auth-missing`
- `invalid-cwd`
- `process-timeout`
- `non-zero-exit`
- `output-parse-error`

## Integration Direction

SkyTurn prioritizes reliable task completion and useful context over adding agent names. Integration priorities and independently verifiable acceptance contracts are:

| Slice | User outcome | Required acceptance |
| --- | --- | --- |
| Registered artifact viewing | Inspect registered text and PNG artifacts from node Context. | Mounted Electron preview, process reopen, denied unsafe/unregistered paths, stale run/HEAD rejection, and late-response isolation. Current file bytes must not be described as immutable historical bytes. |
| Scheduling acknowledgement | Resume does not report an unknown outcome when its own authoritative broadcast arrives first. | Broadcast-before-response regression, duplicate-click/idempotency checks, foreign/stale authority rejection, and mounted desktop control. |
| Desktop Retry | Retry an eligible failed/cancelled attempt without losing original evidence. | Cancel → Retry → pending reopen → Resume → real executor → downstream completion → terminal reopen. |
| Project file snapshot contract | Reliably retain file context across a failed delivery and restart. | Freeze authorized bytes before delivery; changing/deleting the source and retrying the same input must preserve the frozen content. Invalid references must not claim an input. This backend slice does not expose a new UI control. |
| Project file reference UI | Attach precise local context to a Canvas follow-up. | Consume the snapshot contract; scope chips to the project/session; a late ACK must not clear a newer draft. Other composer modes remain explicitly disabled. |
| Exact run-result references | Reuse a selected historical run's output, not a changing aggregate. | Bind session/node/segment/run; compare exact private typed stdout; reject revoked/cross-project sources and preserve frozen retries. |
| Independent verification evidence | Distinguish an agent's clean exit from passing project checks. | A failing verification command must fail the verification lane even if the executor reports success; downstream release remains blocked. |

Reuse existing implementations before starting replacements. Integrate artifact viewing before file snapshots, then the reference UI, then exact run-result references. The snapshot backend and composer UI are separate PRs; do not include unrelated stylesheet cleanup. Scheduling acknowledgement precedes Retry acceptance. Keep changes to shared renderer entrypoints serial at integration time. Each slice needs its own focused tests, current build, applicable desktop acceptance, and exact-head required CI; a blocked slice remains unshipped while independent work continues.

### Pi: Compatibility Before Execution

Official sources checked on 2026-10-15 identify [Pi v1.2.0](https://github.com/earendil-works/pi/releases/tag/v1.2.0) as a non-prerelease, published on 2026-10-12 UTC. Its package is [`@earendil-works/pi-coding-agent`](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/package.json), requiring Node >=22.19.0. A stable release does not promise frozen APIs. Pi is **not currently integrated in SkyTurn**.

The first proposed slice is executable/version compatibility discovery with an explicit non-runnable descriptor. Do not add an unused protocol abstraction or silently route Pi through the Codex adapter. A separate execution slice must establish:

- [JSON/RPC terminal semantics](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/cli-integration.md): JSONL events are not schema-constrained model output; exit zero and `agent_end` do not prove success. Automatic retries can continue until `agent_settled`; final assistant stop reasons and independent verification still matter.
- [Cancellation and queues](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/rpc-commands.md): clear queued work before aborting, handle process deadlines and terminal compensation, and keep conversation fork distinct from Git rollback.
- [Host isolation](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/security.md): project trust, tool allowlists, and the embedded JavaScript sandbox are not a whole-process read-only/workspace-write boundary. Require real OS isolation or an explicit product host-trust safety gate; never borrow the Codex sandbox label.
- [Native MCP](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/mcp.md) and [SDK loading](https://github.com/earendil-works/pi/blob/v1.2.0/packages/coding-agent/docs/sdk.md): Pi now supports MCP, but SDK defaults differ from CLI extension loading. Keep Pi's native configuration isolated from other agents.

Only promote to `experimental-run` after real launch, cancel, timeout, failure, provider, private-evidence, and permission-boundary acceptance. Hermes remains the planner and Codex the existing executor; Pi does not replace either merely by being installed.

### Jev: Optional Advisory Decisions

[TypeSafe's current model documentation](https://docs.typesafe.ai/models) lists `jev-1.13.0`. [Jev is not a coding or chat model](https://docs.typesafe.ai/introduction/coding-agents): it returns typed choice, score, and noul decisions rather than editing code or calling tools.

Evaluate only an optional task-classification/routing suggestion. Pin the evaluated model version, compare it with a deterministic baseline on Chinese and adversarial inputs, measure latency/cost and abstention, and keep a local fallback. English is the primary training language; Chinese quality is not assumed. Do not add a dependency or runtime service before evidence shows a useful improvement. Any authenticated evaluation needs explicit data-transfer consent and approved credentials; repository content is not uploaded by default. Jev must never authorize permissions, declare completion, validate artifacts, or decide whether to merge.

### Broader Direction

Official [scheduled-task documentation](https://developers.openai.com/codex/automations.md) emphasizes recurring work, isolated worktrees, and least-privilege execution. [Claude Code agent teams](https://code.claude.com/docs/en/agent-teams) add independent contexts and task coordination but remain experimental and have resumption/shutdown limitations. For SkyTurn, the useful direction is durable multi-run orchestration with reviewable outputs and recoverable failures, not nested autonomous teams or a new global terminal dashboard.

### Product Increments From Current Agent Workflows

Primary sources checked on 2026-10-17 point toward supervising longer work, retaining useful context, and reviewing results rather than merely adding model names:

- [Cursor Projects, 2026-09-10](https://cursor.com/changelog): a coordinator delegates implementation, maintains shared project context, and supports scheduled/event-driven work. This is a vendor-described beta, not evidence of SkyTurn capability.
- [Cursor local-agent remote control, 2026-10-06](https://cursor.com/changelog/remote-control-local-agents): users can inspect and reply to agents that continue running locally. SkyTurn's immediate opportunity is local cross-session attention, not a new mobile/cloud control plane.
- [Cursor agent canvases, 2026-10-16](https://cursor.com/changelog/cloud-agent-canvases-and-environments): agents can create shareable interactive canvases; its Environments API is beta. SkyTurn should improve review of its existing outputs before adding hosting or arbitrary executable artifacts.
- [Anthropic long-running harness practice, 2025-11-26](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents): incremental feature work, resumable context, and end-to-end checks address premature completion and unfinished work. This is an engineering reference, not a new October release.

The next local product slices have explicit behavior gates:

| Slice | Observable outcome | Acceptance and stopping condition |
| --- | --- | --- |
| Cross-session attention | A user in one canvas sees another session waiting for input, requiring a current manual action, or paused, and can locate its eligible task. | Live inactive-session updates; resolved decisions clear; project identities remain isolated; navigation neither opens details nor performs a workflow action. Historical repaired failures must not cause permanent warnings. |
| Find captured output | A user finds a literal string in long node output and moves between matches. | Exact raw and copied text survives highlighting, split streaming fragments, and CRLF; node/run switches reset search; live updates retain focus; large-result limits are explicit. |
| Reuse a project task | A user copies a prior session's goal into an editable New Session draft. | Only same-project goals are offered; replacing a nonempty draft needs confirmation; selection never launches an agent; Create uses fresh session/planner/run identity and keeps explicit execution-target controls. |

Each slice is local and independently reviewable. Output search can run in parallel with sidebar work; shared `App.tsx` integration and task reuse are serialized. Focused tests precede a fresh build and applicable real Electron interaction checks. A deterministic failure remains incomplete until repaired and revalidated; a model's completion message is not acceptance. Remote publication, merge, unattended schedules, and destructive cleanup remain separate authorization boundaries.

After these slices, prioritize registered-artifact feedback into a gated Repair draft, then reconcile the existing Retry and frozen file/reference candidates against their acceptance contracts above. Do not replace those candidates or start another infrastructure-only loop merely to keep workers busy. Current delivery state belongs in `Project.canvas` with concrete evidence, not in this roadmap.
