/goal Refactor SkyTurn so one Canvas Session is continuously planned by the same Hermes planner session.

Context:
SkyTurn’s product model is:
Project -> Canvas Session Tab -> Canvas -> Workflow Card -> Node Modal.

The desired product behavior is now:
A Canvas Session has one durable Hermes planner session. When the user inserts a new requirement into the same canvas, SkyTurn must continue the same Hermes-agent planning session for that canvas, not create an unrelated Hermes one-shot planning run.

Current issue:
The bottom workflow input currently creates a new Hermes planning card/run for each requirement. The agent bridge currently starts Hermes with `hermes -z`, which is one-shot. This means repeated requirements in the same canvas are not planned by the same long Hermes session, and repeated planning can duplicate Codex implementation cards and Hermes verification cards.

Product decision:
- Card is SkyTurn task state, not the agent itself.
- Hermes cards represent planner/verifier tasks.
- Codex cards represent executor tasks.
- `runId` connects a card to a concrete local agent run.
- Dependencies define both `@xyflow/react` edges and scheduling order.
- A CanvasSession should own or reference a stable Hermes planner session identity.
- New requirements in the same CanvasSession should be appended to that existing Hermes planner session.
- Hermes planner output should mutate the workflow graph through orchestrator-owned workflow-card tools.

Hard architecture constraints:
1. Renderer must not spawn Hermes, Codex, shell commands, or filesystem mutations.
2. Electron main / agent-bridge owns local execution and adapter calls.
3. Orchestrator owns workflow-card tool application and graph hygiene.
4. agent-runtime remains contract-only.
5. @xyflow/react remains the canvas engine.
6. Do not build a full workflow engine.
7. Keep the smallest correct MVP refactor.
8. Do not deeply couple SkyTurn to Hermes private internals or SQLite schema.

Important Hermes research conclusion:
Hermes Kanban correctness comes from durable task/link/run state, idempotency keys, and a dispatcher/claim path. It does not treat a dashboard card as the agent itself.
Hermes `-z` is one-shot and is not suitable for a persistent planner session.
Hermes gateway/session behavior or an official resume/chat path must be verified before relying on it.

⚠️ External API warning:
Hermes gateway/session internals may be unstable. Do not hard-code private Hermes DB schemas, private Python module contracts, or dashboard internals into SkyTurn. Add a SkyTurn adapter boundary and keep fallback behavior explicit.

Objective:
Refactor the MVP so repeated requirements added to one CanvasSession continue the same Hermes planner session, and the resulting workflow cards form a deterministic, connected task graph.

Requirements:

1. Clarify session/card/run model
- Add or formalize a CanvasSession-level Hermes planner identity, for example:
  - `hermesPlannerSessionId`
  - `plannerRunId`
  - `plannerThreadKey`
  - or another name consistent with existing code.
- This identity must be stable for the lifetime of a CanvasSession.
- Do not create a new planner identity for every bottom-input requirement.
- A Hermes planning card may represent the visible planning task state, but it is not the long-lived agent itself.
- New user requirements should be represented as session events/messages or planner inputs, not as independent disconnected root tasks unless there is a product reason.

2. Replace one-shot planning semantics
- Find where the renderer creates Hermes planning nodes from bottom input.
- Find where `startAgentRun` reaches agent-bridge.
- Find where Hermes args are built, especially any `hermes -z` usage.
- Refactor so CanvasSession planning calls route through a Hermes planner-session adapter.
- The adapter should support:
  - create planner session for a CanvasSession if missing
  - continue planner session with a new requirement
  - stream or return planner output
  - map planner output to workflow-card tool calls
- If true Hermes long-session support cannot be verified locally, implement the adapter contract and an explicit fallback that preserves the session identity in SkyTurn state, but document that Hermes transport is still one-shot behind the adapter. Do not pretend it is a real long session.

3. Keep orchestration boundary clean
- Renderer sends only intent:
  - sessionId
  - projectId
  - user requirement text
  - selected context if already supported
- Renderer must not decide graph mutations from Hermes output.
- Electron main / agent-bridge starts or continues Hermes.
- Orchestrator applies workflow-card tools.
- Graph hygiene must live in tool application/orchestration, not UI rendering.

4. Graph hygiene
Implement the smallest graph hygiene layer needed for MVP:
- Prevent duplicate cards by semantic identity, not only by ID.
- Stable semantic identity should consider:
  - agent kind
  - role/purpose: implementation, verification, planning
  - normalized title/task key
  - target file/path if present
  - parent/verified card if present
- If Hermes asks to create an equivalent card, update/merge the existing card instead.
- Prefer `updateWorkflowCard` behavior when an equivalent card already exists.
- Derive or repair missing dependency edges when a verifier clearly targets a Codex implementation card.
- No disconnected cards except the root planning/session card.
- For a simple single-file task, allow at most:
  - one primary Codex implementation card
  - one Hermes verification card
- Keep RunEvidence-derived status authoritative.
- Do not mark a verifier running until all dependencies are completed.

5. Prompt update
Strengthen the Hermes planning prompt so it requires:
- stable card IDs or stable task keys for semantically identical cards
- update existing workflow cards instead of creating duplicates
- every verification card depends on the implementation card it verifies
- no disconnected cards except the root planning/session card
- at most one primary Codex implementation card and one Hermes verification card for a simple single-file task
- cards are SkyTurn task state, not agents
- runId is a concrete local execution, not a planning identity
- dependencies define xyflow edges and scheduling order

6. Data migration / compatibility
- Preserve existing sessions as much as possible.
- If old CanvasSession data lacks a Hermes planner identity, lazily create one on next planning action.
- Do not break existing saved canvas loading.
- Avoid broad schema churn unless required.
- Add narrow migration/defaulting logic if persistence exists.

7. Tests first
Add failing tests before implementation.

Required test coverage:
- Repeated bottom-input requirements in the same CanvasSession reuse the same Hermes planner session identity.
- Adding a new requirement does not create a second disconnected Hermes planning root unless explicitly intended.
- Duplicate Hermes workflow-card tool output is merged or skipped by semantic identity.
- Repeated Hermes planning does not create duplicate Codex implementation cards.
- A Hermes verification card depends on the Codex implementation card it verifies.
- Missing verifier dependency is repaired and produces an xyflow edge.
- RunEvidence-derived completion remains authoritative.
- A verifier is not marked running while its dependencies are incomplete.
- Existing saved sessions without planner identity still load and receive one lazily.

8. Verification commands
Run:
- `pnpm typecheck`
- `pnpm test`
- `pnpm build`
- `pnpm lint`
- `pnpm --filter @skyturn/desktop run demo:mvp`

Then run a browser/Electron smoke test:
- open the desktop app
- create or open a project
- create one canvas session
- submit a first requirement
- submit a second requirement into the same canvas
- verify the same CanvasSession planner identity is reused
- verify generated cards are connected by edges
- verify no duplicate Codex implementation card is created for the same semantic task
- verify verifier card depends on implementation card

9. Reporting
In the final response, report:
- changed files with line references
- how the session/card/run model now works
- how graph hygiene handles duplicates and missing verifier dependencies
- which tests were added
- exact verification commands and results
- any Hermes long-session limitation if the real Hermes transport is not yet verified

Non-goals:
- Do not build a full workflow engine.
- Do not add custom graph engine.
- Do not add file tabs.
- Do not add global terminal/dashboard UI.
- Do not move execution into renderer.
- Do not hard-code Hermes private DB internals.
- Do not mark task completion from agent text alone.
