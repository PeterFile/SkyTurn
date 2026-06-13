import {
  Background,
  BaseEdge,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  getSmoothStepPath,
  type Edge as FlowEdge,
  type EdgeProps,
  type EdgeTypes,
  type Node as FlowNode,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import {
  AlertTriangle,
  CheckCircle2,
  ExternalLink,
  FolderOpen,
  GitBranch,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  RefreshCw,
  Send,
  Square,
  Users,
  X,
} from "lucide-react";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import ReactMarkdown from "react-markdown";

import {
  createMockChangeset,
  mockChangesetService,
  type EditorKind,
} from "@skyturn/git-worktree";
import {
  browserEditorAdapter,
  emptyWorkspace,
  loadWorkspaceState,
  saveWorkspaceState,
  type OpenProjectResult,
  type WorkspaceState,
} from "@skyturn/persistence";
import { convertPlanToCanvas, createFastCanvasSession, createPlanSession } from "@skyturn/planner";
import {
  NODE_MODAL_TABS,
  RUN_EVENT_PROTOCOL_VERSION,
  deriveNodeStatusFromEvidence,
  type AgentKind,
  type CanvasNode,
  type CanvasSession,
  type CanvasSessionTab,
  type Changeset,
  type ImportedProject,
  type NodeModalTab,
  type NodeRuntimeState,
  type NodeStatus,
  type PlanSession,
  type AgentRun,
  type RunEvent,
  type RunEvidence,
  type WorkflowMode,
} from "@skyturn/project-core";

import {
  EDGE_MOTION_BY_STATUS,
  ENERGY_FRAME,
  MOTION_DISTANCE,
  MOTION_DURATION,
  NODE_MOTION_BY_STATUS,
  phraseForRuntime,
  shouldLoopEdge,
  shouldLoopNode,
} from "./motion.js";

gsap.registerPlugin(useGSAP);

type AgentFlowNode = FlowNode<{
  node: CanvasNode;
  onOpen: (nodeId: string) => void;
}, "agent">;

interface AgentEdgeData extends Record<string, unknown> {
  status: NodeStatus;
  active: boolean;
  interrupted: boolean;
}

type AgentFlowEdge = FlowEdge<AgentEdgeData, "agent">;

const MemoAgentNode = memo(AgentNode);
const MemoAgentEdge = memo(AgentEdge);

const nodeTypes: NodeTypes = {
  agent: MemoAgentNode,
  task: MemoAgentNode,
};

const edgeTypes: EdgeTypes = {
  agent: MemoAgentEdge,
};

export default function App() {
  const [workspace, setWorkspace] = useState<WorkspaceState>(() => {
    return emptyWorkspace();
  });
  const [workspaceLoaded, setWorkspaceLoaded] = useState(false);
  const [homeGoal, setHomeGoal] = useState("");
  const [homeMode, setHomeMode] = useState<WorkflowMode>("fast");
  const [newTaskOpen, setNewTaskOpen] = useState(false);
  const [newTaskGoal, setNewTaskGoal] = useState("");
  const [newTaskMode, setNewTaskMode] = useState<WorkflowMode>("fast");
  const [bottomGoal, setBottomGoal] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [modalTab, setModalTab] = useState<NodeModalTab>("Output");
  const startedBridgeRuns = useRef(new Set<string>());

  const activeProject = workspace.projects.find((project) => project.id === workspace.activeProjectId) ?? null;
  const activeSession = workspace.sessions.find((session) => session.id === workspace.activeSessionId) ?? null;
  const selectedNode =
    activeSession?.kind === "canvas"
      ? activeSession.nodes.find((node: CanvasNode) => node.id === selectedNodeId) ?? null
      : null;

  useEffect(() => {
    let active = true;
    void loadWorkspaceState().then((state) => {
      if (!active) return;
      setWorkspace(state);
      setWorkspaceLoaded(true);
    });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (workspaceLoaded) void saveWorkspaceState(workspace);
  }, [workspace, workspaceLoaded]);

  useEffect(() => {
    if (window.devflow) return;
    const timer = window.setInterval(() => {
      setWorkspace((current) => ({
        ...current,
        sessions: current.sessions.map((session) =>
          session.id === current.activeSessionId && session.kind === "canvas"
            ? advanceMockRun(session)
            : session,
        ),
      }));
    }, 1100);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!window.devflow || !activeProject) return;
    let active = true;
    void window.devflow.discoverAgents().then((result) => {
      if (!active) return;
      setWorkspace((current) => ({ ...current, agents: result.agents }));
    });
    return () => {
      active = false;
    };
  }, [activeProject?.id]);

  useEffect(() => {
    if (!window.devflow) return;
    return window.devflow.onRunEvent((event) => {
      setWorkspace((current) => applyRunEventToWorkspace(current, event));
    });
  }, []);

  useEffect(() => {
    if (!window.devflow || !activeProject || activeSession?.kind !== "canvas") return;
    for (const node of activeSession.nodes) {
      if (node.status !== "running" && node.status !== "retrying") continue;
      if (startedBridgeRuns.current.has(node.runId)) continue;
      startedBridgeRuns.current.add(node.runId);
      void startBridgeRun(activeProject, activeSession, node).then((result) => {
        if (!result) return;
        setWorkspace((current) => applyBridgeRunResult(current, result));
      });
    }
  }, [activeProject, activeSession]);

  useEffect(() => {
    if (!window.devflow || !activeProject || !selectedNode) return;
    let active = true;
    void window.devflow.getRunEvents(activeProject.rootPath, selectedNode.runId).then((result) => {
      if (!active || result.events.length === 0) return;
      setWorkspace((current) => mergeRunEventsIntoWorkspace(current, selectedNode.runId, result.events));
    });
    return () => {
      active = false;
    };
  }, [activeProject, selectedNode?.runId]);

  const openSelectedNode = useCallback((nodeId: string) => {
    setSelectedNodeId(nodeId);
    setModalTab("Output");
  }, []);

  async function openProject() {
    const result = window.devflow ? await window.devflow.openProject() : await openMockProject();
    if (result.canceled || !result.project) return;

    if (window.devflow) {
      await window.devflow.initializeProjectMemory(result.project.rootPath);
    }

    const project = makeProject(result.project);
    const initialSession = homeGoal.trim()
      ? createSession(project.id, homeGoal.trim(), homeMode)
      : null;

    setWorkspace((current) => ({
      ...current,
      projects: upsertProject(current.projects, project),
      sessions: initialSession ? [...current.sessions, initialSession] : current.sessions,
      changesets: initialSession
        ? { ...current.changesets, ...changesetsForSession(initialSession) }
        : current.changesets,
      activeProjectId: project.id,
      activeSessionId: initialSession?.id ?? current.activeSessionId,
    }));
  }

  function addSessionFromComposer() {
    if (!activeProject || !newTaskGoal.trim()) return;
    const session = createSession(activeProject.id, newTaskGoal.trim(), newTaskMode);
    setWorkspace((current) => ({
      ...current,
      sessions: [...current.sessions, session],
      changesets: { ...current.changesets, ...changesetsForSession(session) },
      activeSessionId: session.id,
    }));
    setNewTaskGoal("");
    setNewTaskOpen(false);
  }

  function confirmPlan(session: PlanSession) {
    const canvas = convertPlanToCanvas(session);
    setWorkspace((current) => ({
      ...current,
      sessions: current.sessions.map((item) => (item.id === session.id ? canvas : item)),
      changesets: { ...current.changesets, ...changesetsForSession(canvas) },
      activeSessionId: canvas.id,
    }));
  }

  function updateCanvasSession(
    sessionId: string,
    updater: (session: CanvasSession) => CanvasSession,
  ) {
    setWorkspace((current) => ({
      ...current,
      sessions: current.sessions.map((session) =>
        session.id === sessionId && session.kind === "canvas" ? updater(session) : session,
      ),
    }));
  }

  function updateNode(nodeId: string, updater: (node: CanvasNode) => CanvasNode) {
    if (!activeSession || activeSession.kind !== "canvas") return;
    updateCanvasSession(activeSession.id, (session) => ({
      ...session,
      nodes: session.nodes.map((node) => (node.id === nodeId ? updater(node) : node)),
    }));
  }

  function stopActiveRun() {
    if (!activeSession || activeSession.kind !== "canvas") return;
    const running = activeSession.nodes.find(
      (node: CanvasNode) => node.status === "running" || node.status === "retrying",
    );
    if (!running) return;
    if (window.devflow) {
      void window.devflow.cancelAgentRun(running.runId, "Stopped from workspace controls").then((result) => {
        setWorkspace((current) => ({
          ...current,
          runEvidence: { ...current.runEvidence, [running.runId]: result.evidence },
        }));
      });
    }
    updateNode(running.id, (node) => ({
      ...node,
      status: "failed",
      progress: "Stopped; output persisted",
      output: [...node.output, "Run cancelled. Current output and status were persisted."],
    }));
  }

  function stopNodeRun(target: CanvasNode) {
    if (window.devflow) {
      void window.devflow.cancelAgentRun(target.runId, "Stopped from node modal").then((result) => {
        setWorkspace((current) => ({
          ...current,
          runEvidence: { ...current.runEvidence, [target.runId]: result.evidence },
        }));
      });
    }
    updateNode(target.id, (node) => ({
      ...node,
      status: "failed",
      progress: "Stopped; output persisted",
      output: [...node.output, "Run cancelled from node modal."],
    }));
  }

  function appendRequirementNode() {
    if (!activeSession || activeSession.kind !== "canvas" || !bottomGoal.trim()) return;
    const id = `node-${activeSession.nodes.length + 1}`;
    const lastNode = activeSession.nodes.at(-1);
    const node: CanvasNode = {
      id,
      title: bottomGoal.trim().slice(0, 56),
      agent: "hermes",
      progress: "Inserted requirement",
      status: "pending",
      position: { x: 180 + activeSession.nodes.length * 150, y: 360 },
      runId: `run-${activeSession.id}-${id}`,
      changesetId: `changeset-${activeSession.id}-${id}`,
      output: ["Requirement inserted into the task graph."],
      worktree: {
        path: `../${activeProject?.name ?? "project"}.worktrees/session-${activeSession.id}-task-${id}`,
        branchName: `skyturn/${activeSession.id}/${id}`,
        baseCommit: "mock-base-commit",
      },
      context: {
        brief: bottomGoal.trim(),
        sessionGoal: activeSession.goal,
        relatedRequirements: "Inserted from the bottom input bar.",
        relatedDesign: "Hermes will reconcile this with the existing graph.",
        relatedTasks: "New task-local node.",
        dependencies: lastNode ? [lastNode.id] : [],
        constraints: ["No global console.", "Preserve task-local output.", "Verify before completion."],
      },
    };
    const edge = lastNode ? { id: `edge-${lastNode.id}-${id}`, source: lastNode.id, target: id } : null;
    updateCanvasSession(activeSession.id, (session) => ({
      ...session,
      nodes: [...session.nodes, node],
      edges: edge ? [...session.edges, edge] : session.edges,
      activeNodeId: node.id,
    }));
    setWorkspace((current) => ({
      ...current,
      changesets: { ...current.changesets, [node.changesetId]: createMockChangeset(node) },
    }));
    setBottomGoal("");
  }

  function retryNode(nodeId: string) {
    updateNode(nodeId, (node) => ({
      ...node,
      status: "retrying",
      progress: "Retrying",
      output: [...node.output, "Retry requested. Resume brief created from checkpoint."],
    }));
  }

  function reassignNode(nodeId: string) {
    const order: AgentKind[] = ["hermes", "codex", "gemini", "claude-code", "openclaw"];
    updateNode(nodeId, (node) => {
      const nextAgent = order[(order.indexOf(node.agent) + 1) % order.length];
      return {
        ...node,
        agent: nextAgent,
        progress: `Reassigned to ${nextAgent}`,
        output: [...node.output, `Task reassigned to ${nextAgent}.`],
      };
    });
  }

  function insertBefore(nodeId: string) {
    if (!activeSession || activeSession.kind !== "canvas") return;
    const target = activeSession.nodes.find((node: CanvasNode) => node.id === nodeId);
    if (!target) return;

    const id = `node-${activeSession.nodes.length + 1}`;
    const node: CanvasNode = {
      ...target,
      id,
      title: "Clarify dependency",
      agent: "hermes",
      status: "pending",
      progress: "Inserted before target",
      runId: `run-${activeSession.id}-${id}`,
      changesetId: `changeset-${activeSession.id}-${id}`,
      position: { x: Math.max(40, target.position.x - 260), y: target.position.y + 140 },
      output: ["Dependency inserted before target node."],
      context: {
        ...target.context,
        brief: "Clarify constraints before the selected task runs.",
        dependencies: target.context.dependencies,
      },
      worktree: {
        ...target.worktree,
        branchName: `skyturn/${activeSession.id}/${id}`,
      },
    };

    updateCanvasSession(activeSession.id, (session) => ({
      ...session,
      nodes: session.nodes
        .map((item) =>
          item.id === target.id
            ? {
                ...item,
                context: {
                  ...item.context,
                  dependencies: [...new Set([...item.context.dependencies, id])],
                },
              }
            : item,
        )
        .concat(node),
      edges: [...session.edges, { id: `edge-${id}-${target.id}`, source: id, target: target.id }],
    }));
    setWorkspace((current) => ({
      ...current,
      changesets: { ...current.changesets, [node.changesetId]: createMockChangeset(node) },
    }));
  }

  async function openEditor(editor: EditorKind, node: CanvasNode) {
    const result = await browserEditorAdapter.openWorktree(editor, node.worktree.path);
    updateNode(node.id, (current) => ({
      ...current,
      output: [...current.output, result.message],
    }));
  }

  if (!activeProject) {
    return (
      <Home
        goal={homeGoal}
        mode={homeMode}
        onGoalChange={setHomeGoal}
        onModeChange={setHomeMode}
        onOpenProject={openProject}
      />
    );
  }

  return (
    <div className="app-shell">
      <TopBar
        project={activeProject}
        sessions={workspace.sessions.filter((session) => session.projectId === activeProject.id)}
        activeSessionId={workspace.activeSessionId}
        newTaskOpen={newTaskOpen}
        newTaskGoal={newTaskGoal}
        newTaskMode={newTaskMode}
        onSelectSession={(sessionId) =>
          setWorkspace((current) => ({ ...current, activeSessionId: sessionId }))
        }
        onToggleNewTask={() => setNewTaskOpen((open) => !open)}
        onNewTaskGoal={setNewTaskGoal}
        onNewTaskMode={setNewTaskMode}
        onCreateSession={addSessionFromComposer}
      />

      <div className="workspace">
        <aside className={workspace.sidebarCollapsed ? "sidebar collapsed" : "sidebar"}>
          <button
            className="icon-button sidebar-toggle"
            title={workspace.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            onClick={() =>
              setWorkspace((current) => ({ ...current, sidebarCollapsed: !current.sidebarCollapsed }))
            }
          >
            {workspace.sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>
          {!workspace.sidebarCollapsed && (
	        <Sidebar
	          projects={workspace.projects}
	          sessions={workspace.sessions.filter((session) => session.projectId === activeProject.id)}
	          agents={workspace.agents}
	          activeProjectId={activeProject.id}
              activeSessionId={workspace.activeSessionId}
              onSelectProject={(projectId) =>
                setWorkspace((current) => ({ ...current, activeProjectId: projectId }))
              }
              onSelectSession={(sessionId) =>
                setWorkspace((current) => ({ ...current, activeSessionId: sessionId }))
              }
            />
          )}
        </aside>

        <main className="stage">
          {activeSession?.kind === "plan" && <PlanView session={activeSession} onConfirm={confirmPlan} />}
          {activeSession?.kind === "canvas" && (
            <CanvasView session={activeSession} onOpenNode={openSelectedNode} />
          )}
          {!activeSession && <EmptyWorkspace onNewTask={() => setNewTaskOpen(true)} />}
        </main>
      </div>

      <BottomBar
        value={bottomGoal}
        onChange={setBottomGoal}
        disabled={!activeSession || activeSession.kind !== "canvas"}
        onSubmit={appendRequirementNode}
        onStop={stopActiveRun}
      />

      {selectedNode && activeSession?.kind === "canvas" && (
        <NodeModal
          node={selectedNode}
          tab={modalTab}
          onTab={setModalTab}
          onClose={() => setSelectedNodeId(null)}
	          onStop={() =>
	            stopNodeRun(selectedNode)
	          }
          onRetry={() => retryNode(selectedNode.id)}
          onReassign={() => reassignNode(selectedNode.id)}
          onInsertBefore={() => insertBefore(selectedNode.id)}
          onOpenEditor={(editor) => openEditor(editor, selectedNode)}
        />
      )}
    </div>
  );
}

function Home({
  goal,
  mode,
  onGoalChange,
  onModeChange,
  onOpenProject,
}: {
  goal: string;
  mode: WorkflowMode;
  onGoalChange: (value: string) => void;
  onModeChange: (mode: WorkflowMode) => void;
  onOpenProject: () => void;
}) {
  return (
    <main className="home">
      <section className="home-panel" aria-label="Open project">
        <div className="brand-row">
          <div>
            <p className="eyebrow">SkyTurn</p>
            <h1>Development workflow canvas</h1>
          </div>
          <ModeSwitch mode={mode} onChange={onModeChange} />
        </div>
        <textarea
          className="home-input"
          value={goal}
          onChange={(event) => onGoalChange(event.target.value)}
          placeholder="Task goal"
          aria-label="Task goal"
        />
        <button className="primary-action" onClick={onOpenProject}>
          <FolderOpen size={18} />
          Open Project
        </button>
      </section>
    </main>
  );
}

function TopBar({
  project,
  sessions,
  activeSessionId,
  newTaskOpen,
  newTaskGoal,
  newTaskMode,
  onSelectSession,
  onToggleNewTask,
  onNewTaskGoal,
  onNewTaskMode,
  onCreateSession,
}: {
  project: ImportedProject;
  sessions: CanvasSessionTab[];
  activeSessionId: string | null;
  newTaskOpen: boolean;
  newTaskGoal: string;
  newTaskMode: WorkflowMode;
  onSelectSession: (sessionId: string) => void;
  onToggleNewTask: () => void;
  onNewTaskGoal: (goal: string) => void;
  onNewTaskMode: (mode: WorkflowMode) => void;
  onCreateSession: () => void;
}) {
  return (
    <header className="topbar">
      <div className="project-chip">
        <FolderOpen size={16} />
        <span>{project.name}</span>
      </div>
      <nav className="session-tabs" aria-label="Canvas sessions">
        {sessions.map((session, index) => (
          <button
            key={session.id}
            className={session.id === activeSessionId ? "session-tab active" : "session-tab"}
            onClick={() => onSelectSession(session.id)}
          >
            <span>{`Session ${index + 1}`}</span>
            <small>{session.mode}</small>
          </button>
        ))}
        <button className="new-tab-button" onClick={onToggleNewTask}>
          <Plus size={16} />
          New Tab
        </button>
      </nav>
      {newTaskOpen && (
        <form
          className="new-task"
          onSubmit={(event) => {
            event.preventDefault();
            onCreateSession();
          }}
        >
          <input
            value={newTaskGoal}
            onChange={(event) => onNewTaskGoal(event.target.value)}
            placeholder="New task goal"
            aria-label="New task goal"
          />
          <ModeSwitch mode={newTaskMode} onChange={onNewTaskMode} compact />
          <button className="icon-button solid" title="Create session" type="submit">
            <Play size={16} />
          </button>
        </form>
      )}
    </header>
  );
}

function Sidebar({
  projects,
  sessions,
  agents,
  activeProjectId,
  activeSessionId,
  onSelectProject,
  onSelectSession,
}: {
  projects: ImportedProject[];
  sessions: CanvasSessionTab[];
  agents: WorkspaceState["agents"];
  activeProjectId: string;
  activeSessionId: string | null;
  onSelectProject: (projectId: string) => void;
  onSelectSession: (sessionId: string) => void;
}) {
  return (
    <div className="sidebar-inner">
      <section>
        <h2>Projects</h2>
        {projects.map((project) => (
          <button
            key={project.id}
            className={project.id === activeProjectId ? "sidebar-row active" : "sidebar-row"}
            onClick={() => onSelectProject(project.id)}
          >
            <FolderOpen size={15} />
            <span>{project.name}</span>
          </button>
        ))}
      </section>
      <section>
        <h2>Sessions</h2>
        {sessions.map((session) => (
          <button
            key={session.id}
            className={session.id === activeSessionId ? "sidebar-row active" : "sidebar-row"}
            onClick={() => onSelectSession(session.id)}
          >
            <GitBranch size={15} />
            <span>{session.title}</span>
          </button>
        ))}
      </section>
      <section>
        <h2>Status</h2>
        {(["completed", "failed", "retrying", "running", "pending"] as NodeStatus[]).map((status) => (
          <div className="status-row" key={status}>
            <StatusLight status={status} />
            <span>{status}</span>
          </div>
        ))}
      </section>
      <section>
        <h2>Agents</h2>
        {agents.map((agent) => (
          <div className="agent-row" key={agent.kind}>
            <span>{agent.label}</span>
            <small>{`${agent.status} / ${agent.supportLevel}`}</small>
          </div>
        ))}
        {agents.length === 0 && <div className="agent-row muted">No agents discovered</div>}
      </section>
    </div>
  );
}

function EmptyWorkspace({ onNewTask }: { onNewTask: () => void }) {
  return (
    <section className="empty-stage">
      <button className="primary-action" onClick={onNewTask}>
        <Plus size={18} />
        New Tab
      </button>
    </section>
  );
}

function PlanView({ session, onConfirm }: { session: PlanSession; onConfirm: (session: PlanSession) => void }) {
  return (
    <section className="plan-view">
      <div className="plan-header">
        <div>
          <p className="eyebrow">Plan</p>
          <h2>{session.title}</h2>
        </div>
        <button className="primary-action compact-action" onClick={() => onConfirm(session)}>
          <Play size={16} />
          Convert to Canvas
        </button>
      </div>
      <div className="markdown-grid">
        <article>
          <ReactMarkdown>{session.plan.requirements}</ReactMarkdown>
        </article>
        <article>
          <ReactMarkdown>{session.plan.design}</ReactMarkdown>
        </article>
        <article>
          <ReactMarkdown>{session.plan.tasks}</ReactMarkdown>
        </article>
      </div>
    </section>
  );
}

function CanvasView({
  session,
  onOpenNode,
}: {
  session: CanvasSession;
  onOpenNode: (nodeId: string) => void;
}) {
  const nodeById = useMemo(() => new Map(session.nodes.map((node) => [node.id, node])), [session.nodes]);
  const nodes = useMemo<AgentFlowNode[]>(
    () =>
      session.nodes.map((node) => ({
        id: node.id,
        type: "agent",
        position: node.position,
        initialWidth: ENERGY_FRAME.width,
        initialHeight: ENERGY_FRAME.height,
        handles: agentNodeHandles(),
        data: { node, onOpen: onOpenNode },
      })),
    [onOpenNode, session.nodes],
  );
  const edges = useMemo<AgentFlowEdge[]>(
    () =>
      session.edges.map((edge) => {
        const source = nodeById.get(edge.source);
        const target = nodeById.get(edge.target);
        const descends = Boolean(source && target && target.position.y > source.position.y + 120);
        const status = target?.status ?? "pending";
        const active = status === "running";
        const isInterrupted = target?.status === "retrying" || target?.status === "failed";
        const stroke = edgeColorForStatus(status);

        return {
          ...edge,
          type: "agent",
          sourceHandle: descends ? "source-bottom" : "source-right",
          targetHandle: descends ? "target-top" : "target-left",
          interactionWidth: 18,
          markerEnd: { type: MarkerType.ArrowClosed, color: stroke, width: 14, height: 14 },
          data: { status, active, interrupted: isInterrupted },
        } satisfies AgentFlowEdge;
      }),
    [nodeById, session.edges],
  );

  return (
    <section className="canvas-stage">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.18 }}
        minZoom={0.35}
        maxZoom={1.35}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#d8dee8" gap={18} size={1.15} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </section>
  );
}

