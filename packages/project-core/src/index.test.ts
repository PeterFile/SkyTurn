import { createHash } from "node:crypto";

import { describe, expect, expectTypeOf, it } from "vitest";

import {
  AGENT_TRANSPORT_KINDS,
  AGENT_SUPPORT_LEVELS,
  EVIDENCE_CHECK_KINDS,
  DEFAULT_AGENT_TRANSPORT_FEATURE_FLAGS,
  RUN_EVENT_PROTOCOL_VERSION,
  TERMINAL_SESSION_STATUSES,
  canUsePtyInteractiveTransport,
  canonicalCandidateReviewRequestJson,
  canonicalWorkflowCandidateManifestJson,
  canonicalExpectedArtifactDeclarationKeys,
  createWorkflowGitAncestryProofContext,
  expectedArtifactContractForRequiredEvidence,
  normalizeSessionTarget,
  parseExpectedArtifactDeclarations,
  parseExpectedArtifactDeclaration,
  parseChangesetEvidence,
  parseCandidateReviewDecision,
  parseCandidateReviewDecisionJson,
  parseCandidateReviewRequest,
  resolveWorkflowDeliveryCandidateIdentity,
  parseWorkflowLaneCandidateBinding,
  parseWorkflowLaneCandidateBindingBlock,
  parseWorkflowVariantComparisonRecordedEvidence,
  parseWorkflowGitAncestryProof,
  parseWorkflowCandidateManifest,
  parseRunEvent,
  parseRunEvidence,
  parseRunEvidenceChecks,
  parseRunEvidenceArtifacts,
  sanitizeRunEvidence,
  sanitizePublicEvidenceText,
  WORKFLOW_LANE_KINDS,
  WORKFLOW_CANDIDATE_MANIFEST_VERSION,
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
  type CandidateReviewRequest,
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
  type WorkflowGitAncestryProof,
  type WorkflowGitAncestryProofContext,
  type WorkflowNodeCheckpoint,
  type WorkflowRequestedCheckpointSuccessorIntent,
  type NodeRollbackStatus,
  type NodeStatus,
  type WorkflowRollbackEligibility,
  type WorkflowRemoteSideEffectPayload,
  type SessionTarget,
  type WorkflowVariantAdoption,
  type WorkflowWorktreeIdentity,
  type WorkflowLaneCandidateBinding,
  type WorkflowCandidateManifest,
} from "./index";

function candidateReviewRequest(
  overrides: Partial<CandidateReviewRequest> = {},
): CandidateReviewRequest {
  return {
    version: 1,
    manifestSha256: "7".repeat(64),
    identity: {
      sessionId: "session-1",
      nodeId: "lane-implementation",
      laneId: "lane-implementation",
      segmentId: "segment-session-1-lane-implementation",
      runId: "run-session-1-lane-implementation",
    },
    candidate: {
      repositoryIdentity: "1".repeat(64),
      worktreeIdentity: "2".repeat(64),
      branchName: "feature/candidate-review",
      beforeHeadCommit: "a".repeat(40),
      afterHeadCommit: "b".repeat(40),
      ancestryProofSha256: "3".repeat(64),
      fileManifestSha256: "5".repeat(64),
    },
    patch: {
      encoding: "base64",
      sha256: "4".repeat(64),
      byteLength: 4,
      base64: Buffer.from([0, 0xff, 0x41, 0x0a]).toString("base64"),
    },
    ...overrides,
  };
}

describe("CandidateReview v1 contracts", () => {
  it("strictly parses allow and block decisions with exact canonical digests", () => {
    const allow = {
      version: 1,
      requestSha256: "8".repeat(64),
      manifestSha256: "7".repeat(64),
      disposition: "allow",
    } as const;
    const block = { ...allow, disposition: "block" } as const;

    expect(parseCandidateReviewDecision(allow)).toEqual(allow);
    expect(parseCandidateReviewDecision(block)).toEqual(block);
    expect(parseCandidateReviewDecisionJson(JSON.stringify(allow))).toEqual(allow);
    expect(parseCandidateReviewDecisionJson(JSON.stringify(block))).toEqual(block);
  });

  it.each([
    ["missing key", ({ manifestSha256: _digest, ...decision }) => decision],
    ["extra key", (decision) => ({ ...decision, reason: "looks safe" })],
    ["wrong version", (decision) => ({ ...decision, version: 2 })],
    ["uppercase request digest", (decision) => ({ ...decision, requestSha256: "A".repeat(64) })],
    ["malformed manifest digest", (decision) => ({ ...decision, manifestSha256: "7".repeat(63) })],
    ["unknown disposition", (decision) => ({ ...decision, disposition: "approve" })],
  ])("rejects a decision with %s", (_label, mutate) => {
    const decision = {
      version: 1,
      requestSha256: "8".repeat(64),
      manifestSha256: "7".repeat(64),
      disposition: "allow",
    };
    expect(parseCandidateReviewDecision(mutate(decision))).toBeNull();
  });

  it.each([
    ["leading prose", "allow: "],
    ["markdown fence", "```json\n"],
    ["trailing whitespace", ""],
  ])("rejects non-exact decision JSON with %s", (_label, prefix) => {
    const decision = JSON.stringify({
      version: 1,
      requestSha256: "8".repeat(64),
      manifestSha256: "7".repeat(64),
      disposition: "allow",
    });
    const raw = prefix === "" ? `${decision}\n` : `${prefix}${decision}${prefix.startsWith("```") ? "\n```" : ""}`;
    expect(parseCandidateReviewDecisionJson(raw)).toBeNull();
  });

  it("rejects duplicate and non-canonical decision identity serialization", () => {
    const duplicate = `{"version":1,"requestSha256":"${"8".repeat(64)}","requestSha256":"${"8".repeat(64)}","manifestSha256":"${"7".repeat(64)}","disposition":"allow"}`;
    const unsorted = JSON.stringify({
      disposition: "allow",
      manifestSha256: "7".repeat(64),
      requestSha256: "8".repeat(64),
      version: 1,
    });

    expect(parseCandidateReviewDecisionJson(duplicate)).toBeNull();
    expect(parseCandidateReviewDecisionJson(unsorted)).toBeNull();
  });

  it("strictly parses a bounded base64 request and canonicalizes key order", () => {
    const request = candidateReviewRequest();
    const reordered = {
      patch: { ...request.patch },
      candidate: { ...request.candidate },
      identity: { ...request.identity },
      manifestSha256: request.manifestSha256,
      version: request.version,
    };

    expect(parseCandidateReviewRequest(request)).toEqual(request);
    expect(parseCandidateReviewRequest(reordered)).toEqual(request);
    expect(canonicalCandidateReviewRequestJson(reordered)).toBe(JSON.stringify(request));
    expect(
      createHash("sha256").update(canonicalCandidateReviewRequestJson(reordered), "utf8").digest("hex"),
    ).toBe(createHash("sha256").update(JSON.stringify(request), "utf8").digest("hex"));
  });

  it.each([
    ["missing request key", ({ patch: _patch, ...request }) => request],
    ["extra request key", (request) => ({ ...request, prompt: "trust me" })],
    ["wrong request version", (request) => ({ ...request, version: 2 })],
    ["uppercase manifest digest", (request) => ({ ...request, manifestSha256: "A".repeat(64) })],
    ["extra identity key", (request: CandidateReviewRequest) => ({ ...request, identity: { ...request.identity, path: "/private/repo" } })],
    ["malformed identity", (request: CandidateReviewRequest) => ({ ...request, identity: { ...request.identity, runId: " run-1" } })],
    ["extra candidate digest", (request: CandidateReviewRequest) => ({ ...request, candidate: { ...request.candidate, terminalRunEvidenceSha256: "6".repeat(64) } })],
    ["uppercase candidate digest", (request: CandidateReviewRequest) => ({ ...request, candidate: { ...request.candidate, ancestryProofSha256: "A".repeat(64) } })],
    ["unsafe branch", (request: CandidateReviewRequest) => ({ ...request, candidate: { ...request.candidate, branchName: "main..other" } })],
    ["invalid base64", (request: CandidateReviewRequest) => ({ ...request, patch: { ...request.patch, base64: "not base64" } })],
    ["wrong decoded length", (request: CandidateReviewRequest) => ({ ...request, patch: { ...request.patch, byteLength: 5 } })],
    ["uppercase patch digest", (request: CandidateReviewRequest) => ({ ...request, patch: { ...request.patch, sha256: "A".repeat(64) } })],
    ["wire policy claim", (request: CandidateReviewRequest) => ({ ...request, policy: { toolAccess: "none" } })],
  ])("rejects a candidate request with %s", (_label, mutate) => {
    expect(parseCandidateReviewRequest(mutate(candidateReviewRequest()) as unknown)).toBeNull();
  });

  it("serializes manifests canonically before the host hashes them", () => {
    const manifest = workflowCandidateManifest();
    const reordered = Object.fromEntries(Object.entries(manifest).reverse());

    expect(canonicalWorkflowCandidateManifestJson(reordered)).toBe(JSON.stringify(manifest));
    expect(
      createHash("sha256").update(canonicalWorkflowCandidateManifestJson(reordered), "utf8").digest("hex"),
    ).toBe(createHash("sha256").update(JSON.stringify(manifest), "utf8").digest("hex"));
  });
});

