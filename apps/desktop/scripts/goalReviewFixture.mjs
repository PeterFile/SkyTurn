// Synthetic source evidence only. The acceptance verifier must run a real Hermes process.
import { execFileSync } from "node:child_process";
import { writeFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { relative, join, isAbsolute } from "node:path";
import { createGitChangesetService, createWorkflowGitAncestryProof, createLiveWorkflowGitAncestryProofContext } from "@skyturn/git-worktree/node";

export const goalReviewFixture = Object.freeze({
  sessionId: "goal-review-session", sourceNodeId: "source-implementation", unrelatedNodeId: "unrelated-ready",
  originalGoal: "Implement answer.js exporting answer = 42. The current answer = 41 is a genuinely unmet goal. Review must identify this discrepancy.",
  approvedPlan: "Approved Plan Finish\nAcceptance criterion: answer.js must export answer = 42.\nInspect the actual file and cite the observed value; never infer acceptance from process success.",
});

export async function seedGoalReviewSource({ projectRoot, store, approvedPlan = true, brandContext }) {
  const root = await realpath(projectRoot);
  const withinTemp = relative(await realpath(tmpdir()), root);
  if (!withinTemp || withinTemp.startsWith("..") || isAbsolute(withinTemp)) throw new Error("Fixture requires an isolated disposable TMPDIR project.");
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  await writeFile(join(root, "answer.js"), "export const answer = 0;\n");
  git("add", "answer.js");
  git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "test: seed original goal fixture");
  const headCommit = git("rev-parse", "HEAD");
  const branchName = git("branch", "--show-current");
  const now = new Date().toISOString();
  const createSession = approvedPlan ? input => store.createPlanFinishWorkflowSession({ ...input, planSessionId: "fixture" }) : input => store.createWorkflowSession(input);
  const session = createSession({ id: goalReviewFixture.sessionId, projectId: "goal-review-project", title: "Original goal fixture",
    goal: goalReviewFixture.originalGoal, mode: "fast", target: { executionTarget: "current_branch", selectedBranch: branchName },
    plannerProfile: "default", transport: "hermes_replay_recovery", recoveryReason: "Synthetic source fixture, no live planner.", now });
  if (approvedPlan) store.claimUserInput({ sessionId: session.id, inputId: "plan-confirm-fixture", text: goalReviewFixture.approvedPlan, now });
  const { segment: planner } = store.claimPlannerRunStart({ sessionId: session.id, laneId: session.plannerLaneId,
    runId: "synthetic-source-planner", agentKind: "hermes", worktreePath: root, now });
  store.recordRunResult({ ...planner, outputSummary: "Synthetic source fixture.", evidence: terminal(planner.runId, now), now });
  store.recordPlannerIntentReconciled(planner, now);
  store.appendWorkflowEvent({ sessionId: session.id, kind: "workflow.lane.declared", source: "fixture",
    payload: { lane: { id: goalReviewFixture.sourceNodeId, kind: "implementation", title: "Synthetic source implementation", agentKind: "codex" } }, now });
  const scheduled = store.scheduleReadyLanes(session.id, { exactLaneIds: [goalReviewFixture.sourceNodeId], now }).readyLanes[0];
  if (!scheduled) throw new Error("Source fixture did not schedule.");
  const identity = { sessionId: session.id, nodeId: scheduled.id, laneId: scheduled.id, segmentId: scheduled.segmentId, runId: scheduled.runId };
  const checkpoint = { ...identity, executionTarget: "current_branch", worktreePath: root, branchName, headCommit,
    evidenceRefs: [{ kind: "run", id: identity.runId }, { kind: "segment", id: identity.segmentId }] };
  store.recordRunCheckpoint({ ...checkpoint, phase: "before", worktreeState: "clean", now });
  await writeFile(join(root, "answer.js"), "export const answer = 41;\n");
  const node = store.materializeCanvasSession(session.id).nodes.find(node => node.id === identity.nodeId);
  const reconciled = await createGitChangesetService({ repoRoot: root }).reconcileFinalChangeset({ node,
    target: { executionTarget: "current_branch", selectedBranch: branchName }, baselineRef: headCommit });
  if (reconciled.status !== "available") throw new Error("Source fixture candidate snapshot unavailable.");
  store.recordRunResult({ ...identity, agentKind: "codex", outputSummary: "Synthetic implementation process succeeded; goal is deliberately unmet.",
    evidence: { ...terminal(identity.runId, now), changesetId: reconciled.changeset.id }, now });
  const evidenceId = `changeset-evidence:${identity.runId}:after`;
  store.appendWorkflowEvent({ sessionId: session.id, kind: "workflow.changeset.evidence_recorded", source: "backend",
    laneId: identity.laneId, segmentId: identity.segmentId, idempotencyKey: `checkpoint-changeset:${identity.runId}:after`,
    payload: { laneId: identity.laneId, segmentId: identity.segmentId, baselineHeadCommit: headCommit,
      evidence: { ...reconciled.changeset.evidence, evidenceId, collectedAt: now } }, now });
  const proof = await createWorkflowGitAncestryProof({ repositoryPath: root, worktreePath: root, beforeHeadCommit: headCommit, afterHeadCommit: headCommit });
  store.recordRunCheckpoint({ ...checkpoint, phase: "after", worktreeState: "dirty", now,
    evidenceRefs: [...checkpoint.evidenceRefs, { kind: "evidence", id: `evidence-${identity.segmentId}` }, { kind: "changeset", id: evidenceId }],
    ancestryProof: proof, ancestryProofContext: brandContext ? brandContext(JSON.parse(proof)) : await createLiveWorkflowGitAncestryProofContext({ repositoryPath: root, worktreePath: root, beforeHeadCommit: headCommit, afterHeadCommit: headCommit }) });
  const manifest = store.freezeCandidateManifest({ ...identity, now });
  for (const [sessionId, id] of [[session.id, goalReviewFixture.unrelatedNodeId]]) store.appendWorkflowEvent({ sessionId,
    kind: "workflow.lane.declared", source: "fixture", payload: { lane: { id, kind: "validation", title: id, status: "pending" } }, now });
  return { identity, manifest, headCommit, branchName, session: store.materializeCanvasSession(session.id) };
}
function terminal(runId, now) {
  return { runId, status: "succeeded", exitCode: 0, changesetId: null, checks: [], artifacts: [], review: null,
    errorReason: null, cancelReason: null, completedAt: now };
}
