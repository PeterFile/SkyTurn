import { describe, expect, it } from "vitest";

import {
  AGENT_TRANSPORT_KINDS,
  AGENT_SUPPORT_LEVELS,
  EVIDENCE_CHECK_KINDS,
  DEFAULT_AGENT_TRANSPORT_FEATURE_FLAGS,
  RUN_EVENT_PROTOCOL_VERSION,
  TERMINAL_SESSION_STATUSES,
  canUsePtyInteractiveTransport,
  normalizeSessionTarget,
  WORKFLOW_LANE_KINDS,
  deriveNodeStatusFromEvidence,
  hasConcreteRunEvidence,
  summarizeRunEvidence,
  summarizeAgentReadiness,
  type FinalChangesetReconciliation,
  type AgentDescriptor,
  type AgentRun,
  type AgentTerminalSession,
  type AgentTransportCapabilities,
  type CanvasNode,
  type ChangesetEvidence,
  type EvidenceCheck,
  type RunEvent,
  type RunEvidence,
  type TerminalSessionEventDraft,
  type UserDecisionAnsweredPayload,
  type UserDecisionRequestedPayload,
  type WorkflowLedgerSummary,
  type WorkflowRuntimePolicy,
  type LiveRunChangesEvidence,
  type WorkflowCheckpointIntent,
  type WorkflowLoopEngineeringState,
  type WorkflowNodeCheckpoint,
  type WorkflowRequestedCheckpointSuccessorIntent,
  type NodeRollbackStatus,
  type NodeStatus,
  type WorkflowRollbackEligibility,
  type WorkflowRemoteSideEffectPayload,
  type SessionTarget,
  type WorkflowVariantAdoption,
  type WorkflowWorktreeIdentity,
} from "./index";

const stableNodeStatusContract: Record<NodeStatus, true> = {
  pending: true,
  running: true,
  retrying: true,
  completed: true,
  failed: true,
};

function readiness({
  cliAvailable = true,
  auth,
  categories = [],
}: {
  cliAvailable?: boolean;
  auth: NonNullable<AgentDescriptor["readiness"]>["auth"]["status"];
  categories?: NonNullable<AgentDescriptor["readiness"]>["categories"];
}): NonNullable<AgentDescriptor["readiness"]> {
  return {
    level: cliAvailable ? "experimental-run" : "unavailable",
    cli: {
      available: cliAvailable,
      path: cliAvailable ? "/usr/local/bin/agent" : null,
      version: cliAvailable ? "agent 1.0.0" : null,
    },
    auth: auth === "available" ? { status: auth, source: "environment" } : { status: auth },
    categories,
  };
}

function agentDescriptor(input: Partial<AgentDescriptor> & Pick<AgentDescriptor, "kind">): AgentDescriptor {
  return {
    kind: input.kind,
    label: input.label ?? input.kind,
    executablePath: input.executablePath ?? "/usr/local/bin/agent",
    version: input.version ?? "agent 1.0.0",
    status: input.status ?? "available",
    supportLevel: input.supportLevel ?? "experimental-run",
    capabilities: input.capabilities ?? ["chat"],
    configFiles: input.configFiles ?? [],
    ...(input.readiness !== undefined ? { readiness: input.readiness } : {}),
  };
}

