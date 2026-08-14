import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { devNull, homedir, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  connectToReadySkyTurnRenderer,
  finalizeAcceptanceOutcome,
  launchElectronAcceptanceApp,
  waitForStoredProjectRegistration,
} from "./newSessionUiAcceptance.mjs";

const require = createRequire(import.meta.url);
const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const desktopMainPath = fileURLToPath(new URL("../dist-electron/electron/main.js", import.meta.url));
const fdLaunchPath = fileURLToPath(new URL("../../../packages/agent-bridge/dist/native/fd-launch", import.meta.url));
const verifierOwnerPath = fileURLToPath(
  new URL("../../../packages/agent-bridge/dist/native/posix-process-owner", import.meta.url),
);
const sqliteNativeBindingPath = fileURLToPath(
  new URL("../../../packages/persistence/node_modules/better-sqlite3/build/Release/better_sqlite3.node", import.meta.url),
);
const commandOutputLimit = 20 * 1024 * 1024;
const finalJsonLimit = 4_096;
const defaultTimeoutMs = 3 * 60_000;
const maximumTimeoutMs = 5 * 60_000;
const seedPrefix = "SKYTURN_CANDIDATE_REVIEW_COMMIT_SEED=";
const inspectPrefix = "SKYTURN_CANDIDATE_REVIEW_COMMIT_INSPECT=";
const hermesProtectedFiles = [
  "config.yaml",
  ".env",
  "auth.json",
  ".anthropic_oauth.json",
  "SOUL.md",
  "USER.md",
];
const volatilePathspecs = [
  ".",
  ":(top,exclude).devflow/skyturn-workflow.sqlite",
  ":(top,exclude).devflow/skyturn-workflow.sqlite-wal",
  ":(top,exclude).devflow/skyturn-workflow.sqlite-shm",
  ":(top,glob,exclude).devflow/runs/**",
  ":(top,glob,exclude).devflow/tasks/**/output.md",
];
const oracleRootKeys = ["expected", "renderer", "review", "git", "sqlite", "cleanup"];
const oracleExpectedKeys = [
  "beforeHead",
  "commitSha",
  "manifestSha256",
  "requestSha256",
  "publicationRequestSha256",
  "fullPatchSha256",
  "fileManifestSha256",
  "ancestryProofSha256",
  "branch",
  "subject",
  "body",
  "candidateFiles",
];
const oracleRendererKeys = [
  "publicApiAvailable",
  "firstRejected",
  "firstStatus",
  "firstCommitSha",
  "firstBranch",
  "firstParentCommit",
  "duplicateStatus",
  "duplicateCommitSha",
  "duplicateBranch",
  "duplicateParentCommit",
  "preparedVisible",
  "projectionPreparedCount",
  "createdVisibleCount",
];
const oracleReviewKeys = [
  "actualRequestSha256",
  "expectedRequestSha256",
  "manifestSha256",
  "fullPatchSha256",
  "fileManifestSha256",
  "ancestryProofSha256",
  "temporaryRootObserved",
  "verifierProcessObserved",
];
const oracleGitKeys = [
  "branchAdvanceCount",
  "branch",
  "parentCommit",
  "commitSha",
  "changedFiles",
  "reviewedFileBytesExact",
  "treePatchSha256",
  "statusClean",
  "subject",
  "body",
  "remoteCount",
];
const oracleSqliteKeys = ["seededManifest", "reopened", "reopenedAgain"];
const oracleReopenedKeys = [
  "manifest",
  "manifestSha256",
  "preparedCount",
  "createdCount",
  "prepared",
  "created",
  "projectionPreparedCount",
  "canvasPreparedVisible",
  "reviewAttestation",
];
const oraclePreparedKeys = [
  "manifestSha256",
  "requestSha256",
  "commitSha",
  "parentCommit",
  "expectedFullPatchSha256",
  "branch",
];
const oracleCreatedKeys = [
  "manifestSha256",
  "requestSha256",
  "commitSha",
  "parentCommit",
  "branch",
];
const oracleReviewAttestationKeys = ["requestSha256", "manifestSha256", "disposition", "count"];
const oracleCleanupKeys = [
  "protectedStateBefore",
  "protectedStateAfter",
  "hermesRootsBefore",
  "hermesRootsAfter",
  "verifierProcessesBefore",
  "verifierProcessesAfter",
  "electronClosed",
  "sqliteClosed",
  "resourcesRemoved",
];
const oracleManifestKeys = [
  "version",
  "createdAt",
  "sessionId",
  "nodeId",
  "laneId",
  "segmentId",
  "runId",
  "agentKind",
  "executionTarget",
  "worktreeId",
  "repositoryIdentity",
  "worktreeIdentity",
  "branchName",
  "beforeCheckpointId",
  "beforeHeadCommit",
  "afterCheckpointId",
  "afterHeadCommit",
  "ancestryProofSha256",
  "terminalEvidenceId",
  "terminalRunEvidence",
  "terminalRunEvidenceSha256",
  "changesetEvidenceId",
  "changesetId",
  "fullPatchSha256",
  "fullPatchByteLength",
  "fileManifestSha256",
];
const oracleTerminalRunEvidenceKeys = [
  "runId",
  "status",
  "exitCode",
  "changesetId",
  "checks",
  "artifactCount",
  "review",
  "errorReason",
  "cancelReason",
  "completedAt",
];
const oracleEvidenceCheckKeys = ["kind", "status"];
const oracleProtectedEntryKeys = ["kind", "mode", "size", "sha256", "device", "inode"];
const oracleEvidenceKinds = new Set([
  "run-exit",
  "run-timeout",
  "artifact",
  "git",
  "test",
  "typecheck",
  "build",
  "review",
]);
const oracleEvidenceStatuses = new Set(["passed", "failed", "skipped"]);
const oracleAgentKinds = new Set(["hermes", "codex", "agy", "gemini", "claude-code", "openclaw"]);
const publicBlockerStages = new Set([
  "checkout-build",
  "native-rebuild",
  "compiled-preflight",
  "preflight",
  "fixture",
  "seed",
  "electron-launch",
  "renderer-ipc",
  "electron-close",
  "sqlite-reopen",
  "git-oracle",
  "hermes-cleanup",
  "resource-cleanup",
  "oracle",
  "final-json",
  "unhandled",
]);
const publicOracleBooleanKeys = [
  "rendererIpcInvoked",
  "preloadApiAvailable",
  "realHermesReviewObserved",
  "manifestImmutable",
  "reviewRequestExact",
  "branchBindingExact",
  "parentMatchesManifestAfterHead",
  "reviewedTreeExact",
  "noExtraCandidateBytes",
  "commitMessageExact",
  "noRemoteDelivery",
  "publicationPreparedDurable",
  "commitCreatedDurable",
  "preparedOutsideProjection",
  "preparedOutsideRenderer",
  "duplicateCommitStable",
  "duplicateEventsAbsent",
  "hermesProtectedStateUnchanged",
  "hermesTemporaryRootsUnchanged",
  "verifierProcessesReaped",
  "electronClosed",
  "sqliteClosed",
  "disposableResourcesRemoved",
];
const publicOracleCountKeys = ["branchAdvanceCount", "publicationPreparedCount", "commitCreatedCount"];
const publicOracleFailures = new Set([
  "acceptance-unhandled-error",
  "invalid-oracle-input",
  "public-preload-api-unavailable",
  "renderer-ipc-result-invalid",
  "duplicate-ipc-result-conflict",
  "review-request-mismatch",
  "candidate-branch-mismatch",
  "branch-advance-count-invalid",
  "commit-parent-mismatch",
  "reviewed-tree-mismatch",
  "unreviewed-dirty-or-index-bytes",
  "commit-message-mismatch",
  "remote-delivery-surface-present",
  "candidate-manifest-drifted",
  "publication-prepared-not-durable",
  "commit-created-event-count-invalid",
  "prepared-entered-flow-projection",
  "prepared-visible-to-renderer",
  "duplicate-publication-event-present",
  "hermes-protected-state-changed",
  "hermes-temporary-root-survived",
  "verifier-process-survived",
  "electron-not-closed",
  "sqlite-not-closed",
  "disposable-resources-survived",
]);
const acceptanceStageFailureCode = "ACCEPTANCE_STAGE_FAILED";

export const CANDIDATE_REVIEW_COMMIT_SUBJECT = "test(delivery): publish reviewed candidate";
export const CANDIDATE_REVIEW_COMMIT_BODY = "Prove real Hermes review through renderer IPC.";

export async function prepareCandidateReviewCommitCheckout({
  deadline,
  run = runCommand,
  verifyCompiledFiles = verifyCandidateReviewCompiledFiles,
  onStage = () => {},
} = {}) {
  const runStage = async (stage, args, failureMessage) => {
    onStage(stage);
    const timeoutMs = remainingTimeoutMs(deadline);
    try {
      await run("pnpm", args, { cwd: repositoryRoot, timeoutMs });
    } catch {
      throw new Error(failureMessage);
    }
  };

  await runStage(
    "checkout-build",
    ["run", "build", "--force"],
    "Candidate review acceptance checkout build failed.",
  );
  await runStage(
    "native-rebuild",
    ["--filter", "@skyturn/desktop", "run", "rebuild:native"],
    "Candidate review acceptance native rebuild failed.",
  );
  onStage("compiled-preflight");
  try {
    await verifyCompiledFiles();
  } catch {
    throw new Error("Candidate review acceptance compiled files are unavailable.");
  }
}

async function verifyCandidateReviewCompiledFiles() {
  await Promise.all([
    stat(desktopMainPath),
    stat(fdLaunchPath),
    stat(verifierOwnerPath),
    stat(sqliteNativeBindingPath),
  ]);
}

