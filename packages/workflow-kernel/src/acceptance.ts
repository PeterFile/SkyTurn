import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import type { RunEvidence } from "@skyturn/project-core";

import {
  compileWorkflowIntent,
  createDefaultFlowPolicy,
  reduceWorkflowEvents,
  scheduleReadyLanes,
  type FlowEvent,
  type FlowEventKind,
  type FlowEvidence,
  type FlowKernelAcceptanceSummary,
  type FlowKernelScenarioSummary,
  type FlowLane,
  type FlowProjection,
  type FlowSegment,
  type WorkflowIntent,
} from "./index.js";

interface ScenarioDefinition {
  id: string;
  requirement: string;
  languages: string[];
  capabilities: string[];
}

export async function runFlowKernelAcceptanceScenarios(): Promise<FlowKernelAcceptanceSummary> {
  const root = await mkdtemp(join(tmpdir(), "skyturn-flow-kernel-v1-"));
  const scenarios = [
    scenarioDefinition("frontend-ui", "Add a search filtering control", ["typescript"], ["frontend-ui"]),
    scenarioDefinition("backend-api", "Add a search endpoint", ["javascript"], ["backend-api"]),
    scenarioDefinition("data-script", "Clean and validate a CSV export", ["javascript"], ["data-script"]),
    scenarioDefinition("complex-fullstack", "Add a user settings item", ["javascript"], ["fullstack-settings"]),
  ];
  const summaries: FlowKernelScenarioSummary[] = [];

  for (const definition of scenarios) {
    summaries.push(await runAcceptanceScenario(root, definition));
  }

  return {
    ok: summaries.every((scenario) => scenario.projection.lanes.every((lane) => lane.status === "completed")),
    root,
    scenarios: summaries,
    artifacts: summaries.flatMap((scenario) => scenario.artifacts),
  };
}

function scenarioDefinition(
  id: string,
  requirement: string,
  languages: string[],
  capabilities: string[],
): ScenarioDefinition {
  return { id, requirement, languages, capabilities };
}

async function runAcceptanceScenario(root: string, definition: ScenarioDefinition): Promise<FlowKernelScenarioSummary> {
  const repoRoot = join(root, definition.id);
  await seedFixtureRepo(repoRoot, definition);
  const sessionId = `session-${definition.id}`;
  const now = "2026-06-14T00:00:00.000Z";
  const commands: Array<{ command: string; exitCode: number }> = [];
  const artifacts: string[] = [];
  let events: FlowEvent[] = [
    {
      id: `${sessionId}:flow-event:00000001`,
      sessionId,
      seq: 1,
      kind: "workflow.user_input",
      source: "acceptance",
      payload: { text: definition.requirement },
      createdAt: now,
      idempotencyKey: `scenario:${definition.id}:user-input`,
    },
  ];
  let projection = reduceWorkflowEvents(events);
  const intent: WorkflowIntent = {
    intentId: `intent-${definition.id}`,
    sessionId,
    operations: [
      { type: "AnalyzeRequirement", requirement: definition.requirement },
      { type: "DiscoverProject", profile: { languages: definition.languages, capabilities: definition.capabilities } },
      { type: "ProposeLanes" },
    ],
  };
  const compiled = compileWorkflowIntent(intent, projection, createDefaultFlowPolicy({ allowedParallelism: 3 }), now);
  events = [...events, ...compiled.events];
  projection = reduceWorkflowEvents(events);

  while (projection.lanes.some((lane) => lane.status === "pending" || lane.status === "ready")) {
    const ready = scheduleReadyLanes(projection, { allowedParallelism: 3 });
    if (ready.length === 0) throw new Error(`No ready lanes for ${definition.id}.`);
    for (const lane of ready) {
      const result = await runAcceptanceLane(repoRoot, definition, lane, artifacts);
      commands.push(...result.commands);
      events = appendLaneExecutionEvents(events, projection, lane, result, now);
      projection = reduceWorkflowEvents(events);
    }
  }

  return {
    id: definition.id,
    repoRoot,
    laneKinds: projection.lanes.map((lane) => lane.kind),
    projection,
    evidence: projection.evidence,
    commands,
    artifacts,
  };
}