function runEvidence(overrides: Partial<RunEvidence> = {}): RunEvidence {
  return {
    runId: "run-1",
    status: "succeeded",
    exitCode: 0,
    changesetId: null,
    checks: [],
    artifacts: [],
    review: null,
    errorReason: null,
    cancelReason: null,
    completedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("agent run contracts", () => {
  it("publishes stable transport kinds and PTY terminal lifecycle states", () => {
    const terminalSession: AgentTerminalSession = {
      id: "terminal-session-1",
      runId: "run-1",
      canvasSessionId: "canvas-session-1",
      agentKind: "codex",
      cwd: "/repo",
      commandLabel: "codex exec",
      transport: "pty-interactive",
      status: "waiting",
      createdAt: "2026-07-01T00:00:00.000Z",
    };

    expect(AGENT_TRANSPORT_KINDS).toEqual(["exec-json", "pty-interactive"]);
    expect(TERMINAL_SESSION_STATUSES).toEqual([
      "starting",
      "running",
      "waiting",
      "exited",
      "timed-out",
      "cancelled",
      "failed",
    ]);
    expect(terminalSession.transport).toBe("pty-interactive");
    expect(terminalSession.status).toBe("waiting");
  });

  it("keeps PTY interactive sessions disabled unless the feature flag and capability both allow it", () => {
    const capabilities: AgentTransportCapabilities = {
      supportsExecJson: true,
      supportsPtyInteractive: true,
      supportsResume: false,
      supportsStructuredEvents: true,
    };

    expect(DEFAULT_AGENT_TRANSPORT_FEATURE_FLAGS.ptyInteractiveSessions).toBe(false);
    expect(canUsePtyInteractiveTransport(capabilities)).toBe(false);
    expect(canUsePtyInteractiveTransport(capabilities, { ptyInteractiveSessions: true })).toBe(true);
    expect(
      canUsePtyInteractiveTransport(
        { ...capabilities, supportsPtyInteractive: false },
        { ptyInteractiveSessions: true },
      ),
    ).toBe(false);
  });

  it("models terminal session draft events without making terminal text completion evidence", () => {
    const output: TerminalSessionEventDraft = {
      kind: "output",
      terminalSessionId: "terminal-session-1",
      runId: "run-1",
      timestamp: "2026-07-01T00:00:00.000Z",
      stream: "stdout",
      text: "all done",
    };
    const lifecycle: TerminalSessionEventDraft = {
      kind: "lifecycle",
      terminalSessionId: "terminal-session-1",
      runId: "run-1",
      timestamp: "2026-07-01T00:00:01.000Z",
      status: "exited",
    };
    const run: AgentRun = {
      id: "run-1",
      nodeId: "node-1",
      sessionId: "session-1",
      projectRoot: "/tmp/project",
      worktreePath: "/tmp/project.worktrees/node-1",
      agentKind: "codex",
      status: "succeeded",
      startedAt: "2026-07-01T00:00:00.000Z",
      endedAt: "2026-07-01T00:00:01.000Z",
    };
    const evidence: RunEvidence = {
      runId: "run-1",
      status: "succeeded",
      exitCode: null,
      changesetId: null,
      checks: [],
      artifacts: [],
      review: null,
      errorReason: null,
      cancelReason: null,
      completedAt: "2026-07-01T00:00:01.000Z",
    };

    expect(output.kind).toBe("output");
    expect(lifecycle.kind).toBe("lifecycle");
    expect(hasConcreteRunEvidence(evidence)).toBe(false);
    expect(deriveNodeStatusFromEvidence(run, evidence)).toBe("failed");
  });

  it("summarizes experimental real-loop readiness without claiming supported-run", () => {
    const summary = summarizeAgentReadiness([
      agentDescriptor({
        kind: "hermes",
        supportLevel: "experimental-run",
        readiness: readiness({ auth: "unknown" }),
      }),
      agentDescriptor({
        kind: "codex",
        supportLevel: "experimental-run",
        readiness: readiness({ auth: "available" }),
      }),
    ]);

    expect(summary.status).toBe("degraded");
    expect(summary.runSupport).toBe("experimental-run");
    expect(summary.checks.hermesCli).toBe("ready");
    expect(summary.checks.codexCli).toBe("ready");
    expect(summary.checks.agyCli).toBe("missing");
    expect(summary.checks.hermesAuth).toBe("unknown");
    expect(summary.checks.codexAuth).toBe("available");
    expect(summary.reasons).toContain("hermes-auth-unknown");
    expect(summary.reasons).toContain("experimental-run");
    expect(summary.reasons).not.toContain("supported-run");
  });

  it("keeps the real loop ready when optional Antigravity CLI is missing", () => {
    const summary = summarizeAgentReadiness([
      agentDescriptor({
        kind: "hermes",
        supportLevel: "supported-run",
        readiness: readiness({ auth: "available" }),
      }),
      agentDescriptor({
        kind: "codex",
        supportLevel: "supported-run",
        readiness: readiness({ auth: "available" }),
      }),
      agentDescriptor({
        kind: "agy",
        label: "Antigravity CLI",
        status: "missing",
        executablePath: null,
        supportLevel: "detected-only",
        readiness: readiness({ cliAvailable: false, auth: "unknown", categories: ["cli-missing"] }),
      }),
    ]);

    expect(summary.status).toBe("ready");
    expect(summary.runSupport).toBe("supported-run");
    expect(summary.checks.agyCli).toBe("missing");
    expect(summary.reasons).toContain("agy-cli-missing");
    expect(summary.message).toContain("Antigravity CLI optional detected-only");
  });

  it("blocks real workflow runs when the Codex CLI is missing", () => {
    const summary = summarizeAgentReadiness([
      agentDescriptor({
        kind: "hermes",
        supportLevel: "experimental-run",
        readiness: readiness({ auth: "available" }),
      }),
      agentDescriptor({
        kind: "codex",
        status: "missing",
        executablePath: null,
        supportLevel: "detected-only",
        readiness: readiness({ cliAvailable: false, auth: "unknown", categories: ["cli-missing"] }),
      }),
    ]);

    expect(summary.status).toBe("blocked");
    expect(summary.runSupport).toBe("unavailable");
    expect(summary.checks.codexCli).toBe("missing");
    expect(summary.checks.agyCli).toBe("missing");
    expect(summary.reasons).toContain("codex-cli-missing");
    expect(summary.message).toContain("Codex CLI missing");
  });

  it("distinguishes mock-only fallback from real workflow readiness", () => {
    const summary = summarizeAgentReadiness([
      agentDescriptor({
        kind: "codex",
        label: "Mock Codex Agent",
        supportLevel: "mock-only",
        executablePath: null,
        readiness: undefined,
      }),
    ]);

    expect(summary.status).toBe("mock-only");
    expect(summary.runSupport).toBe("mock-only");
    expect(summary.checks.agyCli).toBe("missing");
    expect(summary.checks.mockFallback).toBe(true);
    expect(summary.reasons).toContain("mock-only-fallback");
    expect(summary.message).toContain("Mock fallback only");
  });

  it("distinguishes missing auth from unknown auth", () => {
    const summary = summarizeAgentReadiness([
      agentDescriptor({
        kind: "hermes",
        supportLevel: "experimental-run",
        readiness: readiness({ auth: "missing", categories: ["auth-missing"] }),
      }),
      agentDescriptor({
        kind: "codex",
        supportLevel: "experimental-run",
        readiness: readiness({ auth: "unknown" }),
      }),
    ]);

    expect(summary.status).toBe("blocked");
    expect(summary.checks.hermesAuth).toBe("missing");
    expect(summary.checks.codexAuth).toBe("unknown");
    expect(summary.checks.agyCli).toBe("missing");
    expect(summary.reasons).toContain("hermes-auth-missing");
    expect(summary.reasons).toContain("codex-auth-unknown");
  });

  it("models OpenClaw discovery with an explicit support level", () => {
    const descriptor: AgentDescriptor = {
      kind: "openclaw",
      label: "OpenClaw",
      executablePath: "/usr/local/bin/openclaw",
      version: null,
      status: "available",
      supportLevel: "detected-only",
      capabilities: ["chat", "file-read"],
      configFiles: ["OPENCLAW.md"],
    };

    expect(AGENT_SUPPORT_LEVELS).toContain("detected-only");
    expect(descriptor.supportLevel).toBe("detected-only");
  });

  it("uses a versioned NDJSON-compatible run event shape", () => {
    const event: RunEvent = {
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      runId: "run-1",
      seq: 1,
      timestamp: "2026-06-12T00:00:00.000Z",
      kind: "output",
      payload: { text: "completed" },
    };

    expect(event.protocolVersion).toBe(1);
    expect(event.seq).toBe(1);
  });

  it("models session execution targets and normalizes old sessions to current branch", () => {
    const currentBranch = normalizeSessionTarget(null);
    const explicitCurrentBranch: SessionTarget = normalizeSessionTarget({
      executionTarget: "current_branch",
      selectedBranch: "feature/session-target",
      baseRef: "main",
    });
    const newWorktree: SessionTarget = normalizeSessionTarget({
      executionTarget: "new_worktree",
      selectedBranch: "main",
      baseRef: "origin/main",
    });

    expect(currentBranch).toEqual({
      executionTarget: "current_branch",
      selectedBranch: "HEAD",
    });
    expect(explicitCurrentBranch).toEqual({
      executionTarget: "current_branch",
      selectedBranch: "feature/session-target",
    });
    expect(newWorktree).toEqual({
      executionTarget: "new_worktree",
      selectedBranch: "main",
      baseRef: "origin/main",
    });
  });

  it("publishes structured live changes and final git reconciliation contracts", () => {
    const liveChanges: LiveRunChangesEvidence = {
      source: "codex",
      status: "available",
      files: ["src/index.ts"],
      changes: [
        {
          operation: "update",
          path: "src/index.ts",
          unifiedDiff: "diff --git a/src/index.ts b/src/index.ts",
        },
      ],
      collectedAt: "2026-06-19T00:00:00.000Z",
    };
    const reconciliation: FinalChangesetReconciliation = {
      status: "mismatch",
      changeset: {
        id: "changeset-1",
        files: ["src/other.ts"],
        diffStat: { added: 1, changed: 0, deleted: 0 },
        patchPreview: "diff --git a/src/other.ts b/src/other.ts",
        source: "git",
      },
      metadata: {
        source: "git",
        executionTarget: "current_branch",
        selectedBranch: "main",
        baselineRef: "main",
      },
      liveChanges,
      mismatches: [{ kind: "file-set", liveFiles: ["src/index.ts"], gitFiles: ["src/other.ts"] }],
    };

    expect(liveChanges.changes[0]?.operation).toBe("update");
    expect(reconciliation.status).toBe("mismatch");
    expect(reconciliation.liveChanges?.files).toEqual(["src/index.ts"]);
  });

  it("allows run-timeout evidence checks for hard watchdog expiry", () => {
    const check: EvidenceCheck = {
      kind: "run-timeout",
      name: "Codex CLI watchdog",
      status: "failed",
      detail: "timed out after 1800000ms",
    };

    expect(check.kind).toBe("run-timeout");
    expect(EVIDENCE_CHECK_KINDS).toContain("run-timeout");
  });

  it("does not complete a node from agent text without concrete evidence", () => {
    const run: AgentRun = {
      id: "run-1",
      nodeId: "node-1",
      sessionId: "session-1",
      projectRoot: "/tmp/project",
      worktreePath: "/tmp/project.worktrees/node-1",
      agentKind: "codex",
      status: "succeeded",
      startedAt: "2026-06-12T00:00:00.000Z",
      endedAt: "2026-06-12T00:00:01.000Z",
    };
    const evidence: RunEvidence = {
      runId: "run-1",
      status: "succeeded",
      exitCode: null,
      changesetId: null,
      checks: [],
      artifacts: [],
      review: null,
      errorReason: null,
      cancelReason: null,
      completedAt: "2026-06-12T00:00:01.000Z",
    };

    const status: NodeStatus = deriveNodeStatusFromEvidence(run, evidence);

    expect(Object.keys(stableNodeStatusContract).sort()).toEqual(["completed", "failed", "pending", "retrying", "running"]);
    expect(hasConcreteRunEvidence(evidence)).toBe(false);
    expect(status).toBe("failed");
  });

  it("summarizes empty run evidence without inventing facts", () => {
    const summary = summarizeRunEvidence({});

    expect(summary.run.status).toBe("unknown");
    expect(summary.run.exitCode).toBeNull();
    expect(summary.reason).toBeNull();
    expect(summary.checkSummary).toBe("None");
    expect(summary.artifactSummary).toBe("None");
    expect(summary.changeFacts).toEqual([
      { label: "Changeset status", value: "unknown" },
      { label: "Changed files", value: "None" },
      { label: "Diff stat", value: "+0 / -0 across 0 files" },
      { label: "Repo state", value: "Not recorded" },
    ]);
  });

  it("summarizes partial run evidence from structured fields only", () => {
    const summary = summarizeRunEvidence({
      runEvidence: runEvidence({
        status: "running",
        exitCode: null,
        checks: [{ kind: "test", name: "unit", status: "passed", detail: "1 passed" }],
        artifacts: [],
      }),
    });

    expect(summary.runFacts).toEqual([
      { label: "Run ID", value: "run-1" },
      { label: "Run status", value: "running" },
      { label: "Checks", value: "test [unit]: passed - 1 passed" },
      { label: "Artifacts", value: "None" },
    ]);
    expect(summary.latestFailedCheck).toBeNull();
  });

  it("summarizes failed, cancelled, and timed-out reasons", () => {
    expect(summarizeRunEvidence({
      runEvidence: runEvidence({
        status: "failed",
        exitCode: 1,
        errorReason: "tests failed",
      }),
    }).reason).toBe("Error: tests failed");

    expect(summarizeRunEvidence({
      runEvidence: runEvidence({
        status: "cancelled",
        exitCode: null,
        cancelReason: "user stopped run",
      }),
    }).reason).toBe("Cancelled: user stopped run");

    expect(summarizeRunEvidence({
      runEvidence: runEvidence({
        status: "timed-out",
        exitCode: null,
        checks: [{ kind: "run-timeout", name: "watchdog", status: "failed", detail: "watchdog expired" }],
      }),
    }).reason).toBe("Timeout: watchdog expired");
  });

  it("summarizes artifact evidence from run evidence or explicit expected artifacts", () => {
    expect(summarizeRunEvidence({
      runEvidence: runEvidence({ artifacts: [".devflow/output.md"] }),
      expectedArtifacts: [".devflow/expected.md"],
    }).artifactSummary).toBe("1 (.devflow/output.md)");

    expect(summarizeRunEvidence({
      expectedArtifacts: [".devflow/expected.md"],
    }).artifactSummary).toBe("1 expected (.devflow/expected.md)");
  });

  it("summarizes commit, changed-file, repo-state, and review evidence", () => {
    const summary = summarizeRunEvidence({
      runEvidence: runEvidence({
        review: { kind: "review", name: "Architecture review", status: "passed", detail: "no blockers" },
      }),
      changeset: {
        id: "changeset-1",
        files: ["src/index.ts"],
        diffStat: { added: 3, changed: 1, deleted: 1 },
        patchPreview: "diff --git",
        source: "git",
        evidence: {
          evidenceId: "changeset-evidence-1",
          changesetId: "changeset-1",
          source: "git",
          status: "available",
          files: ["src/index.ts"],
          diffStat: { added: 3, changed: 1, deleted: 1 },
          patchPreviewTruncated: false,
        },
      },
      commitEvidence: {
        commitSha: "abcdef1234567890",
        branch: "feat/evidence",
      },
    });

    expect(summary.reviewSummary).toBe("review [Architecture review]: passed - no blockers");
    expect(summary.runFacts).toContainEqual({
      label: "Review",
      value: "review [Architecture review]: passed - no blockers",
    });
    expect(summary.changeFacts).toEqual([
      { label: "Changeset status", value: "available" },
      { label: "Changed files", value: "1 (src/index.ts)" },
      { label: "Diff stat", value: "+3 / -1 across 1 file" },
      { label: "Repo state", value: "Git changes recorded" },
      { label: "Commit", value: "abcdef1 on feat/evidence" },
    ]);
  });

  it("exports canonical workflow lane semantics for natural flow contracts", () => {
    expect(WORKFLOW_LANE_KINDS).toEqual(
      expect.arrayContaining(["implementation", "fix", "validation", "regression", "review", "commit", "pull_request"]),
    );
  });

  it("models trusted runtime policy and non-executable user decision nodes", () => {
    const runtimePolicy: WorkflowRuntimePolicy = {
      source: "workflow_projection",
      trusted: true,
      executable: false,
      sandbox: "read-only",
      sideEffects: [],
      reason: "Human decision nodes are not agent tasks.",
    };
    const rollbackStatus: NodeRollbackStatus = "rolled_back";
    const node = {
      id: "decision-architecture-risk",
      title: "Choose architecture path",
      agent: "hermes",
      progress: "Waiting for input",
      nodeKind: "user_decision",
      executable: false,
      runtimePolicy,
      userDecision: {
        decisionId: "decision-architecture-risk",
        prompt: "Backtrack or continue?",
        options: ["Backtrack", "Continue"],
        reason: "Earlier design may be wrong.",
        status: "waiting_input",
      },
      status: "running",
      rollbackStatus,
      position: { x: 0, y: 0 },
      runId: "run-decision-architecture-risk",
      changesetId: "changeset-decision-architecture-risk",
      output: [],
      worktree: { path: ".", branchName: "main", baseCommit: "base" },
      context: {
        brief: "Choose architecture path.",
        sessionGoal: "Ship safely.",
        relatedRequirements: "",
        relatedDesign: "",
        relatedTasks: "",
        dependencies: [],
        constraints: [],
      },
    } satisfies CanvasNode;

    expect(node.executable).toBe(false);
    expect(node.runtimePolicy.sandbox).toBe("read-only");
    expect(node.userDecision?.status).toBe("waiting_input");
    expect(node.rollbackStatus).toBe("rolled_back");
  });

  it("publishes ledger, decision, worktree, variant, and changeset evidence contracts", () => {
    const ledger: WorkflowLedgerSummary = {
      throughSeq: 12,
      checkpointSummary: "Implementation failed on typecheck.",
      facts: ["lane-implementation failed typecheck"],
      recentEvents: [{ seq: 12, kind: "workflow.evidence.recorded", summary: "typecheck failed", laneId: "lane-implementation" }],
      openQuestions: ["Backtrack or repair?"],
    };
    const requested: UserDecisionRequestedPayload = {
      decisionId: "decision-typecheck-strategy",
      prompt: "Choose repair strategy.",
      options: ["Repair in place", "Open parallel worktree"],
      reason: "The failure may be architectural.",
      targetLaneId: "lane-implementation",
      targetSegmentId: "segment-implementation-1",
    };
    const answered: UserDecisionAnsweredPayload = {
      decisionId: requested.decisionId,
      selectedOption: "Open parallel worktree",
      action: "parallel_worktree",
      comment: "Compare both approaches.",
      targetLaneId: requested.targetLaneId,
      targetSegmentId: requested.targetSegmentId,
    };
    const worktree: WorkflowWorktreeIdentity = {
      worktreeId: "worktree-a",
      variantId: "variant-a",
      path: "/repo.worktrees/session-1-variant-a",
      realPath: "/repo.worktrees/session-1-variant-a",
      gitdir: "/repo/.git/worktrees/session-1-variant-a",
      repoRoot: "/repo",
      branchName: "skyturn/session-1/variant-a",
      baseCommit: "abc123",
      headCommit: "def456",
      parentLaneId: "lane-implementation",
      parentSegmentId: "segment-implementation-1",
    };
    const adoption: WorkflowVariantAdoption = {
      adoptionId: "adopt-variant-a",
      variantId: worktree.variantId,
      worktreeId: worktree.worktreeId,
      strategy: "merge",
      status: "requested",
      baseCommit: worktree.baseCommit,
      headCommit: worktree.headCommit,
      targetBranchName: "main",
    };
    const changesetEvidence: ChangesetEvidence = {
      evidenceId: "changeset-evidence-a",
      changesetId: "changeset-a",
      source: "git",
      status: "available",
      files: ["src/index.ts"],
      diffStat: { added: 4, changed: 1, deleted: 0 },
      patchPreviewTruncated: true,
      worktreeId: worktree.worktreeId,
      collectedAt: "2026-06-16T00:00:00.000Z",
    };

    expect(ledger.recentEvents[0]?.laneId).toBe("lane-implementation");
    expect(answered.action).toBe("parallel_worktree");
    expect(worktree.gitdir).toContain("/.git/worktrees/");
    expect(adoption.status).toBe("requested");
    expect(changesetEvidence.source).toBe("git");
  });

  it("models node-boundary checkpoints and rollback eligibility without tool-call grain", () => {
    const beforeCheckpoint: WorkflowNodeCheckpoint = {
      id: "checkpoint-before-lane-implementation-run-1",
      sessionId: "session-1",
      nodeId: "node-implementation",
      laneId: "lane-implementation",
      runId: "run-implementation-1",
      segmentId: "segment-implementation-1",
      phase: "before",
      executionTarget: "new_worktree",
      worktreeId: "worktree-implementation",
      worktreePath: "/repo.worktrees/session-1-implementation",
      baseCommit: "base-sha",
      headCommit: "head-before-sha",
      createdAt: "2026-06-23T00:00:00.000Z",
      source: "agent_bridge",
      evidenceRefs: [{ kind: "run", id: "run-implementation-1" }],
      authority: {
        laneIdExplicit: true,
        nodeIdExplicit: true,
        phaseExplicit: true,
        executionTargetExplicit: true,
      },
    };
    const afterCheckpoint: WorkflowNodeCheckpoint = {
      ...beforeCheckpoint,
      id: "checkpoint-after-lane-implementation-run-1",
      phase: "after",
      headCommit: "head-after-sha",
      evidenceRefs: [{ kind: "changeset", id: "changeset-implementation-1" }],
    };
    const eligibility: WorkflowRollbackEligibility = {
      eligible: false,
      targetLaneId: "lane-implementation",
      targetNodeId: "node-implementation",
      checkpointId: beforeCheckpoint.id,
      checkpointPhase: "before",
      restoreCommitRef: beforeCheckpoint.headCommit,
      affectedLaneIds: ["lane-implementation", "lane-validation"],
      affectedNodeIds: ["node-implementation", "lane-validation"],
      downstreamInactiveLaneIds: ["lane-validation"],
      downstreamInactiveNodeIds: ["lane-validation"],
      blockingRemoteSideEffects: [
        {
          eventKind: "workflow.pull_request.created",
          status: "recorded",
          laneId: "lane-validation",
          eventId: "event-pr-created",
        },
      ],
      localRollbackSafe: true,
      localSafetyStatus: "safe",
      reason: "Remote side effects exist.",
    };
    const remoteSideEffectPayload: WorkflowRemoteSideEffectPayload = {
      affectedLaneIds: ["lane-implementation", "lane-validation"],
      evidence: { url: "https://example.test/pr/42" },
    };
    const repairIntent: WorkflowCheckpointIntent = {
      intentId: "repair-lane-implementation",
      sessionId: "session-1",
      kind: "repair",
      status: "requested",
      nodeId: "node-implementation",
      laneId: "lane-implementation",
      checkpointId: afterCheckpoint.id,
      successorLaneId: "lane-implementation-repair",
      successorSemanticKey: "successor:lane-implementation-repair",
      createdAt: "2026-06-23T00:00:01.000Z",
    };

    expect(beforeCheckpoint.phase).toBe("before");
    expect(afterCheckpoint.phase).toBe("after");
    expect(beforeCheckpoint.executionTarget).toBe("new_worktree");
    expect(beforeCheckpoint.authority?.phaseExplicit).toBe(true);
    expect(beforeCheckpoint.authority?.executionTargetExplicit).toBe(true);
    expect(beforeCheckpoint.evidenceRefs).toEqual([{ kind: "run", id: "run-implementation-1" }]);
    expect(beforeCheckpoint).not.toHaveProperty("toolCallId");
    expect(eligibility.checkpointId).toBe(beforeCheckpoint.id);
    expect(eligibility.checkpointPhase).toBe("before");
    expect(eligibility.restoreCommitRef).toBe("head-before-sha");
    expect(eligibility.affectedNodeIds).toEqual(["node-implementation", "lane-validation"]);
    expect(eligibility.downstreamInactiveLaneIds).toEqual(["lane-validation"]);
    expect(eligibility.blockingRemoteSideEffects[0]?.eventKind).toBe("workflow.pull_request.created");
    expect(eligibility.blockingRemoteSideEffects[0]?.status).toBe("recorded");
    expect(eligibility.localSafetyStatus).toBe("safe");
    expect(remoteSideEffectPayload.affectedLaneIds).toEqual(["lane-implementation", "lane-validation"]);
    expect(repairIntent.successorLaneId).toBe("lane-implementation-repair");
    expect(repairIntent.successorSemanticKey).toBe("successor:lane-implementation-repair");
  });

  it("models rejected successor intents when repair, variant, or fork has no explicit successor identity", () => {
    const baseIntent = {
      sessionId: "session-1",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-after-lane-implementation-run-1",
      createdAt: "2026-06-23T00:00:01.000Z",
      status: "rejected",
      reason: "repair requires successor identity.",
    } as const;
    const repairIntentWithoutSuccessor: WorkflowCheckpointIntent = {
      ...baseIntent,
      intentId: "repair-lane-implementation",
      kind: "repair",
    };
    const variantIntentWithoutSuccessor: WorkflowCheckpointIntent = {
      ...baseIntent,
      intentId: "variant-lane-implementation",
      kind: "variant",
      checkpointId: "checkpoint-before-lane-implementation-run-1",
      reason: "variant requires successor identity.",
    };
    const forkIntentWithoutSuccessor: WorkflowCheckpointIntent = {
      ...baseIntent,
      intentId: "fork-lane-implementation",
      kind: "fork",
      checkpointId: "checkpoint-before-lane-implementation-run-1",
      reason: "fork requires successor identity.",
    };
    const repairIntentWithLaneId: WorkflowCheckpointIntent = {
      intentId: "repair-lane-implementation-by-id",
      sessionId: "session-1",
      kind: "repair",
      status: "requested",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-after-lane-implementation-run-1",
      successorLaneId: "lane-implementation-repair",
      createdAt: "2026-06-23T00:00:01.000Z",
    };
    const repairIntentWithSemanticKey: WorkflowCheckpointIntent = {
      intentId: "repair-lane-implementation-by-key",
      sessionId: "session-1",
      kind: "repair",
      status: "requested",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-after-lane-implementation-run-1",
      successorSemanticKey: "successor:lane-implementation-repair",
      createdAt: "2026-06-23T00:00:01.000Z",
    };
    const requestedSuccessorIntent: WorkflowRequestedCheckpointSuccessorIntent = {
      intentId: "repair-lane-implementation-targeted",
      sessionId: "session-1",
      kind: "repair",
      status: "requested",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-after-lane-implementation-run-1",
      successorSemanticKey: "successor:lane-implementation-repair",
      createdAt: "2026-06-23T00:00:01.000Z",
    };
    const rollbackIntentWithoutSuccessor: WorkflowCheckpointIntent = {
      intentId: "rollback-lane-implementation",
      sessionId: "session-1",
      kind: "rollback",
      status: "requested",
      laneId: "lane-implementation",
      checkpointId: "checkpoint-before-lane-implementation-run-1",
      createdAt: "2026-06-23T00:00:01.000Z",
    };

    for (const intent of [repairIntentWithoutSuccessor, variantIntentWithoutSuccessor, forkIntentWithoutSuccessor]) {
      expect(intent.status).toBe("rejected");
      expect(intent.reason).toMatch(/successor identity/i);
      expect(intent).not.toHaveProperty("successorLaneId");
      expect(intent).not.toHaveProperty("successorSemanticKey");
    }
    expect(repairIntentWithLaneId.successorLaneId).toBe("lane-implementation-repair");
    expect(repairIntentWithLaneId.status).toBe("requested");
    expect(repairIntentWithSemanticKey.successorSemanticKey).toBe("successor:lane-implementation-repair");
    expect(repairIntentWithSemanticKey.status).toBe("requested");
    expect(requestedSuccessorIntent.laneId).toBe("lane-implementation");
    expect(rollbackIntentWithoutSuccessor.status).toBe("requested");
  });

  it("publishes Loop Engineering next-action, blocker, stale-evidence, and phase contracts", () => {
    const state: WorkflowLoopEngineeringState = {
      sessionId: "session-1",
      throughSeq: 42,
      evidenceStale: true,
      nextAction: {
        kind: "blocked",
        loop: "delivery",
        reason: "Pull request checks are stale for the current head.",
        laneId: "lane-ci",
      },
      blockedReason: {
        code: "stale_head",
        message: "Pull request checks are stale for the current head.",
        laneId: "lane-ci",
      },
      delivery: {
        phase: "checks_stale",
        evidenceStale: true,
        pullRequestLaneId: "lane-pr",
        checkLaneId: "lane-ci",
        prNumber: 42,
        headSha: "head-current",
        lastCheckedHeadSha: "head-old",
        checks: [{ name: "Build and test", status: "passed" }],
        blockedReason: {
          code: "stale_head",
          message: "Pull request checks are stale for the current head.",
          laneId: "lane-ci",
        },
      },
      rollback: {
        phase: "blocked",
        targetLaneId: "lane-implementation",
        checkpointId: "checkpoint-before-lane-implementation",
        checkpointPhase: "before",
        restoreCommitRef: "head-before-sha",
        affectedLaneIds: ["lane-implementation", "lane-validation"],
        affectedNodeIds: ["lane-implementation", "lane-validation"],
        downstreamInactiveLaneIds: ["lane-validation"],
        downstreamInactiveNodeIds: ["lane-validation"],
        remoteBlockers: [
          {
            eventKind: "workflow.pull_request.created",
            status: "recorded",
            eventId: "event-pr-created",
            laneId: "lane-implementation",
            affectedLaneIds: ["lane-implementation"],
          },
        ],
        localRollbackSafe: true,
        localSafetyStatus: "safe",
        blockedReason: {
          code: "remote_side_effect",
          message: "Rollback is blocked by remote side effects.",
          affectedLaneIds: ["lane-implementation", "lane-validation"],
          eventKinds: ["workflow.pull_request.created"],
        },
      },
      repair: {
        phase: "requested",
        sourceLaneId: "lane-implementation",
        checkpointId: "checkpoint-after-lane-implementation",
        successorLaneId: "lane-implementation-repair",
      },
      variant: {
        phase: "not_requested",
      },
    };

    expect(state.nextAction.kind).toBe("blocked");
    expect(state.delivery.phase).toBe("checks_stale");
    expect(state.rollback.remoteBlockers[0]?.eventKind).toBe("workflow.pull_request.created");
    expect(state.repair.successorLaneId).toBe("lane-implementation-repair");
  });
});
