import { describe, expect, it } from "vitest";
import * as submissions from "./goalReview.js";

describe("explicit original-goal submission", () => {
  it("does nothing until invoked, suppresses duplicates and ignores closed or navigated responses", async () => {
    expect(typeof submissions.createGoalReviewSubmitter).toBe("function");
    const submitter = submissions.createGoalReviewSubmitter();
    let calls = 0, applied = 0, current = true;
    let resolve!: (value: unknown) => void;
    const response = new Promise(done => { resolve = done; });
    const input = { sessionId: "session", nodeId: "source", sourceRunId: "run" };
    const options = { scope: "project:session:source:run", input, createRequestId: () => "request",
      submit: async () => { calls++; return response; }, isCurrent: () => current, apply: () => { applied++; } };
    expect(calls).toBe(0);
    const first = submitter(options);
    await submitter(options);
    expect(calls).toBe(1);
    current = false;
    resolve({ canvasSession: {} });
    await first;
    expect(applied).toBe(0);
  });
});


it("reuses an unknown request outcome and assigns a fresh ID after acknowledgement", async () => {
  const submitter = submissions.createGoalReviewSubmitter();
  const sent: string[] = [];
  let counter = 0;
  const options = { scope: "scope", input: { sessionId: "session", nodeId: "node", sourceRunId: "source" },
    createRequestId: () => `request-${++counter}`, isCurrent: () => true, apply: () => undefined,
    submit: async (request: { requestId: string }) => { sent.push(request.requestId); if (sent.length === 1) throw new Error("Outcome unknown"); return {}; } };
  await expect(submitter(options)).rejects.toThrow("Outcome unknown");
  await submitter(options);
  await submitter(options);
  expect(sent).toEqual(["request-1", "request-1", "request-2"]);
});