describe("Workflow delivery candidate lineage", () => {
  it("requires one completed validation gate followed by one completed workflow review gate", () => {
    expect(resolveWorkflowDeliveryCandidateIdentity(
      candidateDeliveryProjection(),
      "session-1",
      "lane-commit",
    )).toEqual({
      sessionId: "session-1",
      nodeId: "lane-implementation",
      laneId: "lane-implementation",
      segmentId: "segment-implementation",
      runId: "run-implementation",
      agentKind: "codex",
    });
  });

  it.each([
    ["implementation directly to commit", (projection: CandidateDeliveryProjection) => {
      projection.lanes = projection.lanes.filter((lane) => lane.id === "lane-implementation" || lane.id === "lane-commit");
      projection.projectionNodes = projection.projectionNodes.filter((node) => node.id === "lane-implementation" || node.id === "lane-commit");
      projection.segments = projection.segments.filter((segment) => segment.laneId === "lane-implementation");
      projection.edges = [{ sourceLaneId: "lane-implementation", targetLaneId: "lane-commit" }];
    }],
    ["missing validation", (projection: CandidateDeliveryProjection) => {
      projection.lanes = projection.lanes.filter((lane) => lane.id !== "lane-validation");
      projection.projectionNodes = projection.projectionNodes.filter((node) => node.id !== "lane-validation");
      projection.segments = projection.segments.filter((segment) => segment.laneId !== "lane-validation");
      projection.edges = [
        { sourceLaneId: "lane-implementation", targetLaneId: "lane-review" },
        { sourceLaneId: "lane-review", targetLaneId: "lane-commit" },
      ];
    }],
    ["missing review", (projection: CandidateDeliveryProjection) => {
      projection.lanes = projection.lanes.filter((lane) => lane.id !== "lane-review");
      projection.projectionNodes = projection.projectionNodes.filter((node) => node.id !== "lane-review");
      projection.segments = projection.segments.filter((segment) => segment.laneId !== "lane-review");
      projection.edges = [
        { sourceLaneId: "lane-implementation", targetLaneId: "lane-validation" },
        { sourceLaneId: "lane-validation", targetLaneId: "lane-commit" },
      ];
    }],
    ["ambiguous graph", (projection: CandidateDeliveryProjection) => {
      projection.edges.push({ sourceLaneId: "lane-implementation", targetLaneId: "lane-review" });
    }],
    ["failed gate", (projection: CandidateDeliveryProjection) => {
      projection.segments.find((segment) => segment.laneId === "lane-validation")!.status = "failed";
    }],
  ])("rejects %s", (_label, mutate) => {
    const projection = candidateDeliveryProjection();
    mutate(projection);

    expect(() => resolveWorkflowDeliveryCandidateIdentity(
      projection,
      "session-1",
      "lane-commit",
    )).toThrow("Workflow delivery candidate lineage is invalid.");
  });
});

interface CandidateDeliveryProjection {
  lanes: Array<Record<string, unknown> & { id: string; status: string }>;
  projectionNodes: Array<Record<string, unknown> & { id: string }>;
  segments: Array<Record<string, unknown> & { laneId: string; status: string }>;
  edges: Array<{ sourceLaneId: string; targetLaneId: string }>;
  laneRollbackStatuses: Record<string, unknown>;
}

function candidateDeliveryProjection(): CandidateDeliveryProjection {
  return {
    lanes: [
      { id: "lane-implementation", kind: "implementation", laneKind: "implementation", status: "completed", executable: true, agentKind: "codex" },
      { id: "lane-validation", kind: "validation", laneKind: "validation", status: "completed", executable: true, agentKind: "codex" },
      { id: "lane-review", kind: "review", laneKind: "review", status: "completed", executable: true, agentKind: "hermes" },
      { id: "lane-commit", kind: "commit", laneKind: "commit", status: "pending", executable: true, agentKind: "codex" },
    ],
    projectionNodes: [
      { id: "lane-implementation", laneId: "lane-implementation", executable: true },
      { id: "lane-validation", laneId: "lane-validation", executable: true },
      { id: "lane-review", laneId: "lane-review", executable: true },
      { id: "lane-commit", laneId: "lane-commit", executable: true },
    ],
    segments: [
      { id: "segment-implementation", laneId: "lane-implementation", runId: "run-implementation", status: "succeeded" },
      { id: "segment-validation", laneId: "lane-validation", runId: "run-validation", status: "succeeded" },
      { id: "segment-review", laneId: "lane-review", runId: "run-review", status: "succeeded" },
    ],
    edges: [
      { sourceLaneId: "lane-implementation", targetLaneId: "lane-validation" },
      { sourceLaneId: "lane-validation", targetLaneId: "lane-review" },
      { sourceLaneId: "lane-review", targetLaneId: "lane-commit" },
    ],
    laneRollbackStatuses: {},
  };
}

