import {
  Background,
  Controls,
  Handle,
  Position,
  ReactFlow,
  type Edge as FlowEdge,
  type Node as FlowNode,
  type NodeProps,
  type NodeTypes,
} from "@xyflow/react";
import {
  ExternalLink,
  FolderOpen,
  GitBranch,
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
import { useCallback, useEffect, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";

import { mockHermesAdapter } from "@skyturn/agent-runtime";
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
import {
  NODE_MODAL_TABS,
  type AgentKind,
  type CanvasNode,
  type CanvasSession,
  type CanvasSessionTab,
  type Changeset,
  type ImportedProject,
  type NodeModalTab,
  type NodeStatus,
  type PlanSession,
  type WorkflowMode,
} from "@skyturn/project-core";

type TaskFlowNode = FlowNode<{
  node: CanvasNode;
  onOpen: (nodeId: string) => void;
}>;

const nodeTypes: NodeTypes = {
  task: TaskNode,
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

  const activeProject = workspace.projects.find((project) => project.id === workspace.activeProjectId) ?? null;
  const activeSession = workspace.sessions.find((session) => session.id === workspace.activeSessionId) ?? null;
  const selectedNode =
    activeSession?.kind === "canvas"
      ? activeSession.nodes.find((node) => node.id === selectedNodeId) ?? null
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
    const canvas = mockHermesAdapter.confirmPlan(session);
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
    const running = activeSession.nodes.find((node) => node.status === "running" || node.status === "retrying");
    if (!running) return;
    updateNode(running.id, (node) => ({
      ...node,
      status: "failed",
      progress: "Stopped; output persisted",
      output: [...node.output, "Run cancelled. Current output and status were persisted."],
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
    const order: AgentKind[] = ["hermes", "codex", "gemini", "claude-code"];
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
    const target = activeSession.nodes.find((node) => node.id === nodeId);
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
            updateNode(selectedNode.id, (node) => ({
              ...node,
              status: "failed",
              progress: "Stopped; output persisted",
              output: [...node.output, "Run cancelled from node modal."],
            }))
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
  activeProjectId,
  activeSessionId,
  onSelectProject,
  onSelectSession,
}: {
  projects: ImportedProject[];
  sessions: CanvasSessionTab[];
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
  const nodes = useMemo<TaskFlowNode[]>(
    () =>
      session.nodes.map((node) => ({
        id: node.id,
        type: "task",
        position: node.position,
        data: { node, onOpen: onOpenNode },
      })),
    [onOpenNode, session.nodes],
  );
  const edges = useMemo<FlowEdge[]>(
    () =>
      session.edges.map((edge) => ({
        ...edge,
        animated: session.nodes.some((node) => node.id === edge.target && node.status === "running"),
        style: { stroke: "#7f8b8d", strokeWidth: 1.4 },
      })),
    [session.edges, session.nodes],
  );

  return (
    <section className="canvas-stage">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.35}
        maxZoom={1.35}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#c9cfca" gap={24} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </section>
  );
}

function TaskNode({ data }: NodeProps<TaskFlowNode>) {
  const node = data.node;
  return (
    <button className={`task-node ${node.status}`} onClick={() => data.onOpen(node.id)}>
      <Handle type="target" position={Position.Left} />
      <div className="node-heading">
        <StatusLight status={node.status} />
        <span>{node.title}</span>
      </div>
      <div className="node-meta">
        <Users size={13} />
        <span>{node.agent}</span>
      </div>
      <p>{node.progress}</p>
      <Handle type="source" position={Position.Right} />
    </button>
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
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="node-modal" role="dialog" aria-modal="true" aria-label={node.title}>
        <header className="modal-header">
          <div>
            <p className="eyebrow">{node.agent}</p>
            <h2>{node.title}</h2>
          </div>
          <button className="icon-button" title="Close" onClick={onClose}>
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
    ? mockHermesAdapter.createFastSession({ projectId, goal, createdAt })
    : mockHermesAdapter.createPlanSession({ projectId, goal, createdAt });
}

function changesetsForSession(session: CanvasSessionTab): WorkspaceState["changesets"] {
  if (session.kind !== "canvas") return {};
  return Object.fromEntries(session.nodes.map((node) => [node.changesetId, createMockChangeset(node)]));
}

function advanceMockRun(session: CanvasSession): CanvasSession {
  const activeIndex = session.nodes.findIndex(
    (node) => node.status === "running" || node.status === "retrying",
  );
  if (activeIndex === -1) return session;

  const nodes = [...session.nodes];
  const node = nodes[activeIndex];
  const nextLine = mockHermesAdapter.nextOutputLine(node, node.output.length);
  const output = [...node.output, nextLine];

  if (output.length >= 5) {
    nodes[activeIndex] = {
      ...node,
      status: "completed",
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
