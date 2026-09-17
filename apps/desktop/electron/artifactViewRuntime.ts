import { constants } from "node:fs";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import type { ArtifactViewContent, ArtifactViewErrorCode, ArtifactViewRequest, ArtifactViewResult } from "@skyturn/persistence" with { "resolution-mode": "import" };
import type { WorkflowWorktreeIdentity } from "@skyturn/project-core" with { "resolution-mode": "import" };
import { selectWorkflowCheckpointActionPair } from "./workflowCheckpointRuntime";

interface ArtifactViewStore {
  materializeFlowProjection(sessionId: string): unknown;
  listNodeCheckpoints(input: { sessionId: string; laneId?: string; runId?: string; phase?: "before" | "after" }): unknown[];
}

interface ArtifactViewDependencies {
  openedProjectRoots: ReadonlySet<string>;
  canonicalizeProjectRoot(root: string): Promise<string>;
  getStore(root: string): Promise<ArtifactViewStore>;
  /** Authoritative app-private claim and RunEvents; never a project-local mirror. */
  readRunAuthority(root: string, runId: string): Promise<{ claim: unknown; events: unknown[] }>;
}

const messages: Record<ArtifactViewErrorCode, string> = {
  INVALID_INPUT: "Artifact request or registered path is invalid.",
  UNKNOWN_PROJECT: "Artifact project is not open or its identity changed.",
  SCOPE_MISMATCH: "Artifact session, node and run do not match.",
  EVIDENCE_UNAVAILABLE: "Matching persisted terminal RunEvidence is unavailable.",
  UNREGISTERED_ARTIFACT: "Artifact is not registered in terminal RunEvidence.",
  BINDING_UNAVAILABLE: "Exact run checkpoint binding is unavailable.",
  STALE_ARTIFACT: "Artifact run or worktree is no longer current.",
  OUTSIDE_ROOT: "Artifact worktree is outside the authorized project scope.",
  UNAVAILABLE: "Safe artifact reading is unavailable on this platform or the helper failed.",
  MISSING: "Registered artifact file is missing.",
  UNSAFE_FILE: "Artifact is a symlink, hardlink, special file, or otherwise unsafe.",
  OVERSIZE: "Artifact exceeds the content or image dimension limit.",
  CHANGED: "Artifact changed during reading. Retry after writes stop.",
  UNSUPPORTED_CONTENT: "Artifact format or content is unsupported.",
  UNSAFE_CONTENT: "Artifact text contains sensitive or unsafe content.",
};
class ArtifactViewError extends Error {
  constructor(readonly code: ArtifactViewErrorCode) { super(messages[code]); }
}
function reject(code: ArtifactViewErrorCode): never { throw new ArtifactViewError(code); }
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function records(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) && value.every(record) ? value : [];
}

