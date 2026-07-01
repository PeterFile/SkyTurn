import type {
  AgentTerminalSession,
  TerminalSessionEventDraft,
} from "@skyturn/project-core" with { "resolution-mode": "import" };
import type {
  HermesPlannerPtyTransport,
  HermesPlannerPtyTransportOptions,
  PtyProcessFactory,
} from "@skyturn/agent-bridge" with { "resolution-mode": "import" };
import {
  emptyTerminalSnapshot,
  terminalUnsupportedResult,
  type TerminalActionResult,
  type TerminalCancelInput,
  type TerminalRendererEvent,
  type TerminalResizeInput,
  type TerminalSnapshotInput,
  type TerminalSnapshotLine,
  type TerminalSnapshotResult,
  type TerminalSnapshotState,
  type TerminalStartInput,
  type TerminalStartResult,
  type TerminalWriteInput,
} from "./terminalIpcContracts";

const defaultRows = 24;
const defaultCols = 80;
const defaultSnapshotLineLimit = 1_000;

interface AgentBridgeTerminalRuntimeModule {
  createHermesPlannerPtyTransport(options: HermesPlannerPtyTransportOptions): HermesPlannerPtyTransport;
}

export interface StartHermesPlannerForWorkflowSessionInput {
  projectRoot: string;
  canvasSessionId: string;
  runId: string;
  plannerSessionId?: string;
  plannerInputId?: string;
  hermesSessionHandle?: string;
  worktreePath?: string;
  rows?: number;
  cols?: number;
  env?: NodeJS.ProcessEnv;
}

export interface TerminalRuntimeOptions {
  protocolVersion: number;
  featureEnabled?: () => boolean;
  ptyFactory?: PtyProcessFactory | null;
  loadAgentBridge?: () => Promise<AgentBridgeTerminalRuntimeModule>;
  broadcastEvent?: (event: TerminalRendererEvent) => void;
  env?: NodeJS.ProcessEnv;
  maxSnapshotLines?: number;
}

export interface TerminalRuntime {
  start(input: TerminalStartInput): Promise<TerminalStartResult>;
  write(input: TerminalWriteInput): Promise<TerminalActionResult>;
  resize(input: TerminalResizeInput): Promise<TerminalActionResult>;
  cancel(input: TerminalCancelInput): Promise<TerminalActionResult>;
  snapshot(input: TerminalSnapshotInput): Promise<TerminalSnapshotResult>;
  startHermesPlannerForWorkflowSession(input: StartHermesPlannerForWorkflowSessionInput): Promise<TerminalStartResult>;
  sendWorkflowUserInput(canvasSessionId: string, data: string): Promise<TerminalActionResult>;
  hermesPlannerTerminalSessionId(canvasSessionId: string): string | null;
}