async function seedFixtureRepo(repoRoot: string, definition: ScenarioDefinition): Promise<void> {
  await mkdir(repoRoot, { recursive: true });
  if (definition.id === "frontend-ui") {
    await mkdir(join(repoRoot, "src"), { recursive: true });
    await writeFile(join(repoRoot, "index.html"), "<main><input aria-label=\"Search tasks\" id=\"search\" /></main>\n");
    await writeFile(join(repoRoot, "src", "tasks.json"), JSON.stringify([{ title: "Alpha" }, { title: "Beta" }], null, 2));
  }
  if (definition.id === "backend-api") {
    await mkdir(join(repoRoot, "src"), { recursive: true });
    await mkdir(join(repoRoot, "test"), { recursive: true });
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({ name: "backend-api-fixture", type: "module" }, null, 2));
  }
  if (definition.id === "data-script") {
    await mkdir(join(repoRoot, "fixtures"), { recursive: true });
    await mkdir(join(repoRoot, "scripts"), { recursive: true });
    await writeFile(join(repoRoot, "fixtures", "raw.csv"), "name,email\n Alice , ALICE@EXAMPLE.COM \nBob,bob@example.com\n");
  }
  if (definition.id === "complex-fullstack") {
    await mkdir(join(repoRoot, "frontend"), { recursive: true });
    await mkdir(join(repoRoot, "backend"), { recursive: true });
    await mkdir(join(repoRoot, "persistence"), { recursive: true });
    await mkdir(join(repoRoot, "test"), { recursive: true });
    await writeFile(join(repoRoot, "package.json"), JSON.stringify({ name: "fullstack-settings-fixture", type: "module" }, null, 2));
  }
  await runCommand("git", ["init"], repoRoot);
  await runCommand("git", ["add", "."], repoRoot);
  await runCommand("git", ["-c", "user.name=SkyTurn", "-c", "user.email=skyturn@example.test", "commit", "-m", "seed fixture"], repoRoot);
}

async function runAcceptanceLane(
  repoRoot: string,
  definition: ScenarioDefinition,
  lane: FlowLane,
  artifacts: string[],
): Promise<{ evidence: FlowEvidence; commands: Array<{ command: string; exitCode: number }> }> {
  const commands: Array<{ command: string; exitCode: number }> = [];
  const laneArtifacts: string[] = [];
  await applyLaneFixtureWork(repoRoot, definition, lane, laneArtifacts, commands);
  artifacts.push(...laneArtifacts);
  const status = commands.every((command) => command.exitCode === 0) ? "passed" : "failed";
  const safeArtifacts = laneArtifacts.map((artifact) => relative(repoRoot, artifact));
  const runEvidence: RunEvidence = {
    runId: `run-${lane.id}`,
    status: status === "passed" ? "succeeded" : "failed",
    exitCode: status === "passed" ? 0 : 1,
    changesetId: null,
    checks: [
      ...commands.map((command) => ({
        kind: "test" as const,
        name: command.command,
        status: command.exitCode === 0 ? "passed" as const : "failed" as const,
      })),
      { kind: "run-exit", name: "Acceptance runner exit", status },
      ...(safeArtifacts.length > 0
        ? [{
            kind: "artifact" as const,
            name: "Acceptance artifacts",
            status: status === "passed" ? "passed" as const : "failed" as const,
          }]
        : []),
    ],
    artifacts: status === "passed" ? safeArtifacts : [],
    review: null,
    errorReason: status === "failed" ? "Acceptance command failed." : null,
    cancelReason: null,
    completedAt: "2026-06-14T00:00:00.000Z",
  };
  return {
    commands,
    evidence: {
      id: `evidence-${definition.id}-${lane.id}`,
      laneId: lane.id,
      segmentId: `segment-${definition.id}-${lane.id}`,
      kind: evidenceKindForLane(lane.kind),
      status,
      checks: runEvidence.checks.map((check) => `${check.kind}:${check.name}:${check.status}`),
      artifacts: runEvidence.artifacts,
      runEvidence,
    },
  };
}

