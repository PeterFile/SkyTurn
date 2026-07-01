# Flow Kernel v1 Acceptance

Status: historical pass

Historical branch: `codex/flow-kernel-v1`. This document records the Flow Kernel v1 acceptance run; it is not a statement about the current checkout branch.

## Implementation Evidence

- `packages/workflow-kernel` owns the browser-safe WorkflowIntent schema, deterministic compiler, gate engine, scheduler, reducer, and policy packs.
- `packages/orchestrator` prompts Hermes v2 for WorkflowIntent JSON only and parses it through the kernel validator.
- `packages/persistence` stores Flow Kernel events in `.devflow/skyturn-workflow.sqlite` through Electron-main-side APIs and replays projection from the event stream.
- `packages/agent-bridge` maps terminal agent run events and RunEvidence into workflow segment/evidence events without taking over DAG scheduling.
- `packages/ui-canvas` projects accepted WorkflowIntent lanes and edges into compact canvas nodes, schedules ready lanes, and scopes Codex sandbox permissions by lane.
- `apps/desktop/electron` exposes narrow preload/IPC workflow wrappers; renderer does not import `better-sqlite3`.

## Verification Commands

- `pnpm install --frozen-lockfile`: pass
- `pnpm typecheck`: pass, 11 packages
- `pnpm lint`: pass, 11 packages
- `pnpm test`: pass, 22 turbo tasks
- `pnpm build`: pass, 11 packages; Vite emitted the existing large chunk warning
- `pnpm flow-kernel:acceptance --force`: pass, 6 turbo tasks, 0 cached tasks
- `pnpm --filter @skyturn/desktop run demo:mvp`: pass, real Hermes and Codex runs completed from RunEvidence
- `npm test` in `/Users/cwp/projects/skyturn-flowkernel-real-repo-20260615-complete`: pass, 3 node:test tests

## Acceptance Scenarios

Latest forced acceptance root before cleanup:

`/var/folders/cd/7hd8w6ss3ms4hbml2_bxkj980000gn/T/skyturn-flow-kernel-v1-GfZHgk`

Stable copied artifacts:

- Frontend browser screenshot: `/Users/cwp/.codex/worktrees/a731/SkyTurn/output/flow-kernel-v1/acceptance/search-filter-browser.png`
- Data fixture output: `/Users/cwp/.codex/worktrees/a731/SkyTurn/output/flow-kernel-v1/acceptance/clean.csv`
- Fullstack join evidence: `/Users/cwp/.codex/worktrees/a731/SkyTurn/output/flow-kernel-v1/acceptance/integration-join.json`

Frontend UI:

- Requirement: search filtering control.
- Expected lane kinds: `discovery -> design -> implementation -> browser_validation -> review -> commit`.
- Evidence: compiler, scheduler, segment/evidence reducer, and SQLite replay passed.
- Browser artifact copied to `output/flow-kernel-v1/acceptance/search-filter-browser.png`.

Backend API:

- Requirement: new search endpoint.
- Expected lane kinds: `discovery -> contract_analysis -> implementation -> unit_test -> integration_test -> review`.
- Evidence: `node --test test/unit.test.mjs` and `node --test test/integration.test.mjs` passed in the fixture repo; SQLite replay matched lanes, edges, and evidence.

Data/script:

- Requirement: CSV cleaning and validation.
- Expected lane kinds: `data_contract_analysis -> implementation -> fixture_validation -> regression_check`.
- Evidence: fixture validation and regression commands passed.
- Fixture artifact copied to `output/flow-kernel-v1/acceptance/clean.csv`.

Complex fullstack:

- Requirement: user settings item.
- Expected lane kinds: `discovery -> frontend_implementation/backend_implementation/persistence_implementation -> integration_join -> validation -> review`.
- Evidence: projection contains all three implementation edges into `lane-integration-join`; SQLite replay matched projection.
- Join artifact copied to `output/flow-kernel-v1/acceptance/integration-join.json`.

## Real Hermes-To-Codex MVP

Command:

`pnpm --filter @skyturn/desktop run demo:mvp`

Result: pass.

- Retry note: first rerun timed out waiting for Hermes planner run `run-fast-202606141804-node-1-20260614180428`; the single retry below passed.
- Project root before cleanup: `/var/folders/cd/7hd8w6ss3ms4hbml2_bxkj980000gn/T/skyturn-mvp-demo-rHBtqC`
- Planner session: `hermes-planner-fast-202606141807`
- Planner identity reuse: pass
- Planner root dependency-free: pass
- Hermes WorkflowIntent IDs: `node-1`, `intent-fast-202606141807-node-1`
- Codex lane: `lane-implementation`
- Codex RunEvidence: `status=succeeded`, `exitCode=0`, run-exit check passed

## Real SkyTurn UI Workflow

User-facing validation was performed in the real SkyTurn Electron UI, not by injecting static canvas data.

- Real repo: `/Users/cwp/projects/skyturn-flowkernel-real-repo-20260615-complete`
- Requirement submitted through the SkyTurn bottom workflow input:

```text
In this real git repository, add status filtering to src/tasks.js: listTasks(tasks, { status }) should return only tasks whose status strictly matches the requested status, including an empty-string status if requested, while listTasks(tasks) still returns all tasks. Add node:test coverage and commit the verified change.
```

- Baseline commit: `f64789e chore: seed task helper baseline`
- Final commit: `27f35ef96825f6e125b87b7927e4b62f6de5756c Add task status filtering`
- Final repo status: only untracked `.devflow/` remains
- Final repo tests: `npm test` passed, 3 tests, 0 failures
- Final screenshot: `/Users/cwp/.codex/worktrees/a731/SkyTurn/output/playwright/flow-kernel-v1-real-skyturn-workflow-final.png`

Live run evidence:

- Planner run `run-fast-202606141745-node-1`: Hermes produced WorkflowIntent JSON and exited 0.
- Implementation run `run-fast-202606141745-lane-implementation`: Codex wrote tests first, observed RED, implemented `Object.hasOwn(filters, "status")`, ran targeted and full tests, and did not commit.
- Validation run `run-fast-202606141745-lane-validation`: Codex ran `npm test -- test/tasks.test.js`, pass 3/3, and did not commit.
- Review run `run-fast-202606141745-lane-review`: Hermes read-only review passed, no blockers, no stage/commit.
- Commit run `run-fast-202606141745-lane-commit`: Codex ran tests and whitespace check, staged only `src/tasks.js` and `test/tasks.test.js`, and created commit `27f35ef`.

## UI Artifact

Renderer browser verification artifact from automated browser smoke test:

`/Users/cwp/.codex/worktrees/a731/SkyTurn/output/playwright/flow-kernel-v1-renderer.png`

Real full-workflow Electron artifact:

`/Users/cwp/.codex/worktrees/a731/SkyTurn/output/playwright/flow-kernel-v1-real-skyturn-workflow-final.png`

## Known Risks

- The desktop bundle still emits Vite's existing large chunk warning for the main renderer bundle.
- Live Hermes/Codex behavior depends on local credentials and CLI availability; this run passed with the current local setup.
- Flow Kernel implementation lanes now use per-run `workspace-write`, and commit lanes use per-run `danger-full-access` for git metadata writes; validation and review lanes remain read-only by policy.
