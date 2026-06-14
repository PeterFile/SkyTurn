import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

import {
  AgentBridge,
  RUN_EVENT_PROTOCOL_VERSION,
  createCodexCliAdapter,
  createHermesCliAdapter,
  loadRunEvents,
} from "@skyturn/agent-bridge";
import { parseHermesWorkflowToolCalls } from "@skyturn/orchestrator";
import { createFastCanvasSession } from "@skyturn/planner";
import { addRequirementPlanningNode } from "@skyturn/ui-canvas/composer";
import { buildPromptForNodeRun, mergeRunEventsIntoWorkspace } from "@skyturn/ui-canvas/workflow-runtime";

const root = await mkdtemp(join(tmpdir(), "skyturn-mvp-demo-"));
let keepRoot = false;

try {
  await seedProject(root);
  const project = {
    id: "project-demo",
    name: "skyturn-mvp-demo",
    rootPath: root,
    devflowPath: join(root, ".devflow"),
    openedAt: new Date().toISOString(),
  };
  const seedSession = createFastCanvasSession({
    projectId: project.id,
    goal: "Improve the local workflow helper",
    createdAt: new Date().toISOString(),
  });
  const input = addRequirementPlanningNode(completeSeedPlanningNode(seedSession), "Add a task-local evidence summary to a TypeScript workflow helper", {
    projectName: project.name,
    now: new Date().toISOString(),
  });
  const session = input.session;
  let workspace = {
    projects: [project],
    sessions: [session],
    changesets: {},
    agents: [],
    runs: {},
    runEvents: {},
    runEvidence: {},
    activeProjectId: project.id,
    activeSessionId: session.id,
    sidebarCollapsed: false,
    collapsedProjectIds: [],
  };
  const bridge = new AgentBridge({
    adapters: [createHermesCliAdapter(), createCodexCliAdapter()],
  });

  const hermesNode = input.node;
  const hermesRun = await bridge.startRun({
    protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
    runId: hermesNode.runId,
    nodeId: hermesNode.id,
    sessionId: session.id,
    projectRoot: root,
    worktreePath: root,
    agentKind: "hermes",
    prompt: buildPromptForNodeRun(session, hermesNode),
  });
  await waitForFinalStatus(bridge, hermesRun.id);
  const hermesEvents = await loadRunEvents(root, hermesRun.id);
  workspace = mergeRunEventsIntoWorkspace(workspace, hermesRun.id, hermesEvents);

  const activeSession = workspace.sessions.find((item) => item.id === session.id);
  const codexNode = activeSession?.kind === "canvas"
    ? activeSession.nodes.find((node) => node.agent === "codex" && node.status === "running")
    : null;
  if (!codexNode) {
    throw new Error("Hermes did not create a running Codex workflow card.");
  }

  const codexRun = await bridge.startRun({
    protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
    runId: codexNode.runId,
    nodeId: codexNode.id,
    sessionId: session.id,
    projectRoot: root,
    worktreePath: root,
    agentKind: "codex",
    prompt: [
      `Task: ${codexNode.context.brief}`,
      "Inspect the repo and return a concise implementation summary.",
      "Do not modify files; report any blocker and command/output evidence.",
    ].join("\n"),
  });
  await waitForFinalStatus(bridge, codexRun.id);
  const codexEvents = await loadRunEvents(root, codexRun.id);
  workspace = mergeRunEventsIntoWorkspace(workspace, codexRun.id, codexEvents);

  const finalSession = workspace.sessions.find((item) => item.id === session.id);
  if (!finalSession || finalSession.kind !== "canvas") {
    throw new Error("Demo session did not remain a canvas session.");
  }
  const finalHermesNode = finalSession.nodes.find((node) => node.id === hermesNode.id);
  const finalCodexNode = finalSession.nodes.find((node) => node.id === codexNode.id);
  const hermesOutput = hermesEvents
    .filter((event) => event.kind === "output" && typeof event.payload.text === "string")
    .map((event) => event.payload.text)
    .join("\n");
  const toolCalls = parseHermesWorkflowToolCalls(hermesOutput);
  const toolsUsed = [...new Set(toolCalls.map((call) => call.tool))].sort();
  const graph = workflowGraphSummary(finalSession, hermesNode.id, hermesRun.id);
  const ok =
    toolsUsed.includes("createWorkflowCard") &&
    finalHermesNode?.status === "completed" &&
    finalCodexNode?.status === "completed" &&
    Boolean(workspace.runEvidence[codexRun.id]?.checks.some((check) => check.status === "passed")) &&
    graph.connected &&
    graph.primaryCodexImplementationCount <= 1 &&
    graph.hermesVerificationCount <= 1 &&
    graph.duplicateSemanticKeys.length === 0;

  keepRoot = !ok;
  console.log(JSON.stringify({
    ok,
    projectRoot: root,
    hermes: {
      runId: hermesRun.id,
      inputRequirement: hermesNode.context.brief,
      status: finalHermesNode?.status ?? null,
      toolsUsed,
      toolCallCount: toolCalls.length,
    },
    codex: {
      runId: codexRun.id,
      cardId: codexNode.id,
      status: finalCodexNode?.status ?? null,
      outputPreview: finalCodexNode?.output.slice(0, 3) ?? [],
      evidence: workspace.runEvidence[codexRun.id] ?? null,
      worktreePath: root,
    },
    cards: finalSession.nodes.map((node) => ({
      id: node.id,
      agent: node.agent,
      status: node.status,
      title: node.title,
      dependencies: node.context.dependencies,
    })),
    edges: finalSession.edges,
    graph,
  }, null, 2));

  if (!ok) process.exitCode = 1;
} finally {
  if (!keepRoot) await rm(root, { recursive: true, force: true });
}

