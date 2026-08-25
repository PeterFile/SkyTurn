import type {
  CommitLaneCompletionFacts,
} from "@skyturn/persistence/workflow-store" with { "resolution-mode": "import" };
import type { RunEvidence } from "@skyturn/project-core" with { "resolution-mode": "import" };

export const AUTHORITATIVE_COMMIT_FAILURE_REASON =
  "Authoritative Git commit verification failed.";

const AUTHORITATIVE_COMMIT_CHECK_NAME = "Authoritative Git commit";
const AUTHORITATIVE_COMMIT_SUCCESS_DETAIL = "Authoritative Git commit facts recorded.";
const fullCommitPattern = /^[0-9a-f]{40}$/;
const digestPattern = /^[0-9a-f]{64}$/;

export interface WorkflowRunCompletionScope {
  laneKind: string;
  executable: boolean;
  sessionId?: string;
  nodeId?: string;
  laneId?: string;
  segmentId?: string;
  runId?: string;
}

export interface WorkflowRunCompletionOperations {
  readCommitFacts(): CommitLaneCompletionFacts | null;
  captureAndRecordCommitFacts(): Promise<CommitLaneCompletionFacts>;
  recordRunResult(evidence: RunEvidence): void | Promise<void>;
  freezeCandidateManifest(): void | Promise<void>;
}

export interface WorkflowRunCompletionResult {
  evidence: RunEvidence;
  commitFacts: CommitLaneCompletionFacts | null;
}

export async function completeWorkflowRun(
  scope: WorkflowRunCompletionScope,
  rawEvidence: RunEvidence,
  operations: WorkflowRunCompletionOperations,
): Promise<WorkflowRunCompletionResult> {
  const needsCommitFacts = rawEvidence.status === "succeeded" &&
    rawEvidence.exitCode === 0 &&
    scope.laneKind === "commit" &&
    scope.executable === true;
  let commitFacts: CommitLaneCompletionFacts | null = null;
  let durableFactsConflict = false;
  if (needsCommitFacts) {
    try {
      commitFacts = operations.readCommitFacts();
    } catch {
      durableFactsConflict = true;
    }
    if (!commitFacts && !durableFactsConflict) {
      try {
        commitFacts = await operations.captureAndRecordCommitFacts();
      } catch {
        try {
          commitFacts = operations.readCommitFacts();
        } catch {
          commitFacts = null;
        }
      }
    }
  }
  const evidence = adjudicateWorkflowRunEvidence(scope, rawEvidence, commitFacts);
  await operations.recordRunResult(evidence);
  if (needsCommitFacts && evidence.status === "succeeded") {
    await operations.freezeCandidateManifest();
  }
  return { evidence, commitFacts };
}

export function adjudicateWorkflowRunEvidence(
  scope: WorkflowRunCompletionScope,
  rawEvidence: RunEvidence,
  commitFacts: CommitLaneCompletionFacts | null,
): RunEvidence {
  if (rawEvidence.status !== "succeeded" || rawEvidence.exitCode !== 0) return rawEvidence;
  if (scope.laneKind !== "commit" || scope.executable !== true) return rawEvidence;
  if (!isAuthoritativeCommitFactSet(scope, rawEvidence, commitFacts)) {
    return {
      ...rawEvidence,
      status: "failed",
      changesetId: null,
      checks: [
        ...rawEvidence.checks,
        {
          kind: "git",
          name: AUTHORITATIVE_COMMIT_CHECK_NAME,
          status: "failed",
          detail: AUTHORITATIVE_COMMIT_FAILURE_REASON,
        },
      ],
      errorReason: AUTHORITATIVE_COMMIT_FAILURE_REASON,
      cancelReason: null,
    };
  }
  return {
    ...rawEvidence,
    changesetId: commitFacts.changesetEvidence.changesetId,
    checks: [
      ...rawEvidence.checks,
      {
        kind: "git",
        name: AUTHORITATIVE_COMMIT_CHECK_NAME,
        status: "passed",
        detail: AUTHORITATIVE_COMMIT_SUCCESS_DETAIL,
      },
    ],
    errorReason: null,
    cancelReason: null,
  };
}

function isAuthoritativeCommitFactSet(
  scope: WorkflowRunCompletionScope,
  rawEvidence: RunEvidence,
  facts: CommitLaneCompletionFacts | null,
): facts is CommitLaneCompletionFacts {
  if (!facts) return false;
  if (
    facts.sessionId !== scope.sessionId ||
    facts.nodeId !== scope.nodeId ||
    facts.laneId !== scope.laneId ||
    facts.segmentId !== scope.segmentId ||
    facts.runId !== scope.runId ||
    facts.runId !== rawEvidence.runId
  ) return false;
  const before = facts.beforeCheckpoint;
  const after = facts.afterCheckpoint;
  if (
    !fullCommitPattern.test(facts.baselineHeadCommit) ||
    before.headCommit !== facts.baselineHeadCommit ||
    typeof after.headCommit !== "string" ||
    !fullCommitPattern.test(after.headCommit) ||
    after.headCommit === before.headCommit ||
    before.phase !== "before" ||
    after.phase !== "after" ||
    after.worktreeState !== "clean" ||
    before.executionTarget !== after.executionTarget ||
    before.worktreeId !== after.worktreeId ||
    before.worktreePath !== after.worktreePath ||
    before.branchName !== after.branchName ||
    typeof after.ancestryProof !== "string" ||
    after.ancestryProof.length === 0
  ) return false;
  if (
    (after.executionTarget === "current_branch" && after.worktreeId !== undefined) ||
    (after.executionTarget === "new_worktree" && !after.worktreeId)
  ) return false;
  const changeset = facts.changesetEvidence;
  return changeset.evidenceId === `changeset-evidence:${facts.runId}:after` &&
    changeset.source === "git" &&
    changeset.status === "available" &&
    changeset.files.length > 0 &&
    typeof changeset.fullPatchSha256 === "string" &&
    digestPattern.test(changeset.fullPatchSha256) &&
    typeof changeset.fullPatchByteLength === "number" &&
    Number.isSafeInteger(changeset.fullPatchByteLength) &&
    changeset.fullPatchByteLength > 0 &&
    typeof changeset.fileManifestSha256 === "string" &&
    digestPattern.test(changeset.fileManifestSha256);
}