async function applyLaneFixtureWork(
  repoRoot: string,
  definition: ScenarioDefinition,
  lane: FlowLane,
  artifacts: string[],
  commands: Array<{ command: string; exitCode: number }>,
): Promise<void> {
  if (definition.id === "frontend-ui" && lane.kind === "implementation") {
    await writeFile(join(repoRoot, "src", "search-filter.mjs"), [
      "export function filterTasks(tasks, query) {",
      "  const normalized = query.trim().toLowerCase();",
      "  return tasks.filter((task) => task.title.toLowerCase().includes(normalized));",
      "}",
      "",
    ].join("\n"));
  }
  if (definition.id === "frontend-ui" && lane.kind === "browser_validation") {
    const artifact = join(repoRoot, ".devflow", "acceptance", "search-filter-browser.png");
    await mkdir(join(repoRoot, ".devflow", "acceptance"), { recursive: true });
    await writePng(artifact);
    artifacts.push(artifact);
    commands.push(await runCommand("node", ["-e", "import('node:fs').then(fs=>{const html=fs.readFileSync('index.html','utf8'); if(!html.includes('aria-label=\"Search tasks\"')) process.exit(1)})"], repoRoot));
  }
  if (definition.id === "frontend-ui" && lane.kind === "commit") {
    await runCommand("git", ["add", "."], repoRoot);
    commands.push(await runCommand("git", ["-c", "user.name=SkyTurn", "-c", "user.email=skyturn@example.test", "commit", "-m", "flow kernel frontend fixture"], repoRoot));
  }
  if (definition.id === "backend-api" && lane.kind === "implementation") {
    await writeFile(join(repoRoot, "src", "server.mjs"), [
      "export function handleSearchRequest(url) {",
      "  const parsed = new URL(url, 'https://skyturn.test');",
      "  return { status: 200, body: { query: parsed.searchParams.get('q') ?? '', ok: true } };",
      "}",
      "",
    ].join("\n"));
    await writeFile(join(repoRoot, "test", "unit.test.mjs"), [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { handleSearchRequest } from '../src/server.mjs';",
      "test('returns parsed query', () => assert.equal(handleSearchRequest('/search?q=task').body.query, 'task'));",
      "",
    ].join("\n"));
    await writeFile(join(repoRoot, "test", "integration.test.mjs"), [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { handleSearchRequest } from '../src/server.mjs';",
      "test('search endpoint contract', () => assert.deepEqual(handleSearchRequest('/search?q=task'), { status: 200, body: { query: 'task', ok: true } }));",
      "",
    ].join("\n"));
  }
  if (definition.id === "backend-api" && lane.kind === "unit_test") {
    commands.push(await runCommand("node", ["--test", "test/unit.test.mjs"], repoRoot));
  }
  if (definition.id === "backend-api" && lane.kind === "integration_test") {
    commands.push(await runCommand("node", ["--test", "test/integration.test.mjs"], repoRoot));
  }
  if (definition.id === "data-script" && lane.kind === "implementation") {
    await writeFile(join(repoRoot, "scripts", "clean.mjs"), [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "const lines = readFileSync('fixtures/raw.csv', 'utf8').trim().split(/\\n/);",
      "const [header, ...rows] = lines;",
      "const clean = rows.map((row) => row.split(',').map((cell) => cell.trim().toLowerCase()).join(','));",
      "writeFileSync('fixtures/clean.csv', [header, ...clean].join('\\n') + '\\n');",
      "",
    ].join("\n"));
    await writeFile(join(repoRoot, "scripts", "validate.mjs"), [
      "import { readFileSync } from 'node:fs';",
      "const clean = readFileSync('fixtures/clean.csv', 'utf8');",
      "if (!clean.includes('alice,alice@example.com')) process.exit(1);",
      "",
    ].join("\n"));
  }
  if (definition.id === "data-script" && lane.kind === "fixture_validation") {
    commands.push(await runCommand("node", ["scripts/clean.mjs"], repoRoot));
    commands.push(await runCommand("node", ["scripts/validate.mjs"], repoRoot));
  }
  if (definition.id === "data-script" && lane.kind === "regression_check") {
    commands.push(await runCommand("node", ["-e", "import('node:fs').then(fs=>{const csv=fs.readFileSync('fixtures/clean.csv','utf8'); if(csv.split('\\n').length < 3) process.exit(1)})"], repoRoot));
  }
  if (definition.id === "complex-fullstack" && lane.kind === "frontend_implementation") {
    await writeFile(join(repoRoot, "frontend", "settings.mjs"), "export const settingsControl = { key: 'compactMode', label: 'Compact mode' };\n");
  }
  if (definition.id === "complex-fullstack" && lane.kind === "backend_implementation") {
    await writeFile(join(repoRoot, "backend", "settings.mjs"), "export function saveSetting(store, key, value) { store[key] = value; return store; }\n");
  }
  if (definition.id === "complex-fullstack" && lane.kind === "persistence_implementation") {
    await writeFile(join(repoRoot, "persistence", "settings-store.mjs"), "export function createSettingsStore() { return {}; }\n");
  }
  if (definition.id === "complex-fullstack" && lane.kind === "integration_join") {
    const artifact = join(repoRoot, ".devflow", "acceptance", "integration-join.json");
    await mkdir(join(repoRoot, ".devflow", "acceptance"), { recursive: true });
    await writeFile(artifact, JSON.stringify({ upstream: ["frontend", "backend", "persistence"], joined: true }, null, 2));
    artifacts.push(artifact);
  }
  if (definition.id === "complex-fullstack" && lane.kind === "validation") {
    await writeFile(join(repoRoot, "test", "settings.integration.test.mjs"), [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "import { settingsControl } from '../frontend/settings.mjs';",
      "import { saveSetting } from '../backend/settings.mjs';",
      "import { createSettingsStore } from '../persistence/settings-store.mjs';",
      "test('setting flows through UI, backend, and persistence', () => {",
      "  const store = createSettingsStore();",
      "  assert.equal(settingsControl.key, 'compactMode');",
      "  assert.deepEqual(saveSetting(store, settingsControl.key, true), { compactMode: true });",
      "});",
      "",
    ].join("\n"));
    commands.push(await runCommand("node", ["--test", "test/settings.integration.test.mjs"], repoRoot));
  }
}