export const candidateReviewCommitFixture = Object.freeze({
  projectId: "project-candidate-review-commit",
  sessionId: "session-candidate-review-commit",
  implementationLaneId: "lane-candidate-implementation",
  reviewLaneId: "lane-candidate-lineage-review",
  validationLaneId: "lane-candidate-lineage-validation",
  commitLaneId: "lane-candidate-review-commit",
  candidateFiles: ["reviewed.txt", "second.txt"],
  branch: "acceptance",
});

export function buildCandidateReviewCommitRendererInvocation(input) {
  return `
    (async () => {
      const workflow = window.devflow?.workflow;
      const summarize = (value) => ({
        status: value?.status ?? null,
        commitSha: value?.evidence?.commitSha ?? null,
        branch: value?.evidence?.branch ?? null,
        parentCommit: value?.evidence?.parentCommit ?? null,
      });
      if (!workflow || typeof workflow.createDeliveryCommit !== 'function') {
        return { publicApiAvailable: false };
      }
      const request = ${JSON.stringify({
        sessionId: input.sessionId,
        laneId: input.laneId,
        worktreePath: input.worktreePath,
        subject: input.subject,
        body: input.body,
      })};
      let first = null;
      let duplicate = null;
      let firstRejected = false;
      try {
        first = await workflow.createDeliveryCommit(${JSON.stringify(input.projectRoot)}, request);
        duplicate = await workflow.createDeliveryCommit(${JSON.stringify(input.projectRoot)}, request);
      } catch {
        firstRejected = true;
      }
      const visible = await workflow.getEvents(${JSON.stringify(input.projectRoot)}, ${JSON.stringify(input.sessionId)});
      const projected = await workflow.getProjection(${JSON.stringify(input.projectRoot)}, ${JSON.stringify(input.sessionId)});
      const visibleEvents = Array.isArray(visible?.events) ? visible.events : [];
      const projectionEvents = Array.isArray(projected?.projection?.events) ? projected.projection.events : [];
      return {
        publicApiAvailable: true,
        firstRejected,
        first: summarize(first),
        duplicate: summarize(duplicate),
        preparedVisible: visibleEvents.some((event) => event?.kind === 'workflow.commit.publication_prepared'),
        projectionPreparedCount: projectionEvents.filter((event) => event?.kind === 'workflow.commit.publication_prepared').length,
        createdVisibleCount: visibleEvents.filter((event) => event?.kind === 'workflow.commit.created').length,
      };
    })()
  `;
}

export function summarizeCandidateReviewCommitRendererResult(rendererResult) {
  return {
    publicApiAvailable: rendererResult?.publicApiAvailable ?? null,
    firstRejected: rendererResult?.firstRejected ?? null,
    firstStatus: rendererResult?.first?.status ?? null,
    firstCommitSha: rendererResult?.first?.commitSha ?? null,
    firstBranch: rendererResult?.first?.branch ?? null,
    firstParentCommit: rendererResult?.first?.parentCommit ?? null,
    duplicateStatus: rendererResult?.duplicate?.status ?? null,
    duplicateCommitSha: rendererResult?.duplicate?.commitSha ?? null,
    duplicateBranch: rendererResult?.duplicate?.branch ?? null,
    duplicateParentCommit: rendererResult?.duplicate?.parentCommit ?? null,
    preparedVisible: rendererResult?.preparedVisible ?? null,
    projectionPreparedCount: rendererResult?.projectionPreparedCount ?? null,
    createdVisibleCount: rendererResult?.createdVisibleCount ?? null,
  };
}

export function parseCandidateReviewCommitOracleInput(input) {
  try {
    if (!hasExactAllowedKeys(input, oracleRootKeys)) return null;
    const { expected, renderer, review, git, sqlite, cleanup } = input;
    if (
      !hasExactAllowedKeys(expected, oracleExpectedKeys) ||
      !hasExactAllowedKeys(renderer, oracleRendererKeys) ||
      !hasExactAllowedKeys(review, oracleReviewKeys) ||
      !hasExactAllowedKeys(git, oracleGitKeys) ||
      !hasExactAllowedKeys(sqlite, oracleSqliteKeys) ||
      !hasExactAllowedKeys(cleanup, oracleCleanupKeys)
    ) return null;

    if (
      !isCanonicalGitSha(expected.beforeHead) ||
      !isCanonicalGitSha(expected.commitSha) ||
      !isCanonicalDigest(expected.manifestSha256) ||
      !isCanonicalDigest(expected.requestSha256) ||
      !isCanonicalDigest(expected.publicationRequestSha256) ||
      !isCanonicalDigest(expected.fullPatchSha256) ||
      !isCanonicalDigest(expected.fileManifestSha256) ||
      !isCanonicalDigest(expected.ancestryProofSha256) ||
      !isCanonicalBranchName(expected.branch) ||
      !isNonEmptyText(expected.subject) ||
      !isNonEmptyText(expected.body) ||
      !isCanonicalStringArray(expected.candidateFiles)
    ) return null;

    if (
      typeof renderer.publicApiAvailable !== "boolean" ||
      typeof renderer.firstRejected !== "boolean" ||
      renderer.firstStatus !== "committed" ||
      !isCanonicalGitSha(renderer.firstCommitSha) ||
      !isCanonicalBranchName(renderer.firstBranch) ||
      !isCanonicalGitSha(renderer.firstParentCommit) ||
      renderer.duplicateStatus !== "committed" ||
      !isCanonicalGitSha(renderer.duplicateCommitSha) ||
      !isCanonicalBranchName(renderer.duplicateBranch) ||
      !isCanonicalGitSha(renderer.duplicateParentCommit) ||
      typeof renderer.preparedVisible !== "boolean" ||
      !isEvidenceCount(renderer.projectionPreparedCount) ||
      !isEvidenceCount(renderer.createdVisibleCount)
    ) return null;

    if (
      !isCanonicalDigest(review.actualRequestSha256) ||
      !isCanonicalDigest(review.expectedRequestSha256) ||
      !isCanonicalDigest(review.manifestSha256) ||
      !isCanonicalDigest(review.fullPatchSha256) ||
      !isCanonicalDigest(review.fileManifestSha256) ||
      !isCanonicalDigest(review.ancestryProofSha256) ||
      typeof review.temporaryRootObserved !== "boolean" ||
      typeof review.verifierProcessObserved !== "boolean"
    ) return null;

    if (
      !isEvidenceCount(git.branchAdvanceCount) ||
      !isCanonicalBranchName(git.branch) ||
      !isCanonicalGitSha(git.parentCommit) ||
      !isCanonicalGitSha(git.commitSha) ||
      !isCanonicalStringArray(git.changedFiles) ||
      typeof git.reviewedFileBytesExact !== "boolean" ||
      !isCanonicalDigest(git.treePatchSha256) ||
      typeof git.statusClean !== "boolean" ||
      !isNonEmptyText(git.subject) ||
      !isNonEmptyText(git.body) ||
      !isEvidenceCount(git.remoteCount)
    ) return null;

    if (
      !isOracleManifest(sqlite.seededManifest) ||
      !isOracleReopenedState(sqlite.reopened) ||
      !isOracleReopenedState(sqlite.reopenedAgain)
    ) return null;

    if (
      !isOracleProtectedState(cleanup.protectedStateBefore) ||
      !isOracleProtectedState(cleanup.protectedStateAfter) ||
      !isCanonicalStringArray(cleanup.hermesRootsBefore) ||
      !isCanonicalStringArray(cleanup.hermesRootsAfter) ||
      !isCanonicalPidArray(cleanup.verifierProcessesBefore) ||
      !isCanonicalPidArray(cleanup.verifierProcessesAfter) ||
      typeof cleanup.electronClosed !== "boolean" ||
      typeof cleanup.sqliteClosed !== "boolean" ||
      typeof cleanup.resourcesRemoved !== "boolean"
    ) return null;

    return input;
  } catch {
    return null;
  }
}