export function createArtifactViewRuntime(deps: ArtifactViewDependencies) {
  async function projectRoot(input: ArtifactViewRequest): Promise<string> {
    if (!deps.openedProjectRoots.has(input.projectRoot)) reject("UNKNOWN_PROJECT");
    try { return await deps.canonicalizeProjectRoot(input.projectRoot); } catch { return reject("UNKNOWN_PROJECT"); }
  }

  async function authorize(input: ArtifactViewRequest) {
    const root = await projectRoot(input);
    const core = await import("@skyturn/project-core");
    const store = await deps.getStore(root);
    const projection = store.materializeFlowProjection(input.sessionId);
    if (!record(projection) || projection.sessionId !== input.sessionId) reject("SCOPE_MISMATCH");
    const lanes = records(projection.lanes).filter((lane) => lane.id === input.nodeId);
    if (lanes.length !== 1 || lanes[0]!.executable !== true) reject("SCOPE_MISMATCH");
    if (lanes[0]!.rollbackStatus || (record(projection.laneRollbackStatuses) && projection.laneRollbackStatuses[input.nodeId])) reject("STALE_ARTIFACT");
    const allSegments = records(projection.segments);
    if (allSegments.filter((segment) => segment.runId === input.runId).length !== 1) reject("SCOPE_MISMATCH");
    const segments = allSegments.filter((segment) => segment.laneId === input.nodeId);
    const matching = segments.filter((segment) => segment.runId === input.runId);
    if (matching.length !== 1) reject("SCOPE_MISMATCH");
    const segment = matching[0]!;
    if (segments.at(-1) !== segment) reject("STALE_ARTIFACT");
    const evidenceRows = records(projection.evidence).filter((item) => item.laneId === input.nodeId && item.segmentId === segment.id && item.runEvidence !== undefined);
    if (evidenceRows.length !== 1) reject("EVIDENCE_UNAVAILABLE");
    const evidence = core.parseRunEvidence(evidenceRows[0]!.runEvidence);
    if (!evidence || evidence.runId !== input.runId || !core.isTerminalAgentRunStatus(evidence.status) ||
      !evidence.completedAt || evidence.status !== segment.status) reject("EVIDENCE_UNAVAILABLE");
    const { claim, events } = await deps.readRunAuthority(root, input.runId);
    if (!record(claim)) reject("EVIDENCE_UNAVAILABLE");
    if (claim.runId !== input.runId || claim.sessionId !== input.sessionId || claim.nodeId !== input.nodeId || claim.agentKind !== lanes[0]!.agentKind) reject("SCOPE_MISMATCH");
    const parsedEvents = events.map(core.parseRunEvent);
    if (parsedEvents.some((event, index) => !event || event.runId !== input.runId || event.seq !== index + 1)) reject("EVIDENCE_UNAVAILABLE");
    const privateEvidence = core.deriveRunEvidenceFromRunEvents({ runId: input.runId, events: parsedEvents as NonNullable<typeof parsedEvents[number]>[] });
    if (!privateEvidence || JSON.stringify(evidence) !== JSON.stringify(privateEvidence)) reject("EVIDENCE_UNAVAILABLE");
    if (!evidence.artifacts.includes(input.artifactPath)) reject("UNREGISTERED_ARTIFACT");
    let pair;
    try {
      const checkpoints = records(store.listNodeCheckpoints({ sessionId: input.sessionId, laneId: input.nodeId, runId: input.runId, phase: "after" }))
        .filter((item) => item.phase === "after" && item.runId === input.runId && item.segmentId === segment.id);
      if (checkpoints.length !== 1 || typeof checkpoints[0]!.id !== "string") reject("BINDING_UNAVAILABLE");
      pair = selectWorkflowCheckpointActionPair(store, { action: "repair", sessionId: input.sessionId, nodeId: input.nodeId, laneId: input.nodeId, checkpointId: checkpoints[0]!.id });
    } catch { return reject("BINDING_UNAVAILABLE"); }
    const checkpoint = pair.afterCheckpoint;
    if (checkpoint.sessionId !== input.sessionId || checkpoint.runId !== input.runId || checkpoint.segmentId !== segment.id) reject("BINDING_UNAVAILABLE");
    let managed: WorkflowWorktreeIdentity | undefined;
    if (checkpoint.executionTarget === "current_branch") {
      if (checkpoint.worktreeId || checkpoint.worktreePath !== root) reject("OUTSIDE_ROOT");
    } else {
      const matches = records(projection.worktrees).filter((item) => item.worktreeId === checkpoint.worktreeId);
      if (matches.length !== 1) reject("BINDING_UNAVAILABLE");
      const identity = matches[0]!;
      if (identity.repoRoot !== root || identity.path !== checkpoint.worktreePath || identity.realPath !== checkpoint.worktreePath ||
        identity.branchName !== checkpoint.branchName || !inside(`${root}.worktrees`, checkpoint.worktreePath)) reject("OUTSIDE_ROOT");
      if (records(projection.events).some((event) => event.kind === "workflow.worktree.cleaned" && record(event.payload) &&
        [event.payload.result, event.payload.worktree].some((value) => record(value) && value.worktreeId === checkpoint.worktreeId))) reject("STALE_ARTIFACT");
      managed = identity as unknown as WorkflowWorktreeIdentity;
    }
    const worktreePath = checkpoint.worktreePath;
    const directory = await lstat(worktreePath, { bigint: true });
    if (!directory.isDirectory() || await realpath(worktreePath) !== worktreePath) reject("UNSAFE_FILE");
    const backend = await import("@skyturn/git-worktree/node");
    try {
      await backend.verifyWorkflowGitAncestryProof(checkpoint.ancestryProof, {
        repositoryPath: root, worktreePath, beforeHeadCommit: pair.beforeCheckpoint.headCommit, afterHeadCommit: checkpoint.headCommit,
      });
      if (managed) await new backend.NodeGitWorktreeService().reconcileManagedWorktree(managed, { expectedHeadCommit: checkpoint.headCommit });
      const current = await backend.getGitCheckpointSnapshot(worktreePath);
      if (current.branchName !== checkpoint.branchName || current.headCommit !== checkpoint.headCommit) reject("STALE_ARTIFACT");
    } catch { return reject("STALE_ARTIFACT"); }
    if (await projectRoot(input) !== root) reject("UNKNOWN_PROJECT");
    return { root, store, worktreePath, directory, evidence,
      binding: JSON.stringify({ segment, evidence, pair, managed }) };
  }

  return {
    async read(value: unknown): Promise<ArtifactViewResult> {
      try {
        const core = await import("@skyturn/project-core");
        if (!record(value) || Object.keys(value).length !== 5 ||
          !["projectRoot", "sessionId", "nodeId", "runId", "artifactPath"].every((key) =>
            typeof value[key] === "string" && value[key].length > 0 && value[key].length <= (key === "projectRoot" || key === "artifactPath" ? 4096 : 256) &&
            value[key].trim() === value[key] && !/[\x00-\x1f\x7f]/.test(value[key])) ||
          !path.isAbsolute(value.projectRoot as string) || !core.parseExpectedArtifactDeclaration(value.artifactPath)) reject("INVALID_INPUT");
        const input = value as unknown as ArtifactViewRequest;
        if (process.platform === "win32") { await projectRoot(input); reject("UNAVAILABLE"); }
        const initial = await authorize(input);
        const extension = path.extname(input.artifactPath).slice(1).toLowerCase();
        const type = extension === "jpg" ? "jpeg" : extension;
        if (type !== "png" && type !== "jpeg" && type !== "txt" && type !== "md" && type !== "json") reject("UNSUPPORTED_CONTENT");
        const image = type === "png" || type === "jpeg";
        const handle = await open(initial.worktreePath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try {
          const opened = await handle.stat({ bigint: true });
          if (!opened.isDirectory() || opened.dev !== initial.directory.dev || opened.ino !== initial.directory.ino) reject("STALE_ARTIFACT");
          const { readBoundedFile } = await import("@skyturn/agent-bridge/bounded-file-reader");
          const result = await readBoundedFile({ rootFd: handle.fd, relativePath: input.artifactPath, maxBytes: image ? 8 * 1024 * 1024 : 256 * 1024 });
          if (!result.ok) reject(result.code);
          const content = image ? imageContent(result.bytes, type) : textContent(result.bytes, type, core.sanitizePublicPayloadText);
          const current = await authorize(input);
          if (current.root !== initial.root || current.store !== initial.store || current.binding !== initial.binding ||
            current.directory.dev !== opened.dev || current.directory.ino !== opened.ino) reject("STALE_ARTIFACT");
          return { protocolVersion: 1, ok: true, artifact: {
            artifactPath: input.artifactPath, name: path.posix.basename(input.artifactPath), type,
            runId: input.runId, status: initial.evidence.status as "succeeded" | "failed" | "cancelled" | "timed-out", byteLength: result.bytes.length,
          }, contentIdentity: "current-file-unhashed", content };
        } finally { await handle.close(); }
      } catch (error) {
        const code = error instanceof ArtifactViewError ? error.code : "EVIDENCE_UNAVAILABLE";
        return { protocolVersion: 1, ok: false, code, message: messages[code] };
      }
    },
  };
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function textContent(bytes: Buffer, type: string, sanitize: (text: string) => string): ArtifactViewContent {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); } catch { return reject("UNSUPPORTED_CONTENT"); }
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text)) reject("UNSUPPORTED_CONTENT");
  if (sanitize(text) !== text || /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text)) reject("UNSAFE_CONTENT");
  if (type === "json") {
    let decoded: string;
    try { decoded = JSON.stringify(JSON.parse(text)); } catch { return reject("UNSUPPORTED_CONTENT"); }
    if (sanitize(decoded) !== decoded) reject("UNSAFE_CONTENT");
  }
  return { encoding: "utf8", mimeType: "text/plain", text };
}

