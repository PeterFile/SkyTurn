# Flow Kernel v1 Acceptance

Status: pass

Branch: `codex/flow-kernel-v1`

## Implementation Evidence

- `packages/workflow-kernel` owns the browser-safe WorkflowIntent schema, deterministic compiler, gate engine, scheduler, reducer, and policy packs.
- `packages/orchestrator` prompts Hermes v2 for WorkflowIntent JSON only and parses it through the kernel validator.
- `packages/persistence` stores Flow Kernel events in `.devflow/skyturn-workflow.sqlite` through Electron-main-side APIs and replays projection from the event stream.
- `packages/agent-bridge` maps terminal agent run events and RunEvidence into workflow segment/evidence events without taking over DAG scheduling.
- `packages/ui-canvas` projects accepted WorkflowIntent lanes and edges into compact canvas nodes while preserving dependency order.
- `apps/desktop/electron` exposes narrow preload/IPC workflow wrappers; renderer does not import `better-sqlite3`.

## Verification Commands

- `pnpm install`: pass
- `pnpm typecheck`: pass
- `pnpm lint`: pass
- `pnpm test`: pass
- `pnpm build`: pass
- `pnpm flow-kernel:acceptance --force`: pass, 2 packages, 0 cached tasks
- `pnpm --filter @skyturn/desktop run demo:mvp`: pass
- `/Users/cwp/.agents/skills/playwright/scripts/playwright_cli.sh goto http://127.0.0.1:5175`: pass
- `/Users/cwp/.agents/skills/playwright/scripts/playwright_cli.sh snapshot`: pass
- `/Users/cwp/.agents/skills/playwright/scripts/playwright_cli.sh screenshot`: pass

## Acceptance Scenarios

Latest forced acceptance root:

`/var/folders/cd/7hd8w6ss3ms4hbml2_bxkj980000gn/T/skyturn-flow-kernel-v1-lrKKIS`

Frontend UI:

- Requirement: search filtering control.
- Expected lane kinds: `discovery -> design -> implementation -> browser_validation -> review -> commit`.
- Evidence: compiler, scheduler, segment/evidence reducer, and SQLite replay passed.
- Browser artifact: `/var/folders/cd/7hd8w6ss3ms4hbml2_bxkj980000gn/T/skyturn-flow-kernel-v1-lrKKIS/frontend-ui/.devflow/flow-kernel-artifacts/search-filter-browser.png`

Backend API:

- Requirement: new search endpoint.
- Expected lane kinds: `discovery -> contract_analysis -> implementation -> unit_test -> integration_test -> review`.
- Evidence: `node --test test/unit.test.mjs` and `node --test test/integration.test.mjs` passed in the fixture repo; SQLite replay matched lanes, edges, and evidence.

Data/script:

- Requirement: CSV cleaning and validation.
- Expected lane kinds: `data_contract_analysis -> implementation -> fixture_validation -> regression_check`.
- Evidence: fixture validation and regression commands passed.
- Fixture artifact: `/var/folders/cd/7hd8w6ss3ms4hbml2_bxkj980000gn/T/skyturn-flow-kernel-v1-lrKKIS/data-script/fixtures/clean.csv`

Complex fullstack:

- Requirement: user settings item.
- Expected lane kinds: `discovery -> frontend_implementation/backend_implementation/persistence_implementation -> integration_join -> validation -> review`.
- Evidence: projection contains all three implementation edges into `lane-integration-join`; SQLite replay matched projection.
- Join artifact: `/var/folders/cd/7hd8w6ss3ms4hbml2_bxkj980000gn/T/skyturn-flow-kernel-v1-lrKKIS/complex-fullstack/.devflow/flow-kernel-artifacts/integration-join.json`

## Real Hermes-To-Codex MVP

Command:

`pnpm --filter @skyturn/desktop run demo:mvp`

Result: pass.

- Hermes run 1 produced WorkflowIntent `workflow-intent-fast-202606141559-node-1`.
- Hermes run 2 produced WorkflowIntent `intent-fast-202606141559-task-local-evidence-summary`.
- Planner identity reuse: pass.
- Planner root dependency-free: pass.
- Codex lane `lane-implementation` ran through AgentBridge and completed from RunEvidence.
- Codex evidence: run-exit check passed with exit code 0.

## UI Artifact

Renderer browser verification artifact:

`/Users/cwp/.codex/worktrees/a731/SkyTurn/output/playwright/flow-kernel-v1-renderer.png`

Snapshot result: page title `SkyTurn`, first screen contains `Development workflow canvas` and `Open Project`.

## Known Risks

- The desktop bundle still emits Vite's existing large chunk warning for the main renderer bundle.
- The real MVP demo uses live Hermes/Codex behavior; the prompt and validator now reject malformed intent schema instead of crashing.