const AGENT_HANDLE_SIZE = 9;
const AGENT_HANDLE_OFFSET = -5;

function agentNodeHandles(): AgentFlowNode["handles"] {
  const centerX = ENERGY_FRAME.width / 2 - AGENT_HANDLE_SIZE / 2;
  const centerY = ENERGY_FRAME.height / 2 - AGENT_HANDLE_SIZE / 2;
  return [
    {
      id: "target-left",
      type: "target",
      position: Position.Left,
      x: AGENT_HANDLE_OFFSET,
      y: centerY,
      width: AGENT_HANDLE_SIZE,
      height: AGENT_HANDLE_SIZE,
    },
    {
      id: "target-top",
      type: "target",
      position: Position.Top,
      x: centerX,
      y: AGENT_HANDLE_OFFSET,
      width: AGENT_HANDLE_SIZE,
      height: AGENT_HANDLE_SIZE,
    },
    {
      id: "source-right",
      type: "source",
      position: Position.Right,
      x: ENERGY_FRAME.width + AGENT_HANDLE_OFFSET,
      y: centerY,
      width: AGENT_HANDLE_SIZE,
      height: AGENT_HANDLE_SIZE,
    },
    {
      id: "source-bottom",
      type: "source",
      position: Position.Bottom,
      x: centerX,
      y: ENERGY_FRAME.height + AGENT_HANDLE_OFFSET,
      width: AGENT_HANDLE_SIZE,
      height: AGENT_HANDLE_SIZE,
    },
  ];
}

function AgentEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  markerEnd,
  interactionWidth,
  data,
  selected,
}: EdgeProps<AgentFlowEdge>) {
  const signalRef = useRef<SVGPathElement | null>(null);
  const previousStatusRef = useRef<NodeStatus>(data?.status ?? "pending");
  const [edgePath] = getSmoothStepPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    borderRadius: 28,
  });
  const status = data?.status ?? "pending";
  const active = Boolean(data?.active);
  const interrupted = Boolean(data?.interrupted);
  const showSignal = active || interrupted;

  useGSAP(
    () => {
      const signal = signalRef.current;
      if (!signal) return;

      const policy = EDGE_MOTION_BY_STATUS[status];
      const reducedMotion = userPrefersReducedMotion();
      const previousStatus = previousStatusRef.current;
      const cameFromActive = previousStatus === "running" || previousStatus === "retrying";
      previousStatusRef.current = status;
      gsap.killTweensOf(signal);
      gsap.set(signal, {
        autoAlpha: 0,
        strokeDasharray: policy.dasharray,
        strokeDashoffset: 0,
      });

      if (shouldLoopEdge({ status, active }, reducedMotion)) {
        gsap.set(signal, { autoAlpha: policy.opacity, strokeDashoffset: 0 });
        const flow = gsap.to(signal, {
          strokeDashoffset: -168,
          duration: 1.45,
          ease: "none",
          repeat: -1,
        });
        return () => flow.kill();
      }

      if (!reducedMotion && interrupted && cameFromActive) {
        const interruption = gsap.timeline();
        interruption
          .set(signal, { autoAlpha: policy.opacity, strokeDashoffset: 0 })
          .to(signal, { strokeDashoffset: -28, duration: 0.24, ease: "power2.out" })
          .to(signal, { autoAlpha: 0, duration: 0.18, ease: "power2.out" }, 0.18);

        return () => interruption.kill();
      }
    },
    { dependencies: [active, interrupted, status], scope: signalRef, revertOnUpdate: true },
  );

  return (
    <g className={`agent-edge ${status}${active ? " active" : ""}${selected ? " selected" : ""}`}>
      <BaseEdge
        id={id}
        path={edgePath}
        markerEnd={markerEnd}
        interactionWidth={interactionWidth ?? 18}
        className="agent-edge-base"
      />
      {showSignal && <path ref={signalRef} className="agent-edge-flow" d={edgePath} markerEnd={markerEnd} />}
    </g>
  );
}

