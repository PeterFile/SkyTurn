import { Fragment, memo, useLayoutEffect, useReducer, useRef, useState } from "react";
import type { CanvasSession, CanvasNode, RunEvidence } from "@skyturn/project-core";
import type { ArtifactViewResult } from "@skyturn/persistence";
import { Eye, X, AlertTriangle } from "lucide-react";

export interface RunArtifactsProps {
  projectRoot: string;
  session: CanvasSession;
  node: CanvasNode;
  runEvidence?: RunEvidence | null;
  onDraftRepair?: (request: ArtifactRepairDraftRequest) => Promise<void>;
  isCurrent?: () => boolean;
}

export interface ArtifactRepairDraftRequest {
  artifactPath: string;
  feedback: string;
  append: boolean;
  isCurrent: () => boolean;
}

function getArtifactType(path: string) {
  const lower = path.toLowerCase();
  if (lower.endsWith(".png")) return "png";
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "jpeg";
  if (lower.endsWith(".txt")) return "txt";
  if (lower.endsWith(".md")) return "md";
  if (lower.endsWith(".json")) return "json";
  return "unknown";
}

export const RunArtifacts = memo(function RunArtifacts({
  projectRoot,
  session,
  node,
  runEvidence,
  onDraftRepair,
  isCurrent,
}: RunArtifactsProps) {
  const artifacts = runEvidence?.artifacts ?? [];
  const runId = runEvidence?.runId === node.runId ? runEvidence?.runId : undefined;

  const [active, setActive] = useState<{ scopeId: string; path: string } | null>(null);

  const scopeId = JSON.stringify([projectRoot, session.id, node.id, runId]);
  const activePath = active?.scopeId === scopeId ? active.path : null;

  if (!artifacts.length || !runId) {
    return (
      <Fragment>
        <dt>Registered artifacts</dt>
        <dd className="run-artifacts empty">No registered artifacts</dd>
      </Fragment>
    );
  }

  return (
    <Fragment>
      <dt>Registered artifacts</dt>
      <dd className="run-artifacts">
        <ul className="artifacts-list">
          {artifacts.map(path => (
            <li key={path} className="artifact-item">
              <div className="artifact-item-header">
                <div className="artifact-name-row">
                  <span className="artifact-name">{path}</span>
                  <div className="artifact-meta-preview">
                    <span className="meta-badge">Type: {getArtifactType(path)}</span>
                    <span className="meta-badge">Run: {runId}</span>
                  </div>
                </div>
                <button
                  className="icon-button"
                  onClick={() => setActive(activePath === path ? null : { scopeId, path })}
                  aria-label={activePath === path ? "Close" : "View"}
                >
                  {activePath === path ? <X size={14}/> : <Eye size={14}/>}
                  {activePath === path ? "Close" : "View"}
                </button>
              </div>
              {activePath === path && (
                <ArtifactView
                  key={`${scopeId}:${path}`}
                  projectRoot={projectRoot}
                  sessionId={session.id}
                  nodeId={node.id}
                  runId={runId}
                  artifactPath={path}
                  onDraftRepair={onDraftRepair}
                  isCurrent={isCurrent}
                />
              )}
            </li>
          ))}
        </ul>
      </dd>
    </Fragment>
  );
});

export interface ArtifactViewProps {
  projectRoot: string;
  sessionId: string;
  nodeId: string;
  runId: string;
  artifactPath: string;
  onDraftRepair?: (request: ArtifactRepairDraftRequest) => Promise<void>;
  isCurrent?: () => boolean;
}

export type ArtifactViewState = {
  result: ArtifactViewResult | null;
  loading: boolean;
  imageError: boolean;
  imageLoaded: boolean;
  feedback: string;
  append: boolean;
  drafting: boolean;
  draftError: string | null;
};

const viewScope = (props: ArtifactViewProps) => JSON.stringify([
  props.projectRoot, props.sessionId, props.nodeId, props.runId, props.artifactPath,
]);