export function createTerminalRuntime(options: TerminalRuntimeOptions): TerminalRuntime {
  const snapshots = new Map<string, TerminalSnapshotState>();
  const terminalToCanvasSessionId = new Map<string, string>();
  const canvasToTerminalSessionId = new Map<string, string>();
  const lineLimit = options.maxSnapshotLines ?? defaultSnapshotLineLimit;
  let transport: HermesPlannerPtyTransport | null = null;

  return {
    async start(input) {
      if (input.agentKind !== "hermes") return unavailableAction(input.runId);
      return startHermesPlannerForWorkflowSession({
        projectRoot: input.projectRoot,
        canvasSessionId: input.canvasSessionId,
        runId: input.runId,
        worktreePath: input.cwd ?? input.projectRoot,
        rows: input.rows,
        cols: input.cols,
      });
    },

    async write(input) {
      const canvasSessionId = terminalToCanvasSessionId.get(input.terminalSessionId);
      if (!canvasSessionId || !transport?.getSession(canvasSessionId)) return unavailableAction(input.terminalSessionId);
      try {
        await transport.sendUserInput(canvasSessionId, input.data);
        return acceptedAction(input.terminalSessionId);
      } catch {
        forgetTerminal(input.terminalSessionId, canvasSessionId);
        return unavailableAction(input.terminalSessionId);
      }
    },

    async resize(input) {
      const canvasSessionId = terminalToCanvasSessionId.get(input.terminalSessionId);
      if (!canvasSessionId || !transport?.getSession(canvasSessionId)) return unavailableAction(input.terminalSessionId);
      try {
        await transport.resizeSession(canvasSessionId, { cols: input.cols, rows: input.rows });
        updateSnapshotSize(input.terminalSessionId, input.rows, input.cols);
        return acceptedAction(input.terminalSessionId);
      } catch {
        forgetTerminal(input.terminalSessionId, canvasSessionId);
        return unavailableAction(input.terminalSessionId);
      }
    },

    async cancel(input) {
      const canvasSessionId = terminalToCanvasSessionId.get(input.terminalSessionId);
      if (!canvasSessionId || !transport?.getSession(canvasSessionId)) return unavailableAction(input.terminalSessionId);
      try {
        await transport.cancelSession(canvasSessionId, input.reason);
        return acceptedAction(input.terminalSessionId);
      } catch {
        forgetTerminal(input.terminalSessionId, canvasSessionId);
        return unavailableAction(input.terminalSessionId);
      }
    },

    async snapshot(input) {
      const snapshot = snapshots.get(input.terminalSessionId);
      if (!snapshot) return emptyTerminalSnapshot(options.protocolVersion, input.terminalSessionId);
      return { protocolVersion: options.protocolVersion, ...snapshot };
    },

    startHermesPlannerForWorkflowSession,

    async sendWorkflowUserInput(canvasSessionId, data) {
      const currentTransport = transport;
      if (!currentTransport) return unavailableAction(canvasSessionId);
      const session = currentTransport.getSession(canvasSessionId);
      if (!session) return unavailableAction(canvasSessionId);
      try {
        await currentTransport.sendUserInput(canvasSessionId, data);
        return acceptedAction(session.terminalSession.id);
      } catch {
        forgetTerminal(session.terminalSession.id, canvasSessionId);
        return unavailableAction(session.terminalSession.id);
      }
    },

    hermesPlannerTerminalSessionId(canvasSessionId) {
      const session = transport?.getSession(canvasSessionId);
      if (!session) {
        const terminalSessionId = canvasToTerminalSessionId.get(canvasSessionId);
        if (terminalSessionId) forgetTerminal(terminalSessionId, canvasSessionId);
        return null;
      }
      rememberSession(session.terminalSession);
      return session.terminalSession.id;
    },
  };

  async function startHermesPlannerForWorkflowSession(
    input: StartHermesPlannerForWorkflowSessionInput,
  ): Promise<TerminalStartResult> {
    if (!isFeatureEnabled()) return terminalUnsupportedResult(options.protocolVersion, false);
    const plannerTransport = await ensureTransport();
    if (!plannerTransport) return terminalUnsupportedResult(options.protocolVersion, true);

    try {
      const result = await plannerTransport.startSession(input);
      rememberSession(result.terminalSession, input.rows, input.cols);
      return acceptedStart(result.terminalSession);
    } catch {
      return terminalUnsupportedResult(options.protocolVersion, true);
    }
  }

  async function ensureTransport(): Promise<HermesPlannerPtyTransport | null> {
    if (transport) return transport;
    if (!options.ptyFactory) return null;
    try {
      const bridge = await (options.loadAgentBridge ?? importAgentBridge)();
      transport = bridge.createHermesPlannerPtyTransport({
        ptyFactory: options.ptyFactory,
        featureFlags: { ptyInteractiveSessions: true },
        emitEvent: async (event) => {
          captureEvent(event);
        },
        ...(options.env ? { env: options.env } : {}),
      });
      return transport;
    } catch {
      transport = null;
      return null;
    }
  }

  function captureEvent(event: TerminalSessionEventDraft): void {
    const snapshot = ensureSnapshot(event.terminalSessionId);
    const sequence = snapshot.sequence + 1;
    const updatedAt = event.timestamp ?? new Date().toISOString();
    const lines = event.kind === "output"
      ? appendLine(snapshot.lines, {
          sequence,
          stream: event.stream,
          text: event.text,
          ...(event.timestamp ? { timestamp: event.timestamp } : {}),
        })
      : snapshot.lines;
    snapshots.set(event.terminalSessionId, {
      ...snapshot,
      status: event.kind === "lifecycle" ? event.status : snapshot.status,
      sequence,
      lines,
      updatedAt,
    });
    options.broadcastEvent?.({ ...event, protocolVersion: options.protocolVersion });
  }

  function rememberSession(session: AgentTerminalSession, rows?: number, cols?: number): void {
    terminalToCanvasSessionId.set(session.id, session.canvasSessionId);
    canvasToTerminalSessionId.set(session.canvasSessionId, session.id);
    const snapshot = ensureSnapshot(session.id);
    snapshots.set(session.id, {
      ...snapshot,
      status: session.status,
      rows: rows ?? (snapshot.rows || defaultRows),
      cols: cols ?? (snapshot.cols || defaultCols),
      updatedAt: session.endedAt ?? session.createdAt,
    });
  }

  function ensureSnapshot(terminalSessionId: string): TerminalSnapshotState {
    return snapshots.get(terminalSessionId) ?? {
      terminalSessionId,
      status: "starting",
      sequence: 0,
      rows: defaultRows,
      cols: defaultCols,
      cursor: { row: 0, col: 0 },
      lines: [],
    };
  }

  function updateSnapshotSize(terminalSessionId: string, rows: number, cols: number): void {
    const snapshot = ensureSnapshot(terminalSessionId);
    snapshots.set(terminalSessionId, {
      ...snapshot,
      rows,
      cols,
      updatedAt: new Date().toISOString(),
    });
  }

  function appendLine(lines: TerminalSnapshotLine[], line: TerminalSnapshotLine): TerminalSnapshotLine[] {
    const next = [...lines, line];
    return next.length > lineLimit ? next.slice(next.length - lineLimit) : next;
  }

  function acceptedStart(session: AgentTerminalSession): TerminalStartResult {
    return {
      protocolVersion: options.protocolVersion,
      ok: true,
      status: "accepted",
      terminalSessionId: session.id,
      session,
    };
  }

  function acceptedAction(terminalSessionId: string): TerminalActionResult {
    return {
      protocolVersion: options.protocolVersion,
      ok: true,
      status: "accepted",
      terminalSessionId,
    };
  }

  function unavailableAction(terminalSessionId: string): TerminalActionResult {
    return {
      ...terminalUnsupportedResult(options.protocolVersion, isFeatureEnabled()),
      terminalSessionId,
    };
  }

  function forgetTerminal(terminalSessionId: string, canvasSessionId: string): void {
    terminalToCanvasSessionId.delete(terminalSessionId);
    if (canvasToTerminalSessionId.get(canvasSessionId) === terminalSessionId) {
      canvasToTerminalSessionId.delete(canvasSessionId);
    }
  }

  function isFeatureEnabled(): boolean {
    return options.featureEnabled?.() === true;
  }
}

async function importAgentBridge(): Promise<AgentBridgeTerminalRuntimeModule> {
  return import("@skyturn/agent-bridge");
}