async function seedProject(projectRoot) {
  await mkdir(join(projectRoot, "src"), { recursive: true });
  await writeFile(join(projectRoot, "package.json"), JSON.stringify({
    name: "skyturn-mvp-demo",
    type: "module",
    scripts: {
      test: "node src/workflow.js",
    },
  }, null, 2));
  await writeFile(join(projectRoot, "src", "workflow.js"), [
    "export function evidenceSummary(status) {",
    "  return `status:${status}`;",
    "}",
    "",
    "console.log(evidenceSummary('pending'));",
    "",
  ].join("\n"));
  await run("git", ["init"], projectRoot);
}

function completeSeedPlanningNode(session) {
  return {
    ...session,
    nodes: session.nodes.map((node) => ({
      ...node,
      status: "completed",
      progress: "Seed canvas ready",
      runtime: {
        phase: "Completed",
        message: "Seed canvas ready",
        action: "ready for workflow input",
      },
      output: ["Seed canvas ready for workflow input."],
    })),
    activeNodeId: null,
  };
}

function waitForFinalStatus(bridge, runId) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      unsubscribe();
      reject(new Error(`Timed out waiting for ${runId}`));
    }, 180_000);
    const unsubscribe = bridge.onRunEvent((event) => {
      if (event.runId !== runId || event.kind !== "status") return;
      const status = event.payload.status;
      if (status !== "succeeded" && status !== "failed" && status !== "cancelled" && status !== "timed-out") return;
      clearTimeout(timeout);
      unsubscribe();
      resolve(event);
    });
  });
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: "ignore",
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

function workflowGraphSummary(session, rootCardId, sourceRunId) {
  const generated = session.nodes.filter((node) => node.id === rootCardId || node.workflowTrace?.sourceRunId === sourceRunId);
  const generatedIds = new Set(generated.map((node) => node.id));
  const generatedEdges = session.edges.filter((edge) => generatedIds.has(edge.source) && generatedIds.has(edge.target));
  const incoming = new Map(generated.map((node) => [node.id, 0]));
  const outgoing = new Map(generated.map((node) => [node.id, []]));

  for (const edge of generatedEdges) {
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    outgoing.get(edge.source)?.push(edge.target);
  }

  const visited = new Set();
  const queue = [rootCardId];
  while (queue.length > 0) {
    const id = queue.shift();
    if (!id || visited.has(id)) continue;
    visited.add(id);
    for (const next of outgoing.get(id) ?? []) queue.push(next);
  }

  const disconnectedCardIds = generated
    .filter((node) => node.id !== rootCardId && ((incoming.get(node.id) ?? 0) === 0 || !visited.has(node.id)))
    .map((node) => node.id);
  const semanticKeys = generated
    .map((node) => node.workflowTrace?.semanticKey ?? `${node.agent}:${normalizeText(node.title)}:${normalizeText(node.context.brief)}`)
    .filter(Boolean);
  const duplicateSemanticKeys = [...new Set(semanticKeys.filter((key, index) => semanticKeys.indexOf(key) !== index))];

  return {
    connected: disconnectedCardIds.length === 0,
    rootCardId,
    generatedCardIds: [...generatedIds],
    generatedEdges,
    disconnectedCardIds,
    duplicateSemanticKeys,
    primaryCodexImplementationCount: generated.filter((node) => node.agent === "codex").length,
    hermesVerificationCount: generated.filter((node) => node.agent === "hermes" && isVerifierCard(node)).length,
  };
}

function isVerifierCard(node) {
  const text = normalizeText(`${node.title} ${node.context.brief}`);
  return /\b(verify|verification|validate|validation|review|check|test|qa|audit)\b/.test(text) ||
    /验证|验收|复核|检查|测试/.test(`${node.title} ${node.context.brief}`);
}

function normalizeText(value) {
  return value.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ").replace(/\s+/g, " ").trim();
}
