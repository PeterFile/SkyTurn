interface RunCheckpointRecord {
  segmentId: string;
  headCommit: string;
}

interface RunCheckpointStore {
  listNodeCheckpoints(input: {
    sessionId: string;
    laneId: string;
    runId: string;
    phase: "before";
  }): unknown[];
}

interface CurrentBranchRunBaselineInput {
  sessionId: string;
  laneId: string;
  segmentId: string;
  runId: string;
  phase: "before" | "after";
  headCommit: string;
}

export function resolveCurrentBranchRunBaseline(
  store: RunCheckpointStore,
  input: CurrentBranchRunBaselineInput,
): string {
  if (input.phase === "before") return fullCommit(input.headCommit);
  const before = store.listNodeCheckpoints({
    sessionId: input.sessionId,
    laneId: input.laneId,
    runId: input.runId,
    phase: "before",
  }).find((checkpoint): checkpoint is RunCheckpointRecord =>
    isRecord(checkpoint) &&
    checkpoint.segmentId === input.segmentId &&
    typeof checkpoint.headCommit === "string"
  );
  if (!before) throw new Error("After run changeset requires the matching before checkpoint.");
  return fullCommit(before.headCommit);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fullCommit(value: string): string {
  if (!/^[0-9a-f]{40}$/i.test(value)) throw new Error("Run changeset baseline requires a full commit SHA.");
  return value.toLowerCase();
}