function AgentNode({ data, selected }: NodeProps<AgentFlowNode>) {
  const node = data.node;
  const rootRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<SVGRectElement | null>(null);
  const glintRef = useRef<SVGRectElement | null>(null);
  const statusDotRef = useRef<HTMLSpanElement | null>(null);
  const phraseRef = useRef<HTMLSpanElement | null>(null);
  const previousPhraseRef = useRef<HTMLSpanElement | null>(null);
  const handlesRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLButtonElement | null>(null);
  const previousStatusRef = useRef<NodeStatus>(node.status);
  const completedShimmerPlayed = useRef(false);
  const gradientKey = useId().replaceAll(":", "");
  const runningGradientId = `agent-running-${gradientKey}`;
  const retryingGradientId = `agent-retrying-${gradientKey}`;
  const runtime = runtimeForNode(node);
  const footer = nodeFooterForNode(node, runtime);
  const summary = nodeSummaryForNode(node);
  const phrase = phraseForRuntime(runtime);
  const [phraseState, setPhraseState] = useState<{ current: string; previous: string | null }>({
    current: phrase,
    previous: null,
  });

  useEffect(() => {
    setPhraseState((current) =>
      current.current === phrase ? current : { current: phrase, previous: current.current },
    );
  }, [phrase]);

  useGSAP(
    () => {
      const root = rootRef.current;
      if (!root) return;

      gsap.set(root, { autoAlpha: 1, clearProps: "transform,filter" });
      if (userPrefersReducedMotion()) {
        return;
      }

      gsap.fromTo(
        root,
        {
          autoAlpha: 0,
          scale: MOTION_DISTANCE.enterScaleStart,
          y: MOTION_DISTANCE.enterY,
          filter: "blur(8px)",
        },
        {
          autoAlpha: 1,
          scale: 1,
          y: 0,
          filter: "blur(0px)",
          duration: MOTION_DURATION.enter,
          ease: "power3.out",
          immediateRender: false,
          clearProps: "transform,filter",
        },
      );
    },
    { scope: rootRef },
  );

  useGSAP(
    () => {
      const card = cardRef.current;
      const frame = frameRef.current;
      const glint = glintRef.current;
      const statusDot = statusDotRef.current;
      if (!card || !frame || !glint || !statusDot) return;

      const policy = NODE_MOTION_BY_STATUS[node.status];
      const previousStatus = previousStatusRef.current;
      const cameFromActive = previousStatus === "running" || previousStatus === "retrying";
      previousStatusRef.current = node.status;
      if (node.status !== "completed") completedShimmerPlayed.current = false;

      gsap.killTweensOf([card, frame, glint, statusDot]);
      gsap.set(card, { x: 0 });
      gsap.set(frame, {
        autoAlpha: policy.frameOpacity,
        stroke: frameStrokeForStatus(node.status, runningGradientId, retryingGradientId),
        strokeDasharray: policy.frameDasharray,
        strokeDashoffset: 0,
      });
      gsap.set(glint, {
        autoAlpha: 0,
        stroke: glintStrokeForStatus(node.status, runningGradientId, retryingGradientId),
        strokeDasharray: policy.glintDasharray,
        strokeDashoffset: 0,
      });
      gsap.set(statusDot, {
        autoAlpha: 1,
        scale: 1,
        backgroundColor: statusColorForStatus(node.status),
        transformOrigin: "50% 50%",
      });

      if (userPrefersReducedMotion()) {
        return;
      }

      if (shouldLoopNode(node.status)) {
        if (node.status === "running") {
          gsap.set(glint, { autoAlpha: 0.76, strokeDashoffset: 0 });
          const loop = gsap.to(glint, {
            strokeDashoffset: -ENERGY_FRAME.pathLength,
            duration: MOTION_DURATION.energyLoop,
            ease: "none",
            repeat: -1,
          });
          const dot = gsap.to(statusDot, {
            autoAlpha: 0.55,
            scale: 1.16,
            duration: 1.18,
            ease: "sine.inOut",
            repeat: -1,
            yoyo: true,
          });

          return () => {
            loop.kill();
            dot.kill();
          };
        }

        gsap.set(glint, { autoAlpha: 0.44, strokeDashoffset: 0 });
        const retryFrame = gsap.to(frame, {
          strokeDashoffset: -14,
          duration: 0.42,
          ease: "sine.inOut",
          repeat: -1,
          repeatDelay: 0.82,
        });
        const retryDot = gsap.to(statusDot, {
          autoAlpha: 0.64,
          scale: 1.1,
          duration: 0.4,
          ease: "sine.inOut",
          repeat: -1,
          repeatDelay: 0.9,
          yoyo: true,
        });

        return () => {
          retryFrame.kill();
          retryDot.kill();
        };
      }

      if (node.status === "completed" && cameFromActive && !completedShimmerPlayed.current) {
        completedShimmerPlayed.current = true;
        const shimmer = gsap.timeline();
        shimmer
          .set(glint, {
            autoAlpha: 0.86,
            stroke: glintStrokeForStatus("completed", runningGradientId, retryingGradientId),
            strokeDasharray: policy.glintDasharray,
            strokeDashoffset: 28,
          })
          .to(glint, {
            strokeDashoffset: -ENERGY_FRAME.pathLength,
            duration: MOTION_DURATION.shimmer,
            ease: "power2.out",
          })
          .to(glint, { autoAlpha: 0, duration: 0.12, ease: "power2.out" }, 0.56);

        return () => shimmer.kill();
      }

      if (node.status === "failed" && cameFromActive) {
        const failure = gsap.timeline();
        failure
          .set(glint, {
            autoAlpha: 0.7,
            stroke: glintStrokeForStatus("failed", runningGradientId, retryingGradientId),
            strokeDasharray: policy.glintDasharray,
            strokeDashoffset: 18,
          })
          .to(frame, { autoAlpha: 0.82, duration: 0.08, ease: "power2.out" }, 0)
          .to(
            card,
            {
              x: MOTION_DISTANCE.failedShakeX,
              duration: 0.045,
              ease: "power1.inOut",
              repeat: 3,
              yoyo: true,
            },
            0,
          )
          .to(glint, { strokeDashoffset: -34, duration: 0.2, ease: "power2.out" }, 0)
          .to(glint, { autoAlpha: 0, duration: 0.12, ease: "power2.out" }, 0.14)
          .to(frame, { autoAlpha: policy.frameOpacity, duration: 0.16, ease: "power2.out" }, 0.1)
          .set(card, { x: 0 });

        return () => failure.kill();
      }
    },
    { dependencies: [node.id, node.status], scope: rootRef, revertOnUpdate: true },
  );

  useGSAP(
    (_context, contextSafe) => {
      const root = rootRef.current;
      const card = cardRef.current;
      const handles = handlesRef.current;
      const menu = menuRef.current;
      if (!root || !card || !handles || !menu) return;
      const safe = contextSafe ?? (<T extends (...args: never[]) => unknown>(fn: T) => fn);

      gsap.killTweensOf([card, handles, menu]);
      gsap.set(card, { y: 0, scale: selected ? MOTION_DISTANCE.selectedScale : 1 });
      gsap.set(handles, {
        autoAlpha: selected ? 1 : 0,
        scale: selected ? 1 : 0.92,
        transformOrigin: "50% 50%",
      });
      gsap.set(menu, { autoAlpha: selected ? 1 : 0.72 });

      if (userPrefersReducedMotion()) {
        return;
      }

      const activate = safe(() => {
        gsap.to(card, {
          y: MOTION_DISTANCE.hoverLift,
          scale: selected ? MOTION_DISTANCE.selectedScale : 1,
          duration: MOTION_DURATION.fast,
          ease: "power2.out",
          overwrite: "auto",
        });
        gsap.to(handles, {
          autoAlpha: 1,
          scale: 1,
          duration: MOTION_DURATION.fast,
          ease: "power2.out",
          overwrite: "auto",
        });
        gsap.to(menu, {
          autoAlpha: 1,
          duration: MOTION_DURATION.fast,
          ease: "power2.out",
          overwrite: "auto",
        });
      });

      const deactivate = safe(() => {
        gsap.to(card, {
          y: 0,
          scale: selected ? MOTION_DISTANCE.selectedScale : 1,
          duration: MOTION_DURATION.fast,
          ease: "power2.out",
          overwrite: "auto",
        });
        gsap.to(handles, {
          autoAlpha: selected ? 1 : 0,
          scale: selected ? 1 : 0.92,
          duration: MOTION_DURATION.fast,
          ease: "power2.out",
          overwrite: "auto",
        });
        gsap.to(menu, {
          autoAlpha: selected ? 1 : 0.72,
          duration: MOTION_DURATION.fast,
          ease: "power2.out",
          overwrite: "auto",
        });
      });

      root.addEventListener("pointerenter", activate);
      root.addEventListener("pointerleave", deactivate);
      root.addEventListener("focusin", activate);
      root.addEventListener("focusout", deactivate);

      return () => {
        root.removeEventListener("pointerenter", activate);
        root.removeEventListener("pointerleave", deactivate);
        root.removeEventListener("focusin", activate);
        root.removeEventListener("focusout", deactivate);
      };
    },
    { dependencies: [selected], scope: rootRef, revertOnUpdate: true },
  );

  useGSAP(
    (_context, contextSafe) => {
      const current = phraseRef.current;
      const previous = previousPhraseRef.current;
      if (!current) return;
      const safe = contextSafe ?? (<T extends (...args: never[]) => unknown>(fn: T) => fn);

      gsap.killTweensOf([current, previous].filter(Boolean));
      if (userPrefersReducedMotion()) {
        gsap.set(current, { autoAlpha: 1, y: 0 });
        if (previous) setPhraseState((state) => ({ ...state, previous: null }));
        return;
      }

      const clearPrevious = safe(() => {
        setPhraseState((state) => ({ ...state, previous: null }));
      });
      const phraseTimeline = gsap.timeline({ onComplete: previous ? clearPrevious : undefined });

      if (previous) {
        phraseTimeline.to(previous, {
          autoAlpha: 0,
          y: -MOTION_DISTANCE.phraseShift,
          duration: MOTION_DURATION.normal,
          ease: "power2.out",
        }, 0);
      }
      phraseTimeline.fromTo(
        current,
        { autoAlpha: previous ? 0 : 1, y: previous ? MOTION_DISTANCE.phraseShift : 0 },
        {
          autoAlpha: 1,
          y: 0,
          duration: previous ? MOTION_DURATION.normal : 0,
          ease: "power2.out",
        },
        previous ? 0.04 : 0,
      );

      return () => phraseTimeline.kill();
    },
    { dependencies: [phraseState.current, phraseState.previous], scope: rootRef, revertOnUpdate: true },
  );

  function openFromKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    data.onOpen(node.id);
  }

  return (
    <div
      ref={rootRef}
      className={`agent-node-shell ${node.status}${selected ? " selected" : ""}`}
    >
      <svg
        className="energy-frame"
        aria-hidden="true"
        viewBox={`0 0 ${ENERGY_FRAME.width} ${ENERGY_FRAME.height}`}
        preserveAspectRatio="none"
      >
        <defs>
          <linearGradient id={runningGradientId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#22d3ee" />
            <stop offset="46%" stopColor="#818cf8" />
            <stop offset="100%" stopColor="#a78bfa" />
          </linearGradient>
          <linearGradient id={retryingGradientId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#f59e0b" />
            <stop offset="100%" stopColor="#fbbf24" />
          </linearGradient>
        </defs>
        <rect
          ref={frameRef}
          className="energy-frame-base"
          x={ENERGY_FRAME.inset}
          y={ENERGY_FRAME.inset}
          width={ENERGY_FRAME.width - ENERGY_FRAME.inset * 2}
          height={ENERGY_FRAME.height - ENERGY_FRAME.inset * 2}
          rx={ENERGY_FRAME.radius}
          ry={ENERGY_FRAME.radius}
          pathLength={ENERGY_FRAME.pathLength}
        />
        <rect
          ref={glintRef}
          className="energy-glint"
          x={ENERGY_FRAME.inset}
          y={ENERGY_FRAME.inset}
          width={ENERGY_FRAME.width - ENERGY_FRAME.inset * 2}
          height={ENERGY_FRAME.height - ENERGY_FRAME.inset * 2}
          rx={ENERGY_FRAME.radius}
          ry={ENERGY_FRAME.radius}
          pathLength={ENERGY_FRAME.pathLength}
        />
      </svg>
      <div ref={handlesRef} className="agent-handles">
        <Handle id="target-left" type="target" position={Position.Left} className="node-handle target-left" />
        <Handle id="target-top" type="target" position={Position.Top} className="node-handle target-top" />
        <Handle id="source-right" type="source" position={Position.Right} className="node-handle source-right" />
        <Handle id="source-bottom" type="source" position={Position.Bottom} className="node-handle source-bottom" />
      </div>
      <div
        ref={cardRef}
        className="agent-card"
        role="button"
        tabIndex={0}
        aria-label={`${node.title}: ${agentIdentityForNode(node)}. ${footer.primary} ${footer.secondary}. ${summary}`}
        title={nodeTooltipForNode(node, runtime)}
        onClick={() => data.onOpen(node.id)}
        onKeyDown={openFromKeyboard}
      >
        <div className="agent-node-header">
          <span className="agent-node-title">{node.title}</span>
          <button
            ref={menuRef}
            className="agent-node-menu nodrag"
            type="button"
            aria-label={`Open actions for ${node.title}`}
            onClick={(event) => event.stopPropagation()}
          >
            <MoreHorizontal size={16} aria-hidden="true" />
          </button>
        </div>
        <div className="agent-identity-pill">
          <span ref={statusDotRef} className="agent-dot status-dot" aria-hidden="true" />
          <span>{agentIdentityForNode(node)}</span>
        </div>
        <p className="agent-summary">{summary}</p>
        <p className="runtime-phrase" aria-live="polite">
          {phraseState.previous && (
            <span ref={previousPhraseRef} className="runtime-phrase-copy exiting">
              {phraseState.previous}
            </span>
          )}
          <span ref={phraseRef} className="runtime-phrase-copy">
            {phraseState.current}
          </span>
        </p>
        <div className={`agent-footer ${node.status}`} aria-label="Node status summary">
          {node.status === "completed" && <CheckCircle2 size={13} aria-hidden="true" />}
          {node.status === "failed" && <AlertTriangle size={13} aria-hidden="true" />}
          <span>{footer.primary}</span>
          <span className="footer-separator" aria-hidden="true">·</span>
          <span>{footer.secondary}</span>
        </div>
      </div>
    </div>
  );
}

const AGENT_LABELS: Record<AgentKind, string> = {
  hermes: "Hermes",
  codex: "Codex",
  gemini: "Gemini",
  "claude-code": "ClaudeCode",
  openclaw: "OpenClaw",
};

function agentIdentityForNode(node: CanvasNode): string {
  return AGENT_LABELS[node.agent];
}

function nodeSummaryForNode(node: CanvasNode): string {
  return node.context.brief.trim() || node.progress.trim() || "Waiting for execution context.";
}

function nodeFooterForNode(
  node: CanvasNode,
  runtime: NodeRuntimeState,
): { primary: string; secondary: string } {
  const action = runtime.action.trim() || node.progress.trim() || "Waiting for evidence";
  switch (node.status) {
    case "pending":
      return { primary: "Queued", secondary: action };
    case "running":
      return { primary: runtime.phase === "Think" ? "Thinking" : runtime.phase, secondary: action };
    case "retrying":
      return { primary: "Retrying", secondary: action };
    case "completed":
      return { primary: "Verified", secondary: "Evidence ready" };
    case "failed":
      return { primary: "Attention", secondary: action };
  }
}

function nodeTooltipForNode(node: CanvasNode, runtime: NodeRuntimeState): string {
  return [
    node.title,
    `Status: ${node.status}`,
    `Agent: ${agentIdentityForNode(node)}`,
    `Run: ${node.runId}`,
    `Branch: ${node.worktree.branchName}`,
    `Worktree: ${node.worktree.path}`,
    `Runtime: ${runtime.phase} — ${runtime.action}`,
  ].join("\n");
}

function edgeColorForStatus(status: NodeStatus): string {
  switch (status) {
    case "running":
      return "#7c8cff";
    case "retrying":
      return "#d97706";
    case "failed":
      return "#dc6b65";
    case "completed":
      return "#a8b4c1";
    case "pending":
      return "#cbd5e1";
  }
}

function frameStrokeForStatus(status: NodeStatus, runningGradientId: string, retryingGradientId: string): string {
  switch (status) {
    case "running":
      return `url(#${runningGradientId})`;
    case "retrying":
      return `url(#${retryingGradientId})`;
    case "completed":
      return "rgba(63, 127, 95, 0.62)";
    case "failed":
      return "rgba(180, 83, 74, 0.72)";
    case "pending":
      return "rgba(148, 163, 184, 0.5)";
  }
}

function glintStrokeForStatus(status: NodeStatus, runningGradientId: string, retryingGradientId: string): string {
  switch (status) {
    case "running":
      return `url(#${runningGradientId})`;
    case "retrying":
      return `url(#${retryingGradientId})`;
    case "completed":
      return "rgba(34, 197, 94, 0.82)";
    case "failed":
      return "rgba(220, 107, 101, 0.8)";
    case "pending":
      return "rgba(148, 163, 184, 0)";
  }
}

function statusColorForStatus(status: NodeStatus): string {
  switch (status) {
    case "running":
      return "#6366f1";
    case "retrying":
      return "#d97706";
    case "completed":
      return "#2f7d50";
    case "failed":
      return "#b4534a";
    case "pending":
      return "#94a3b8";
  }
}

function userPrefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function runtimeForNode(node: CanvasNode): NodeRuntimeState {
  if (node.runtime && runtimeMatchesStatus(node.runtime, node.status)) return node.runtime;

  const action = node.progress.trim() || "waiting for next evidence";
  switch (node.status) {
    case "pending":
      return { phase: "Queued", message: "正在等待调度", action };
    case "running":
      return { phase: "Executing", message: "正在执行任务", action };
    case "retrying":
      return { phase: "Retrying", message: "正在重新尝试", action };
    case "completed":
      return { phase: "Completed", message: "已完成验证", action };
    case "failed":
      return { phase: "Failed", message: "等待人工处理", action };
  }
}

function runtimeMatchesStatus(runtime: NodeRuntimeState, status: NodeStatus): boolean {
  if (status === "pending") return runtime.phase === "Queued";
  if (status === "retrying") return runtime.phase === "Retrying";
  if (status === "completed") return runtime.phase === "Completed";
  if (status === "failed") return runtime.phase === "Failed";
  return ["Think", "Planning", "Executing", "Testing", "Validating", "Summarizing"].includes(
    runtime.phase,
  );
}

function NodeModal({
  node,
  tab,
  onTab,
  onClose,
  onStop,
  onRetry,
  onReassign,
  onInsertBefore,
  onOpenEditor,
}: {
  node: CanvasNode;
  tab: NodeModalTab;
  onTab: (tab: NodeModalTab) => void;
  onClose: () => void;
  onStop: () => void;
  onRetry: () => void;
  onReassign: () => void;
  onInsertBefore: () => void;
  onOpenEditor: (editor: EditorKind) => void;
}) {
  const backdropRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const closingRef = useRef(false);

  useGSAP(
    () => {
      const backdrop = backdropRef.current;
      const panel = panelRef.current;
      if (!backdrop || !panel) return;

      closingRef.current = false;
      gsap.killTweensOf([backdrop, panel]);
      gsap.set(backdrop, { autoAlpha: 1 });
      gsap.set(panel, { autoAlpha: 1, x: 0 });
      if (userPrefersReducedMotion()) return;

      gsap.fromTo(backdrop, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.18, ease: "power2.out" });
      gsap.fromTo(
        panel,
        { autoAlpha: 0, x: 28 },
        { autoAlpha: 1, x: 0, duration: MOTION_DURATION.inspector, ease: "power3.out" },
      );
    },
    { dependencies: [node.id], scope: backdropRef, revertOnUpdate: true },
  );

  function closeWithMotion() {
    const backdrop = backdropRef.current;
    const panel = panelRef.current;
    if (closingRef.current || !backdrop || !panel || userPrefersReducedMotion()) {
      onClose();
      return;
    }

    closingRef.current = true;
    gsap.killTweensOf([backdrop, panel]);
    gsap.timeline({ onComplete: onClose })
      .to(panel, { autoAlpha: 0, x: 28, duration: 0.2, ease: "power2.in" }, 0)
      .to(backdrop, { autoAlpha: 0, duration: 0.16, ease: "power2.out" }, 0);
  }

  return (
    <div ref={backdropRef} className="modal-backdrop" role="presentation">
      <section ref={panelRef} className="node-modal" role="dialog" aria-modal="true" aria-label={node.title}>
        <header className="modal-header">
          <div>
            <p className="eyebrow">{node.agent}</p>
            <h2>{node.title}</h2>
          </div>
          <button className="icon-button" title="Close" onClick={closeWithMotion}>
            <X size={18} />
          </button>
        </header>
        <div className="modal-actions">
          <button onClick={onStop}>
            <Square size={15} />
            Stop
          </button>
          <button onClick={onRetry}>
            <RefreshCw size={15} />
            Retry
          </button>
          <button onClick={onReassign}>
            <Users size={15} />
            Reassign
          </button>
          <button onClick={onInsertBefore}>
            <Plus size={15} />
            Insert Before
          </button>
          <button onClick={() => onOpenEditor("vscode")}>
            <ExternalLink size={15} />
            Open Worktree in VSCode
          </button>
          <button onClick={() => onOpenEditor("cursor")}>
            <ExternalLink size={15} />
            Open Worktree in Cursor
          </button>
          <button onClick={() => onOpenEditor("zed")}>
            <ExternalLink size={15} />
            Open Worktree in Zed
          </button>
        </div>
        <nav className="modal-tabs" aria-label="Node details">
          {NODE_MODAL_TABS.map((item) => (
            <button
              key={item}
              className={item === tab ? "active" : ""}
              onClick={() => onTab(item)}
            >
              {item}
            </button>
          ))}
        </nav>
        <div className="modal-body">
          {tab === "Output" && <OutputTab node={node} />}
          {tab === "Changes" && <ChangesTab node={node} />}
          {tab === "Context" && <ContextTab node={node} />}
        </div>
      </section>
    </div>
  );
}