function appendLaneExecutionEvents(
  events: FlowEvent[],
  projection: FlowProjection,
  lane: FlowLane,
  result: { evidence: FlowEvidence },
  now: string,
): FlowEvent[] {
  let working = projection;
  const segment: FlowSegment = {
    id: result.evidence.segmentId,
    laneId: lane.id,
    runId: `run-${lane.id}`,
    status: "running",
    exitCode: null,
  };
  const started = makeEvent(working, {
    kind: "workflow.segment.started",
    source: "acceptance-runner",
    payload: { segment },
    now,
    idempotencyKey: `segment:${segment.id}:started`,
  });
  working = reduceWorkflowEvents([...working.events, started]);
  const output = makeEvent(working, {
    kind: "workflow.segment.output_delta",
    source: "acceptance-runner",
    payload: {
      laneId: lane.id,
      segmentId: segment.id,
      text: `${lane.kind} executed`,
      delta: {
        protocolVersion: 1,
        runId: segment.runId,
        seq: 1,
        timestamp: now,
        kind: "output",
        payload: { text: `${lane.kind} executed` },
      },
    },
    now,
    idempotencyKey: `segment:${segment.id}:output`,
  });
  working = reduceWorkflowEvents([...working.events, output]);
  const evidence = makeEvent(working, {
    kind: "workflow.evidence.recorded",
    source: "acceptance-runner",
    payload: { laneId: lane.id, segmentId: segment.id, evidence: result.evidence },
    now,
    idempotencyKey: `segment:${segment.id}:evidence`,
  });
  working = reduceWorkflowEvents([...working.events, evidence]);
  const finished = makeEvent(working, {
    kind: "workflow.segment.finished",
    source: "acceptance-runner",
    payload: { laneId: lane.id, segmentId: segment.id, status: result.evidence.status === "passed" ? "succeeded" : "failed", exitCode: result.evidence.status === "passed" ? 0 : 1 },
    now,
    idempotencyKey: `segment:${segment.id}:finished`,
  });
  const extra =
    lane.kind === "commit"
      ? [
          makeEvent(reduceWorkflowEvents([...working.events, finished]), {
            kind: "workflow.commit.created",
            source: "acceptance-runner",
            payload: { laneId: lane.id },
            now,
            idempotencyKey: `lane:${lane.id}:commit-created`,
          }),
        ]
      : [];
  return [...events, started, output, evidence, finished, ...extra];
}

function makeEvent(
  projection: FlowProjection,
  input: {
    kind: FlowEventKind;
    source: string;
    payload: Record<string, unknown>;
    now: string;
    idempotencyKey?: string | null;
  },
): FlowEvent {
  const seq = projection.events.length + 1;
  return {
    id: `${projection.sessionId}:flow-event:${String(seq).padStart(8, "0")}`,
    sessionId: projection.sessionId,
    seq,
    kind: input.kind,
    source: input.source,
    payload: input.payload,
    createdAt: input.now,
    idempotencyKey: input.idempotencyKey ?? null,
  };
}

function evidenceKindForLane(kind: string): string {
  if (/browser/.test(kind)) return "browser";
  if (/review/.test(kind)) return "review";
  if (/commit/.test(kind)) return "git";
  if (/validation|test|regression/.test(kind)) return "test";
  if (/join/.test(kind)) return "join";
  return "run-exit";
}

async function writePng(path: string): Promise<void> {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
  await writeFile(path, Buffer.from(png, "base64"));
}

function runCommand(command: string, args: string[], cwd: string): Promise<{ command: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "ignore" });
    child.once("error", reject);
    child.once("close", (code: number | null) => {
      const exitCode = typeof code === "number" ? code : 1;
      const label = [command, ...args].join(" ");
      if (exitCode === 0) {
        resolve({ command: label, exitCode });
        return;
      }
      reject(new Error(`${label} exited ${exitCode}`));
    });
  });
}