function workflowCandidateManifest(
  overrides: Partial<WorkflowCandidateManifest> = {},
): WorkflowCandidateManifest {
  return {
    version: 1,
    createdAt: "2026-08-11T00:00:00.000Z",
    sessionId: "session-1",
    nodeId: "lane-implementation",
    laneId: "lane-implementation",
    segmentId: "segment-session-1-lane-implementation",
    runId: "run-session-1-lane-implementation",
    agentKind: "codex",
    executionTarget: "current_branch",
    worktreeId: null,
    repositoryIdentity: "1".repeat(64),
    worktreeIdentity: "2".repeat(64),
    branchName: "main",
    beforeCheckpointId: "checkpoint:run-session-1-lane-implementation:before",
    beforeHeadCommit: "a".repeat(40),
    afterCheckpointId: "checkpoint:run-session-1-lane-implementation:after",
    afterHeadCommit: "b".repeat(40),
    ancestryProofSha256: "3".repeat(64),
    terminalEvidenceId: "evidence-segment-session-1-lane-implementation",
    terminalRunEvidence: {
      runId: "run-session-1-lane-implementation",
      status: "succeeded",
      exitCode: 0,
      changesetId: "changeset-run-session-1-lane-implementation",
      checks: [
        { kind: "test", status: "passed" },
        { kind: "review", status: "skipped" },
      ],
      artifactCount: 2,
      review: { kind: "review", status: "passed" },
      errorReason: null,
      cancelReason: null,
      completedAt: "2026-08-11T00:00:00.000Z",
    },
    terminalRunEvidenceSha256: "6".repeat(64),
    changesetEvidenceId: "changeset-evidence:run-session-1-lane-implementation:after",
    changesetId: "changeset-run-session-1-lane-implementation",
    fullPatchSha256: "4".repeat(64),
    fullPatchByteLength: 128,
    fileManifestSha256: "5".repeat(64),
    ...overrides,
  };
}

describe("WorkflowCandidateManifest contract", () => {
  it("strictly parses the current immutable manifest shape", () => {
    const manifest = workflowCandidateManifest();

    expect(WORKFLOW_CANDIDATE_MANIFEST_VERSION).toBe(1);
    expect(parseWorkflowCandidateManifest(manifest)).toEqual(manifest);
  });

  it.each([
    ["missing field", ({ createdAt: _createdAt, ...manifest }) => manifest],
    ["extra field", (manifest) => ({ ...manifest, worktreePath: "/private/repo" })],
    ["bad version", (manifest) => ({ ...manifest, version: 2 })],
    ["malformed identity", (manifest) => ({ ...manifest, sessionId: " session-1" })],
    ["path-like opaque identity", (manifest: WorkflowCandidateManifest) => ({ ...manifest, changesetId: "src/private.ts" })],
    ["prose terminal evidence identity", (manifest: WorkflowCandidateManifest) => ({ ...manifest, terminalEvidenceId: "agent said success" })],
    ["absolute-path branch", (manifest: WorkflowCandidateManifest) => ({ ...manifest, branchName: "/private/repo" })],
    ["double-dot branch", (manifest: WorkflowCandidateManifest) => ({ ...manifest, branchName: "main..tampered" })],
    ["empty branch component", (manifest: WorkflowCandidateManifest) => ({ ...manifest, branchName: "refs//heads/x" })],
    ["lock-suffixed branch", (manifest: WorkflowCandidateManifest) => ({ ...manifest, branchName: "feature/x.lock" })],
    ["malformed timestamp", (manifest) => ({ ...manifest, createdAt: "2026-08-11" })],
    ["non-current evidence", (manifest: WorkflowCandidateManifest) => ({ ...manifest, terminalRunEvidence: { ...manifest.terminalRunEvidence, exitCode: null } })],
    ["failed evidence", (manifest: WorkflowCandidateManifest) => ({ ...manifest, terminalRunEvidence: { ...manifest.terminalRunEvidence, status: "failed" } })],
    ["extra evidence field", (manifest: WorkflowCandidateManifest) => ({ ...manifest, terminalRunEvidence: { ...manifest.terminalRunEvidence, compatibilitySource: "legacy-disk" } })],
    ["evidence check prose", (manifest: WorkflowCandidateManifest) => ({ ...manifest, terminalRunEvidence: { ...manifest.terminalRunEvidence, checks: [{ kind: "test", status: "passed", name: "pnpm test" }] } })],
    ["negative artifact count", (manifest: WorkflowCandidateManifest) => ({ ...manifest, terminalRunEvidence: { ...manifest.terminalRunEvidence, artifactCount: -1 } })],
    ["non-null failure reason", (manifest: WorkflowCandidateManifest) => ({ ...manifest, terminalRunEvidence: { ...manifest.terminalRunEvidence, errorReason: "hidden output" } })],
    ["malformed evidence timestamp", (manifest: WorkflowCandidateManifest) => ({ ...manifest, terminalRunEvidence: { ...manifest.terminalRunEvidence, completedAt: "2026-08-11" } })],
    ["mismatched evidence run", (manifest: WorkflowCandidateManifest) => ({ ...manifest, terminalRunEvidence: { ...manifest.terminalRunEvidence, runId: "run-other" } })],
    ["mismatched changeset", (manifest: WorkflowCandidateManifest) => ({ ...manifest, terminalRunEvidence: { ...manifest.terminalRunEvidence, changesetId: "changeset-other" } })],
    ["path-like evidence changeset", (manifest: WorkflowCandidateManifest) => ({ ...manifest, terminalRunEvidence: { ...manifest.terminalRunEvidence, changesetId: "src/private.ts" }, changesetId: "src/private.ts" })],
    ["missing evidence digest", ({ terminalRunEvidenceSha256: _digest, ...manifest }) => manifest],
    ["bad evidence digest", (manifest) => ({ ...manifest, terminalRunEvidenceSha256: "A".repeat(64) })],
    ["bad patch digest", (manifest) => ({ ...manifest, fullPatchSha256: "A".repeat(64) })],
    ["bad manifest digest", (manifest) => ({ ...manifest, fileManifestSha256: "5".repeat(63) })],
    ["zero patch bytes", (manifest) => ({ ...manifest, fullPatchByteLength: 0 })],
    ["unsafe patch bytes", (manifest) => ({ ...manifest, fullPatchByteLength: Number.MAX_SAFE_INTEGER + 1 })],
  ])("rejects %s", (_label, mutate) => {
    expect(parseWorkflowCandidateManifest(mutate(workflowCandidateManifest()) as unknown)).toBeNull();
  });

  it("allows null RunEvidence changeset identity while retaining authoritative changeset evidence", () => {
    const manifest = workflowCandidateManifest({
      terminalRunEvidence: { ...workflowCandidateManifest().terminalRunEvidence, changesetId: null },
    });

    expect(parseWorkflowCandidateManifest(manifest)).toEqual(manifest);
  });
});

