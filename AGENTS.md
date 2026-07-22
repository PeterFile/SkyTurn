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
- New Session input must expose two separate development-target controls: an execution target and a branch selector. The execution target defaults to Current branch; New worktree is explicit opt-in. The branch selector picks the development branch in Current branch mode and the base branch/ref in New worktree mode.
- A canvas is the visual task graph for one session.
- A node is one executable agent task, preferably bound to a run and worktree.
- A workflow card is SkyTurn task state, not the agent itself.
- Hermes cards represent planner or verifier tasks.
- Codex cards represent executor tasks.
- `runId` connects a card to a concrete local agent run.
- Dependencies define both `@xyflow/react` edges and scheduling order.
- Selecting a node must not open details. It only binds the bottom composer to node-scoped actions.
- Node details open through the node card **More** button.
- The node modal contains exactly three content tabs: `Output`, `Changes`, and `Context`.
- Node-scoped actions use user-visible before/after checkpoints at node/run boundaries: repair from after checkpoint, variant from before checkpoint, and rollback selected node plus downstream.

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
- Flow Kernel Codex implementation lanes may request per-run `workspace-write` for source/test edits; commit lanes may request per-run `danger-full-access` to write git metadata for `git add`/`git commit`; keep validation lanes on the adapter default sandbox unless a lane has a concrete reason to write.
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
- The node modal `Changes` tab must source live changes from structured agent/run events when available, Codex-style patch/file-change/turn-diff events for Codex, and final changesets from git-backed reconciliation. Agent prose is not a changed-file source.
- Do not mark a task or node complete only because an agent says it is done.
- Completion must be tied to run status, git changes, tests, or concrete verification evidence.
- Node status must be derived from `RunEvidence`; Agent text claiming success is only output.
- Rollback must retain evidence and history. Rolled-back or inactive nodes are not schedulable.
- Push, PR creation, merge, and main sync block rollback. A local commit is not a remote side effect, but rollback across it requires exact commit evidence and an explicit safety gate.
- Rollback must not automatically close PRs, delete remote branches, merge, sync main, or delete local branches.
- Do not mark tasks complete without concrete verification.
- Agent CLI adapters must emit terminal `RunEvidence` and `status` for timeout/cancel paths as well as normal process close; never leave a node running just because a child process failed to exit cleanly.
- Use `pnpm --filter @skyturn/desktop run demo:mvp` to verify the real Hermes-to-Codex MVP loop; it requires local Hermes/Codex credentials and must not be replaced by mock-only evidence.
- The bottom workflow input must create a running Hermes planning card that calls workflow-card tools; do not regress it into a local pending/mock node.

## Engineering Rules