function OutputTab({ node }: { node: CanvasNode }) {
  return (
    <div className="output-lines">
      {node.output.map((line, index) => (
        <p key={`${node.id}-${index}`}>{line}</p>
      ))}
      {node.output.length === 0 && <p>No node output yet.</p>}
    </div>
  );
}

function ChangesTab({ node }: { node: CanvasNode }) {
  const [changeset, setChangeset] = useState<Changeset | null>(null);

  useEffect(() => {
    let active = true;
    void mockChangesetService.getChangeset(node).then((value) => {
      if (active) setChangeset(value);
    });
    return () => {
      active = false;
    };
  }, [node]);

  if (!changeset) return <p>Loading changes...</p>;

  return (
    <div className="changes-view">
      <div className="diff-stat">
        <span>+{changeset.diffStat.added}</span>
        <span>~{changeset.diffStat.changed}</span>
        <span>-{changeset.diffStat.deleted}</span>
        <small>{changeset.source}</small>
      </div>
      <ul>
        {changeset.files.map((file) => (
          <li key={file}>{file}</li>
        ))}
      </ul>
      <pre>{changeset.patchPreview}</pre>
    </div>
  );
}

function ContextTab({ node }: { node: CanvasNode }) {
  return (
    <dl className="context-grid">
      <dt>Brief</dt>
      <dd>{node.context.brief}</dd>
      <dt>Session goal</dt>
      <dd>{node.context.sessionGoal}</dd>
      <dt>Dependencies</dt>
      <dd>{node.context.dependencies.length ? node.context.dependencies.join(", ") : "None"}</dd>
      <dt>Assigned agent</dt>
      <dd>{node.agent}</dd>
      <dt>Worktree path</dt>
      <dd>{node.worktree.path}</dd>
      <dt>Branch name</dt>
      <dd>{node.worktree.branchName}</dd>
      <dt>Base commit</dt>
      <dd>{node.worktree.baseCommit}</dd>
      <dt>Requirements source</dt>
      <dd>{node.context.relatedRequirements}</dd>
      <dt>Design source</dt>
      <dd>{node.context.relatedDesign}</dd>
      <dt>Tasks source</dt>
      <dd>{node.context.relatedTasks}</dd>
      <dt>Constraints</dt>
      <dd>{node.context.constraints.join("; ")}</dd>
    </dl>
  );
}

