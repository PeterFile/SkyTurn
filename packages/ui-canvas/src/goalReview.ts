import type { GoalReviewRequest } from "@skyturn/project-core";

/** Keep unknown outcomes idempotent across close/reopen; new acknowledged clicks get a new ID. */
export function createGoalReviewSubmitter() {
  const attempts = new Map<string, { requestId: string; busy: boolean }>();
  return async <T>(options: {
    scope: string;
    input: Omit<GoalReviewRequest, "requestId">;
    createRequestId(): string;
    submit(request: GoalReviewRequest): Promise<T>;
    isCurrent(): boolean;
    apply(result: T): void;
  }): Promise<void> => {
    if (!options.isCurrent() || attempts.get(options.scope)?.busy) return;
    const attempt = attempts.get(options.scope) ?? { requestId: options.createRequestId(), busy: false };
    attempts.set(options.scope, attempt);
    attempt.busy = true;
    try {
      const result = await options.submit({ ...options.input, requestId: attempt.requestId });
      attempts.delete(options.scope);
      if (options.isCurrent()) options.apply(result);
    } finally { attempt.busy = false; }
  };
}