export function candidateReviewCommitOracle(input) {
  const parsed = parseCandidateReviewCommitOracleInput(input);
  if (!parsed) return { ok: false, failures: ["invalid-oracle-input"] };
  input = parsed;
  const failures = [];
  const fail = (name) => {
    if (!failures.includes(name)) failures.push(name);
  };
  const expected = input.expected;
  const renderer = input.renderer;
  const review = input.review;
  const git = input.git;
  const sqlite = input.sqlite;
  const cleanup = input.cleanup;
  const reopened = sqlite.reopened;
  const reopenedAgain = sqlite.reopenedAgain;

  const preloadApiAvailable = renderer.publicApiAvailable === true;
  const rendererIpcInvoked = preloadApiAvailable &&
    renderer.firstRejected === false &&
    renderer.firstStatus === "committed" &&
    renderer.firstCommitSha === expected.commitSha &&
    renderer.firstParentCommit === expected.beforeHead;
  if (!preloadApiAvailable) fail("public-preload-api-unavailable");
  if (!rendererIpcInvoked) fail("renderer-ipc-result-invalid");

  const duplicateCommitStable = renderer.duplicateStatus === "committed" &&
    renderer.duplicateCommitSha === expected.commitSha &&
    renderer.duplicateCommitSha === renderer.firstCommitSha &&
    renderer.duplicateParentCommit === expected.beforeHead &&
    renderer.duplicateParentCommit === renderer.firstParentCommit;
  if (rendererIpcInvoked && !duplicateCommitStable) fail("duplicate-ipc-result-conflict");

  const realHermesReviewObserved = review.temporaryRootObserved === true &&
    review.verifierProcessObserved === true && rendererIpcInvoked;

  const reviewRequestExact = review.actualRequestSha256 === expected.requestSha256 &&
    review.expectedRequestSha256 === expected.requestSha256 &&
    review.manifestSha256 === expected.manifestSha256 &&
    review.fullPatchSha256 === expected.fullPatchSha256 &&
    review.fileManifestSha256 === expected.fileManifestSha256 &&
    review.ancestryProofSha256 === expected.ancestryProofSha256 &&
    [reopened, reopenedAgain].every((state) =>
      state.reviewAttestation.requestSha256 === expected.requestSha256 &&
      state.reviewAttestation.manifestSha256 === expected.manifestSha256 &&
      state.reviewAttestation.disposition === "allow" &&
      state.reviewAttestation.count === 1
    );
  if (!reviewRequestExact) fail("review-request-mismatch");

  const branchBindingExact = expected.branch === sqlite.seededManifest.branchName &&
    reopened.manifest.branchName === expected.branch &&
    reopenedAgain.manifest.branchName === expected.branch &&
    git.branch === expected.branch &&
    renderer.firstBranch === expected.branch &&
    renderer.duplicateBranch === expected.branch &&
    [reopened, reopenedAgain].every((state) =>
      state.prepared.branch === expected.branch && state.created.branch === expected.branch
    );
  if (!branchBindingExact) fail("candidate-branch-mismatch");

  const branchAdvanceCount = Number.isSafeInteger(git.branchAdvanceCount)
    ? git.branchAdvanceCount
    : null;
  if (branchAdvanceCount !== 1 || git.commitSha !== expected.commitSha) {
    fail("branch-advance-count-invalid");
  }
  const manifestAfterHead = sqlite.seededManifest.afterHeadCommit;
  const parentMatchesManifestAfterHead = expected.beforeHead === manifestAfterHead &&
    reopened.manifest.afterHeadCommit === manifestAfterHead &&
    reopenedAgain.manifest.afterHeadCommit === manifestAfterHead &&
    renderer.firstParentCommit === manifestAfterHead &&
    renderer.duplicateParentCommit === manifestAfterHead &&
    git.parentCommit === manifestAfterHead &&
    [reopened, reopenedAgain].every((state) =>
      state.prepared.parentCommit === manifestAfterHead && state.created.parentCommit === manifestAfterHead
    );
  if (!parentMatchesManifestAfterHead) fail("commit-parent-mismatch");
  const reviewedTreeExact = git.reviewedFileBytesExact === true &&
    git.treePatchSha256 === expected.fullPatchSha256 &&
    exactStrings(git.changedFiles, expected.candidateFiles);
  if (!reviewedTreeExact) fail("reviewed-tree-mismatch");
  const noExtraCandidateBytes = reviewedTreeExact && git.statusClean === true;
  if (!noExtraCandidateBytes) fail("unreviewed-dirty-or-index-bytes");
  const commitMessageExact = git.subject === expected.subject && git.body === expected.body;
  if (!commitMessageExact) fail("commit-message-mismatch");
  const noRemoteDelivery = git.remoteCount === 0;
  if (!noRemoteDelivery) fail("remote-delivery-surface-present");

  const manifestImmutable = stableJson(sqlite.seededManifest) === stableJson(reopened.manifest) &&
    stableJson(reopened.manifest) === stableJson(reopenedAgain.manifest) &&
    reopened.manifestSha256 === expected.manifestSha256 &&
    reopenedAgain.manifestSha256 === expected.manifestSha256;
  if (!manifestImmutable) fail("candidate-manifest-drifted");

  const publicationPreparedDurable = [reopened, reopenedAgain].every((state) =>
    state.preparedCount === 1 &&
    state.prepared?.manifestSha256 === expected.manifestSha256 &&
    state.prepared?.requestSha256 === expected.publicationRequestSha256 &&
    state.prepared?.commitSha === expected.commitSha &&
    state.prepared?.parentCommit === manifestAfterHead &&
    state.prepared?.expectedFullPatchSha256 === expected.fullPatchSha256
  );
  if (!publicationPreparedDurable) fail("publication-prepared-not-durable");

  const commitCreatedDurable = [reopened, reopenedAgain].every((state) =>
    state.createdCount === 1 &&
    state.created?.manifestSha256 === expected.manifestSha256 &&
    state.created?.requestSha256 === expected.publicationRequestSha256 &&
    state.created?.commitSha === expected.commitSha &&
    state.created?.parentCommit === manifestAfterHead
  );
  if (!commitCreatedDurable) fail("commit-created-event-count-invalid");

  const preparedOutsideProjection = renderer.projectionPreparedCount === 0 &&
    reopened.projectionPreparedCount === 0 && reopenedAgain.projectionPreparedCount === 0;
  if (!preparedOutsideProjection) fail("prepared-entered-flow-projection");
  const preparedOutsideRenderer = renderer.preparedVisible === false &&
    reopened.canvasPreparedVisible === false && reopenedAgain.canvasPreparedVisible === false;
  if (!preparedOutsideRenderer) fail("prepared-visible-to-renderer");
  const duplicateEventsAbsent = reopened.preparedCount === 1 && reopened.createdCount === 1 &&
    reopenedAgain.preparedCount === 1 && reopenedAgain.createdCount === 1 &&
    renderer.createdVisibleCount === 1;
  if (!duplicateEventsAbsent) fail("duplicate-publication-event-present");

  const hermesProtectedStateUnchanged = stableJson(cleanup.protectedStateBefore) ===
    stableJson(cleanup.protectedStateAfter);
  if (!hermesProtectedStateUnchanged) fail("hermes-protected-state-changed");
  const hermesTemporaryRootsUnchanged = exactStrings(
    cleanup.hermesRootsBefore,
    cleanup.hermesRootsAfter,
  );
  if (!hermesTemporaryRootsUnchanged) fail("hermes-temporary-root-survived");
  const verifierProcessesReaped = exactNumbers(
    cleanup.verifierProcessesBefore,
    cleanup.verifierProcessesAfter,
  );
  if (!verifierProcessesReaped) fail("verifier-process-survived");
  const electronClosed = cleanup.electronClosed === true;
  if (!electronClosed) fail("electron-not-closed");
  const sqliteClosed = cleanup.sqliteClosed === true;
  if (!sqliteClosed) fail("sqlite-not-closed");
  const disposableResourcesRemoved = cleanup.resourcesRemoved === true;
  if (!disposableResourcesRemoved) fail("disposable-resources-survived");

  return {
    ok: failures.length === 0,
    failures,
    rendererIpcInvoked,
    preloadApiAvailable,
    realHermesReviewObserved,
    manifestImmutable,
    reviewRequestExact,
    branchBindingExact,
    branchAdvanceCount,
    parentMatchesManifestAfterHead,
    reviewedTreeExact,
    noExtraCandidateBytes,
    commitMessageExact,
    noRemoteDelivery,
    publicationPreparedDurable,
    commitCreatedDurable,
    publicationPreparedCount: Number.isSafeInteger(reopened.preparedCount) ? reopened.preparedCount : null,
    commitCreatedCount: Number.isSafeInteger(reopened.createdCount) ? reopened.createdCount : null,
    preparedOutsideProjection,
    preparedOutsideRenderer,
    duplicateCommitStable,
    duplicateEventsAbsent,
    hermesProtectedStateUnchanged,
    hermesTemporaryRootsUnchanged,
    verifierProcessesReaped,
    electronClosed,
    sqliteClosed,
    disposableResourcesRemoved,
  };
}

export function boundedCandidateReviewCommitJson(value) {
  const fallback = {
    ok: false,
    failures: ["invalid-oracle-input"],
    blocker: normalizeBlocker("final-json"),
  };
  try {
    if (!isOrdinaryRecord(value)) return JSON.stringify(fallback);
    const failures = isCanonicalPublicFailures(value.failures)
      ? value.failures
      : ["invalid-oracle-input"];
    const result = {
      ok: value.ok === true && failures.length === 0 && value.blocker === undefined,
      failures,
    };
    for (const key of publicOracleBooleanKeys) {
      if (typeof value[key] === "boolean") result[key] = value[key];
    }
    for (const key of publicOracleCountKeys) {
      if (isEvidenceCount(value[key])) result[key] = value[key];
    }
    if (value.blocker !== undefined) {
      result.blocker = normalizeBlocker(
        isOrdinaryRecord(value.blocker) ? value.blocker.stage : "unknown",
      );
      result.ok = false;
    }
    const json = JSON.stringify(result);
    return Buffer.byteLength(json, "utf8") <= finalJsonLimit ? json : JSON.stringify(fallback);
  } catch {
    return JSON.stringify(fallback);
  }
}

