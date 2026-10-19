import { describe, expect, it } from "vitest";
import { parseGoalReviewRequest } from "./index.js";

describe("strict original-goal review requests", () => {
  const request = { requestId: "request-1", sessionId: "session-1", nodeId: "node-1", sourceRunId: "run-1" };
  it("accepts only bounded canonical identity fields", () => {
    expect(parseGoalReviewRequest(request)).toEqual(request);
    for (const value of [null, [], {}, { ...request, requestId: "x".repeat(257) }, { ...request, nodeId: "node-1 " },
      { ...request, originalGoal: "forged" }, { ...request, sandbox: "danger-full-access" }, { ...request, report: "accepted" }]) {
      expect(() => parseGoalReviewRequest(value)).toThrow();
    }
  });
});