function BottomBar({
  value,
  disabled,
  onChange,
  onSubmit,
  onStop,
}: {
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
}) {
  return (
    <footer className="bottom-bar">
      <button className="icon-button" title="Stop active run" onClick={onStop} disabled={disabled}>
        <Square size={17} />
      </button>
      <input
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Insert requirement or node"
        aria-label="Insert requirement or node"
        onKeyDown={(event) => {
          if (event.key === "Enter") onSubmit();
        }}
      />
      <button className="icon-button solid" title="Insert requirement" onClick={onSubmit} disabled={disabled}>
        <Send size={17} />
      </button>
    </footer>
  );
}

function ModeSwitch({
  mode,
  compact = false,
  onChange,
}: {
  mode: WorkflowMode;
  compact?: boolean;
  onChange: (mode: WorkflowMode) => void;
}) {
  return (
    <div className={compact ? "mode-switch compact" : "mode-switch"} role="group" aria-label="Mode">
      <button className={mode === "fast" ? "active" : ""} onClick={() => onChange("fast")} type="button">
        Fast
      </button>
      <button className={mode === "plan" ? "active" : ""} onClick={() => onChange("plan")} type="button">
        Plan
      </button>
    </div>
  );
}

function StatusLight({ status }: { status: NodeStatus }) {
  return <span className={`status-light ${status}`} aria-label={status} />;
}