export async function seedCandidateReviewCommitStore(config) {
  const { createWorkflowStore } = await import("@skyturn/persistence/workflow-store");
  const {
    createGitChangesetService,
    createLiveWorkflowGitAncestryProofContext,
    createWorkflowGitAncestryProof,
    verifyWorkflowGitAncestryProof,
  } = await import("@skyturn/git-worktree/node");
  const {
    canonicalCandidateReviewRequestJson,
    canonicalWorkflowCandidateManifestJson,
    parseCandidateReviewRequest,
    resolveWorkflowDeliveryCandidateIdentity,
  } = await import("@skyturn/project-core");
  const store = createWorkflowStore({ projectRoot: config.projectRoot });
  const now = "2026-08-14T00:00:00.000Z";
  try {
    store.createWorkflowSession({
      id: candidateReviewCommitFixture.sessionId,
      projectId: candidateReviewCommitFixture.projectId,
      title: "Real Hermes candidate review commit acceptance",
      goal: "Publish one exact reviewed candidate through renderer-visible Electron IPC.",
      mode: "fast",
      target: {
        executionTarget: "current_branch",
        selectedBranch: candidateReviewCommitFixture.branch,
      },
      plannerProfile: "default",
      transport: "hermes_replay_recovery",
      recoveryReason: "Acceptance deterministically seeds candidate publication prerequisites.",
      now,
    });

    const lanes = [
      {
        id: candidateReviewCommitFixture.implementationLaneId,
        semanticKey: "acceptance:candidate-implementation",
        kind: "implementation",
        title: "Prepare exact candidate bytes",
        brief: "Production-shaped completed implementation prerequisite.",
        agentKind: "codex",
        executable: true,
        status: "pending",
        requiredEvidence: [],
        fileScopes: [...candidateReviewCommitFixture.candidateFiles],
        packageScopes: [],
      },
      {
        id: candidateReviewCommitFixture.reviewLaneId,
        semanticKey: "acceptance:lineage-review",
        kind: "review",
        title: "Recorded lineage review gate",
        brief: "Production-shaped completed lineage prerequisite; not the candidate reviewer.",
        agentKind: "hermes",
        executable: false,
        status: "completed",
        requiredEvidence: [],
        fileScopes: [],
        packageScopes: [],
      },
      {
        id: candidateReviewCommitFixture.validationLaneId,
        semanticKey: "acceptance:lineage-validation",
        kind: "validation",
        title: "Recorded lineage validation gate",
        brief: "Production-shaped completed validation prerequisite.",
        agentKind: "codex",
        executable: false,
        status: "completed",
        requiredEvidence: [],
        fileScopes: [],
        packageScopes: [],
      },
      {
        id: candidateReviewCommitFixture.commitLaneId,
        semanticKey: "acceptance:candidate-commit",
        kind: "commit",
        title: "Publish reviewed candidate",
        brief: "Commit only after the real isolated Hermes candidate verifier allows it.",
        agentKind: "codex",
        executable: false,
        status: "pending",
        requiredEvidence: [],
        fileScopes: [...candidateReviewCommitFixture.candidateFiles],
        packageScopes: [],
      },
    ];
    for (const [index, lane] of lanes.entries()) {
      store.appendWorkflowEvent({
        sessionId: candidateReviewCommitFixture.sessionId,
        kind: "workflow.lane.declared",
        source: "candidate-review-commit-acceptance",
        idempotencyKey: `candidate-review-commit:lane:${lane.id}`,
        payload: { lane },
        now: `2026-08-14T00:00:0${index + 1}.000Z`,
      });
    }
    const edges = [
      [candidateReviewCommitFixture.implementationLaneId, candidateReviewCommitFixture.validationLaneId],
      [candidateReviewCommitFixture.validationLaneId, candidateReviewCommitFixture.reviewLaneId],
      [candidateReviewCommitFixture.reviewLaneId, candidateReviewCommitFixture.commitLaneId],
    ];
    for (const [index, [sourceLaneId, targetLaneId]] of edges.entries()) {
      store.appendWorkflowEvent({
        sessionId: candidateReviewCommitFixture.sessionId,
        kind: "workflow.edge.declared",
        source: "candidate-review-commit-acceptance",
        idempotencyKey: `candidate-review-commit:edge:${index + 1}`,
        payload: {
          edge: {
            id: `edge-candidate-review-commit-${index + 1}`,
            sourceLaneId,
            targetLaneId,
          },
        },
        now: `2026-08-14T00:00:0${index + 5}.000Z`,
      });
    }

    const scheduled = store.scheduleReadyLanes(candidateReviewCommitFixture.sessionId, {
      allowedParallelism: 1,
      authorizedLaneIds: [candidateReviewCommitFixture.implementationLaneId],
      now: "2026-08-14T00:00:08.000Z",
    });
    if (
      scheduled.readyLanes.length !== 1 ||
      scheduled.readyLanes[0]?.id !== candidateReviewCommitFixture.implementationLaneId
    ) {
      throw new Error("Candidate implementation prerequisite was not scheduled exactly once.");
    }
    const segment = scheduled.readyLanes[0];
    const checkpointBase = {
      sessionId: candidateReviewCommitFixture.sessionId,
      nodeId: candidateReviewCommitFixture.implementationLaneId,
      laneId: candidateReviewCommitFixture.implementationLaneId,
      segmentId: segment.segmentId,
      runId: segment.runId,
      executionTarget: "current_branch",
      worktreePath: config.projectRoot,
      branchName: candidateReviewCommitFixture.branch,
    };
    store.recordRunCheckpoint({
      ...checkpointBase,
      phase: "before",
      headCommit: config.baseHead,
      worktreeState: "clean",
      evidenceRefs: [{ kind: "run", id: segment.runId }],
      now: "2026-08-14T00:00:09.000Z",
    });

    const changesetId = `changeset:${segment.runId}:candidate`;
    const changesetService = createGitChangesetService({
      repoRoot: config.projectRoot,
      maxPatchPreviewBytes: 1,
    });
    const changesetEvidence = await changesetService.collectChangesetEvidence({
      node: {
        id: candidateReviewCommitFixture.implementationLaneId,
        changesetId,
        worktree: { path: config.projectRoot },
      },
    });
    if (
      changesetEvidence.status !== "available" ||
      !exactStrings(changesetEvidence.files, candidateReviewCommitFixture.candidateFiles) ||
      typeof changesetEvidence.fullPatchSha256 !== "string" ||
      typeof changesetEvidence.fullPatchByteLength !== "number" ||
      typeof changesetEvidence.fileManifestSha256 !== "string"
    ) {
      throw new Error("Candidate changeset prerequisite is not complete exact Git evidence.");
    }

    const runEvidence = {
      runId: segment.runId,
      status: "succeeded",
      exitCode: 0,
      changesetId,
      checks: [{
        kind: "test",
        name: "Deterministic candidate fixture",
        status: "passed",
        detail: "The candidate fixture bytes were staged before manifest freeze.",
      }],
      artifacts: [],
      review: null,
      errorReason: null,
      cancelReason: null,
      completedAt: "2026-08-14T00:00:10.000Z",
    };
    store.recordRunResult({
      sessionId: candidateReviewCommitFixture.sessionId,
      laneId: candidateReviewCommitFixture.implementationLaneId,
      segmentId: segment.segmentId,
      runId: segment.runId,
      agentKind: "codex",
      outputSummary: "Deterministic candidate prerequisite completed.",
      evidence: runEvidence,
      now: runEvidence.completedAt,
    });
    store.appendWorkflowEvent({
      sessionId: candidateReviewCommitFixture.sessionId,
      kind: "workflow.changeset.evidence_recorded",
      source: "backend",
      laneId: candidateReviewCommitFixture.implementationLaneId,
      segmentId: segment.segmentId,
      idempotencyKey: `checkpoint-changeset:${segment.runId}:after`,
      payload: {
        laneId: candidateReviewCommitFixture.implementationLaneId,
        segmentId: segment.segmentId,
        baselineHeadCommit: config.baseHead,
        evidence: changesetEvidence,
      },
      now: "2026-08-14T00:00:11.000Z",
    });

    const ancestryInput = {
      repositoryPath: config.projectRoot,
      worktreePath: config.projectRoot,
      beforeHeadCommit: config.baseHead,
      afterHeadCommit: config.baseHead,
    };
    const ancestryProof = await createWorkflowGitAncestryProof(ancestryInput);
    const ancestryProofContext = await createLiveWorkflowGitAncestryProofContext(ancestryInput);
    await verifyWorkflowGitAncestryProof(ancestryProof, ancestryInput);
    store.recordRunCheckpoint({
      ...checkpointBase,
      phase: "after",
      headCommit: config.baseHead,
      worktreeState: "dirty",
      ancestryProof,
      ancestryProofContext,
      evidenceRefs: [
        { kind: "run", id: segment.runId },
        { kind: "segment", id: segment.segmentId },
        { kind: "evidence", id: `evidence-${segment.segmentId}` },
        { kind: "changeset", id: changesetEvidence.evidenceId },
      ],
      now: "2026-08-14T00:00:12.000Z",
    });

    const identity = {
      sessionId: candidateReviewCommitFixture.sessionId,
      nodeId: candidateReviewCommitFixture.implementationLaneId,
      laneId: candidateReviewCommitFixture.implementationLaneId,
      segmentId: segment.segmentId,
      runId: segment.runId,
    };
    const manifest = store.freezeCandidateManifest({
      ...identity,
      now: "2026-08-14T00:00:13.000Z",
    });
    const manifestSha256 = sha256(Buffer.from(canonicalWorkflowCandidateManifestJson(manifest), "utf8"));
    const patch = await canonicalCandidatePatch(config.projectRoot, config.baseHead);
    if (
      sha256(patch) !== changesetEvidence.fullPatchSha256 ||
      patch.byteLength !== changesetEvidence.fullPatchByteLength
    ) {
      throw new Error("Independent candidate patch bytes differ from authoritative changeset evidence.");
    }
    const reviewRequest = {
      version: 1,
      manifestSha256,
      identity,
      candidate: {
        repositoryIdentity: manifest.repositoryIdentity,
        worktreeIdentity: manifest.worktreeIdentity,
        branchName: manifest.branchName,
        beforeHeadCommit: manifest.beforeHeadCommit,
        afterHeadCommit: manifest.afterHeadCommit,
        ancestryProofSha256: manifest.ancestryProofSha256,
        fileManifestSha256: manifest.fileManifestSha256,
      },
      patch: {
        encoding: "base64",
        sha256: manifest.fullPatchSha256,
        byteLength: manifest.fullPatchByteLength,
        base64: patch.toString("base64"),
      },
    };
    if (!parseCandidateReviewRequest(reviewRequest)) {
      throw new Error("Independently reconstructed candidate review request is invalid.");
    }
    const reviewRequestSha256 = sha256(Buffer.from(
      canonicalCandidateReviewRequestJson(reviewRequest),
      "utf8",
    ));

    const projection = store.materializeFlowProjection(candidateReviewCommitFixture.sessionId);
    const canvasSession = store.materializeCanvasSession(candidateReviewCommitFixture.sessionId);
    if (!canvasSession) throw new Error("Candidate review commit CanvasSession did not materialize.");
    const deliveryIdentity = resolveWorkflowDeliveryCandidateIdentity(
      projection,
      candidateReviewCommitFixture.sessionId,
      candidateReviewCommitFixture.commitLaneId,
    );
    const { agentKind: deliveryAgentKind, ...deliveryManifestIdentity } = deliveryIdentity;
    if (
      deliveryAgentKind !== "codex" ||
      stableJson(deliveryManifestIdentity) !== stableJson(identity)
    ) {
      throw new Error("Candidate delivery lineage does not resolve to the frozen manifest identity.");
    }
    const candidateNode = canvasSession.nodes.find((node) => node.id === manifest.nodeId);
    if (
      !candidateNode ||
      canvasSession.target.executionTarget !== manifest.executionTarget ||
      canvasSession.target.selectedBranch !== manifest.branchName ||
      candidateNode.worktree?.branchName !== manifest.branchName ||
      manifest.worktreeId !== null ||
      candidateNode.worktree?.worktreeId
    ) {
      throw new Error("Candidate CanvasSession binding does not match the frozen current-branch manifest.");
    }
    const workspace = candidateReviewCommitWorkspace({
      projectRoot: config.projectRoot,
      canvasSession,
      segment,
      runEvidence,
      openedAt: now,
    });
    await mkdir(dirname(config.workspacePath), { recursive: true });
    await writeFile(config.workspacePath, `${JSON.stringify(workspace, null, 2)}\n`, "utf8");
    return {
      identity,
      manifest,
      manifestSha256,
      reviewRequestSha256,
      changesetEvidence,
      projectionPreparedCount: projection.events.filter((event) =>
        event.kind === "workflow.commit.publication_prepared"
      ).length,
      canvasSessionId: canvasSession.id,
    };
  } finally {
    store.close();
  }
}

