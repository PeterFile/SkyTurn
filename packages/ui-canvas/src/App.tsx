import {
  Background,
  BaseEdge,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  getSmoothStepPath,
  useNodesState,
  type Edge as FlowEdge,
  type EdgeProps,
  type EdgeTypes,
  type NodeChange,
  type Node as FlowNode,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import gsap from "gsap";
import { useGSAP } from "@gsap/react";
import {
  AlertTriangle,
  ArrowUp,
  CheckCircle2,
  Check,
  ChevronDown,
  ChevronRight,
  Columns2,
  Copy,
  Eye,
  EyeOff,
  FileText,
  FoldVertical,
  FolderOpen,
  GitBranch,
  GitPullRequest,
  ListTree,
  MoreHorizontal,
  PanelLeftClose,
  PanelLeftOpen,
  Play,
  Plus,
  RefreshCw,
  Settings,
  Square,
  WrapText,
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
  type ReactNode,
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
  type UserDecisionAction,
  type WorkflowMode,
} from "@skyturn/project-core";

import {
  EDGE_MOTION_BY_STATUS,
  ENERGY_FRAME,
  MOTION_DISTANCE,
  MOTION_DURATION,
  NODE_MOTION_BY_STATUS,
  shouldLoopEdge,
  shouldLoopNode,
} from "./motion.js";
import {
  applyCanvasNodePositionUpdates,
  positionUpdatesFromNodeChanges,
  type CanvasNodePositionUpdate,
} from "./canvasState.js";
import DecryptedText from "./DecryptedText.js";
import {
  chooseActiveSessionIdForProject,
  renameSessionTitle,
  resolveSessionProjectId,
  toggleCollapsedProjectId,
} from "./sessionState.js";
import {
  DEFAULT_EDITOR_LAUNCH_OPTION,
  EDITOR_LAUNCH_OPTIONS,
  type EditorLaunchOption,
} from "./editorLaunchOptions.js";
import {
  DEFAULT_CHANGES_DIFF_OPTIONS,
  renderChangesetDiffHtml,
  type ChangesDiffViewOptions,
} from "./diffViewer.js";
import { streamingLogLineForNode, type StreamingLogLine } from "./streamingLog.js";
import {
  applyBridgeRunResult,
  applyRunEventToWorkspace,
  mergeRunEventsIntoWorkspace,
  retryCanvasNode,
  startBridgeRun,
} from "./workflowRuntime.js";
import { addRequirementPlanningNode } from "./composer.js";

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
  const [newTaskGoal, setNewTaskGoal] = useState("");
  const [newTaskMode, setNewTaskMode] = useState<WorkflowMode>("fast");
  const [newTaskProjectId, setNewTaskProjectId] = useState<string | null>(null);
  const [bottomGoal, setBottomGoal] = useState("");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [modalTab, setModalTab] = useState<NodeModalTab>("Output");
  const startedBridgeRuns = useRef(new Set<string>());

  const activeProject = workspace.projects.find((project) => project.id === workspace.activeProjectId) ?? null;
  const activeSession =
    workspace.sessions.find(
      (session) => session.id === workspace.activeSessionId && session.projectId === activeProject?.id,
    ) ?? null;
  const selectedNode =
    activeSession?.kind === "canvas"
      ? activeSession.nodes.find((node: CanvasNode) => node.id === selectedNodeId) ?? null
      : null;
  const resolvedNewTaskProjectId = resolveSessionProjectId(
    workspace.projects,
    newTaskProjectId,
    workspace.activeProjectId,
  );

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
    if (!window.devflow) return;
    return window.devflow.onWorkflowEvent((event) => {
      const canvasSession = canvasSessionFromWorkflowEvent(event);
      if (!canvasSession) return;
      setWorkspace((current) => ({
        ...current,
        sessions: current.sessions.map((session) => (session.id === canvasSession.id ? canvasSession : session)),
      }));
    });
  }, []);

  useEffect(() => {
    if (!window.devflow || !activeProject || activeSession?.kind !== "canvas") return;
    let active = true;
    void window.devflow.getWorkflowProjection(activeProject.rootPath, activeSession.id).then((result) => {
      if (!active || !result.canvasSession) return;
      setWorkspace((current) => ({
        ...current,
        sessions: current.sessions.map((session) => (session.id === result.canvasSession?.id ? result.canvasSession : session)),
      }));
    });
    return () => {
      active = false;
    };
  }, [activeProject?.id, activeSession?.id]);

  useEffect(() => {
    if (!window.devflow || !activeProject || activeSession?.kind !== "canvas") return;
    for (const node of activeSession.nodes) {
      if (node.executable === false) continue;
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

  const activeCanvasSessionId = activeSession?.kind === "canvas" ? activeSession.id : null;
  const updateActiveNodePositions = useCallback(
    (updates: CanvasNodePositionUpdate[]) => {
      if (!activeCanvasSessionId || updates.length === 0) return;
      const updatedAt = new Date().toISOString();

      setWorkspace((current) => ({
        ...current,
        sessions: current.sessions.map((session) => {
          if (session.id !== activeCanvasSessionId || session.kind !== "canvas") return session;
          const nodes = applyCanvasNodePositionUpdates(session.nodes, updates);
          return nodes === session.nodes ? session : { ...session, nodes, updatedAt };
        }),
      }));
    },
    [activeCanvasSessionId],
  );

  async function importProject(initialGoal = "", initialMode: WorkflowMode = "fast") {
    const result = window.devflow ? await window.devflow.openProject() : await openMockProject();
    if (result.canceled || !result.project) return;

    if (window.devflow) {
      await window.devflow.initializeProjectMemory(result.project.rootPath);
    }

    const project = makeProject(result.project);
    const goal = initialGoal.trim();
    const initialSession = goal
      ? createSession(project.id, goal, initialMode)
      : null;
    if (initialSession?.kind === "canvas") {
      await persistCanvasWorkflowSession(project, initialSession, "initial");
    }

    setWorkspace((current) => {
      const sessions = initialSession ? [...current.sessions, initialSession] : current.sessions;
      return {
        ...current,
        projects: upsertProject(current.projects, project),
        sessions,
        changesets: initialSession
          ? { ...current.changesets, ...changesetsForSession(initialSession) }
          : current.changesets,
        activeProjectId: project.id,
        activeSessionId:
          initialSession?.id ?? chooseActiveSessionIdForProject(sessions, current.activeSessionId, project.id),
      };
    });
  }

  function openProjectStartPage(projectId = workspace.activeProjectId) {
    const resolvedProjectId = resolveSessionProjectId(workspace.projects, projectId, workspace.activeProjectId);
    if (!resolvedProjectId) return;

    setNewTaskProjectId(resolvedProjectId);
    setNewTaskGoal("");
    setNewTaskMode("fast");
    setWorkspace((current) => ({
      ...current,
      activeProjectId: resolvedProjectId,
      activeSessionId: null,
    }));
  }

  async function addSessionFromComposer() {
    const goal = newTaskGoal.trim();
    if (!resolvedNewTaskProjectId || !goal) return;
    const projectId = resolvedNewTaskProjectId;
    const project = workspace.projects.find((item) => item.id === projectId);
    const session = createSession(projectId, goal, newTaskMode);
    if (project && session.kind === "canvas") {
      await persistCanvasWorkflowSession(project, session, "composer");
    }
    setWorkspace((current) => ({
      ...current,
      sessions: [...current.sessions, session],
      changesets: { ...current.changesets, ...changesetsForSession(session) },
      activeProjectId: projectId,
      activeSessionId: session.id,
    }));
    setNewTaskGoal("");
  }

  async function confirmPlan(session: PlanSession) {
    const canvas = convertPlanToCanvas(session);
    const project = workspace.projects.find((item) => item.id === canvas.projectId);
    if (project) await persistCanvasWorkflowSession(project, canvas, "plan-confirm");
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

  async function appendRequirementNode() {
    if (!activeSession || activeSession.kind !== "canvas" || !bottomGoal.trim()) return;
    if (window.devflow && activeProject) {
      await window.devflow.appendWorkflowUserInput(activeProject.rootPath, {
        sessionId: activeSession.id,
        inputId: `bottom-${Date.now()}`,
        text: bottomGoal.trim(),
        now: new Date().toISOString(),
      });
    }
    const result = addRequirementPlanningNode(activeSession, bottomGoal, {
      now: new Date().toISOString(),
      projectName: activeProject?.name ?? "project",
    });
    updateCanvasSession(activeSession.id, () => result.session);
    setWorkspace((current) => ({
      ...current,
      changesets: { ...current.changesets, [result.node.changesetId]: createMockChangeset(result.node) },
    }));
    setBottomGoal("");
  }

  function retryNode(nodeId: string) {
    if (!activeSession || activeSession.kind !== "canvas") return;
    updateCanvasSession(activeSession.id, (session) => retryCanvasNode(session, nodeId, new Date().toISOString()));
  }

  function answerUserDecision(nodeId: string, selectedOption: string) {
    if (!activeSession || activeSession.kind !== "canvas") return;
    const now = new Date().toISOString();
    const action = actionForDecisionOption(selectedOption);
    updateCanvasSession(activeSession.id, (session) => ({
      ...session,
      updatedAt: now,
      nodes: session.nodes.map((node) => {
        if (node.id !== nodeId || !node.userDecision) return node;
        return {
          ...node,
          status: "completed",
          progress: "Decision answered",
          userDecision: {
            ...node.userDecision,
            status: "answered",
            selectedOption,
            action,
          },
          output: [...node.output, `Selected: ${selectedOption}`],
        };
      }),
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
      <Home onOpenProject={() => void importProject()} />
    );
  }

  return (
    <div className={workspace.sidebarCollapsed ? "app-shell sidebar-collapsed" : "app-shell"}>
      <aside className={workspace.sidebarCollapsed ? "sidebar collapsed" : "sidebar"}>
        <button
          className="icon-button sidebar-toggle"
          title={workspace.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          aria-label={workspace.sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          onClick={() =>
            setWorkspace((current) => ({ ...current, sidebarCollapsed: !current.sidebarCollapsed }))
          }
        >
          {workspace.sidebarCollapsed ? <PanelLeftOpen size={17} /> : <PanelLeftClose size={17} />}
          <span className="sidebar-toggle-label">{workspace.sidebarCollapsed ? "Expand" : "Collapse"}</span>
        </button>
        {!workspace.sidebarCollapsed && (
          <Sidebar
            projects={workspace.projects}
            sessions={workspace.sessions}
            activeProjectId={activeProject.id}
            activeSessionId={workspace.activeSessionId}
            collapsedProjectIds={workspace.collapsedProjectIds}
            onNewSession={() => openProjectStartPage()}
            onOpenProject={() => void importProject()}
            onSelectProject={(projectId) =>
              setWorkspace((current) => {
                const activeSessionId = chooseActiveSessionIdForProject(
                  current.sessions,
                  current.activeSessionId,
                  projectId,
                );
                return { ...current, activeProjectId: projectId, activeSessionId };
              })
            }
            onSelectSession={(sessionId, projectId) =>
              setWorkspace((current) => ({ ...current, activeProjectId: projectId, activeSessionId: sessionId }))
            }
            onToggleProjectSessions={(projectId) =>
              setWorkspace((current) => ({
                ...current,
                collapsedProjectIds: toggleCollapsedProjectId(current.collapsedProjectIds, projectId),
              }))
            }
          />
        )}
      </aside>
      <div className="main-shell">
        <TopBar
          activeSession={activeSession}
          onRenameSession={(sessionId, title) =>
            setWorkspace((current) => ({
              ...current,
              sessions: renameSessionTitle(current.sessions, sessionId, title, new Date().toISOString()),
            }))
          }
          onToggleNewTask={() => openProjectStartPage()}
        />

        <main className="stage">
          {activeSession?.kind === "plan" && <PlanView session={activeSession} onConfirm={confirmPlan} />}
          {activeSession?.kind === "canvas" && (
            <CanvasView
              session={activeSession}
              composerValue={bottomGoal}
              composerDisabled={false}
              onComposerChange={setBottomGoal}
              onComposerSubmit={appendRequirementNode}
              onComposerStop={stopActiveRun}
              onNodePositionsChange={updateActiveNodePositions}
              onOpenNode={openSelectedNode}
            />
          )}
          {!activeSession && (
            <ProjectStartPage
              goal={newTaskGoal}
              mode={newTaskMode}
              projects={workspace.projects}
              selectedProjectId={resolvedNewTaskProjectId}
              onGoalChange={setNewTaskGoal}
              onModeChange={setNewTaskMode}
              onProjectChange={setNewTaskProjectId}
              onCreate={addSessionFromComposer}
            />
          )}
        </main>
      </div>

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
          onDecisionAnswer={(option) => answerUserDecision(selectedNode.id, option)}
        />
      )}
    </div>
  );
}

function Home({ onOpenProject }: { onOpenProject: () => void }) {
  return (
    <main className="home">
      <section className="home-panel" aria-label="Open project">
        <div className="brand-row">
          <div>
            <p className="eyebrow">SkyTurn</p>
            <h1>Development workflow canvas</h1>
          </div>
        </div>
        <button className="primary-action" onClick={onOpenProject}>
          <FolderOpen size={18} />
          Open Project
        </button>
      </section>
    </main>
  );
}

function TopBar({
  activeSession,
  onRenameSession,
  onToggleNewTask,
}: {
  activeSession: CanvasSessionTab | null;
  onRenameSession: (sessionId: string, title: string) => void;
  onToggleNewTask: () => void;
}) {
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState(activeSession?.title ?? "");

  useEffect(() => {
    setTitleDraft(activeSession?.title ?? "");
    setEditingTitle(false);
  }, [activeSession?.id, activeSession?.title]);

  function commitTitleEdit() {
    if (!activeSession) return;
    const title = titleDraft.trim();
    if (title) onRenameSession(activeSession.id, title);
    setTitleDraft(title || activeSession.title);
    setEditingTitle(false);
  }

  function cancelTitleEdit() {
    setTitleDraft(activeSession?.title ?? "");
    setEditingTitle(false);
  }

  function handleTitleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter") commitTitleEdit();
    if (event.key === "Escape") cancelTitleEdit();
  }

  return (
    <header className="topbar">
      <div className="topbar-context">
        <div className="topbar-field title-field" aria-label="Session title">
          <GitBranch size={14} />
          {editingTitle && activeSession ? (
            <input
              className="title-edit-input"
              value={titleDraft}
              autoFocus
              onBlur={commitTitleEdit}
              onChange={(event) => setTitleDraft(event.target.value)}
              onKeyDown={handleTitleKeyDown}
              aria-label="Edit session title"
            />
          ) : (
            <button
              className="title-edit-button"
              type="button"
              onClick={() => activeSession && setEditingTitle(true)}
              disabled={!activeSession}
              title="Edit title"
            >
              {activeSession?.title ?? "No session"}
            </button>
          )}
        </div>
        {activeSession && (
          <div className="topbar-field type-field" aria-label="Session type">
            <span className="session-type-value">{activeSession.mode}</span>
          </div>
        )}
      </div>
      <div className="topbar-actions">
        <button
          className="new-tab-button icon-only"
          type="button"
          onClick={onToggleNewTask}
          title="New session"
          aria-label="New session"
        >
          <Plus size={16} />
        </button>
      </div>
    </header>
  );
}

function Sidebar({
  projects,
  sessions,
  activeProjectId,
  activeSessionId,
  collapsedProjectIds,
  onNewSession,
  onOpenProject,
  onSelectProject,
  onSelectSession,
  onToggleProjectSessions,
}: {
  projects: ImportedProject[];
  sessions: CanvasSessionTab[];
  activeProjectId: string;
  activeSessionId: string | null;
  collapsedProjectIds: string[];
  onNewSession: () => void;
  onOpenProject: () => void;
  onSelectProject: (projectId: string) => void;
  onSelectSession: (sessionId: string, projectId: string) => void;
  onToggleProjectSessions: (projectId: string) => void;
}) {
  const collapsedProjects = useMemo(() => new Set(collapsedProjectIds), [collapsedProjectIds]);

  return (
    <div className="sidebar-inner">
      <div className="sidebar-scroll">
        <button className="sidebar-new-session" type="button" onClick={onNewSession}>
          <Plus size={15} />
          <span>New tab</span>
          <ChevronRight size={14} />
        </button>
        <div className="sidebar-section-heading">
          <h2>Projects</h2>
          <button
            className="sidebar-hover-action"
            type="button"
            title="Add project"
            aria-label="Add project"
            onClick={onOpenProject}
          >
            <FolderOpen size={14} />
          </button>
        </div>
        {projects.map((project) => {
          const projectSessions = sessions.filter((session) => session.projectId === project.id);
          const collapsed = collapsedProjects.has(project.id);
          const collapseButtonClassName = collapsed
            ? "sidebar-hover-action project-collapse collapsed"
            : "sidebar-hover-action project-collapse";

          return (
            <section className="sidebar-project-group" key={project.id}>
              <div className="sidebar-project-line">
                <button
                  className={project.id === activeProjectId ? "sidebar-project-row active" : "sidebar-project-row"}
                  onClick={() => onSelectProject(project.id)}
                >
                  <FolderOpen size={15} />
                  <span>{project.name}</span>
                </button>
                <button
                  className={collapseButtonClassName}
                  type="button"
                  title={collapsed ? "Expand sessions" : "Collapse sessions"}
                  aria-label={collapsed ? "Expand project sessions" : "Collapse project sessions"}
                  aria-expanded={!collapsed}
                  onClick={() => onToggleProjectSessions(project.id)}
                >
                  <ChevronRight size={14} />
                </button>
              </div>
              {!collapsed && (
                <div className="sidebar-session-list">
                  {projectSessions.map((session) => (
                    <button
                      key={session.id}
                      className={session.id === activeSessionId ? "sidebar-session-row active" : "sidebar-session-row"}
                      onClick={() => onSelectSession(session.id, project.id)}
                    >
                      <span className="sidebar-session-title">{session.title}</span>
                      <small>{formatRelativeTime(session.updatedAt)}</small>
                    </button>
                  ))}
                  {projectSessions.length === 0 && <div className="sidebar-empty">No sessions</div>}
                </div>
              )}
            </section>
          );
        })}
      </div>
      <button className="sidebar-settings" type="button" title="Settings" aria-label="Settings">
        <Settings size={15} />
        <span>Settings</span>
      </button>
    </div>
  );
}

function ProjectStartPage({
  goal,
  mode,
  projects,
  selectedProjectId,
  onGoalChange,
  onModeChange,
  onProjectChange,
  onCreate,
}: {
  goal: string;
  mode: WorkflowMode;
  projects: ImportedProject[];
  selectedProjectId: string | null;
  onGoalChange: (goal: string) => void;
  onModeChange: (mode: WorkflowMode) => void;
  onProjectChange: (projectId: string) => void;
  onCreate: () => void;
}) {
  return (
    <section className="empty-stage">
      <div className="project-start-page">
        <h1 className="project-start-title">What should we build in SkyTurn?</h1>
        <SessionComposer
          variant="inline"
          goal={goal}
          mode={mode}
          projects={projects}
          selectedProjectId={selectedProjectId}
          ariaLabel="Create session"
          onGoalChange={onGoalChange}
          onModeChange={onModeChange}
          onProjectChange={onProjectChange}
          onCreate={onCreate}
        />
      </div>
    </section>
  );
}

function SessionComposer({
  variant,
  goal,
  mode,
  projects,
  selectedProjectId,
  ariaLabel,
  onGoalChange,
  onModeChange,
  onProjectChange,
  onClose,
  onCreate,
}: {
  variant: "panel" | "inline";
  goal: string;
  mode: WorkflowMode;
  projects: ImportedProject[];
  selectedProjectId: string | null;
  ariaLabel: string;
  onGoalChange: (goal: string) => void;
  onModeChange: (mode: WorkflowMode) => void;
  onProjectChange: (projectId: string) => void;
  onClose?: () => void;
  onCreate: () => void;
}) {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const hasGoal = goal.trim().length > 0;
  const canCreate = hasGoal && selectedProjectId !== null;
  const className = [
    "session-panel",
    variant === "inline" ? "inline-session-panel" : "",
    hasGoal ? "has-content" : "",
  ].filter(Boolean).join(" ");

  return (
    <form
      className={className}
      role={variant === "panel" ? "dialog" : undefined}
      aria-modal={variant === "panel" ? true : undefined}
      aria-label={ariaLabel}
      onMouseDown={variant === "panel" ? (event) => event.stopPropagation() : undefined}
      onSubmit={(event) => {
        event.preventDefault();
        onCreate();
      }}
    >
      {onClose && (
        <button
          className="icon-button session-panel-close"
          title="Close"
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            onClose();
          }}
        >
          <X size={17} />
        </button>
      )}
      <textarea
        className="session-panel-input"
        ref={textareaRef}
        value={goal}
        onChange={(event) => onGoalChange(event.target.value)}
        placeholder="What shall this canvas session build?"
        aria-label="New task goal"
      />
      <footer className="session-panel-footer">
        <button
          className="icon-button session-panel-tool"
          type="button"
          title="Focus prompt"
          onClick={() => textareaRef.current?.focus()}
        >
          <Plus size={17} />
        </button>
        <label className="session-project-picker">
          <FolderOpen size={15} />
          <select
            value={selectedProjectId ?? ""}
            disabled={projects.length === 0}
            aria-label="Project"
            onChange={(event) => onProjectChange(event.target.value)}
          >
            {projects.length === 0 && <option value="">No projects</option>}
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        </label>
        <ModeSwitch mode={mode} onChange={onModeChange} compact />
        <span className="session-panel-spacer" />
        <button
          className="icon-button session-panel-submit"
          type="submit"
          disabled={!canCreate}
          title="Create"
        >
          <ArrowUp size={18} />
        </button>
      </footer>
    </form>
  );
}

function formatRelativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return "";

  const minutes = Math.max(1, Math.floor((Date.now() - timestamp) / 60_000));
  if (minutes < 60) return `${minutes}m`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d`;

  return `${Math.floor(days / 30)}mo`;
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
  composerValue,
  composerDisabled,
  onComposerChange,
  onComposerSubmit,
  onComposerStop,
  onNodePositionsChange,
  onOpenNode,
}: {
  session: CanvasSession;
  composerValue: string;
  composerDisabled: boolean;
  onComposerChange: (value: string) => void;
  onComposerSubmit: () => void;
  onComposerStop: () => void;
  onNodePositionsChange: (updates: CanvasNodePositionUpdate[]) => void;
  onOpenNode: (nodeId: string) => void;
}) {
  const nodeById = useMemo(() => new Map(session.nodes.map((node) => [node.id, node])), [session.nodes]);
  const nodesSource = useMemo<AgentFlowNode[]>(
    () =>
      session.nodes.map((node) => ({
        id: node.id,
        type: "agent",
        position: node.position,
        draggable: true,
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
  const [flowNodes, setFlowNodes, onFlowNodesChange] = useNodesState<AgentFlowNode>(nodesSource);

  useEffect(() => {
    setFlowNodes((current) => mergeFlowNodeState(current, nodesSource));
  }, [nodesSource, setFlowNodes]);

  const handleNodesChange = useCallback(
    (changes: NodeChange<AgentFlowNode>[]) => {
      onFlowNodesChange(changes);
      const updates = positionUpdatesFromNodeChanges(changes);
      if (updates.length > 0) onNodePositionsChange(updates);
    },
    [onFlowNodesChange, onNodePositionsChange],
  );

  return (
    <section className="canvas-stage">
      <ReactFlow
        nodes={flowNodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        onNodesChange={handleNodesChange}
        fitView
        fitViewOptions={{ padding: 0.18 }}
        minZoom={0.35}
        maxZoom={1.35}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="var(--sk-canvas-grid)" gap={18} size={1.15} />
        <Controls showInteractive={false} />
      </ReactFlow>
      <CanvasComposer
        value={composerValue}
        disabled={composerDisabled}
        onChange={onComposerChange}
        onSubmit={onComposerSubmit}
        onStop={onComposerStop}
      />
    </section>
  );
}

function mergeFlowNodeState(current: AgentFlowNode[], next: AgentFlowNode[]): AgentFlowNode[] {
  if (current.length === 0) return next;

  const currentById = new Map(current.map((node) => [node.id, node]));
  return next.map((node) => {
    const existing = currentById.get(node.id);
    if (!existing) return node;

    return {
      ...existing,
      ...node,
      dragging: existing.dragging,
      height: existing.height,
      measured: existing.measured,
      selected: existing.selected,
      width: existing.width,
    };
  });
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
  const streamLine = streamingLogLineForNode(node, runtime);

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
          strokeDashoffset: -16,
          duration: MOTION_DURATION.retryPulse,
          ease: "sine.inOut",
          repeat: -1,
          repeatDelay: MOTION_DURATION.retryBackoff,
        });
        const retryGlint = gsap.fromTo(glint, {
          autoAlpha: 0.12,
          strokeDashoffset: 0,
        }, {
          autoAlpha: 0.44,
          strokeDashoffset: -18,
          duration: MOTION_DURATION.retryPulse,
          ease: "sine.inOut",
          repeat: -1,
          repeatDelay: MOTION_DURATION.retryBackoff,
          yoyo: true,
        });
        const retryDot = gsap.to(statusDot, {
          autoAlpha: 0.64,
          scale: 1.1,
          duration: MOTION_DURATION.retryPulse,
          ease: "sine.inOut",
          repeat: -1,
          repeatDelay: MOTION_DURATION.retryBackoff,
          yoyo: true,
        });

        return () => {
          retryFrame.kill();
          retryGlint.kill();
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
            <stop offset="0%" stopColor="var(--sk-running-gradient-start)" />
            <stop offset="46%" stopColor="var(--sk-running-gradient-mid)" />
            <stop offset="100%" stopColor="var(--sk-running-gradient-end)" />
          </linearGradient>
          <linearGradient id={retryingGradientId} x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="var(--sk-retrying-gradient-start)" />
            <stop offset="100%" stopColor="var(--sk-retrying-gradient-end)" />
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
        aria-label={`${node.title}: ${agentIdentityForNode(node)}. ${footer.primary}${footer.secondary ? ` ${footer.secondary}` : ""}. ${summary}`}
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
        <AgentStreamPreview line={streamLine} nodeId={node.id} />
        <div className={`agent-footer ${node.status}`} aria-label="Node status summary">
          {node.status === "completed" && <CheckCircle2 size={13} aria-hidden="true" />}
          {node.status === "failed" && <AlertTriangle size={13} aria-hidden="true" />}
          <span>{footer.primary}</span>
          {footer.secondary && (
            <>
              <span className="footer-separator" aria-hidden="true">·</span>
              <span>{footer.secondary}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function AgentStreamPreview({ line, nodeId }: { line: StreamingLogLine; nodeId: string }) {
  const text = `${line.kind}: "${line.text}"`;

  return (
    <div className="agent-stream" aria-label="Streaming log placeholder">
      <div className="agent-stream-row active">
        <span className="agent-stream-prompt" aria-hidden="true">›</span>
        <DecryptedText
          key={`${nodeId}-${text}`}
          text={text}
          speed={16}
          maxIterations={5}
          animateOn="view"
          className="agent-stream-copy"
          encryptedClassName="agent-stream-copy encrypted"
          parentClassName="agent-stream-text"
        />
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

function actionForDecisionOption(option: string): UserDecisionAction {
  const value = option.toLowerCase();
  if (value.includes("backtrack")) return "backtrack";
  if (value.includes("parallel") || value.includes("worktree")) return "parallel_worktree";
  if (value.includes("abort") || value.includes("cancel") || value.includes("stop")) return "abort";
  return "continue";
}

function nodeSummaryForNode(node: CanvasNode): string {
  return node.context.brief.trim() || node.progress.trim() || "Waiting for execution context.";
}

function nodeFooterForNode(
  node: CanvasNode,
  runtime: NodeRuntimeState,
): { primary: string; secondary?: string } {
  switch (node.status) {
    case "pending":
      return { primary: "Queued" };
    case "running":
      return { primary: runtime.phase === "Think" ? "Thinking" : runtime.phase };
    case "retrying":
      return { primary: "Retrying" };
    case "completed":
      return { primary: "Verified", secondary: "Evidence ready" };
    case "failed":
      return { primary: "Attention" };
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
      return "var(--sk-edge-active)";
    case "retrying":
      return "var(--sk-edge-retrying)";
    case "failed":
      return "var(--sk-edge-failed)";
    case "completed":
      return "var(--sk-edge-completed)";
    case "pending":
      return "var(--sk-edge-pending)";
  }
}

function frameStrokeForStatus(status: NodeStatus, runningGradientId: string, retryingGradientId: string): string {
  switch (status) {
    case "running":
      return `url(#${runningGradientId})`;
    case "retrying":
      return `url(#${retryingGradientId})`;
    case "completed":
      return "var(--sk-frame-completed)";
    case "failed":
      return "var(--sk-frame-failed)";
    case "pending":
      return "var(--sk-frame-pending)";
  }
}

function glintStrokeForStatus(status: NodeStatus, runningGradientId: string, retryingGradientId: string): string {
  switch (status) {
    case "running":
      return `url(#${runningGradientId})`;
    case "retrying":
      return `url(#${retryingGradientId})`;
    case "completed":
      return "var(--sk-glint-completed)";
    case "failed":
      return "var(--sk-glint-failed)";
    case "pending":
      return "var(--sk-glint-pending)";
  }
}

function statusColorForStatus(status: NodeStatus): string {
  switch (status) {
    case "running":
      return "var(--sk-status-running)";
    case "retrying":
      return "var(--sk-status-retrying)";
    case "completed":
      return "var(--sk-status-completed-text)";
    case "failed":
      return "var(--sk-status-failed-text)";
    case "pending":
      return "var(--sk-status-pending)";
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
  onDecisionAnswer,
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
  onDecisionAnswer: (option: string) => void;
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
  const canExecute = node.executable !== false;

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
          <button onClick={onStop} disabled={!canExecute}>
            <Square size={15} />
            Stop
          </button>
          <button onClick={onRetry} disabled={!canExecute}>
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
          <EditorLaunchMenu onOpenEditor={onOpenEditor} />
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
          {tab === "Output" && <OutputTab node={node} onDecisionAnswer={onDecisionAnswer} />}
          {tab === "Changes" && <ChangesTab node={node} />}
          {tab === "Context" && <ContextTab node={node} />}
        </div>
      </section>
    </div>
  );
}

function EditorLaunchMenu({ onOpenEditor }: { onOpenEditor: (editor: EditorKind) => void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();
  const triggerOption = DEFAULT_EDITOR_LAUNCH_OPTION;

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent) {
      const root = rootRef.current;
      if (!root || root.contains(event.target as Node)) return;
      setOpen(false);
    }

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  function openEditor(option: EditorLaunchOption) {
    setOpen(false);
    onOpenEditor(option.editor);
  }

  return (
    <div ref={rootRef} className="editor-menu">
      <button
        className="editor-menu-trigger"
        type="button"
        title="Open worktree"
        aria-label="Open worktree menu"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((current) => !current)}
      >
        <EditorLaunchIcon option={triggerOption} />
        <ChevronDown size={14} aria-hidden="true" />
      </button>
      {open && (
        <div id={menuId} className="editor-menu-list" role="menu" aria-label="Open worktree with">
          {EDITOR_LAUNCH_OPTIONS.map((option) => (
            <button
              key={option.editor}
              className="editor-menu-item"
              type="button"
              role="menuitem"
              onClick={() => openEditor(option)}
            >
              <EditorLaunchIcon option={option} />
              <span>{option.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function EditorLaunchIcon({ option }: { option: EditorLaunchOption }) {
  return (
    <span className={`editor-menu-icon ${option.tone}`} aria-hidden="true">
      {option.iconText}
    </span>
  );
}

function OutputTab({
  node,
  onDecisionAnswer,
}: {
  node: CanvasNode;
  onDecisionAnswer: (option: string) => void;
}) {
  return (
    <div className="output-lines">
      {node.userDecision && (
        <UserDecisionPanel node={node} onDecisionAnswer={onDecisionAnswer} />
      )}
      {node.output.map((line, index) => (
        <p key={`${node.id}-${index}`}>{line}</p>
      ))}
      {node.output.length === 0 && <p>No node output yet.</p>}
    </div>
  );
}

function UserDecisionPanel({
  node,
  onDecisionAnswer,
}: {
  node: CanvasNode;
  onDecisionAnswer: (option: string) => void;
}) {
  const decision = node.userDecision;
  if (!decision) return null;
  const answered = decision.status === "answered";

  return (
    <section className="decision-panel" aria-label={decision.prompt}>
      <p className="decision-prompt">{decision.prompt}</p>
      <p className="decision-reason">{decision.reason}</p>
      <div className="decision-options">
        {decision.options.map((option) => (
          <button
            key={option}
            type="button"
            disabled={answered}
            onClick={() => onDecisionAnswer(option)}
          >
            {answered && decision.selectedOption === option && <Check size={14} aria-hidden="true" />}
            <span>{option}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function ChangesTab({ node }: { node: CanvasNode }) {
  const [changeset, setChangeset] = useState<Changeset | null>(null);
  const [diffHtml, setDiffHtml] = useState("");
  const [diffError, setDiffError] = useState<string | null>(null);
  const [diffLoading, setDiffLoading] = useState(false);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [diffCollapsed, setDiffCollapsed] = useState(false);
  const [options, setOptions] = useState<ChangesDiffViewOptions>(DEFAULT_CHANGES_DIFF_OPTIONS);

  useEffect(() => {
    let active = true;
    setChangeset(null);
    void mockChangesetService.getChangeset(node).then((value) => {
      if (active) setChangeset(value);
    });
    return () => {
      active = false;
    };
  }, [node]);

  useEffect(() => {
    if (!changeset) return;

    let active = true;
    setDiffLoading(true);
    setDiffError(null);
    void renderChangesetDiffHtml(changeset.patchPreview, changeset.files, options)
      .then((html) => {
        if (!active) return;
        setDiffHtml(html);
      })
      .catch((error: unknown) => {
        if (!active) return;
        setDiffHtml("");
        setDiffError(error instanceof Error ? error.message : "Unable to render diff preview.");
      })
      .finally(() => {
        if (active) setDiffLoading(false);
      });

    return () => {
      active = false;
    };
  }, [
    changeset,
    options.hideWhitespace,
    options.loadFullFiles,
    options.outputFormat,
    options.richPreview,
    options.wordDiffs,
    options.wordWrap,
    refreshVersion,
  ]);

  function setDiffOption<K extends keyof ChangesDiffViewOptions>(key: K, value: ChangesDiffViewOptions[K]) {
    setOptions((current) => ({ ...current, [key]: value }));
  }

  function toggleOutputFormat() {
    setOptions((current) => ({
      ...current,
      outputFormat: current.outputFormat === "line-by-line" ? "side-by-side" : "line-by-line",
    }));
  }

  if (!changeset) return <p>Loading changes...</p>;

  const diffShellClassName = [
    "diff2html-shell",
    options.wordWrap ? "is-word-wrapped" : "",
    diffCollapsed ? "is-collapsed" : "",
    options.outputFormat === "side-by-side" ? "is-side-by-side" : "is-line-by-line",
  ].filter(Boolean).join(" ");

  return (
    <section className="changes-review" aria-label="Code changes review">
      <header className="changes-summary">
        <div className="changes-summary-copy">
          <p className="eyebrow">Turn Summary</p>
          <h3>{changeset.source === "git" ? "Worktree diff review" : "Task diff preview"}</h3>
          <p>{changeReviewSummary(node, changeset)}</p>
        </div>
        <div className="diff-stat" aria-label="Diff statistics">
          <span className="diff-stat-pill added">
            <strong>+{changeset.diffStat.added}</strong>
            <small>additions</small>
          </span>
          <span className="diff-stat-pill changed">
            <strong>{changeset.diffStat.changed}</strong>
            <small>files</small>
          </span>
          <span className="diff-stat-pill removed">
            <strong>-{changeset.diffStat.deleted}</strong>
            <small>deletions</small>
          </span>
        </div>
      </header>

      <ChangesDiffToolbar
        collapsed={diffCollapsed}
        options={options}
        onCollapseToggle={() => setDiffCollapsed((current) => !current)}
        onOption={setDiffOption}
        onOutputFormatToggle={toggleOutputFormat}
        onRefresh={() => setRefreshVersion((current) => current + 1)}
      />

      {diffError ? (
        <div className="changes-empty" role="alert">{diffError}</div>
      ) : diffLoading ? (
        <div className="changes-empty">Rendering diff preview...</div>
      ) : diffHtml ? (
        <div className={diffShellClassName} dangerouslySetInnerHTML={{ __html: diffHtml }} />
      ) : (
        <div className="changes-empty">No structured diff was available for this changeset.</div>
      )}
    </section>
  );
}

function changeReviewSummary(node: CanvasNode, changeset: Changeset): string {
  const agent = agentIdentityForNode(node);
  const source = changeset.source === "git" ? "git worktree" : "mock adapter";
  const fileLabel = changeset.diffStat.changed === 1 ? "file" : "files";
  return `${agent} produced ${changeset.id} from the ${source}: ${changeset.diffStat.changed} ${fileLabel} ready for review.`;
}

function ChangesDiffToolbar({
  collapsed,
  options,
  onCollapseToggle,
  onOption,
  onOutputFormatToggle,
  onRefresh,
}: {
  collapsed: boolean;
  options: ChangesDiffViewOptions;
  onCollapseToggle: () => void;
  onOption: <K extends keyof ChangesDiffViewOptions>(key: K, value: ChangesDiffViewOptions[K]) => void;
  onOutputFormatToggle: () => void;
  onRefresh: () => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();
  const splitTitle = options.outputFormat === "side-by-side" ? "Switch to unified diff" : "Switch to split diff";

  useEffect(() => {
    if (!open) return;

    function handlePointerDown(event: PointerEvent) {
      const root = rootRef.current;
      if (!root || root.contains(event.target as Node)) return;
      setOpen(false);
    }

    function handleKeyDown(event: globalThis.KeyboardEvent) {
      if (event.key === "Escape") setOpen(false);
    }

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [open]);

  function selectMenuAction(action: () => void) {
    action();
    setOpen(false);
  }

  return (
    <div className="changes-toolbar" aria-label="Diff preview controls">
      <button className="changes-tool-button" type="button" title="Refresh" onClick={onRefresh}>
        <RefreshCw size={15} aria-hidden="true" />
        <span>Refresh</span>
      </button>
      <button
        className="changes-tool-button icon-only"
        type="button"
        title={splitTitle}
        aria-label={splitTitle}
        aria-pressed={options.outputFormat === "side-by-side"}
        onClick={onOutputFormatToggle}
      >
        <Columns2 size={16} aria-hidden="true" />
      </button>
      <button className="changes-tool-button muted" type="button" disabled title="Commit or push is not wired yet">
        <GitPullRequest size={15} aria-hidden="true" />
        <span>Commit or push</span>
      </button>
      <div ref={rootRef} className="changes-menu">
        <button
          className="changes-tool-button icon-only"
          type="button"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={open ? menuId : undefined}
          title="Diff display options"
          onClick={() => setOpen((current) => !current)}
        >
          <MoreHorizontal size={16} aria-hidden="true" />
        </button>
        {open && (
          <div id={menuId} className="changes-menu-list" role="menu" aria-label="Diff display options">
            <ChangesMenuItem icon={<RefreshCw size={15} />} label="Refresh" onClick={() => selectMenuAction(onRefresh)} />
            <ChangesMenuItem
              active={options.wordWrap}
              icon={<WrapText size={15} />}
              label="Enable word wrap"
              onClick={() => selectMenuAction(() => onOption("wordWrap", !options.wordWrap))}
            />
            <ChangesMenuItem
              active={collapsed}
              icon={<FoldVertical size={15} />}
              label={collapsed ? "Expand all diffs" : "Collapse all diffs"}
              onClick={() => selectMenuAction(onCollapseToggle)}
            />
            <div className="changes-menu-separator" role="separator" />
            <ChangesMenuItem
              active={!options.loadFullFiles}
              icon={<FileText size={15} />}
              label="Don't load full files"
              onClick={() => selectMenuAction(() => onOption("loadFullFiles", !options.loadFullFiles))}
            />
            <ChangesMenuItem
              active={options.richPreview}
              icon={<Eye size={15} />}
              label="Enable rich preview"
              onClick={() => selectMenuAction(() => onOption("richPreview", !options.richPreview))}
            />
            <ChangesMenuItem
              active={options.wordDiffs}
              icon={<ListTree size={15} />}
              label="Enable word diffs"
              onClick={() => selectMenuAction(() => onOption("wordDiffs", !options.wordDiffs))}
            />
            <ChangesMenuItem
              active={options.hideWhitespace}
              icon={<EyeOff size={15} />}
              label="Hide white space"
              onClick={() => selectMenuAction(() => onOption("hideWhitespace", !options.hideWhitespace))}
            />
            <ChangesMenuItem disabled icon={<Copy size={15} />} label="Copy git apply command" />
          </div>
        )}
      </div>
    </div>
  );
}

function ChangesMenuItem({
  active = false,
  disabled = false,
  icon,
  label,
  onClick,
}: {
  active?: boolean;
  disabled?: boolean;
  icon: ReactNode;
  label: string;
  onClick?: () => void;
}) {
  return (
    <button
      className="changes-menu-item"
      type="button"
      role="menuitemcheckbox"
      aria-checked={active}
      disabled={disabled}
      onClick={onClick}
    >
      <span className="changes-menu-icon" aria-hidden="true">{active ? <Check size={13} /> : icon}</span>
      <span>{label}</span>
    </button>
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

function CanvasComposer({
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
  const inputRef = useRef<HTMLInputElement | null>(null);
  const hasValue = value.trim().length > 0;

  return (
    <div
      className={hasValue ? "canvas-composer nodrag nopan has-content" : "canvas-composer nodrag nopan"}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <input
        className="canvas-composer-input"
        ref={inputRef}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
        placeholder="Insert requirement or node"
        aria-label="Insert requirement or node"
        onKeyDown={(event) => {
          if (event.key === "Enter" && hasValue) onSubmit();
        }}
      />
      <div className="canvas-composer-toolbar">
        <button
          className="icon-button composer-tool"
          title="Focus input"
          onClick={() => inputRef.current?.focus()}
          disabled={disabled}
        >
          <Plus size={17} />
        </button>
        <span className="composer-slash" aria-hidden="true">/</span>
        <span className="composer-toolbar-spacer" />
        <button className="icon-button composer-tool" title="Stop active run" onClick={onStop} disabled={disabled}>
          <Square size={16} />
        </button>
        <button
          className="icon-button composer-send"
          title="Insert requirement"
          onClick={onSubmit}
          disabled={disabled || !hasValue}
        >
          <ArrowUp size={18} />
        </button>
      </div>
    </div>
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

async function persistCanvasWorkflowSession(
  project: ImportedProject,
  session: CanvasSession,
  inputSource: string,
): Promise<void> {
  if (!window.devflow) return;
  await window.devflow.createWorkflowSession(project.rootPath, {
    id: session.id,
    projectId: session.projectId,
    title: session.title,
    goal: session.goal,
    mode: session.mode,
    plannerProfile: "default",
    transport: "hermes_replay_recovery",
    recoveryReason: "SkyTurn event ledger initializes planner continuity.",
    now: session.createdAt,
  });
  await window.devflow.appendWorkflowUserInput(project.rootPath, {
    sessionId: session.id,
    inputId: `${inputSource}-${session.id}`,
    text: session.goal,
    now: session.createdAt,
  });
}

function canvasSessionFromWorkflowEvent(event: unknown): CanvasSession | null {
  if (!event || typeof event !== "object") return null;
  const canvasSession = (event as { canvasSession?: unknown }).canvasSession;
  return isCanvasSession(canvasSession) ? canvasSession : null;
}

function isCanvasSession(value: unknown): value is CanvasSession {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<CanvasSession>;
  return (
    candidate.kind === "canvas" &&
    typeof candidate.id === "string" &&
    Array.isArray(candidate.nodes) &&
    Array.isArray(candidate.edges)
  );
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