function createSession(projectId: string, goal: string, mode: WorkflowMode): CanvasSessionTab {
  const createdAt = new Date().toISOString();
  return mode === "fast"
    ? createFastCanvasSession({ projectId, goal, createdAt })
    : createPlanSession({ projectId, goal, createdAt });
}

function changesetsForSession(session: CanvasSessionTab): WorkspaceState["changesets"] {
  if (session.kind !== "canvas") return {};
  return Object.fromEntries(session.nodes.map((node) => [node.changesetId, createMockChangeset(node)]));
}

function advanceMockRun(session: CanvasSession): CanvasSession {
  const activeIndex = session.nodes.findIndex(
    (node) => (node.status === "running" || node.status === "retrying") && !hasAuthoredDisplayState(node),
  );
  if (activeIndex === -1) return session;

  const nodes = [...session.nodes];
  const node = nodes[activeIndex];
  const nextLine = nextMockOutputLine(node, node.output.length);
  const output = [...node.output, nextLine];

  if (output.length >= 5) {
    const run = {
      id: node.runId,
      nodeId: node.id,
      sessionId: session.id,
      projectRoot: session.projectId,
      worktreePath: node.worktree.path,
      agentKind: node.agent,
      status: "succeeded" as const,
      startedAt: session.createdAt,
      endedAt: new Date().toISOString(),
    };
    const evidence = {
      runId: node.runId,
      status: "succeeded" as const,
      exitCode: 0,
      changesetId: node.changesetId,
      checks: [{ kind: "run-exit" as const, name: "Browser mock run", status: "passed" as const }],
      artifacts: [],
      review: null,
      errorReason: null,
      cancelReason: null,
      completedAt: run.endedAt,
    };
    nodes[activeIndex] = {
      ...node,
      status: deriveNodeStatusFromEvidence(run, evidence),
      progress: "Evidence ready",
      output,
    };
    const nextIndex = nodes.findIndex(
      (candidate) =>
        candidate.status === "pending" &&
        candidate.context.dependencies.every((dependency) =>
          nodes.some((item) => item.id === dependency && item.status === "completed"),
        ),
    );
    if (nextIndex !== -1) {
      nodes[nextIndex] = {
        ...nodes[nextIndex],
        status: "running",
        progress: "Running",
        output: [...nodes[nextIndex].output, "Run started by Hermes orchestrator."],
      };
    }
  } else {
    nodes[activeIndex] = {
      ...node,
      status: node.status === "retrying" ? "retrying" : "running",
      progress: node.status === "retrying" ? "Retry checkpoint" : "Streaming output",
      output,
    };
  }

  return {
    ...session,
    nodes,
    updatedAt: new Date().toISOString(),
  };
}