export async function inspectCandidateReviewCommitStore(config) {
  const { createWorkflowStore } = await import("@skyturn/persistence/workflow-store");
  const { canonicalWorkflowCandidateManifestJson } = await import("@skyturn/project-core");
  const store = createWorkflowStore({ projectRoot: config.projectRoot });
  try {
    const identity = config.identity;
    const manifest = store.getCandidateManifest(identity);
    if (!manifest) throw new Error("Authoritative candidate manifest is missing after reopen.");
    const events = store.listEvents(candidateReviewCommitFixture.sessionId);
    const reviewEvents = events.filter((event) => event.kind === "workflow.candidate.review_allowed");
    const preparedEvents = events.filter((event) => event.kind === "workflow.commit.publication_prepared");
    const createdEvents = events.filter((event) => event.kind === "workflow.commit.created");
    const reviewDecision = store.getCandidateReviewAllowed({
      ...identity,
      manifestSha256: sha256(Buffer.from(canonicalWorkflowCandidateManifestJson(manifest), "utf8")),
    });
    const prepared = summarizePreparedEvent(preparedEvents[0]);
    const created = summarizeCreatedEvent(createdEvents[0]);
    const projection = store.materializeFlowProjection(candidateReviewCommitFixture.sessionId);
    const canvasSession = store.materializeCanvasSession(candidateReviewCommitFixture.sessionId);
    return {
      manifest,
      manifestSha256: sha256(Buffer.from(canonicalWorkflowCandidateManifestJson(manifest), "utf8")),
      preparedCount: preparedEvents.length,
      createdCount: createdEvents.length,
      prepared,
      created,
      projectionPreparedCount: projection.events.filter((event) =>
        event.kind === "workflow.commit.publication_prepared"
      ).length,
      canvasPreparedVisible: JSON.stringify(canvasSession).includes("workflow.commit.publication_prepared"),
      reviewAttestation: reviewDecision ? {
        requestSha256: reviewDecision.requestSha256,
        manifestSha256: reviewDecision.manifestSha256,
        disposition: reviewDecision.disposition,
        count: reviewEvents.length,
      } : null,
    };
  } finally {
    store.close();
  }
}

