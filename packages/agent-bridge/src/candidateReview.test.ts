import { createHash } from "node:crypto";

import {
  canonicalCandidateReviewRequestJson,
  type CandidateReviewDecision,
  type CandidateReviewRequest,
} from "@skyturn/project-core";
import { describe, expect, it, vi } from "vitest";

import {
  CANDIDATE_REVIEW_REJECTED_MESSAGE,
  reviewCandidateWithHermes,
  type HermesCandidateVerifier,
} from "./candidateReview.js";

function request(): CandidateReviewRequest {
  const patch = Buffer.from([0, 0xff, 0x41, 0x0a]);
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
      sha256: createHash("sha256").update(patch).digest("hex"),
      byteLength: patch.byteLength,
      base64: patch.toString("base64"),
    },
  };
}

function requestSha256(value: CandidateReviewRequest): string {
  return createHash("sha256")
    .update(canonicalCandidateReviewRequestJson(value), "utf8")
    .digest("hex");
}

function decision(
  value: CandidateReviewRequest,
  overrides: Partial<CandidateReviewDecision> = {},
): CandidateReviewDecision {
  return {
    version: 1,
    requestSha256: requestSha256(value),
    manifestSha256: value.manifestSha256,
    disposition: "allow",
    ...overrides,
  };
}

function verifierReturning(response: string): {
  calls: Array<{ prompt: string; timeoutMs: number }>;
  verifier: HermesCandidateVerifier;
} {
  const calls: Array<{ prompt: string; timeoutMs: number }> = [];
  return {
    calls,
    verifier: async (input) => {
      calls.push(input);
      return response;
    },
  };
}

describe("reviewCandidateWithHermes", () => {
  it("accepts only a digest-bound decision from the internal verifier", async () => {
    const candidate = request();
    const { calls, verifier } = verifierReturning(JSON.stringify(decision(candidate)));

    await expect(reviewCandidateWithHermes({ request: candidate }, { runVerifier: verifier }))
      .resolves.toEqual(decision(candidate));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.timeoutMs).toBe(30_000);
    expect(calls[0]?.prompt).toContain(candidate.patch.base64);
    expect(calls[0]?.prompt).toContain("UNTRUSTED");
    expect(calls[0]?.prompt).not.toContain(Buffer.from(candidate.patch.base64, "base64").toString("utf8"));
    expect(calls[0]?.prompt).not.toContain("toolAccess");
  });

  it("passes one validated end-to-end timeout to the managed verifier", async () => {
    const candidate = request();
    const { calls, verifier } = verifierReturning(JSON.stringify(decision(candidate)));

    await reviewCandidateWithHermes({ request: candidate, timeoutMs: 17 }, { runVerifier: verifier });

    expect(calls[0]?.timeoutMs).toBe(17);
  });

  it.each([
    ["block", (candidate: CandidateReviewRequest) => JSON.stringify(decision(candidate, { disposition: "block" }))],
    ["malformed", () => "not json"],
    ["fenced", () => "```json\n{}\n```"],
    ["wrong request digest", (candidate: CandidateReviewRequest) => JSON.stringify(decision(candidate, { requestSha256: "8".repeat(64) }))],
    ["wrong manifest digest", (candidate: CandidateReviewRequest) => JSON.stringify(decision(candidate, { manifestSha256: "9".repeat(64) }))],
  ])("rejects %s verifier output", async (_label, output) => {
    const candidate = request();
    const { verifier } = verifierReturning(output(candidate));

    await expect(reviewCandidateWithHermes({ request: candidate }, { runVerifier: verifier }))
      .rejects.toThrow(CANDIDATE_REVIEW_REJECTED_MESSAGE);
  });

  it("rejects verifier failure with the fixed public error", async () => {
    const verifier: HermesCandidateVerifier = async () => {
      throw new Error("private runtime path");
    };

    await expect(reviewCandidateWithHermes({ request: request() }, { runVerifier: verifier }))
      .rejects.toThrow(CANDIDATE_REVIEW_REJECTED_MESSAGE);
  });

  it("rejects a patch digest mismatch before launching Hermes", async () => {
    const candidate = request();
    const tamperedPatch = Buffer.from(candidate.patch.base64, "base64");
    tamperedPatch[0] = tamperedPatch[0]! ^ 1;
    const verifier = vi.fn<HermesCandidateVerifier>();

    await expect(reviewCandidateWithHermes({
      request: {
        ...candidate,
        patch: { ...candidate.patch, base64: tamperedPatch.toString("base64") },
      },
    }, { runVerifier: verifier })).rejects.toThrow(CANDIDATE_REVIEW_REJECTED_MESSAGE);
    expect(verifier).not.toHaveBeenCalled();
  });
});