export function createArtifactViewController(read: () => ArtifactViewProps, changed: () => void) {
  let state: ArtifactViewState = { result: null, loading: true, imageError: false, imageLoaded: false, feedback: "", append: false, drafting: false, draftError: null };
  let mountToken = 0;
  let mountedScope: string | null = null;
  let requestRevision = 0;
  const scopeCurrent = (token: number, scope: string) => token === mountToken && mountedScope === scope &&
    viewScope(read()) === scope && read().isCurrent?.() !== false;
  const previewReady = () => state.result?.ok === true && !state.imageError &&
    (state.result.content.mimeType === "text/plain" || state.imageLoaded);
  const invalidatedMessage = () => state.imageError
    ? "Image decode failed. Feedback retained; reopen the preview before retrying Draft Repair."
    : "Feedback or append consent changed. Review the current feedback and retry Draft Repair.";
  function setImageError(value: boolean) {
    if (state.imageError !== value) {
      requestRevision++;
      state = { ...state, imageError: value, imageLoaded: false };
      changed();
    }
  }

  return {
    get state() { return state; },
    get canDraftRepair() { return previewReady() && !state.drafting && !!state.feedback.trim(); },
    setFeedback(feedback: string) { requestRevision++; state = { ...state, feedback }; changed(); },
    setAppend(append: boolean) { requestRevision++; state = { ...state, append }; changed(); },
    async draftRepair() {
      const props = read();
      const token = mountToken;
      const scope = viewScope(props);
      const result = state.result;
      if (!scopeCurrent(token, scope) || state.drafting) return;
      if (!result?.ok || result.artifact.runId !== props.runId || result.artifact.artifactPath !== props.artifactPath) {
        state = { ...state, draftError: "Read and verify this registered artifact before drafting Repair." }; changed(); return;
      }
      if (state.imageError) {
        state = { ...state, draftError: invalidatedMessage() }; changed(); return;
      }
      if (!props.onDraftRepair || !state.feedback.trim()) {
        state = { ...state, draftError: props.onDraftRepair ? "Enter artifact feedback first." : "Repair draft preparation is unavailable." }; changed(); return;
      }
      if (!previewReady()) {
        state = { ...state, draftError: "Wait for the image preview to load successfully before drafting Repair." }; changed(); return;
      }
      const revision = requestRevision;
      const feedback = state.feedback;
      const isScopeCurrent = () => scopeCurrent(token, scope);
      const isCurrent = () => isScopeCurrent() && revision === requestRevision && previewReady();
      state = { ...state, drafting: true, draftError: null }; changed();
      try {
        await props.onDraftRepair({ artifactPath: props.artifactPath, feedback, append: state.append, isCurrent });
        if (!isScopeCurrent()) return;
        state = isCurrent() ? { ...state, feedback: "" } : { ...state, draftError: invalidatedMessage() };
      } catch (error) {
        if (isScopeCurrent()) state = { ...state, draftError: !isCurrent() ? invalidatedMessage()
          : error instanceof Error ? error.message : "Repair draft preparation failed." };
      } finally {
        if (isScopeCurrent()) { state = { ...state, drafting: false }; changed(); }
      }
    },
    setImageError,
    imageEvents() {
      const token = mountToken;
      const scope = viewScope(read());
      const result = state.result;
      const isCurrent = () => scopeCurrent(token, scope) && result === state.result &&
        result?.ok === true && result.content.mimeType !== "text/plain";
      return {
        onLoad() {
          if (!isCurrent() || state.imageError || state.imageLoaded) return;
          requestRevision++;
          state = { ...state, imageLoaded: true }; changed();
        },
        onError() { if (isCurrent()) setImageError(true); },
      };
    },
    mount() {
      const currentToken = ++mountToken;
      const scope = viewScope(read());
      mountedScope = scope;
      state = { ...state, result: null, loading: true, imageError: false, imageLoaded: false, drafting: false, draftError: null };
      changed();

      if (!window.devflow?.artifacts?.read) {
        state = {
          ...state,
          result: {
            protocolVersion: 1,
            ok: false,
            code: "UNAVAILABLE",
            message: "Artifacts API is not available"
          },
          loading: false,
          imageError: false,
        };
        changed();
        return () => { if (mountToken === currentToken) { mountToken++; mountedScope = null; } };
      }

      const props = read();
      window.devflow.artifacts.read({
        projectRoot: props.projectRoot,
        sessionId: props.sessionId,
        nodeId: props.nodeId,
        runId: props.runId,
        artifactPath: props.artifactPath
      }).then(res => {
        if (!scopeCurrent(currentToken, scope)) return;
        state = { ...state, result: res, loading: false };
        changed();
      }).catch(err => {
        if (!scopeCurrent(currentToken, scope)) return;
        state = {
          ...state,
          result: {
            protocolVersion: 1,
            ok: false,
            code: "UNAVAILABLE",
            message: String(err)
          },
          loading: false
        };
        changed();
      });

      return () => { if (mountToken === currentToken) { mountToken++; mountedScope = null; } };
    }
  };
}

export function ArtifactView(props: ArtifactViewProps) {
  const latest = useRef(props);
  const [, redraw] = useReducer((value: number) => value + 1, 0);
  const [controller] = useState(() => createArtifactViewController(() => latest.current, redraw));
  useLayoutEffect(() => { latest.current = props; });
  useLayoutEffect(() => controller.mount(), [controller, props.projectRoot, props.sessionId, props.nodeId, props.runId, props.artifactPath]);

  const { result, loading, imageError } = controller.state;

  if (loading) {
    return <div className="artifact-view loading">Checking...</div>;
  }

  if (!result) {
    return <div className="artifact-view error">Unknown error</div>;
  }

  if (!result.ok) {
    return (
      <div className="artifact-view error">
        <AlertTriangle size={14} />
        <div className="error-details">
          <strong>{result.code}</strong>: {result.message}
        </div>
      </div>
    );
  }

  const { artifact, content, contentIdentity } = result;

  return (
    <div className="artifact-view available">
      <div className="artifact-meta-post">
        <span className="meta-badge">Status: {artifact.status}</span>
        <span className="meta-badge warning">Identity: {contentIdentity} (current file at registered path, not immutable historical bytes)</span>
      </div>
      <div className="artifact-content">
        {content.mimeType === "text/plain" ? (
          <pre className="artifact-text">{content.text}</pre>
        ) : (
          <div className="artifact-image-container">
            {imageError ? (
              <div className="artifact-image-error">Image decode failure</div>
            ) : (
              <img
                src={`data:${content.mimeType};base64,${content.base64}`}
                alt={artifact.name}
                {...controller.imageEvents()}
              />
            )}
          </div>
        )}
      </div>
      <div className="artifact-feedback">
        <label>
          Artifact feedback
          <textarea rows={2} value={controller.state.feedback} onChange={event => controller.setFeedback(event.target.value)} />
        </label>
        <label className="artifact-feedback-append">
          <input type="checkbox" checked={controller.state.append} onChange={event => controller.setAppend(event.target.checked)} />
          Append to existing Repair draft
        </label>
        <button type="button" disabled={!controller.canDraftRepair} onClick={() => void controller.draftRepair()}>Draft Repair</button>
        {content.mimeType !== "text/plain" && !imageError && !controller.state.imageLoaded && <p role="status">Image preview is still loading.</p>}
        {controller.state.draftError && <p role="alert">{controller.state.draftError}</p>}
      </div>
    </div>
  );
}