export async function runCandidateReviewCommitAcceptance(options = {}) {
  const env = options.env ?? process.env;
  const timeoutMs = boundedTimeout(env.SKYTURN_CANDIDATE_REVIEW_COMMIT_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;
  const services = options.services ?? {};
  let stage = "preflight";
  let blocker = null;
  let tempRoot = null;
  let projectRoot = null;
  let userData = null;
  let app = null;
  let cdp = null;
  let closeResult = null;
  let seeded = null;
  let rendererResult = null;
  let reviewObservation = { temporaryRootObserved: false, verifierProcessObserved: false };
  let reopened = null;
  let reopenedAgain = null;
  let gitFacts = null;
  let protectedStateBefore = null;
  let protectedStateAfter = null;
  let hermesRootsBefore = [];
  let hermesRootsAfter = [];
  let verifierProcessesBefore = [];
  let verifierProcessesAfter = [];
  let sqliteClosed = false;
  let resourcesRemoved = false;

  try {
    assertBeforeDeadline(deadline, stage);
    await prepareCandidateReviewCommitCheckout({
      deadline,
      onStage(nextStage) {
        stage = nextStage;
      },
    });
    stage = "preflight";
    assertBeforeDeadline(deadline, stage);
    const hermesRoot = await resolveHermesRoot(env);
    protectedStateBefore = await snapshotHermesProtectedState(hermesRoot);
    hermesRootsBefore = await listHermesReviewRoots();
    verifierProcessesBefore = await listHermesVerifierProcesses();
    await assertVerifierPreflight();

    stage = "fixture";
    const makeTempRoot = services.makeTempRoot ?? (() =>
      mkdtemp(join(tmpdir(), "skyturn-candidate-review-commit-")));
    tempRoot = await realpath(await makeTempRoot());
    projectRoot = join(tempRoot, "project");
    userData = join(tempRoot, "user-data");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(userData, { recursive: true });
    const fixture = await createDisposableCandidateRepository(projectRoot);
    const workspacePath = join(userData, "workspace.json");

    stage = "seed";
    assertBeforeDeadline(deadline, stage);
    seeded = await runElectronNodeMode("--seed", {
      projectRoot,
      workspacePath,
      baseHead: fixture.baseHead,
    });
    if (
      seeded?.canvasSessionId !== candidateReviewCommitFixture.sessionId ||
      seeded?.projectionPreparedCount !== 0
    ) {
      throw new Error("Seeded acceptance authority is incomplete or already contains publication facts.");
    }

    stage = "electron-launch";
    assertBeforeDeadline(deadline, stage);
    app = await (services.launch ?? launchElectronAcceptanceApp)({ userData, projectRoot });
    cdp = await (services.connect ?? connectToReadySkyTurnRenderer)({
      cdpPort: app.cdpPort,
      devServerUrl: app.devServerUrl,
      projectRoot,
      processDiagnostics: app.diagnostics,
    });
    await (services.waitForProject ?? waitForStoredProjectRegistration)(cdp, projectRoot);

    stage = "renderer-ipc";
    assertBeforeDeadline(deadline, stage);
    const invocation = () => cdp.evaluate(buildCandidateReviewCommitRendererInvocation({
      projectRoot,
      sessionId: candidateReviewCommitFixture.sessionId,
      laneId: candidateReviewCommitFixture.commitLaneId,
      worktreePath: projectRoot,
      subject: CANDIDATE_REVIEW_COMMIT_SUBJECT,
      body: CANDIDATE_REVIEW_COMMIT_BODY,
    }), {
      awaitPromise: true,
      returnByValue: true,
      requestTimeoutMs: Math.max(1_000, deadline - Date.now()),
    });
    const observed = await observeRealHermesReview(invocation, {
      hermesRootsBefore,
      verifierProcessesBefore,
    });
    rendererResult = observed.value;
    reviewObservation = observed.observation;

  } catch (error) {
    blocker = normalizeBlocker(stage, error);
  } finally {
    if (app || cdp) {
      closeResult = await (services.closeApp ?? finalizeAcceptanceOutcome)({
        app,
        liveCdp: cdp,
        ...(blocker ? { error: new Error("Acceptance stage failed.") } : { ok: true }),
      }).catch(() => ({
        ok: false,
        cleanupConfirmed: false,
      }));
      app = null;
      cdp = null;
      if (closeResult?.ok !== true && !blocker) {
        blocker = normalizeBlocker("electron-close");
      }
    }
  }

  if (projectRoot && seeded) {
    try {
      stage = "sqlite-reopen";
      assertBeforeDeadline(deadline, stage);
      reopened = await runElectronNodeMode("--inspect", {
        projectRoot,
        identity: seeded.identity,
      });
      reopenedAgain = await runElectronNodeMode("--inspect", {
        projectRoot,
        identity: seeded.identity,
      });
      sqliteClosed = await noProcessHoldsFile(join(projectRoot, ".devflow", "skyturn-workflow.sqlite"));
      if (!sqliteClosed) throw new Error("SQLite workflow store remains open after Electron and inspector exit.");
    } catch (error) {
      blocker ??= normalizeBlocker(stage, error);
    }
  }

  if (projectRoot && seeded && rendererResult?.first?.commitSha) {
    try {
      stage = "git-oracle";
      gitFacts = await inspectCandidateCommitGit({
        projectRoot,
        baseHead: seeded.manifest.afterHeadCommit,
        commitSha: rendererResult.first.commitSha,
        expectedFiles: candidateReviewCommitFixture.candidateFiles,
      });
    } catch (error) {
      blocker ??= normalizeBlocker(stage, error);
    }
  }

  try {
    stage = "hermes-cleanup";
    const hermesRoot = await resolveHermesRoot(env);
    protectedStateAfter = await snapshotHermesProtectedState(hermesRoot);
    hermesRootsAfter = await listHermesReviewRoots();
    verifierProcessesAfter = await listHermesVerifierProcesses();
  } catch (error) {
    blocker ??= normalizeBlocker(stage, error);
  }

  const publicationRequestSha256 = seeded
    ? sha256(Buffer.from(JSON.stringify({
        version: 1,
        manifestSha256: seeded.manifestSha256,
        subject: CANDIDATE_REVIEW_COMMIT_SUBJECT,
        body: CANDIDATE_REVIEW_COMMIT_BODY,
      }), "utf8"))
    : null;
  const expected = seeded && rendererResult?.first?.commitSha ? {
    beforeHead: seeded.manifest.afterHeadCommit,
    commitSha: rendererResult.first.commitSha,
    manifestSha256: seeded.manifestSha256,
    requestSha256: seeded.reviewRequestSha256,
    publicationRequestSha256,
    fullPatchSha256: seeded.manifest.fullPatchSha256,
    fileManifestSha256: seeded.manifest.fileManifestSha256,
    ancestryProofSha256: seeded.manifest.ancestryProofSha256,
    branch: seeded.manifest.branchName,
    subject: CANDIDATE_REVIEW_COMMIT_SUBJECT,
    body: CANDIDATE_REVIEW_COMMIT_BODY,
    candidateFiles: candidateReviewCommitFixture.candidateFiles,
  } : {};

  if (tempRoot) {
    try {
      await rm(tempRoot, { recursive: true, force: true });
      resourcesRemoved = await isMissingPath(tempRoot);
    } catch (error) {
      blocker ??= normalizeBlocker("resource-cleanup", error);
    }
  }

  const oracle = candidateReviewCommitOracle({
    expected,
    renderer: summarizeCandidateReviewCommitRendererResult(rendererResult),
    review: {
      actualRequestSha256: seeded?.reviewRequestSha256 ?? null,
      expectedRequestSha256: seeded?.reviewRequestSha256 ?? null,
      manifestSha256: seeded?.manifestSha256 ?? null,
      fullPatchSha256: seeded?.manifest?.fullPatchSha256 ?? null,
      fileManifestSha256: seeded?.manifest?.fileManifestSha256 ?? null,
      ancestryProofSha256: seeded?.manifest?.ancestryProofSha256 ?? null,
      ...reviewObservation,
    },
    git: gitFacts ?? {},
    sqlite: {
      seededManifest: seeded?.manifest ?? null,
      reopened,
      reopenedAgain,
    },
    cleanup: {
      protectedStateBefore,
      protectedStateAfter,
      hermesRootsBefore,
      hermesRootsAfter,
      verifierProcessesBefore,
      verifierProcessesAfter,
      electronClosed: closeResult?.ok === true && closeResult?.cleanupConfirmed === true,
      sqliteClosed,
      resourcesRemoved,
    },
  });
  if (!oracle.ok && !blocker) {
    blocker = normalizeBlocker("oracle");
  }
  return blocker ? { ...oracle, ok: false, blocker } : oracle;
}

async function createDisposableCandidateRepository(projectRoot) {
  await runGit(projectRoot, ["init", "--initial-branch", candidateReviewCommitFixture.branch]);
  await runGit(projectRoot, ["config", "user.name", "SkyTurn Acceptance"]);
  await runGit(projectRoot, ["config", "user.email", "acceptance@skyturn.invalid"]);
  await writeFile(join(projectRoot, "reviewed.txt"), "before reviewed bytes\n", "utf8");
  await writeFile(join(projectRoot, "second.txt"), "before second bytes\n", "utf8");
  await runGit(projectRoot, ["add", "--", ...candidateReviewCommitFixture.candidateFiles]);
  await runGit(projectRoot, ["commit", "-m", "chore: seed candidate fixture"]);
  const baseHead = (await runGit(projectRoot, ["rev-parse", "HEAD^{commit}"])).stdout.trim();
  await writeFile(join(projectRoot, "reviewed.txt"), "reviewed candidate bytes\n", "utf8");
  await writeFile(join(projectRoot, "second.txt"), "second reviewed candidate bytes\n", "utf8");
  await runGit(projectRoot, ["add", "--", ...candidateReviewCommitFixture.candidateFiles]);
  return { baseHead };
}

async function inspectCandidateCommitGit({ projectRoot, baseHead, commitSha, expectedFiles }) {
  const [head, branch, parentLine, changed, subject, body, status, remotes, advance, reverse] = await Promise.all([
    runGit(projectRoot, ["rev-parse", "HEAD^{commit}"]),
    runGit(projectRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
    runGit(projectRoot, ["rev-list", "--parents", "-n", "1", commitSha]),
    runGit(projectRoot, ["diff-tree", "--no-commit-id", "--name-only", "-r", commitSha]),
    runGit(projectRoot, ["log", "-1", "--format=%s", commitSha]),
    runGit(projectRoot, ["log", "-1", "--format=%b", commitSha]),
    runGit(projectRoot, ["status", "--porcelain=v1", "--untracked-files=all", "--", ...volatilePathspecs]),
    runGit(projectRoot, ["remote"]),
    runGit(projectRoot, ["rev-list", "--count", `${baseHead}..${commitSha}`]),
    runGit(projectRoot, ["rev-list", "--count", `${commitSha}..${baseHead}`]),
  ]);
  const parentParts = parentLine.stdout.trim().split(" ");
  const changedFiles = changed.stdout.trim().split("\n").filter(Boolean).sort(compareUtf8);
  let reviewedFileBytesExact = true;
  const expectedContents = new Map([
    ["reviewed.txt", Buffer.from("reviewed candidate bytes\n")],
    ["second.txt", Buffer.from("second reviewed candidate bytes\n")],
  ]);
  for (const file of expectedFiles) {
    const value = await runGitBuffer(projectRoot, ["show", `${commitSha}:${file}`]);
    if (!value.equals(expectedContents.get(file))) reviewedFileBytesExact = false;
  }
  const patch = await canonicalCandidatePatch(projectRoot, baseHead, commitSha);
  return {
    branchAdvanceCount: Number(advance.stdout.trim()),
    branch: branch.stdout.trim(),
    parentCommit: parentParts.length === 2 ? parentParts[1] : null,
    commitSha: head.stdout.trim() === commitSha && Number(reverse.stdout.trim()) === 0 ? commitSha : null,
    changedFiles,
    reviewedFileBytesExact,
    treePatchSha256: sha256(patch),
    statusClean: status.stdout.trim() === "",
    subject: subject.stdout.trimEnd(),
    body: body.stdout.trimEnd(),
    remoteCount: remotes.stdout.trim() ? remotes.stdout.trim().split("\n").length : 0,
  };
}

async function canonicalCandidatePatch(projectRoot, baseHead, commitSha) {
  const deterministicConfig = [
    "--no-optional-locks",
    "-c", `core.attributesFile=${devNull}`,
    "-c", "core.bigFileThreshold=512m",
    "-c", "core.checkStat=default",
    "-c", `core.excludesFile=${devNull}`,
    "-c", `core.fileMode=${process.platform === "win32" ? "false" : "true"}`,
    "-c", "core.fsmonitor=false",
    "-c", "core.ignoreStat=false",
    "-c", "core.quotePath=false",
    "-c", "core.trustctime=true",
    "-c", "core.untrackedCache=false",
    "-c", "color.ui=false",
    "-c", "diff.algorithm=myers",
    "-c", "diff.colorMoved=false",
    "-c", "diff.external=",
    "-c", "diff.ignoreSubmodules=none",
    "-c", "diff.indentHeuristic=false",
    "-c", "diff.mnemonicPrefix=false",
    "-c", "diff.noprefix=false",
    "-c", `diff.orderFile=${devNull}`,
    "-c", "diff.renames=false",
    "-c", "diff.submodule=short",
    "-c", "diff.suppressBlankEmpty=false",
  ];
  const flags = [
    "--binary",
    "--full-index",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    "--no-color",
    "--no-relative",
    "--no-indent-heuristic",
    "--diff-algorithm=myers",
    "--inter-hunk-context=0",
    `-O${devNull}`,
    "--ignore-submodules=none",
    "--submodule=short",
    "--unified=3",
    "--output-indicator-new=+",
    "--output-indicator-old=-",
    "--output-indicator-context= ",
    "--src-prefix=a/",
    "--dst-prefix=b/",
  ];
  return runGitBuffer(projectRoot, [
    ...deterministicConfig,
    "diff",
    ...flags,
    baseHead,
    ...(commitSha ? [commitSha] : []),
    "--",
    ...volatilePathspecs,
  ]);
}

async function observeRealHermesReview(operation, baseline) {
  let active = true;
  let temporaryRootObserved = false;
  let verifierProcessObserved = false;
  const baselineRoots = new Set(baseline.hermesRootsBefore);
  const baselineProcesses = new Set(baseline.verifierProcessesBefore);
  const monitor = (async () => {
    while (active) {
      const [roots, processes] = await Promise.all([
        listHermesReviewRoots(),
        listHermesVerifierProcesses(),
      ]);
      if (roots.some((root) => !baselineRoots.has(root))) temporaryRootObserved = true;
      if (processes.some((pid) => !baselineProcesses.has(pid))) verifierProcessObserved = true;
      if (active) await delay(50);
    }
  })();
  let value;
  try {
    value = await operation();
  } finally {
    active = false;
    await monitor;
  }
  return {
    value,
    observation: { temporaryRootObserved, verifierProcessObserved },
  };
}

async function snapshotHermesProtectedState(root) {
  const snapshot = {};
  for (const name of hermesProtectedFiles) {
    const path = join(root, name);
    try {
      const metadata = await lstat(path, { bigint: true });
      const bytes = await readFile(path);
      snapshot[name] = {
        kind: metadata.isSymbolicLink() ? "symlink" : metadata.isFile() ? "file" : "other",
        mode: Number(metadata.mode & 0o777n),
        size: bytes.byteLength,
        sha256: sha256(bytes),
        device: metadata.dev.toString(),
        inode: metadata.ino.toString(),
      };
    } catch (error) {
      if (!isMissingError(error)) throw error;
      snapshot[name] = { kind: "missing" };
    }
  }
  return snapshot;
}

async function listHermesReviewRoots() {
  const entries = await readdir(tmpdir(), { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("skyturn-hermes-review-"))
    .map((entry) => entry.name)
    .sort(compareUtf8);
}

export async function listHermesVerifierProcesses(run = runCommand) {
  try {
    const result = await run("/usr/sbin/lsof", ["-t", "--", verifierOwnerPath]);
    return strictLsofPids(result);
  } catch (error) {
    if (isCleanLsofNoMatch(error)) return [];
    throw new Error("Process-holder inspection failed.");
  }
}

async function resolveHermesRoot(env) {
  const candidate = env.HERMES_HOME?.trim() || join(env.HOME?.trim() || homedir(), ".hermes");
  const root = await realpath(candidate);
  if (!(await stat(root)).isDirectory()) throw new Error("Hermes state root is unavailable.");
  return root;
}

async function assertVerifierPreflight() {
  const electronBinary = require("electron");
  await Promise.all([
    stat(electronBinary),
    stat("/usr/bin/sandbox-exec"),
    stat(verifierOwnerPath),
    stat(fdLaunchPath),
  ]);
  const path = process.env.PATH ?? "";
  const found = await findExecutable("hermes", path);
  if (!found) throw new Error("Installed Hermes executable is unavailable on PATH.");
}

async function findExecutable(name, path) {
  for (const directory of path.split(":")) {
    if (!directory) continue;
    try {
      const metadata = await stat(join(directory, name));
      if (metadata.isFile()) return true;
    } catch {}
  }
  return false;
}

export async function noProcessHoldsFile(path, run = runCommand) {
  try {
    const result = await run("/usr/sbin/lsof", ["-t", "--", path]);
    strictLsofPids(result);
    return false;
  } catch (error) {
    if (isCleanLsofNoMatch(error)) return true;
    throw new Error("Process-holder inspection failed.");
  }
}

function strictLsofPids(result) {
  if (!isOrdinaryRecord(result) || typeof result.stdout !== "string" || result.stderr !== "") {
    throw new Error("Process-holder inspection failed.");
  }
  const lines = result.stdout.endsWith("\n")
    ? result.stdout.slice(0, -1).split("\n")
    : result.stdout.split("\n");
  if (lines.length === 0 || lines.some((line) => !/^[1-9][0-9]*$/.test(line))) {
    throw new Error("Process-holder inspection failed.");
  }
  const pids = lines.map(Number);
  if (pids.some((pid) => !Number.isSafeInteger(pid))) {
    throw new Error("Process-holder inspection failed.");
  }
  return [...new Set(pids)].sort((left, right) => left - right);
}

function isCleanLsofNoMatch(error) {
  return error !== null &&
    typeof error === "object" &&
    !Array.isArray(error) &&
    error.exitCode === 1 &&
    error.stdout === "" &&
    error.stderr === "" &&
    error.signal == null &&
    error.killed !== true &&
    error.spawnError !== true;
}

async function runElectronNodeMode(mode, config) {
  const electronBinary = require("electron");
  const result = await runCommand(electronBinary, [scriptPath, mode, JSON.stringify(config)], {
    cwd: dirname(scriptPath),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
  });
  const prefix = mode === "--seed" ? seedPrefix : inspectPrefix;
  const line = result.stdout.split("\n").find((candidate) => candidate.startsWith(prefix));
  if (!line) throw new Error(`Electron ${mode} did not return a structured acceptance result.`);
  return JSON.parse(line.slice(prefix.length));
}

export async function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      encoding: "utf8",
      maxBuffer: commandOutputLimit,
      shell: false,
      ...(options.timeoutMs ? { timeout: options.timeoutMs, killSignal: "SIGKILL" } : {}),
    }, (error, stdout, stderr) => {
      const boundedStdout = boundedCommandText(stdout);
      const boundedStderr = boundedCommandText(stderr);
      if (error) {
        error.exitCode = typeof error.code === "number" ? error.code : null;
        error.stdout = boundedStdout;
        error.stderr = boundedStderr;
        error.signal = typeof error.signal === "string" ? error.signal : null;
        error.spawnError = typeof error.code !== "number";
        error.message = `${basename(String(command))} ${safeAction(args)} failed${boundedStderr ? `: ${boundedStderr.trim()}` : ""}`;
        reject(error);
        return;
      }
      resolve({ stdout: boundedStdout, stderr: boundedStderr });
    });
  });
}