describe("Git ancestry proof contract", () => {
  const contextValues = {
    beforeHeadCommit: "a".repeat(40),
    afterHeadCommit: "b".repeat(40),
    repositoryIdentity: "1".repeat(64),
    worktreeIdentity: "2".repeat(64),
  };
  const context = createWorkflowGitAncestryProofContext(
    contextValues.beforeHeadCommit,
    contextValues.afterHeadCommit,
    contextValues.repositoryIdentity,
    contextValues.worktreeIdentity,
  );
  const proof: WorkflowGitAncestryProof = {
    protocolVersion: 1,
    method: "git-merge-base-is-ancestor",
    ...contextValues,
  };
  const serializedProof = JSON.stringify(proof);

  function createContext(overrides: Partial<typeof contextValues> = {}) {
    const values = { ...contextValues, ...overrides };
    return createWorkflowGitAncestryProofContext(
      values.beforeHeadCommit,
      values.afterHeadCommit,
      values.repositoryIdentity,
      values.worktreeIdentity,
    );
  }

  it("accepts a canonical proof only in its expected repository and worktree context", () => {
    expect(parseWorkflowGitAncestryProof(serializedProof, context)).toEqual(proof);
    expect(Object.isFrozen(context)).toBe(true);
  });

  it("accepts equal before and after commits", () => {
    const equalContext = createContext({ afterHeadCommit: contextValues.beforeHeadCommit });
    const equalProof = { ...proof, afterHeadCommit: contextValues.beforeHeadCommit };

    expect(parseWorkflowGitAncestryProof(JSON.stringify(equalProof), equalContext)).toEqual(equalProof);
  });

  it("rejects non-string input without inspecting objects, arrays, proxies, or symbols", () => {
    let getterCalls = 0;
    let proxyTrapCalls = 0;
    const symbolBearing = Object.defineProperties({}, {
      beforeHeadCommit: {
        enumerable: true,
        get() {
          getterCalls += 1;
          return contextValues.beforeHeadCommit;
        },
      },
      [Symbol("hidden")]: {
        enumerable: true,
        get() {
          getterCalls += 1;
          return "hidden";
        },
      },
    });
    const trappedProxy = new Proxy({}, {
      get() {
        proxyTrapCalls += 1;
        throw new Error("proxy get trap executed");
      },
      getOwnPropertyDescriptor() {
        proxyTrapCalls += 1;
        throw new Error("proxy descriptor trap executed");
      },
      getPrototypeOf() {
        proxyTrapCalls += 1;
        throw new Error("proxy prototype trap executed");
      },
      ownKeys() {
        proxyTrapCalls += 1;
        throw new Error("proxy ownKeys trap executed");
      },
    });

    for (const value of [proof, [], trappedProxy, symbolBearing]) {
      expect(() => parseWorkflowGitAncestryProof(value, context)).toThrow(/serialized string/i);
    }
    expect(getterCalls).toBe(0);
    expect(proxyTrapCalls).toBe(0);
  });

  it("rejects oversized input before JSON parsing with a bounded error", () => {
    let caught: unknown;

    try {
      parseWorkflowGitAncestryProof("{".repeat(513), context);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe(
      "Workflow Git ancestry proof must not exceed 512 code units.",
    );
    expect((caught as Error).message.length).toBeLessThan(80);
  });

  it.each([
    ["malformed JSON", "{", /valid JSON/i],
    ["trailing content", `${serializedProof}x`, /valid JSON/i],
    ["JSON scalar", "null", /ordinary object/i],
    ["JSON array", "[]", /ordinary object/i],
    [
      "duplicate key",
      serializedProof.replace('"protocolVersion":1', '"protocolVersion":1,"protocolVersion":1'),
      /canonical/i,
    ],
    ["whitespace", serializedProof.replace("{", "{ "), /canonical/i],
    [
      "reordered keys",
      JSON.stringify({ method: proof.method, protocolVersion: proof.protocolVersion, ...contextValues }),
      /canonical/i,
    ],
    ["extra key", serializedProof.replace(/}$/, ',"extra":true}'), /exactly/i],
    [
      "missing key",
      JSON.stringify({
        protocolVersion: proof.protocolVersion,
        method: proof.method,
        beforeHeadCommit: proof.beforeHeadCommit,
        afterHeadCommit: proof.afterHeadCommit,
        repositoryIdentity: proof.repositoryIdentity,
      }),
      /exactly/i,
    ],
    ["alternate escape", serializedProof.replace("ancestor", "ancest\\u006fr"), /canonical/i],
  ] as const)("rejects %s", (_label, malformed, expectedError) => {
    expect(() => parseWorkflowGitAncestryProof(malformed, context)).toThrow(expectedError);
  });

  it.each([
    ["protocol version", { ...proof, protocolVersion: 2 }],
    ["verification method", { ...proof, method: "git-rev-list" }],
  ])("rejects a wrong %s", (_label, malformed) => {
    expect(() => parseWorkflowGitAncestryProof(JSON.stringify(malformed), context)).toThrow(
      /protocol version|method/i,
    );
  });

  it.each([
    ["beforeHeadCommit", "A".repeat(40)],
    ["beforeHeadCommit", "a".repeat(39)],
    ["afterHeadCommit", "b".repeat(41)],
    ["afterHeadCommit", "g".repeat(40)],
    ["repositoryIdentity", "A".repeat(64)],
    ["repositoryIdentity", "1".repeat(63)],
    ["worktreeIdentity", "2".repeat(65)],
    ["worktreeIdentity", "z".repeat(64)],
  ] as const)("rejects a non-canonical %s", (field, value) => {
    expect(() => parseWorkflowGitAncestryProof(
      JSON.stringify({ ...proof, [field]: value }),
      context,
    )).toThrow(/canonical/i);
  });

  it.each([
    ["beforeHeadCommit", "c".repeat(40)],
    ["afterHeadCommit", "d".repeat(40)],
    ["repositoryIdentity", "3".repeat(64)],
    ["worktreeIdentity", "4".repeat(64)],
  ] as const)("rejects an isolated %s context mismatch", (field, value) => {
    expect(() => parseWorkflowGitAncestryProof(
      serializedProof,
      createContext({ [field]: value }),
    )).toThrow(/context mismatch/i);
  });

  it.each([
    ["non-string before commit", 1 as unknown as string, contextValues.afterHeadCommit, contextValues.repositoryIdentity, contextValues.worktreeIdentity],
    ["uppercase before commit", "A".repeat(40), contextValues.afterHeadCommit, contextValues.repositoryIdentity, contextValues.worktreeIdentity],
    ["short after commit", contextValues.beforeHeadCommit, "b".repeat(39), contextValues.repositoryIdentity, contextValues.worktreeIdentity],
    ["nonhex repository", contextValues.beforeHeadCommit, contextValues.afterHeadCommit, "z".repeat(64), contextValues.worktreeIdentity],
    ["uppercase worktree", contextValues.beforeHeadCommit, contextValues.afterHeadCommit, contextValues.repositoryIdentity, "A".repeat(64)],
  ] as const)("rejects invalid context creation: %s", (_label, before, after, repository, worktree) => {
    expect(() => createWorkflowGitAncestryProofContext(
      before,
      after,
      repository,
      worktree,
    )).toThrow(/canonical lowercase/i);
  });

  it("rejects plain, cast, fake, and frozen contexts without reading getters", () => {
    let getterCalls = 0;
    const getterContext = Object.create(null);
    for (const key of Object.keys(contextValues)) {
      Object.defineProperty(getterContext, key, {
        enumerable: true,
        get() {
          getterCalls += 1;
          throw new Error("context getter executed");
        },
      });
    }
    const invalidContexts = [
      { ...contextValues },
      { ...contextValues } as WorkflowGitAncestryProofContext,
      Object.create(context) as WorkflowGitAncestryProofContext,
      Object.freeze({ ...contextValues }) as WorkflowGitAncestryProofContext,
      getterContext as WorkflowGitAncestryProofContext,
    ];

    for (const invalidContext of invalidContexts) {
      expect(() => parseWorkflowGitAncestryProof(serializedProof, invalidContext)).toThrow(/branded context/i);
    }
    expect(getterCalls).toBe(0);
  });

  it("models a checkpoint proof as optional raw canonical bytes", () => {
    const checkpoint: WorkflowNodeCheckpoint = {
      id: "checkpoint-after-lane",
      sessionId: "session-1",
      nodeId: "lane-1",
      phase: "after",
      executionTarget: "current_branch",
      headCommit: proof.afterHeadCommit,
      createdAt: "2026-07-31T00:00:00.000Z",
      source: "backend",
      evidenceRefs: [],
      ancestryProof: serializedProof,
    };

    expect(checkpoint.ancestryProof).toBe(serializedProof);
    expectTypeOf(checkpoint.ancestryProof).toEqualTypeOf<string | undefined>();
  });
});