function hasAuthoredDisplayState(node: CanvasNode): boolean {
  return node.runtime !== undefined || node.display !== undefined;
}

function nextMockOutputLine(node: CanvasNode, lineIndex: number): string {
  const lines = [
    `${node.agent} accepted run ${node.runId}.`,
    `${node.agent} is writing task-local output under .devflow/tasks/${node.id}.`,
    `${node.agent} recorded changeset evidence ${node.changesetId}.`,
    `${node.agent} text may say completed, but RunEvidence decides status.`,
  ];
  return lines[lineIndex] ?? `${node.agent} is waiting for the next checkpoint.`;
}

interface BridgeRunResult {
  run: AgentRun;
  events: RunEvent[];
  evidence: RunEvidence;
}

async function startBridgeRun(
  project: ImportedProject,
  session: CanvasSession,
  node: CanvasNode,
): Promise<BridgeRunResult | null> {
  const result = await window.devflow?.startAgentRun({
    protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
    runId: node.runId,
    nodeId: node.id,
    sessionId: session.id,
    projectRoot: project.rootPath,
    worktreePath: node.worktree.path,
    agentKind: node.agent,
    prompt: node.context.brief,
  });
  if (!result || !window.devflow) return null;
  const [eventsResult, evidenceResult] = await Promise.all([
    window.devflow.getRunEvents(project.rootPath, node.runId),
    window.devflow.getRunEvidence(project.rootPath, node.runId),
  ]);
  return { run: result.run, events: eventsResult.events, evidence: evidenceResult.evidence };
}

function applyBridgeRunResult(workspace: WorkspaceState, result: BridgeRunResult): WorkspaceState {
  const withEvents = mergeRunEventsIntoWorkspace(workspace, result.run.id, result.events);
  const status = deriveNodeStatusFromEvidence(result.run, result.evidence);
  return {
    ...withEvents,
    runs: { ...withEvents.runs, [result.run.id]: result.run },
    runEvidence: { ...withEvents.runEvidence, [result.run.id]: result.evidence },
    sessions: withEvents.sessions.map((session) =>
      session.kind === "canvas"
        ? {
            ...session,
            nodes: session.nodes.map((node: CanvasNode) =>
              node.runId === result.run.id
                ? {
                    ...node,
                    status,
                    progress: status === "completed" ? "Evidence ready" : "Run evidence incomplete",
                  }
                : node,
            ),
          }
        : session,
    ),
  };
}

function applyRunEventToWorkspace(workspace: WorkspaceState, event: RunEvent): WorkspaceState {
  return mergeRunEventsIntoWorkspace(workspace, event.runId, [...(workspace.runEvents[event.runId] ?? []), event]);
}

function mergeRunEventsIntoWorkspace(
  workspace: WorkspaceState,
  runId: string,
  events: RunEvent[],
): WorkspaceState {
  const deduped = dedupeRunEvents(events);
  return {
    ...workspace,
    runEvents: { ...workspace.runEvents, [runId]: deduped },
    sessions: workspace.sessions.map((session) =>
      session.kind === "canvas"
        ? {
            ...session,
            nodes: session.nodes.map((node: CanvasNode) =>
              node.runId === runId ? applyRunEventsToNode(node, deduped) : node,
            ),
          }
        : session,
    ),
  };
}

function applyRunEventsToNode(node: CanvasNode, events: RunEvent[]): CanvasNode {
  const output = outputFromEvents(events);
  if (output.length === 0) return node;
  return {
    ...node,
    output,
    progress: node.status === "running" ? "Streaming persisted output" : node.progress,
  };
}

function outputFromEvents(events: RunEvent[]): string[] {
  return events
    .filter((event) => event.kind === "output")
    .map((event) => (typeof event.payload.text === "string" ? event.payload.text : ""))
    .filter(Boolean);
}

function dedupeRunEvents(events: RunEvent[]): RunEvent[] {
  return [...new Map(events.map((event) => [event.seq, event])).values()].sort((left, right) => left.seq - right.seq);
}

function makeProject(project: { name: string; rootPath: string; devflowPath: string }): ImportedProject {
  return {
    id: `project-${stableId(project.rootPath)}`,
    name: project.name,
    rootPath: project.rootPath,
    devflowPath: project.devflowPath,
    openedAt: new Date().toISOString(),
  };
}

function upsertProject(projects: ImportedProject[], project: ImportedProject): ImportedProject[] {
  return projects.some((item) => item.id === project.id)
    ? projects.map((item) => (item.id === project.id ? project : item))
    : [...projects, project];
}

function stableId(value: string): string {
  let hash = 0;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0;
  }
  return hash.toString(36);
}

async function openMockProject(): Promise<OpenProjectResult> {
  return {
    canceled: false,
    project: {
      name: "SkyTurn Demo",
      rootPath: "/tmp/skyturn-demo",
      devflowPath: "/tmp/skyturn-demo/.devflow",
    },
  };
}