function boundedCommandText(value) {
  const bytes = Buffer.from(value ?? "", "utf8");
  return bytes.subarray(0, commandOutputLimit).toString("utf8").replace(/\uFFFD$/, "");
}

async function runGit(cwd, args) {
  return runCommand("git", args, { cwd });
}

async function runGitBuffer(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile("git", args, {
      cwd,
      encoding: null,
      maxBuffer: commandOutputLimit,
      shell: false,
    }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(`git ${safeAction(args)} failed: ${Buffer.from(stderr ?? "").toString("utf8").trim()}`));
        return;
      }
      resolve(Buffer.from(stdout ?? ""));
    });
  });
}

function candidateReviewCommitWorkspace({ projectRoot, canvasSession, segment, runEvidence, openedAt }) {
  const project = {
    id: candidateReviewCommitFixture.projectId,
    name: basename(projectRoot),
    rootPath: projectRoot,
    canonicalRootPath: projectRoot,
    devflowPath: join(projectRoot, ".devflow"),
    openedAt,
  };
  const run = {
    id: segment.runId,
    nodeId: candidateReviewCommitFixture.implementationLaneId,
    sessionId: candidateReviewCommitFixture.sessionId,
    projectRoot,
    worktreePath: projectRoot,
    agentKind: "codex",
    status: "succeeded",
    startedAt: segment.startedAt ?? openedAt,
    endedAt: runEvidence.completedAt,
  };
  return {
    projects: [project],
    sessions: [canvasSession],
    changesets: {},
    agents: [],
    runs: { [run.id]: run },
    runEvents: { [run.id]: [] },
    runEvidence: { [run.id]: runEvidence },
    activeProjectId: project.id,
    activeSessionId: canvasSession.id,
    sidebarCollapsed: false,
    collapsedProjectIds: [],
  };
}

function summarizePreparedEvent(event) {
  const preparation = event?.payload?.preparation;
  return event ? {
    manifestSha256: event.payload?.manifestSha256 ?? null,
    requestSha256: event.payload?.requestSha256 ?? null,
    commitSha: preparation?.commitSha ?? null,
    parentCommit: preparation?.parentCommit ?? null,
    expectedFullPatchSha256: preparation?.expected?.fullPatchSha256 ?? null,
    branch: preparation?.branch ?? null,
  } : null;
}

function summarizeCreatedEvent(event) {
  const evidence = event?.payload?.evidence;
  return event ? {
    manifestSha256: event.payload?.manifestSha256 ?? null,
    requestSha256: event.payload?.requestSha256 ?? null,
    commitSha: evidence?.commitSha ?? null,
    parentCommit: evidence?.parentCommit ?? null,
    branch: evidence?.branch ?? null,
  } : null;
}

function boundedTimeout(value) {
  if (value === undefined || value === "") return defaultTimeoutMs;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > maximumTimeoutMs) {
    throw new Error(`Acceptance timeout must be between 1 and ${maximumTimeoutMs} milliseconds.`);
  }
  return parsed;
}

function assertBeforeDeadline(deadline, stage) {
  if (Date.now() >= deadline) throw new Error(`Acceptance timed out before ${stage}.`);
}

function remainingTimeoutMs(deadline) {
  if (!Number.isSafeInteger(deadline)) throw new Error("Acceptance deadline is invalid.");
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Acceptance deadline expired.");
  return remaining;
}

function normalizeBlocker(stage, _error) {
  return {
    stage: typeof stage === "string" && publicBlockerStages.has(stage) ? stage : "unknown",
    code: acceptanceStageFailureCode,
  };
}

function isCanonicalPublicFailures(value) {
  return isPlainDenseArray(value) &&
    value.length <= publicOracleFailures.size &&
    value.every((failure) => typeof failure === "string" && publicOracleFailures.has(failure)) &&
    new Set(value).size === value.length;
}

