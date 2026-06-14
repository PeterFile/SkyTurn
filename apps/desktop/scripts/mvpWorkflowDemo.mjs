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
import { parseHermesWorkflowIntent } from "@skyturn/orchestrator";
import { createFastCanvasSession } from "@skyturn/planner";
import { addRequirementPlanningNode } from "@skyturn/ui-canvas/composer";
import { buildPromptForNodeRun, mergeRunEventsIntoWorkspace } from "@skyturn/ui-canvas/workflow-runtime";

const root = await mkdtemp(join(tmpdir(), "skyturn-mvp-demo-"));
let keepRoot = true;

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
  const firstInput = addRequirementPlanningNode(completeSeedPlanningNode(seedSession), "Add a task-local evidence summary to a TypeScript workflow helper", {
    projectName: project.name,
    now: new Date().toISOString(),
  });
  let session = firstInput.session;
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

  const firstHermesNode = firstInput.node;
  const firstHermesRun = await startHermesPlannerRun(bridge, root, session, firstHermesNode);
  await waitForFinalStatus(bridge, firstHermesRun.id);
  const firstHermesEvents = await loadRunEvents(root, firstHermesRun.id);
  workspace = mergeRunEventsIntoWorkspace(workspace, firstHermesRun.id, firstHermesEvents);

  const afterFirst = workspace.sessions.find((item) => item.id === session.id);
  if (!afterFirst || afterFirst.kind !== "canvas") {
    throw new Error("First planning pass did not keep a canvas session.");
  }
  const secondInput = addRequirementPlanningNode(afterFirst, "Add a task-local evidence summary to a TypeScript workflow helper", {
    projectName: project.name,
    now: new Date(Date.now() + 1_000).toISOString(),
  });
  const samePlannerIdentity = secondInput.session.hermesPlannerSessionId === firstInput.session.hermesPlannerSessionId;
  const samePlannerRootCard = secondInput.node.id === firstInput.node.id;
  if (!samePlannerIdentity || !samePlannerRootCard || secondInput.node.runId === firstInput.node.runId) {
    throw new Error("Repeated workflow input did not reuse the CanvasSession Hermes planner identity.");
  }
  session = secondInput.session;
  workspace = {
    ...workspace,
    sessions: workspace.sessions.map((item) => (item.id === session.id ? session : item)),
  };

  const hermesNode = secondInput.node;
  const hermesRun = await startHermesPlannerRun(bridge, root, session, hermesNode);
  await waitForFinalStatus(bridge, hermesRun.id);
  const hermesEvents = await loadRunEvents(root, hermesRun.id);
  workspace = mergeRunEventsIntoWorkspace(workspace, hermesRun.id, hermesEvents);

  const activeSession = workspace.sessions.find((item) => item.id === session.id);
  const codexNode = activeSession?.kind === "canvas"
    ? activeSession.nodes.find((node) => node.agent === "codex" && node.display?.meta.includes("flow-kernel"))
    : null;
  if (!codexNode) {
    console.log(JSON.stringify({
      ok: false,
      projectRoot: root,
      error: "Hermes WorkflowIntent did not project a Codex Flow Kernel lane.",
      firstHermesOutput: outputFromEvents(firstHermesEvents),
      secondHermesOutput: outputFromEvents(hermesEvents),
      activeSession: activeSession?.kind === "canvas" ? canvasSummary(activeSession) : null,
    }, null, 2));
    throw new Error("Hermes WorkflowIntent did not project a Codex Flow Kernel lane.");
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
  const firstHermesIntents = workflowIntentsFromEvents(firstHermesEvents);
  const secondHermesIntents = workflowIntentsFromEvents(hermesEvents);
  const intents = [...firstHermesIntents, ...secondHermesIntents];
  const graph = flowKernelGraphSummary(finalSession, hermesNode.id);
  const ok =
    intents.length >= 2 &&
    finalHermesNode?.status === "completed" &&
    finalCodexNode?.status === "completed" &&
    Boolean(workspace.runEvidence[codexRun.id]?.checks.some((check) => check.status === "passed")) &&
    graph.connected &&
    graph.rootDependencyIds.length === 0 &&
    graph.rootIncomingEdgeIds.length === 0 &&
    graph.codexLaneCount > 0 &&
    graph.duplicateSemanticKeys.length === 0;

  keepRoot = !ok;
  console.log(JSON.stringify({
    ok,
    projectRoot: root,
    planner: {
      plannerSessionId: session.hermesPlannerSessionId,
      samePlannerIdentity,
      samePlannerRootCard,
      firstRunId: firstHermesRun.id,
      secondRunId: hermesRun.id,
    },
    hermes: {
      runId: hermesRun.id,
      inputRequirement: hermesNode.context.brief,
      status: finalHermesNode?.status ?? null,
      intentIds: intents.map((intent) => intent.intentId),
      firstIntentIds: firstHermesIntents.map((intent) => intent.intentId),
      secondIntentIds: secondHermesIntents.map((intent) => intent.intentId),
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

function startHermesPlannerRun(bridge, root, session, hermesNode) {
  return bridge.startRun({
    protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
    runId: hermesNode.runId,
    nodeId: hermesNode.id,
    sessionId: session.id,
    plannerSessionId: session.hermesPlannerSessionId,
    plannerInputId: hermesNode.runId,
    projectRoot: root,
    worktreePath: root,
    agentKind: "hermes",
    prompt: buildPromptForNodeRun(session, hermesNode),
  });
}

function workflowIntentsFromEvents(events) {
  return events.flatMap((event) => {
    if (event.kind !== "output" || typeof event.payload.text !== "string") return [];
    const parsed = parseHermesWorkflowIntent(event.payload.text);
    return parsed.ok ? [parsed.intent] : [];
  });
}

function outputFromEvents(events) {
  return events
    .filter((event) => event.kind === "output" && typeof event.payload.text === "string")
    .map((event) => event.payload.text);
}

function canvasSummary(session) {
  return {
    id: session.id,
    plannerNodeId: session.plannerNodeId,
    nodes: session.nodes.map((node) => ({
      id: node.id,
      agent: node.agent,
      status: node.status,
      title: node.title,
      meta: node.display?.meta ?? [],
      dependencies: node.context.dependencies,
    })),
    edges: session.edges,
  };
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

function flowKernelGraphSummary(session, rootCardId) {
  const generated = session.nodes.filter((node) => node.id === rootCardId || node.display?.meta.includes("flow-kernel"));
  const generatedIds = new Set(generated.map((node) => node.id));
  const generatedEdges = session.edges.filter((edge) => generatedIds.has(edge.source) && generatedIds.has(edge.target));
  const rootCard = session.nodes.find((node) => node.id === rootCardId);
  const rootDependencyIds = rootCard?.context.dependencies ?? [];
  const rootIncomingEdgeIds = session.edges.filter((edge) => edge.target === rootCardId).map((edge) => edge.id);
  const incoming = new Map(generated.map((node) => [node.id, 0]));
  const outgoing = new Map(generated.map((node) => [node.id, []]));

  for (const edge of generatedEdges) {
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    outgoing.get(edge.source)?.push(edge.target);
  }

  const flowLaneIds = new Set(generated.filter((node) => node.display?.meta.includes("flow-kernel")).map((node) => node.id));
  const disconnectedCardIds = generated
    .filter((node) => {
      if (node.id === rootCardId) return false;
      if (!flowLaneIds.has(node.id)) return false;
      return node.context.dependencies.some((dependency) => !generatedIds.has(dependency));
    })
    .map((node) => node.id);
  const dependencyMismatchIds = generated
    .filter((node) => flowLaneIds.has(node.id))
    .filter((node) => !arraysEqual([...node.context.dependencies].sort(), incomingDependencies(generatedEdges, node.id)))
    .map((node) => node.id);
  const semanticKeys = generated
    .map((node) => node.workflowTrace?.semanticKey ?? `${node.agent}:${normalizeText(node.title)}:${normalizeText(node.context.brief)}`)
    .filter(Boolean);
  const duplicateSemanticKeys = [...new Set(semanticKeys.filter((key, index) => semanticKeys.indexOf(key) !== index))];

  return {
    connected: disconnectedCardIds.length === 0 && dependencyMismatchIds.length === 0,
    rootCardId,
    rootDependencyIds,
    rootIncomingEdgeIds,
    generatedCardIds: [...generatedIds],
    generatedEdges,
    disconnectedCardIds,
    dependencyMismatchIds,
    duplicateSemanticKeys,
    codexLaneCount: generated.filter((node) => node.agent === "codex" && node.display?.meta.includes("flow-kernel")).length,
  };
}

function incomingDependencies(edges, nodeId) {
  return edges.filter((edge) => edge.target === nodeId).map((edge) => edge.source).sort();
}

function arraysEqual(left, right) {
  if (left.length !== right.length) return false;
  return left.every((value, index) => value === right[index]);
}

function normalizeText(value) {
  return value.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ").replace(/\s+/g, " ").trim();
}