describe("public RunEvidence boundaries", () => {
  it("preserves lossless RunEvent payload whitespace while compacting metadata", () => {
    const output = "  first line\r\n\tsecond line  \n\n";
    const patch = "@@ -1 +1 @@\r\n-  old\r\n+\tnew  \r\n";
    const codeBody = "  const value = 1;\r\n\tcwd=/Users/alice/private/repo  \nAPI_KEY=nested-secret-value\r\n\n";
    const diffLines = ["  first\r\n", "\tsecond  \n", "", "final\n"];
    const parsed = parseRunEvent({
      protocolVersion: RUN_EVENT_PROTOCOL_VERSION,
      runId: "run-lossless-output",
      seq: 1,
      timestamp: "2026-07-15T00:00:00.000Z",
      kind: "output",
      payload: {
        text: output,
        patchPreview: patch,
        changes: [{ path: "src/index.ts", unifiedDiff: patch }],
        patch: {
          path: "  src/index.ts\n",
          hunks: [{ header: "  @@ -1 +1 @@  ", content: patch }],
        },
        code: [{ language: "  typescript\n", body: codeBody }],
        diff: { path: "  src/index.ts\n", lines: diffLines },
        phase: "  generating\n  output  ",
      },
    });

    expect(parsed?.payload.text).toBe(output);
    expect(parsed?.payload.patchPreview).toBe(patch);
    expect(parsed?.payload.changes).toEqual([{ path: "src/index.ts", unifiedDiff: patch }]);
    expect(parsed?.payload.patch).toEqual({
      path: "src/index.ts",
      hunks: [{ header: "@@ -1 +1 @@", content: patch }],
    });
    expect(parsed?.payload.code).toEqual([{
      language: "typescript",
      body: codeBody
        .replace("/Users/alice/private/repo", "[redacted-path]")
        .replace("nested-secret-value", "[redacted]"),
    }]);
    expect(parsed?.payload.diff).toEqual({ path: "src/index.ts", lines: diffLines });
    expect(parsed?.payload.phase).toBe("generating output");
  });

  it.each([
    ".devflow/acceptance/a\nb.png",
    ".devflow/acceptance/a\rb.png",
    ".devflow/acceptance/a\u007fb.png",
    "/tmp/result.png",
    "C:\\Users\\alice\\result.png",
    ".devflow/acceptance/../result.png",
    ...[
      "id_rsa", "id_ed25519", "id_ecdsa", "authorized_keys", "known_hosts", "shadow",
      "token", "credential", "key", "password", "secret",
      ".npmrc", "COOKIES_SQLITE", "service_account.JSON", "service-account.backup.json", "report.PRIVATE_PEM",
      "service-account.json.backup", "service_account.json.bak", "service-account.JSON.old",
      "SERVICE__ACCOUNT--JSON.BACKUP.old", "service_account_json.bak.backup.old",
      "service-account.json.backup.txt", "service-account.json.orig.1",
      "service_account_json.backup.backup.orig.1", "SERVICE._-ACCOUNT--JSON__COPY.tar.gz",
      "service..account..json..saved..2", "service-account.snapshot.json.backup.txt",
      "service account.json.backup.txt", "service．account.json.orig.1",
      "service—account.JSON.backup", "service。account.json.saved.2",
      "serviceaccount.json.orig.1", "SERVICEACCOUNTJSON.backup.txt",
      "service-account.json.report.json",
      "authorized keys.backup.txt", "AUTHORIZED\u3000KEYS.BAK.old",
      "known\u2014hosts", "Known\uff3fHosts.backup",
      "AUTHORIZED\u3000KEYS\uff0eJSON\uff0ebackup\uff0eorig\uff0e2",
      "authorizedkeysjsonbackupbackupbakoldcopyarchive3pem",
      "KNOWN\u2014HOSTSbackupbackupbakoldcopyarchive3txt",
      "SERVICE\uff0eACCOUNTcredentialsbackupbackuporig2json",
      "credentials json.backup", "CREDENTIALS\uff0eJSON.orig.1",
      "access token.report", "Access\u00a0Token.Results.JSON",
      "certificate\uff0epem", "certificate\u2024PEM.backup.txt",
      ".npmrc.backup", ".NPMRC-BAK", ".env.local.backup", ".ENV_LOCAL_BAK",
      "id_rsa_backup.txt", "ID-RSA.old", "id_ed25519.old", "id-ED25519_backup.TXT",
      "client.private-key.backup", "signing_private_pem.old",
      "accesstoken.report", "credentialbackup.json", "passwordbackup.txt",
      "secretarchive.txt", "idrsa.backup", "privatekey.backup",
      "TLS_PRIVATEKEY.archive.old", "certificatepem.backup",
    ].map((name) => `.devflow/acceptance/${name}`),
  ])("rejects unsafe expected artifact declaration %j", (candidate) => {
    expect(parseExpectedArtifactDeclaration(candidate)).toBeNull();
  });

  it.each([
    "ACCESS　TOKEN․REPORT.JSON.BACKUP",
    "api-token__archive.tar.gz",
    "auth．key—backup.old.2",
    "credentialsbackupjsonorig1",
    "passwords．backup．txt．old",
    "secretsarchivebackupzip",
    "ID−ED25519․backup․old",
    "certificate．DER．backup．tar．gz",
    "private—key․P12․archive",
    "TLS_PRIVATEKEYPEM.backup",
    "sslcertificatepfxarchive",
  ])("rejects separatorless sensitive-family suffix chain %j", (name) => {
    expect(parseExpectedArtifactDeclaration(`.devflow/acceptance/${name}`)).toBeNull();
  });

  it.each([
    "accessibility-report.json",
    "credentialed-learning.json",
    "passwordless-guide.txt",
    "secretary-notes.txt",
    "tokenizer-results.json",
    "keyboard-layout-report.json",
    "certificate-course-summary.txt",
    "identity-rsa-analysis.txt",
    "service-accounting-report.txt",
    "service-accountability-report.txt",
    "authorized-keyspace-report.txt",
    "known-hostscope-report.txt",
  ])("accepts unrelated artifact family name %j", (name) => {
    const candidate = `.devflow/acceptance/${name}`;
    expect(parseExpectedArtifactDeclaration(candidate)).toBe(candidate);
  });

  it.each([
    ".devflow/acceptance/service-account-acceptance-report.json",
    ".devflow/acceptance/service_account_validation_report.JSON",
    ".devflow/acceptance/service-account-audit-summary.json",
    ".devflow/acceptance/service_account_migration_report.JSON",
  ])("accepts legitimate service-account report artifact %j", (candidate) => {
    expect(parseExpectedArtifactDeclaration(candidate)).toBe(candidate);
  });

  it("preserves neighboring non-sensitive families in strict RunEvidence", () => {
    const artifacts = [
      ".devflow/acceptance/service-accounting-report.txt",
      ".devflow/acceptance/service-accountability-report.txt",
      ".devflow/acceptance/authorized-keyspace-report.txt",
      ".devflow/acceptance/known-hostscope-report.txt",
    ];
    const evidence = {
      runId: "run-neighbor-artifacts",
      status: "succeeded",
      exitCode: 0,
      changesetId: null,
      checks: [{ kind: "artifact", name: "Expected artifacts", status: "passed" }],
      artifacts,
      review: null,
      errorReason: null,
      cancelReason: null,
      completedAt: "2026-07-15T00:00:00.000Z",
    } satisfies RunEvidence;

    expect(parseExpectedArtifactDeclarations(artifacts)).toEqual(artifacts);
    expect(parseRunEvidence(evidence)).toEqual(evidence);
  });

  it("accepts only complete canonical non-sensitive artifact lists", () => {
    expect(parseRunEvidenceArtifacts([
      ".devflow/acceptance/browser/result.png",
      ".devflow/acceptance/mobile/result.png",
    ])).toEqual([
      ".devflow/acceptance/browser/result.png",
      ".devflow/acceptance/mobile/result.png",
    ]);
    expect(parseRunEvidenceArtifacts([
      ".devflow/acceptance/browser/result.png",
      ".devflow\\acceptance\\windows.png",
      "/Users/alice/.ssh/id_rsa",
      "C:\\Users\\alice\\secret.txt",
      ".devflow/acceptance/../secret.txt",
      ".devflow/acceptance//empty.png",
      ".devflow/acceptance/./dot.png",
      ".devflow/acceptance/link->/etc/passwd",
      ".DEVFLOW/ACCEPTANCE/TOKEN.PEM",
      7,
    ])).toBeNull();
    expect(parseRunEvidenceArtifacts([
      ".devflow/acceptance/service-account.json.backup",
      ".devflow/acceptance/authorized keys.backup.txt",
      ".devflow/acceptance/known\u2014hosts",
      ".devflow/acceptance/credentials json.backup",
      ".devflow/acceptance/access token.report",
      ".devflow/acceptance/certificate\uff0epem",
    ])).toBeNull();
  });

  it.each([
    ".devflow/acceptance/service-account.json.backup.txt",
    ".devflow/acceptance/service-account.json.orig.1",
    ".devflow/acceptance/SERVICE._-ACCOUNT--JSON__COPY.tar.gz",
    ".devflow/acceptance/service account.json.backup.txt",
    ".devflow/acceptance/service．account.json.orig.1",
    ".devflow/acceptance/service—account.JSON.backup",
    ".devflow/acceptance/serviceaccount.json.orig.1",
    ".devflow/acceptance/service-account.json.report.json",
  ])("rejects the complete service-account credential family from strict RunEvidence %j", (artifact) => {
    const evidence = {
      runId: "run-sensitive-service-account",
      status: "succeeded",
      exitCode: 0,
      changesetId: null,
      checks: [{ kind: "artifact", name: "Expected artifacts", status: "passed" }],
      artifacts: [artifact],
      review: null,
      errorReason: null,
      cancelReason: null,
      completedAt: "2026-07-15T00:00:00.000Z",
    } satisfies RunEvidence;

    expect(parseRunEvidence(evidence)).toBeNull();
    const sanitized = sanitizeRunEvidence(evidence);
    expect(sanitized).toMatchObject({ status: "failed", artifacts: [] });
    expect(JSON.stringify(sanitized)).not.toContain(artifact);
  });

  it("canonicalizes expected artifact declaration sets with completion parser semantics", () => {
    expect(parseExpectedArtifactDeclarations([
      ".devflow/acceptance/Zeta.png",
      ".devflow/acceptance/alpha.png",
    ])).toEqual([
      ".devflow/acceptance/Zeta.png",
      ".devflow/acceptance/alpha.png",
    ]);
    expect(canonicalExpectedArtifactDeclarationKeys([
      ".devflow/acceptance/Zeta.png",
      ".devflow/acceptance/alpha.png",
    ])).toEqual([
      ".devflow/acceptance/alpha.png",
      ".devflow/acceptance/zeta.png",
    ]);
    expect(canonicalExpectedArtifactDeclarationKeys([
      ".devflow/acceptance/result.png",
      ".devflow/acceptance/RESULT.PNG",
    ])).toBeNull();
    expect(canonicalExpectedArtifactDeclarationKeys([
      ".devflow/acceptance/Ｒeport.png",
      ".devflow/acceptance/Report.png",
    ])).toBeNull();
    expect(canonicalExpectedArtifactDeclarationKeys([
      ".devflow/acceptance/nested/../result.png",
    ])).toBeNull();
    expect(canonicalExpectedArtifactDeclarationKeys([
      ".devflow/acceptance/service_account.json.bak.old",
    ])).toBeNull();
  });

  it("derives only the fixed browser artifact from required evidence", () => {
    expect(expectedArtifactContractForRequiredEvidence(["browser", "screenshot"])).toEqual({
      required: true,
      declarations: [".devflow/acceptance/react-app.png"],
    });
    expect(expectedArtifactContractForRequiredEvidence(["artifact"])).toEqual({
      required: true,
      declarations: [],
    });
    expect(expectedArtifactContractForRequiredEvidence(["test"])).toEqual({
      required: false,
      declarations: [],
    });
  });

  it("redacts public evidence text and caps its length", () => {
    const value = sanitizePublicEvidenceText(
      "spawn /Users/alice/bin/codex C:\\Users\\alice\\tool.exe Authorization: Bearer abc123 API_KEY=secret password=hunter2 credentials.json " + "x".repeat(500),
    );
    expect(value).not.toMatch(/alice|abc123|secret|hunter2|credentials\.json/);
    expect(value).toContain("[redacted]");
    expect(value.length).toBeLessThanOrEqual(320);
  });

  it("redacts absolute paths at public process-text boundaries", () => {
    const rawPaths = [
      "/Users/alice/private/repo",
      "/Users/alice/private/quoted repo",
      "/Users/alice/private/paren-repo",
      "C:\\Users\\alice\\private\\repo",
      "C:\\Users\\alice\\private\\quoted repo",
      "C:\\Users\\alice\\private\\paren-repo",
    ];
    const value = sanitizePublicEvidenceText(
      `failed after ${rawPaths[0]} cwd=${rawPaths[1]} "${rawPaths[4]}" (${rawPaths[2]}) (${rawPaths[5]}) then ${rawPaths[3]}`,
    );

    for (const rawPath of rawPaths) expect(value).not.toContain(rawPath);
    expect(value).toContain("[redacted-path]");
  });

  it.each([
    ["worktree=/Users/alice/private/repo", "worktree=[redacted-path]"],
    ["path=/private/secret/result", "path=[redacted-path]"],
    ["repo=C:\\Users\\alice\\private", "repo=[redacted-path]"],
    ["root:/private/secret/result", "root:[redacted-path]"],
    ["path:'/private/secret/quoted result'", "path:'[redacted-path]'"],
    ["path=(/private/secret/paren result)", "path=([redacted-path])"],
    ["path=[C:\\Users\\alice\\bracketed result]", "path=[[redacted-path]]"],
    ["path={/private/secret/braced result}", "path={[redacted-path]}"],
    ["failed: /private/secret/result.", "failed: [redacted-path]."],
    ["path=/private/secret/result, repo=C:\\Users\\alice\\private;", "path=[redacted-path], repo=[redacted-path];"],
  ])("redacts delimiter-prefixed absolute paths in %j", (input, expected) => {
    expect(sanitizePublicEvidenceText(input)).toBe(expected);
  });
});

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

function collectStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(collectStrings);
  if (value && typeof value === "object") return Object.values(value).flatMap(collectStrings);
  return [];
}

describe("agent run contracts", () => {
  it("rejects an entire check list when any check is malformed", () => {
    const secret = "sk-supersecret123456";
    expect(parseRunEvidenceChecks([
      { kind: "test", name: "Unit /Users/alice/private/repo", status: "passed", detail: `OPENAI_API_KEY=${secret}` },
    ])).toEqual([
      {
        kind: "test",
        name: "Unit [redacted-path]",
        status: "passed",
        detail: "OPENAI_API_KEY=[redacted]",
      },
    ]);

    expect(parseRunEvidenceChecks([
      { kind: "test", name: "Unit", status: "passed" },
      { kind: "verification", name: "Unknown", status: "passed", detail: "must be ignored" },
      { kind: "build", name: "Invalid status", status: "success", detail: "must be ignored" },
      { kind: "review", name: 42, status: "failed" },
    ])).toBeNull();
    expect(parseRunEvidenceChecks([
      { kind: "test", name: "control\ntext", status: "passed" },
    ])).toBeNull();
  });

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

  it("fails closed when succeeded RunEvidence contains a failed expected-artifact gate", () => {
    const evidence = runEvidence({
      status: "succeeded",
      exitCode: 0,
      checks: [
        { kind: "artifact", name: "Expected artifacts", status: "failed", detail: "missing=1" },
      ],
      artifacts: [".devflow/acceptance/partial.png"],
    });
    const run: AgentRun = {
      id: evidence.runId,
      nodeId: "node-1",
      sessionId: "session-1",
      projectRoot: "/tmp/project",
      worktreePath: "/tmp/project",
      agentKind: "codex",
      status: "succeeded",
      startedAt: "2026-06-12T00:00:00.000Z",
      endedAt: "2026-06-12T00:00:01.000Z",
    };

    expect(sanitizeRunEvidence(evidence).status).toBe("failed");
    expect(sanitizeRunEvidence(evidence).artifacts).toEqual([]);
    expect(deriveNodeStatusFromEvidence(run, evidence)).toBe("failed");
    expect(summarizeRunEvidence({ runEvidence: evidence }).run.status).toBe("failed");
  });

  it("strictly parses complete RunEvidence before exposing it", () => {
    const secret = "run-evidence-secret-123456";
    const parsed = parseRunEvidence({
      ...runEvidence({
        status: "succeeded",
        exitCode: 0,
        checks: [
          { kind: "artifact", name: "Expected artifacts", status: "failed", detail: "missing=1" },
        ],
        artifacts: [".devflow/acceptance/result.png"],
        errorReason: `failed at /Users/alice/private/repo token=${secret}`,
      }),
      review: { kind: "review", name: "Review", status: "passed" },
    });

    expect(parsed).toMatchObject({
      status: "failed",
      artifacts: [],
      review: { kind: "review", name: "Review", status: "passed" },
    });
    expect(JSON.stringify(parsed)).not.toMatch(/alice|run-evidence-secret-123456/);
    expect(parseRunEvidence({ runId: "run-1", status: "succeeded" })).toBeNull();
  });

  it.each([
    ["unknown check kind", { checks: [{ kind: "verification", name: "Unknown", status: "passed" }] }],
    ["unknown check status", { checks: [{ kind: "test", name: "Unit", status: "success" }] }],
    ["malformed check type", { checks: [{ kind: "test", name: 7, status: "passed" }] }],
    ["control text", { checks: [{ kind: "test", name: "Unit\nleak", status: "passed" }] }],
    ["absolute artifact", { artifacts: ["/Users/alice/private/result.png"] }],
    ["Windows-separator artifact", { artifacts: [".devflow\\acceptance\\result.png"] }],
    ["control artifact", { artifacts: [".devflow/acceptance/result\u0000.png"] }],
    ["sensitive artifact", { artifacts: [".devflow/acceptance/.env"] }],
    ["case-aliased artifact", { artifacts: [
      ".devflow/acceptance/result.png",
      ".DEVFLOW/ACCEPTANCE/RESULT.PNG",
    ] }],
    ["malformed exit code", { exitCode: "0" }],
    ["malformed review", { review: { kind: "policy-review", name: "Unsafe", status: "passed" } }],
  ])("rejects complete RunEvidence with %s", (_label, overrides) => {
    expect(parseRunEvidence({ ...runEvidence(), ...overrides })).toBeNull();
  });

  it("fails public summaries closed for malformed RunEvidence", () => {
    const summary = summarizeRunEvidence({
      runEvidence: runEvidence({
        status: "succeeded",
        checks: [{ kind: "unknown-kind", name: "Unsafe", status: "passed" } as never],
        artifacts: ["/Users/alice/private/result.png"],
      }),
    });

    expect(summary.run).toEqual({ id: null, status: "unknown", exitCode: null });
    expect(summary.checkSummary).toBe("None");
    expect(summary.artifactSummary).toBe("None");
    expect(JSON.stringify(summary)).not.toContain("/Users/alice/private/result.png");
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

  it("summarizes only artifacts recorded in run evidence", () => {
    expect(summarizeRunEvidence({
      runEvidence: runEvidence({ artifacts: [".devflow/acceptance/output.md"] }),
      expectedArtifacts: [".devflow/expected.md"],
    }).artifactSummary).toBe("1 (.devflow/acceptance/output.md)");

    expect(summarizeRunEvidence({
      expectedArtifacts: [".devflow/expected.md"],
    }).artifactSummary).toBe("None");
  });

  it("never exposes failed artifact declarations in public evidence summaries", () => {
    const declarations = [
      "/Users/alice/private/host-output.png",
      "../outside/traversal.png",
      ".devflow/acceptance/.env",
      ".devflow/acceptance/id_rsa",
      ".devflow/acceptance/credentials.json",
      ".DEVFLOW\\ACCEPTANCE\\TOKEN.PEM",
      ".devflow/acceptance/duplicate/../result.png",
      ".devflow/acceptance/result.png",
    ];
    const summary = summarizeRunEvidence({
      runEvidence: runEvidence({
        status: "failed",
        exitCode: 1,
        checks: [{ kind: "artifact", name: "Expected artifacts", status: "failed", detail: "invalid=6, duplicate=2" }],
        artifacts: [],
      }),
      expectedArtifacts: declarations,
    });
    const returnedStrings = collectStrings(summary);

    expect(summary.artifactSummary).toBe("None");
    expect(returnedStrings).toContain("artifact [Expected artifacts]: failed - invalid=6, duplicate=2");
    for (const declaration of declarations) {
      expect(returnedStrings.every((value) => !value.includes(declaration))).toBe(true);
    }
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
    const fullPatchEvidence: ChangesetEvidence = {
      ...changesetEvidence,
      patchPreviewTruncated: false,
      fullPatchSha256: "a".repeat(64),
      fullPatchByteLength: 128,
      fileManifestSha256: "b".repeat(64),
    };

    expect(ledger.recentEvents[0]?.laneId).toBe("lane-implementation");
    expect(answered.action).toBe("parallel_worktree");
    expect(worktree.gitdir).toContain("/.git/worktrees/");
    expect(adoption.status).toBe("requested");
    expect(changesetEvidence.source).toBe("git");
    expect(fullPatchEvidence.fullPatchSha256).toHaveLength(64);
    expect(fullPatchEvidence.fullPatchByteLength).toBe(128);
    expect(fullPatchEvidence.fileManifestSha256).toHaveLength(64);
  });

  it("strictly reconstructs atomic full patch evidence while preserving legacy rows", () => {
    const legacy = {
      evidenceId: "changeset-evidence-a",
      changesetId: "changeset-a",
      source: "git",
      status: "available",
      files: ["src/index.ts"],
      diffStat: { added: 4, changed: 1, deleted: 0 },
      patchPreviewTruncated: false,
      collectedAt: "2026-06-16T00:00:00.000Z",
    };
    const complete = {
      ...legacy,
      fullPatchSha256: "a".repeat(64),
      fullPatchByteLength: 128,
      fileManifestSha256: "b".repeat(64),
    };

    expect(parseChangesetEvidence(legacy)).toEqual(legacy);
    expect(parseChangesetEvidence({ ...complete, ignored: "not reconstructed" })).toEqual(complete);

    for (const malformed of [
      { ...legacy, fullPatchSha256: "a".repeat(64) },
      { ...complete, fullPatchSha256: "A".repeat(64) },
      { ...complete, fileManifestSha256: "b".repeat(63) },
      { ...complete, fullPatchByteLength: 0 },
      { ...complete, fullPatchByteLength: Number.MAX_SAFE_INTEGER + 1 },
      { ...complete, source: "mock" },
      { ...complete, status: "empty" },
      { ...complete, files: [] },
    ]) {
      expect(parseChangesetEvidence(malformed)).toBeNull();
    }
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

  it("strictly parses durable lane candidate bindings", () => {
    const binding: WorkflowLaneCandidateBinding = {
      sessionId: "session-1", laneId: "lane-variant", variantId: "variant",
      worktreeId: "worktree-session-1-variant",
      lineageId: "lineage-variant", reason: "variant", predecessorLaneIds: ["lane-a", "lane-b"],
      sourceCheckpointId: "checkpoint-before-lane-implementation",
      sourceHeadCommit: "a".repeat(40),
    };
    expect(parseWorkflowLaneCandidateBinding(binding)).toEqual(binding);
    for (const [malformed, reason] of [
      [{ ...binding, unknown: true }, /unknown/i],
      [{ ...binding, reason: "first_edge" }, /reason/i],
      [{ ...binding, predecessorLaneIds: ["lane-b", "lane-a"] }, /sorted/i],
      [{ ...binding, variantId: "" }, /variantId/i],
      [{ ...binding, variantId: "variant:unsafe" }, /variantId/i],
      [{ ...binding, variantId: "v".repeat(241) }, /variantId/i],
      [{ ...binding, worktreeId: "worktree-session-1-other" }, /worktreeId.*variantId/i],
      [{ ...binding, sourceHeadCommit: "b".repeat(64) }, /full commit SHA/i],
      [{ ...binding, sourceHeadCommit: "g".repeat(40) }, /full commit SHA/i],
      [{ ...binding, sourceHeadCommit: "short-sha" }, /full commit SHA/i],
    ] as const) expect(() => parseWorkflowLaneCandidateBinding(malformed)).toThrow(reason);

    const longSessionId = "s".repeat(200);
    const longVariantId = `variant-${"b".repeat(64)}`;
    const longBinding: WorkflowLaneCandidateBinding = {
      ...binding,
      sessionId: longSessionId,
      variantId: longVariantId,
      worktreeId: `worktree-${longSessionId}-${longVariantId}`,
    };
    expect(parseWorkflowLaneCandidateBinding(longBinding)).toEqual(longBinding);
  });

  it("strictly parses bounded path-free variant comparison records", () => {
    const changeset = {
      evidenceId: "evidence-left",
      changesetId: "changeset-left",
      source: "git" as const,
      status: "available" as const,
      files: ["src/index.ts"],
      diffStat: { added: 1, changed: 0, deleted: 0 },
      patchPreviewTruncated: false,
      worktreeId: "worktree-left",
      collectedAt: "2026-08-26T00:00:00.000Z",
    };
    const comparison = {
      comparisonId: "comparison-left-right-2026-08-26T00:00:00.000Z",
      collectedAt: "2026-08-26T00:00:00.000Z",
      variants: [
        { variantId: "variant-left", worktreeId: "worktree-left", changeset, metrics: [] },
        {
          variantId: "variant-right",
          worktreeId: "worktree-right",
          changeset: {
            ...changeset,
            evidenceId: "evidence-right",
            changesetId: "changeset-right",
            worktreeId: "worktree-right",
          },
          metrics: [],
        },
      ],
    };
    const recording = {
      sessionId: "session-1",
      comparison,
      left: {
        laneId: "lane-left",
        variantId: "variant-left",
        worktreeId: "worktree-left",
        branchName: "skyturn/session-1/variant-left",
        baseCommit: "a".repeat(40),
        headCommit: "b".repeat(40),
      },
      right: {
        laneId: "lane-right",
        variantId: "variant-right",
        worktreeId: "worktree-right",
        branchName: "skyturn/session-1/variant-right",
        baseCommit: "a".repeat(40),
        headCommit: "c".repeat(40),
      },
    };

    expect(parseWorkflowVariantComparisonRecordedEvidence(recording)).toEqual(recording);
    for (const malformed of [
      { ...recording, projectRoot: "/secret/project" },
      { ...recording, left: { ...recording.left, path: "/secret/worktree" } },
      { ...recording, right: { ...recording.right, headCommit: "short" } },
      { ...recording, comparison: { ...comparison, prompt: "secret" } },
      {
        ...recording,
        comparison: {
          ...comparison,
          variants: [{ ...comparison.variants[0], changeset: { ...changeset, files: ["/secret/file.ts"] } }, comparison.variants[1]],
        },
      },
      { ...recording, sessionId: "s".repeat(241) },
    ]) {
      expect(() => parseWorkflowVariantComparisonRecordedEvidence(malformed)).toThrow(/variant comparison record/i);
    }
  });

  it.each([
    ["ambiguous", "ambiguous_predecessor_lineage", ["lineage-a", "lineage-b"]],
    ["conflicting", "conflicting_predecessor_binding", ["lineage-shared"]],
  ] as const)("accepts canonical %s binding block evidence", (_label, reason, lineageIds) => {
    const block = { sessionId: "session-1", laneId: "lane-join", reason, predecessorLaneIds: ["lane-a", "lane-b"], lineageIds };
    expect(parseWorkflowLaneCandidateBindingBlock(block)).toEqual(block);
  });

  it.each([
    ["ambiguous lineage with one lineage", "ambiguous_predecessor_lineage", ["lane-a", "lane-b"], ["lineage-a"]],
    ["conflicting binding with two lineages", "conflicting_predecessor_binding", ["lane-a", "lane-b"], ["lineage-a", "lineage-b"]],
    ["conflicting binding without two predecessors", "conflicting_predecessor_binding", ["lane-a"], ["lineage-a"]],
  ] as const)("rejects contradictory binding block evidence: %s", (_label, reason, predecessorLaneIds, lineageIds) => {
    expect(() => parseWorkflowLaneCandidateBindingBlock({
      sessionId: "session-1", laneId: "lane-join", reason, predecessorLaneIds, lineageIds,
    })).toThrow(/predecessor lineage evidence/i);
  });
});