function isOracleManifest(value) {
  if (
    !hasExactAllowedKeys(value, oracleManifestKeys) ||
    value.version !== 1 ||
    !isCanonicalTimestamp(value.createdAt)
  ) return false;
  if (![
    value.sessionId,
    value.nodeId,
    value.laneId,
    value.segmentId,
    value.runId,
    value.beforeCheckpointId,
    value.afterCheckpointId,
    value.terminalEvidenceId,
    value.changesetEvidenceId,
    value.changesetId,
  ].every(isCanonicalIdentity)) return false;
  if (
    !oracleAgentKinds.has(value.agentKind) ||
    (value.executionTarget !== "current_branch" && value.executionTarget !== "new_worktree") ||
    (value.executionTarget === "current_branch" && value.worktreeId !== null) ||
    (value.executionTarget === "new_worktree" && !isCanonicalIdentity(value.worktreeId)) ||
    !isCanonicalDigest(value.repositoryIdentity) ||
    !isCanonicalDigest(value.worktreeIdentity) ||
    !isCanonicalBranchName(value.branchName) ||
    !isCanonicalGitSha(value.beforeHeadCommit) ||
    !isCanonicalGitSha(value.afterHeadCommit) ||
    value.beforeCheckpointId === value.afterCheckpointId ||
    !isCanonicalDigest(value.ancestryProofSha256) ||
    !isOracleTerminalRunEvidence(value.terminalRunEvidence) ||
    value.terminalRunEvidence.runId !== value.runId ||
    (value.terminalRunEvidence.changesetId !== null &&
      value.terminalRunEvidence.changesetId !== value.changesetId) ||
    !isCanonicalDigest(value.terminalRunEvidenceSha256) ||
    !isCanonicalDigest(value.fullPatchSha256) ||
    !Number.isSafeInteger(value.fullPatchByteLength) ||
    value.fullPatchByteLength <= 0 ||
    !isCanonicalDigest(value.fileManifestSha256)
  ) return false;
  return true;
}

function isOracleTerminalRunEvidence(value) {
  return hasExactAllowedKeys(value, oracleTerminalRunEvidenceKeys) &&
    isCanonicalIdentity(value.runId) &&
    value.status === "succeeded" &&
    value.exitCode === 0 &&
    (value.changesetId === null || isCanonicalIdentity(value.changesetId)) &&
    isPlainDenseArray(value.checks) &&
    value.checks.every(isOracleEvidenceCheck) &&
    isEvidenceCount(value.artifactCount) &&
    (value.review === null || isOracleEvidenceCheck(value.review)) &&
    value.errorReason === null &&
    value.cancelReason === null &&
    isCanonicalTimestamp(value.completedAt);
}

function isOracleEvidenceCheck(value) {
  return hasExactAllowedKeys(value, oracleEvidenceCheckKeys) &&
    oracleEvidenceKinds.has(value.kind) &&
    oracleEvidenceStatuses.has(value.status);
}

function isOracleReopenedState(value) {
  return hasExactAllowedKeys(value, oracleReopenedKeys) &&
    isOracleManifest(value.manifest) &&
    isCanonicalDigest(value.manifestSha256) &&
    isEvidenceCount(value.preparedCount) &&
    isEvidenceCount(value.createdCount) &&
    isOraclePreparedSummary(value.prepared) &&
    isOracleCreatedSummary(value.created) &&
    isEvidenceCount(value.projectionPreparedCount) &&
    typeof value.canvasPreparedVisible === "boolean" &&
    isOracleReviewAttestation(value.reviewAttestation);
}

function isOraclePreparedSummary(value) {
  return hasExactAllowedKeys(value, oraclePreparedKeys) &&
    isCanonicalDigest(value.manifestSha256) &&
    isCanonicalDigest(value.requestSha256) &&
    isCanonicalGitSha(value.commitSha) &&
    isCanonicalGitSha(value.parentCommit) &&
    isCanonicalDigest(value.expectedFullPatchSha256) &&
    isCanonicalBranchName(value.branch);
}

function isOracleCreatedSummary(value) {
  return hasExactAllowedKeys(value, oracleCreatedKeys) &&
    isCanonicalDigest(value.manifestSha256) &&
    isCanonicalDigest(value.requestSha256) &&
    isCanonicalGitSha(value.commitSha) &&
    isCanonicalGitSha(value.parentCommit) &&
    isCanonicalBranchName(value.branch);
}

function isOracleReviewAttestation(value) {
  return hasExactAllowedKeys(value, oracleReviewAttestationKeys) &&
    isCanonicalDigest(value.requestSha256) &&
    isCanonicalDigest(value.manifestSha256) &&
    (value.disposition === "allow" || value.disposition === "block") &&
    isEvidenceCount(value.count);
}

function isOracleProtectedState(value) {
  return hasExactAllowedKeys(value, hermesProtectedFiles) &&
    hermesProtectedFiles.every((name) => isOracleProtectedEntry(value[name]));
}

function isOracleProtectedEntry(value) {
  if (!isOrdinaryRecord(value)) return false;
  if (value.kind === "missing") return hasExactAllowedKeys(value, ["kind"]);
  return hasExactAllowedKeys(value, oracleProtectedEntryKeys) &&
    (value.kind === "file" || value.kind === "symlink" || value.kind === "other") &&
    Number.isSafeInteger(value.mode) &&
    value.mode >= 0 &&
    value.mode <= 0o777 &&
    isEvidenceCount(value.size) &&
    isCanonicalDigest(value.sha256) &&
    isCanonicalDecimal(value.device) &&
    isCanonicalDecimal(value.inode);
}

function hasExactAllowedKeys(value, allowedKeys) {
  if (!isOrdinaryRecord(value)) return false;
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== allowedKeys.length ||
    ownKeys.some((key) => typeof key !== "string" || !allowedKeys.includes(key))
  ) return false;
  for (const key of allowedKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return false;
  }
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return false;
  }
  return true;
}

function isOrdinaryRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isPlainDenseArray(value) {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) return false;
  const expectedKeys = new Set(["length", ...value.map((_entry, index) => String(index))]);
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== expectedKeys.size ||
    ownKeys.some((key) => typeof key !== "string" || !expectedKeys.has(key))
  ) return false;
  for (const key of ownKeys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) return false;
  }
  for (const key in value) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) return false;
  }
  return true;
}

function isCanonicalGitSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value);
}

function isCanonicalDigest(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function isCanonicalIdentity(value) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    /^[A-Za-z0-9._:-]+$/.test(value);
}

function isCanonicalTimestamp(value) {
  if (typeof value !== "string") return false;
  const timestamp = Date.parse(value);
  return !Number.isNaN(timestamp) && new Date(timestamp).toISOString() === value;
}

function isCanonicalDecimal(value) {
  return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value);
}

function isCanonicalBranchName(value) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    value.trim() === value &&
    value !== "@" &&
    !value.startsWith("-") &&
    value !== "HEAD" &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.endsWith(".lock") &&
    !value.includes("..") &&
    !value.includes("//") &&
    !value.includes("@{") &&
    !/[\x00-\x20\x7f~^:?*[\]\\]/.test(value) &&
    value.split("/").every((component) =>
      component.length > 0 && !component.startsWith(".") && !component.endsWith(".lock")
    );
}

function isNonEmptyText(value) {
  return typeof value === "string" && value.length > 0 && value.trim() === value;
}

function isEvidenceCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isCanonicalStringArray(value) {
  return isPlainDenseArray(value) &&
    value.every(isNonEmptyText) &&
    new Set(value).size === value.length;
}

function isCanonicalPidArray(value) {
  return isPlainDenseArray(value) &&
    value.every((pid) => Number.isSafeInteger(pid) && pid > 0) &&
    new Set(value).size === value.length;
}

function stableJson(value) {
  return JSON.stringify(value, (_key, nested) => {
    if (!nested || typeof nested !== "object" || Array.isArray(nested)) return nested;
    return Object.fromEntries(Object.entries(nested).sort(([left], [right]) => left.localeCompare(right)));
  });
}

function exactStrings(actual, expected) {
  return Array.isArray(actual) && Array.isArray(expected) &&
    actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function exactNumbers(actual, expected) {
  return Array.isArray(actual) && Array.isArray(expected) &&
    actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function safeAction(args) {
  const action = Array.isArray(args) && typeof args[0] === "string" ? args[0] : "command";
  return /^[A-Za-z0-9._:-]+$/.test(action) ? action : "command";
}

async function isMissingPath(path) {
  try {
    await lstat(path);
    return false;
  } catch (error) {
    if (isMissingError(error)) return true;
    throw error;
  }
}

function isMissingError(error) {
  return error && typeof error === "object" && error.code === "ENOENT";
}

async function runRuntimeMode() {
  const mode = process.argv[2];
  if (mode !== "--seed" && mode !== "--inspect") return false;
  const config = JSON.parse(process.argv[3] ?? "null");
  if (mode === "--seed") {
    process.stdout.write(`${seedPrefix}${JSON.stringify(await seedCandidateReviewCommitStore(config))}\n`);
  } else {
    process.stdout.write(`${inspectPrefix}${JSON.stringify(await inspectCandidateReviewCommitStore(config))}\n`);
  }
  return true;
}

if (process.argv[1] === scriptPath) {
  runRuntimeMode().then(async (handled) => {
    if (handled) return;
    const result = await runCandidateReviewCommitAcceptance();
    process.stdout.write(`${boundedCandidateReviewCommitJson(result)}\n`);
    if (result.ok !== true) process.exitCode = 1;
  }).catch((error) => {
    const result = {
      ok: false,
      failures: ["acceptance-unhandled-error"],
      blocker: normalizeBlocker("unhandled", error),
    };
    process.stdout.write(`${boundedCandidateReviewCommitJson(result)}\n`);
    process.exitCode = 1;
  });
}
