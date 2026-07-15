import { describe, expect, it } from "vitest";

import type {
  CanvasNode,
  ChangesetEvidence,
  WorkflowVariantAdoption,
  WorkflowWorktreeIdentity,
} from "@skyturn/project-core";
import {
  GIT_WORKTREE_CONTRACT_VERSION,
  INVALID_VARIANT_COMPARISON_EVIDENCE_ERROR,
  createMockChangeset,
  mockWorktreeService,
  parseVariantComparisonEvidence,
  parseWorktreeComparisonRequest,
} from "./index";
import type {
  ChangesetEvidenceService,
  RecordedAdjudicationEvidence,
  ManagedWorktreeService,
  VariantAdoptionService,
} from "./index";
import { buildAdjudicationMetrics } from "./index";

describe("git worktree services", () => {
  it("accepts only the three ID fields in a worktree comparison request", () => {
    expect(parseWorktreeComparisonRequest({
      sessionId: "session-1",
      leftWorktreeId: "worktree-left",
      rightWorktreeId: "worktree-right",
    })).toEqual({
      sessionId: "session-1",
      leftWorktreeId: "worktree-left",
      rightWorktreeId: "worktree-right",
    });

    for (const malformed of [
      null,
      { sessionId: "session-1", leftWorktreeId: "worktree-left" },
      { sessionId: "session-1", leftWorktreeId: "worktree-left", rightWorktreeId: "../right" },
      { sessionId: "session-1", leftWorktreeId: "worktree-left", rightWorktreeId: "worktree-right", repoRoot: "/forged" },
    ]) {
      expect(() => parseWorktreeComparisonRequest(malformed)).toThrow("Invalid worktree comparison request.");
    }
  });

  it("validates complete variant comparison evidence with a fixed safe error", () => {
    const evidence = {
      comparisonId: "comparison-left-right",
      collectedAt: "2026-07-12T00:00:00.000Z",
      variants: [{
        variantId: "variant-left",
        worktreeId: "worktree-left",
        changeset: {
          evidenceId: "evidence-left",
          changesetId: "changeset-left",
          source: "git",
          status: "available",
          files: ["src/index.ts"],
          diffStat: { added: 1, changed: 0, deleted: 0 },
          patchPreviewTruncated: false,
        },
        metrics: [{
          kind: "diff-summary",
          label: "Diff summary",
          status: "recorded",
          source: "recorded",
          detail: "+1 / -0 across 1 file",
        }],
      }],
    };

    expect(parseVariantComparisonEvidence(evidence)).toEqual(evidence);
    for (const malformed of [
      null,
      { ...evidence, comparisonId: 42 },
      { ...evidence, variants: [{ ...evidence.variants[0], metrics: [{ kind: "forged" }] }] },
      { ...evidence, variants: [{ ...evidence.variants[0], changeset: { status: "available", files: [42] } }] },
    ]) {
      expect(() => parseVariantComparisonEvidence(malformed)).toThrow(INVALID_VARIANT_COMPARISON_EVIDENCE_ERROR);
    }
  });

  it("reconstructs comparison evidence without unknown fields at any nested layer", () => {
    const evidence = {
      comparisonId: "comparison-left-right",
      collectedAt: "2026-07-12T00:00:00.000Z",
      hostPath: "/secret/comparison",
      variants: [{
        variantId: "variant-left",
        worktreeId: "worktree-left",
        repoRoot: "/secret/variant",
        changeset: {
          evidenceId: "evidence-left",
          changesetId: "changeset-left",
          source: "git",
          status: "available",
          files: ["src/index.ts"],
          diffStat: { added: 1, changed: 0, deleted: 0, hostPath: "/secret/stat" },
          patchPreviewTruncated: false,
          repoRoot: "/secret/changeset",
        },
        metrics: [{
          kind: "diff-summary",
          label: "Diff summary",
          status: "recorded",
          source: "recorded",
          detail: "+1 / -0 across 1 file",
          worktreePath: "/secret/metric",
        }],
      }],
    };

    const parsed = parseVariantComparisonEvidence(evidence);

    expect(parsed).toEqual({
      comparisonId: "comparison-left-right",
      collectedAt: "2026-07-12T00:00:00.000Z",
      variants: [{
        variantId: "variant-left",
        worktreeId: "worktree-left",
        changeset: {
          evidenceId: "evidence-left",
          changesetId: "changeset-left",
          source: "git",
          status: "available",
          files: ["src/index.ts"],
          diffStat: { added: 1, changed: 0, deleted: 0 },
          patchPreviewTruncated: false,
        },
        metrics: [{
          kind: "diff-summary",
          label: "Diff summary",
          status: "recorded",
          source: "recorded",
          detail: "+1 / -0 across 1 file",
        }],
      }],
    });
    expect(parsed).not.toBe(evidence);
  });

  it("versions the root contract ABI", () => {
    expect(GIT_WORKTREE_CONTRACT_VERSION).toBe(1);
  });

  it("keeps mock changesets tied to node completion evidence", () => {
    const node = {
      id: "node-1",
      changesetId: "changeset-1",
      worktree: {
        path: "../project.worktrees/node-1",
        branchName: "skyturn/session/node-1",
        baseCommit: "base",
      },
    } as CanvasNode;

    const changeset = createMockChangeset(node);

    expect(changeset.id).toBe("changeset-1");
    expect(changeset.files).toContain(".devflow/tasks/node-1/result.md");
    expect(changeset.patchPreview).toContain("Verification evidence");
  });

  it("returns the node-bound worktree in mock mode", async () => {
    const node = {
      worktree: {
        path: "../project.worktrees/node-1",
        branchName: "skyturn/session/node-1",
        baseCommit: "base",
      },
    } as CanvasNode;

    await expect(mockWorktreeService.createWorktree(node)).resolves.toEqual(node.worktree);
  });

  it("publishes managed worktree, variant adoption, and changeset evidence service contracts", async () => {
    const identity: WorkflowWorktreeIdentity = {
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
    };
    const evidence: ChangesetEvidence = {
      evidenceId: "changeset-evidence-a",
      changesetId: "changeset-a",
      source: "git",
      status: "available",
      files: ["src/index.ts"],
      diffStat: { added: 1, changed: 0, deleted: 0 },
      patchPreviewTruncated: true,
      worktreeId: identity.worktreeId,
    };
    const adoption: WorkflowVariantAdoption = {
      adoptionId: "adopt-a",
      variantId: identity.variantId,
      worktreeId: identity.worktreeId,
      strategy: "merge",
      status: "requested",
      baseCommit: identity.baseCommit,
      headCommit: identity.headCommit,
      targetBranchName: "main",
    };
    const worktrees: ManagedWorktreeService = {
      async createManagedWorktree() {
        return identity;
      },
      async compareVariants() {
        return {
          comparisonId: "comparison-a",
          variants: [{
            variantId: identity.variantId,
            worktreeId: identity.worktreeId,
            changeset: evidence,
            metrics: buildAdjudicationMetrics({ changeset: evidence }),
          }],
          collectedAt: "2026-06-16T00:00:00.000Z",
        };
      },
      async cleanManagedWorktree(input) {
        return { ok: true, worktreeId: input.worktree.worktreeId, cleanedAt: "2026-06-16T00:00:00.000Z" };
      },
    };
    const adopter: VariantAdoptionService = {
      async adoptVariant(input) {
        return { ...input, status: "adopted", adoptedCommit: "789abc" };
      },
    };
    const changesets: ChangesetEvidenceService = {
      async collectChangesetEvidence() {
        return evidence;
      },
    };

    await expect(worktrees.createManagedWorktree({
      sessionId: "session-1",
      variantId: identity.variantId,
      repoRoot: identity.repoRoot,
      baseCommit: identity.baseCommit,
      branchName: identity.branchName,
      parentLaneId: identity.parentLaneId,
    })).resolves.toEqual(identity);
    await expect(adopter.adoptVariant(adoption)).resolves.toMatchObject({ status: "adopted" });
    await expect(changesets.collectChangesetEvidence({ node: { id: "node-1" } as CanvasNode, worktree: identity })).resolves.toEqual(evidence);
  });

  it("builds adjudication metrics only from recorded evidence and marks missing data unknown", () => {
    const recorded: RecordedAdjudicationEvidence = {
      runEvidence: {
        runId: "run-a",
        status: "succeeded",
        exitCode: 0,
        changesetId: "changeset-a",
        checks: [
          { kind: "test", name: "unit", status: "passed", detail: "42 tests" },
          { kind: "typecheck", name: "tsc", status: "failed", detail: "TS error" },
        ],
        artifacts: [".devflow/acceptance/screenshot.png"],
        review: null,
        errorReason: null,
        cancelReason: null,
        completedAt: "2026-06-16T00:00:00.000Z",
      },
      changeset: {
        evidenceId: "changeset-evidence-a",
        changesetId: "changeset-a",
        source: "git",
        status: "available",
        files: ["src/index.ts", "src/index.test.ts"],
        diffStat: { added: 12, changed: 2, deleted: 3 },
        patchPreviewTruncated: false,
      },
    };

    const metrics = buildAdjudicationMetrics(recorded);

    expect(metrics).toContainEqual(expect.objectContaining({ kind: "test", status: "passed", source: "recorded" }));
    expect(metrics).toContainEqual(expect.objectContaining({ kind: "typecheck", status: "failed", detail: "TS error" }));
    expect(metrics).toContainEqual(expect.objectContaining({ kind: "artifact", status: "recorded", artifactPaths: [".devflow/acceptance/screenshot.png"] }));
    expect(metrics).toContainEqual(expect.objectContaining({ kind: "changed-file-count", status: "recorded", value: 2 }));
    expect(metrics).toContainEqual(expect.objectContaining({ kind: "diff-summary", status: "recorded", detail: "+12 / -3 across 2 files" }));
    expect(metrics).toContainEqual(expect.objectContaining({ kind: "build", status: "unknown", source: "recorded" }));
    expect(metrics).toContainEqual(expect.objectContaining({ kind: "performance-output", status: "unknown", source: "recorded" }));
    expect(metrics).not.toEqual(expect.arrayContaining([expect.objectContaining({ detail: expect.stringMatching(/Hermes/i) })]));
  });

  it.each([
    { order: "failed then malformed", validStatus: "failed", malformedFirst: false },
    { order: "malformed then failed", validStatus: "failed", malformedFirst: true },
    { order: "passed then malformed", validStatus: "passed", malformedFirst: false },
    { order: "malformed then passed", validStatus: "passed", malformedFirst: true },
  ] as const)("fails closed for $order RunEvidence without publishing changeset artifacts", ({ validStatus, malformedFirst }) => {
    const validCheck = {
      kind: "artifact" as const,
      name: "Expected artifacts",
      status: validStatus,
      detail: "private-check-detail token=artifact-secret path=/Users/alice/private/result.png",
    };
    const malformedCheck = {
      kind: "unknown",
      name: "malformed-extra-check /Users/alice/private/check",
      status: "passed",
    };
    const recorded = {
      runEvidence: {
        runId: "run-malformed",
        status: "succeeded",
        exitCode: 0,
        changesetId: "changeset-malformed",
        checks: malformedFirst ? [malformedCheck, validCheck] : [validCheck, malformedCheck],
        artifacts: [".devflow/acceptance/run-evidence.png"],
        review: null,
        errorReason: null,
        cancelReason: null,
        completedAt: "2026-06-16T00:00:00.000Z",
      } as never,
      changeset: {
        evidenceId: "changeset-evidence-malformed",
        changesetId: "changeset-malformed",
        source: "git" as const,
        status: "available" as const,
        files: ["src/index.ts"],
        diffStat: { added: 1, changed: 1, deleted: 0 },
        artifactPaths: [".devflow/acceptance/changeset-only.png"],
        patchPreviewTruncated: false,
      },
    };
    const before = structuredClone(recorded);

    const metrics = buildAdjudicationMetrics(recorded);

    expect(recorded).toEqual(before);
    expect(metrics.filter((metric) => metric.kind === "artifact")).toEqual([{
      kind: "artifact",
      label: "Artifact",
      status: "failed",
      source: "recorded",
      detail: "Run evidence is invalid.",
    }]);
    expect(metrics).toContainEqual(expect.objectContaining({ kind: "test", status: "unknown" }));
    expect(JSON.stringify(metrics)).not.toMatch(
      /run-evidence\.png|changeset-only\.png|malformed-extra-check|private-check-detail|artifact-secret|alice/,
    );
  });

  it("preserves provenance-safe artifact metrics when no RunEvidence was supplied", () => {
    const metrics = buildAdjudicationMetrics({
      changeset: {
        evidenceId: "changeset-evidence-no-run",
        changesetId: "changeset-no-run",
        source: "git",
        status: "available",
        files: ["src/index.ts"],
        diffStat: { added: 1, changed: 1, deleted: 0 },
        artifactPaths: [".devflow/acceptance/changeset-only.png"],
        patchPreviewTruncated: false,
      },
    });

    expect(metrics).toContainEqual(expect.objectContaining({
      kind: "artifact",
      status: "recorded",
      artifactPaths: [".devflow/acceptance/changeset-only.png"],
    }));
  });

  it.each([
    { checkOrder: "passed+failed", failedFirst: false, withChangesetArtifact: false },
    { checkOrder: "passed+failed", failedFirst: false, withChangesetArtifact: true },
    { checkOrder: "failed+passed", failedFirst: true, withChangesetArtifact: false },
    { checkOrder: "failed+passed", failedFirst: true, withChangesetArtifact: true },
  ])(
    "makes artifact failure dominate $checkOrder checks with changeset artifacts=$withChangesetArtifact",
    ({ failedFirst, withChangesetArtifact }) => {
      const passedCheck = {
        kind: "artifact" as const,
        name: "Expected artifact",
        status: "passed" as const,
        detail: "verified .devflow/acceptance/success.png",
      };
      const failedCheck = {
        kind: "artifact" as const,
        name: "Expected artifact",
        status: "failed" as const,
        detail: "raw-failure-detail token=artifact-secret path=/Users/alice/private/result.png",
      };
      const metrics = buildAdjudicationMetrics({
        runEvidence: {
          runId: "run-artifact-failed",
          status: "succeeded",
          exitCode: 0,
          changesetId: withChangesetArtifact ? "changeset-artifact-failed" : null,
          checks: failedFirst ? [failedCheck, passedCheck] : [passedCheck, failedCheck],
          artifacts: [".devflow/acceptance/success.png"],
          review: null,
          errorReason: null,
          cancelReason: null,
          completedAt: "2026-06-16T00:00:00.000Z",
        },
        ...(withChangesetArtifact
          ? {
              changeset: {
                evidenceId: "changeset-evidence-artifact-failed",
                changesetId: "changeset-artifact-failed",
                source: "git" as const,
                status: "available" as const,
                files: ["src/index.ts"],
                diffStat: { added: 1, changed: 1, deleted: 0 },
                artifactPaths: [".devflow/acceptance/unrelated.png"],
                patchPreviewTruncated: false,
              },
            }
          : {}),
      });

      const artifactMetrics = metrics.filter((metric) => metric.kind === "artifact");
      expect(artifactMetrics).toEqual([
        expect.objectContaining({
          kind: "artifact",
          status: "failed",
          source: "recorded",
          detail: "1 artifact check failed.",
        }),
      ]);
      expect(artifactMetrics[0]).not.toHaveProperty("artifactPaths");
      expect(artifactMetrics).not.toContainEqual(expect.objectContaining({ status: "recorded" }));
      expect(JSON.stringify(artifactMetrics)).not.toMatch(
        /success\.png|unrelated\.png|raw-failure-detail|artifact-secret|alice/,
      );
    },
  );

  it("bounds recorded adjudication details instead of forwarding raw output", () => {
    const longDetail = "x".repeat(5000);
    const metrics = buildAdjudicationMetrics({
      runEvidence: {
        runId: "run-a",
        status: "succeeded",
        exitCode: 0,
        changesetId: "changeset-a",
        checks: [{ kind: "test", name: "unit", status: "passed", detail: longDetail }],
        artifacts: [],
        review: null,
        errorReason: null,
        cancelReason: null,
        completedAt: "2026-06-16T00:00:00.000Z",
      },
      performanceOutput: longDetail,
      conflictCheck: { kind: "review", name: "conflict", status: "failed", detail: longDetail },
    });

    for (const metric of metrics.filter((item) => item.detail)) {
      expect(metric.detail?.length).toBeLessThanOrEqual(1003);
    }
    expect(metrics).toContainEqual(expect.objectContaining({
      kind: "performance-output",
      detail: `${"x".repeat(1000)}...`,
    }));
  });
});