- Make the smallest correct change.
- Keep service boundaries clean: Electron main owns filesystem, git, process execution, and editor launching; renderer owns UI and interaction state.
- Prefer typed interfaces for orchestration, persistence, git, worktrees, changesets, and editor adapters.
- Use `pnpm` for this monorepo. The root pins `pnpm@10.28.2`; Corepack-selected `pnpm@11.6.0` fails on the local Node `20.19.0` runtime.
- Keep root package scripts as `turbo run` delegators. Put actual build, typecheck, lint, test, and dev commands in the package-level `package.json` files.
- Do not manually chain `pnpm --filter ... build` inside package test or acceptance scripts; declare workspace dependencies and let Turbo task dependencies run required builds.
- In clean CI, run root `pnpm run build` before root `pnpm run lint`; TypeScript project-reference typechecks consume generated workspace `dist/*.d.ts` outputs.
- Workspace packages live under `apps/*` and `packages/*`. Internal imports must use `workspace:*` package dependencies, not cross-package relative paths.
- Browser-consumed workspace packages that emit ESM `dist` must use `.js` suffixes for local source imports/exports so compiled files resolve in Vite/Node ESM.
- The node modal `Changes` tab renders patch previews through `packages/ui-canvas/src/diffViewer.ts` with `diff2html` output sanitized by `DOMPurify`; do not reintroduce renderer git execution or custom diff table rendering.
- The SQLite workflow event store lives behind the Node-only `@skyturn/persistence/workflow-store` subpath; do not import `better-sqlite3` through the browser-facing `@skyturn/persistence` root entry or from renderer code.
- `better-sqlite3` is an approved native workspace dependency for the workflow store; keep it scoped to backend/Electron-main-side code and listed in `pnpm-workspace.yaml` build approvals.
- Electron is pinned to `41.5.1` because newer Electron package metadata required Node `>=22.12.0`, while the initial local Node runtime was `20.19.0`.
- Before real desktop workflow testing, rebuild Electron native dependencies with `pnpm --filter @skyturn/desktop run rebuild:native` so `better-sqlite3` matches the Electron ABI.
- Desktop dev must get renderer host/port values from `apps/desktop/scripts/devServer.mjs`; do not hard-code `5173` in launcher code because Vite may need another local port.
- `apps/desktop/electron/main.ts` compiles as CommonJS; dynamically import ESM workspace packages from Electron main instead of static value imports.
- Pull request checks, squash merge, and local main sync are separate explicit delivery IPC actions; checks success must not trigger merge, merge must not trigger cleanup, and sync-main evidence remains session-scoped.
- A `CanvasSession` owns `hermesPlannerSessionId` and `plannerNodeId`; bottom workflow input must update that planner root card instead of appending a second Hermes root, and the planner root must remain dependency-free.
- When merging Hermes run events, preserve source run evidence without overwriting graph hygiene; source-node restoration must not reintroduce planner dependencies or incoming planner edges.
- Keep Flow Kernel lane sandbox policy centralized in `packages/ui-canvas/src/workflowRuntime.ts` through `sandboxForNodeRun`; demo scripts must reuse it instead of copying looser permissions.
- Record executable-lane run checkpoints only from Electron main using the scheduled session/lane/segment/run plus backend-resolved worktree path, branch, and full Git HEAD. Bind dirty checkpoints to concrete changeset evidence; dirty before checkpoints are not restorable rollback or variant sources.
- Exclude only SkyTurn volatile Git evidence paths (`.devflow/skyturn-workflow.sqlite`, its `-wal`/`-shm` sidecars, `.devflow/runs/**`, and `.devflow/tasks/**/output.md`) through one shared pathspec rule for dirty checks and changeset collection. Keep legitimate `.devflow` project memory visible and never mutate the user's `.gitignore`.
- Resolve `current_branch` targets that still use the public/default `HEAD` sentinel in Electron main, persist the actual branch, and only then validate run checkpoints; this migration path must also cover reopened SQLite sessions.
- Reconcile `current_branch` after checkpoints against the matching persisted before checkpoint's immutable full `headCommit`, never a moving branch ref.
- A trusted Hermes planner-root turn does not require a Flow-scheduled segment. Persist one real planner segment per concrete planner `runId`, keep the planner root dependency-free, and replay the latest turn into the authoritative `CanvasSession`.
- Treat `claimPlannerRunStart().created` as ownership for compensation. An existing matching running planner segment belongs to its creator, not the current caller.
- AgentBridge explicit-`runId` starts must create a durable exclusive claim before adapter launch under a backend-owned private state root outside the imported project/worktree. Establish the claim-root and project-hash hierarchy component-by-component, and fsync every containing parent before treating a new or already-visible retry entry as usable; PrivateRunEventStore must reuse the same hierarchy protocol. Key project and run marker paths with bounded canonical SHA-256 identities, create the final `0600` marker itself with no-overwrite exclusivity, and treat successful exclusive creation as ownership even when the marker remains empty, truncated, or not fully synced. Electron must pass an app-private `userData` claim root; tests and demos must pass isolated temporary roots. Any invalid final marker fails closed through authoritative scheduled-run compensation and never authorizes relaunch. Compare one canonical non-sensitive fingerprint for every launch-semantic field at handler, bridge, and durable-claim boundaries; never persist raw project paths, prompts, or continuity handles in marker paths or content. Concurrent duplicates may share the same in-process start only when their fingerprints match; restart duplicates must fail without launching another process or replacing run state. Once the claim is owned, every start failure must preserve the ownership marker and original adapter cause even if all terminal-event persistence paths fail.
- The durable claim store is an adapter-sandbox boundary, not a same-UID host isolation boundary. Canonicalize and validate the app-private claim root outside every project/worktree before launch; `read-only` and `workspace-write` adapters must not access it. `danger-full-access` explicitly grants host-state trust and can rewrite Electron `userData`, databases, and configuration; protect that mode with the product safety gate. Do not add pathname monitors or native watcher helpers to claim otherwise.
- Persist authoritative AgentBridge events beside durable claims under the same validated app-private boundary, keyed by framed canonical project/run SHA-256 identities. Write private state before any listener or project mirror. Treat `.devflow/runs/**/events.ndjson` only as a sanitized best-effort observability mirror; never derive evidence, recovery, completion, artifacts, output deltas, or scheduling from it, and do not expose a programmatic mirror replay path.
- Private RunEvent append success requires file and required parent-directory durability. An exact readable final record is only idempotent success after it is reopened, identity-checked, and re-synced; readback bytes never prove durability.
- Treat PTY output sanitization as one streaming public boundary with bounded carry across arbitrary stdout/stderr chunks; raw Hermes resume handles may reach spawn argv but no listener, scrollback, snapshot, broadcast, output, or evidence surface.
- Once an absolute terminal path begins, treat unquoted spaces and punctuation as path content through CR/LF; only a matching quote may end a quoted path earlier. Retain at most the bounded path carry, then stream fail-closed to the line boundary with one path marker.
- Keep streaming public redaction linear in input length: track retained carry in O(1), bound frontier/carry scans, and drain queued chunks with indexes instead of repeated shifts or full rescans.
- Treat terminal escape normalization as ambiguous during capability redaction: retain bounded, deduplicated raw and decoded match frontiers over the same original spans until resolution; never discard the literal-backslash interpretation early.
- Validate expected-artifact declaration duplicates with the strict public artifact parser's canonical semantics before launching any artifact helper.
- Treat only `undefined` expected-artifact declarations as omitted; `null` and every other non-array value must reach the strict parser and fail before capability, persistence, claim, checkpoint, or CLI side effects.
- Match every sensitive expected-artifact family through the shared NFKC-folded separatorless key and one bounded explicit family table. Keep report exceptions narrow and named; generic suffixes never make credentials safe.
- Apply the descriptor-anchored expected-artifact verifier to every real CLI adapter that accepts declarations, including Hermes; missing, empty, unsafe, or duplicate artifacts fail atomically.
- On Windows, expected-artifact verification must use the packaged `packages/agent-bridge/src/native/artifact-gate.ps1` Win32 handle helper and complete its capability preflight before checkpointing or run claims. Only nonempty valid declarations probe this capability; omitted or empty declarations never require the helper. Never add a path-only fallback or omit the helper from `dist/native`.
- Treat helper `close` as the only reap and stdio-completion boundary. Every failure or abort must share one terminate-and-reap promise, issue at most one kill, await actual `close` even when kill returns false or throws, and never substitute `exitCode`, `signalCode`, or another cleanup timeout.
- Keep streaming redactor diagnostics inside `packages/agent-bridge/src/internal`; the package root must not expose diagnostic hooks, and complexity checks must bound `O(chars + chunks + boundedFrontierWork)`.
- Never use project-local terminal recovery sidecars or event mirrors as terminal authority. After private terminal append retries fail, await Electron-main compensation without broadcasting an unpersisted terminal; on restart, a valid orphaned start claim converges to one fixed sanitized failure without relaunch.
- Keep the desktop `run:start` handler single-flight around preflight, checkpointing, adapter start, and failure reconciliation. Validate the scheduled agent and trusted worktree before binding a compensation target; compensate only after an owned durable claim or real start attempt, and never mutate the legal segment for an identity conflict.
- Publish each per-project workflow store only after one shared initialization/recovery barrier completes. Concurrent callers must await the same barrier; failed initialization must close partial state and clear the barrier for retry.
- Workflow-store initialization must transactionally rewrite legacy `hermes_sessions.opaque_handle` values to `[redacted]`, then use secure deletion, compaction, and checked WAL truncate checkpoints so reopened database files and sidecars retain no raw resume capability bytes. Keep logical migration v5 separate from durable physical-cleanup completion; every open without completion must retry the full checkpoint/VACUUM/checkpoint sequence before recording completion.
- Planner terminal reconciliation must compare canonical terminal evidence before writing. Identical replays return the original terminal state, conflicting replays fail without writes, and terminal lane-status events use stable idempotency keys.
- Finalize every succeeded planner intent with one internal `applied`, `invalid`, or `rejected` disposition. Invalid or rejected intents keep the exact succeeded segment and `RunEvidence`, fail only the latest planner lane, and recover from SQLite candidate/output facts without replaying terminal persistence.
- Executable non-planner terminal reconciliation must exact-compare sanitized full `RunEvidence` and output before writing. Identical same-process or reopened-store replays are zero-write success; any conflict fails before mutation.
- A strict nested cancelled `RunEvidence` keeps outer evidence skipped but fixes the matching segment to cancelled across event order, persistence reopen, CanvasSession materialization, and renderer application; stale success cannot complete the lane or release downstream work.
- Repair remains available from any valid after checkpoint regardless of succeeded, failed, cancelled, or timed-out RunEvidence. Exact failed evidence may enrich repair context and add a regression lane, but it is not a Repair gate.
- Persist run recovery, start reconciliation, and checkpoint failures as audit-only workflow events; exclude them from `FlowProjection.events` so fault history cannot invalidate the executable projection.
- Treat Hermes `WorkflowIntent` lane suggestions as untrusted at the parse boundary; strip `runtimePolicy` and `executable` from external lane payloads and derive execution policy inside the workflow kernel.
- Persist graph topology mutations through validated workflow events and return an authoritative CanvasSession over desktop IPC; insert-before must fail unavailable when that backend is absent and must never mutate topology in the renderer.
- Insert-before must retain target-specific dependency exceptions on the original successor and add clarification as a separate gate; this includes checkpoint successors and trusted failed-evidence Repair lanes.
- Keep `FlowEventKind` additions that can reach node-action projections synchronized with `packages/ui-canvas/src/nodeActionState.ts` or checkpoint actions will fail closed.
- Treat persisted and agent-provided `RunEvidence` as untrusted; reuse the strict parsers and evidence text sanitizer from `@skyturn/project-core` at bridge, renderer replay, persistence, workflow event conversion/projection, and summary boundaries, including checks carried by terminal `status` events.
- Persist authoritative public run output as strictly parsed typed `RunEvent` deltas end to end. Keep compact summaries and ledger text metadata-only; never trim, normalize, or substitute them for exact Canvas Output text.
- For `workflow.segment.output_delta`, accept only typed output/progress/changes deltas with exact optional outer text. Flow Kernel unconditionally drops text-only events; persistence physically upgrades schema-bounded historical SQLite rows to strict typed deltas before projection.
- Carry `FlowLane.requiredEvidence` through `CanvasNode` and `CanvasSession`; renderer artifact completion and launch gates must treat `artifact`, `browser`, and `screenshot` requirements as authoritative, and a generic artifact contract without a concrete expected path must not launch.
- Derive browser/screenshot `requiredEvidence` only through the Workflow Kernel canonical lane normalizer, persist or migrate that canonical result before launch, and never infer a broader artifact contract from renderer or terminal-only title/brief regexes.
- `packages/workflow-kernel` must stay browser-safe and pure; Node/SQLite acceptance belongs in backend-side packages such as `packages/persistence`.
- `pnpm flow-kernel:acceptance` must cover both kernel scenario execution and SQLite event-stream replay; do not reduce it to static JSON snapshots or mock-only projection checks.
- Update this file only for reusable project knowledge, not story-specific notes.

## Commit Messages and Pull Requests

- Follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/) and [Chris Beams](http://chris.beams.io/posts/git-commit/) style for commit messages.
- Write commit messages focused on user impact, not implementation details.
- Use `type(scope): imperative user-impact summary` for commit subjects and PR titles.
- Keep PR titles aligned with the intended squash-merge commit title.
- Do not end commit subjects, PR titles, or squash-merge titles with a period.
- NEVER add `Co-Authored-By` with yourself as co-author of the commit. Agents cannot be authors; humans can be. Agents are assistants.
- Every pull request should answer:
  - **What changed?**
  - **Why?**
  - **Breaking changes?**
  - **Server PR** (if the change requires a coordinated server update)
- Use `None.` for **Breaking changes?** and **Server PR** when they do not apply.
- For squash merges, use the PR title as the merge commit title unless a clearer Conventional Commit subject is needed.
- For squash merges, make the merge commit body the cleaned PR body: preserve user impact, rationale, breaking changes, and server coordination; remove checklist noise, generated logs, and agent attribution.
- Comments should be complete sentences and end with a period.
- Update documentation for user-facing changes.