function imageContent(bytes: Buffer, type: "png" | "jpeg"): ArtifactViewContent {
  let width = 0, height = 0;
  if (type === "png") {
    if (bytes.length < 45 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" ||
      bytes.readUInt32BE(8) !== 13 || bytes.toString("latin1", 12, 16) !== "IHDR") reject("UNSUPPORTED_CONTENT");
    width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20);
    let offset = 8, dataSeen = false, ended = false;
    while (offset + 12 <= bytes.length) {
      const size = bytes.readUInt32BE(offset), kind = bytes.toString("latin1", offset + 4, offset + 8);
      if (offset + size + 12 > bytes.length || kind === "acTL" || (kind === "IHDR" && offset !== 8)) reject("UNSUPPORTED_CONTENT");
      if (kind === "IDAT") dataSeen = true;
      offset += size + 12;
      if (kind === "IEND") { ended = size === 0 && offset === bytes.length; break; }
    }
    if (!dataSeen || !ended) reject("UNSUPPORTED_CONTENT");
  } else {
    if (bytes.length < 4 || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) reject("UNSUPPORTED_CONTENT");
    let offset = 2, scanSeen = false;
    while (offset + 4 <= bytes.length) {
      if (bytes[offset++] !== 0xff) reject("UNSUPPORTED_CONTENT");
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++]!;
      if (offset + 2 > bytes.length) reject("UNSUPPORTED_CONTENT");
      const size = bytes.readUInt16BE(offset);
      if (size < 2 || offset + size > bytes.length) reject("UNSUPPORTED_CONTENT");
      if (marker === 0xda) {
        scanSeen = size >= 6 && offset + size < bytes.length - 2;
        break;
      }
      if (marker === 0xc0 || marker === 0xc2) {
        if (width || size < 8) reject("UNSUPPORTED_CONTENT");
        height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5);
      }
      offset += size;
    }
    if (!scanSeen) reject("UNSUPPORTED_CONTENT");
  }
  if (!width || !height) reject("UNSUPPORTED_CONTENT");
  if (width > 8192 || height > 8192 || width * height > 16_000_000) reject("OVERSIZE");
  return { encoding: "base64", mimeType: type === "png" ? "image/png" : "image/jpeg", base64: bytes.toString("base64"), width, height };
}
