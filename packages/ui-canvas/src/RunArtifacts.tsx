import { Fragment, memo, useLayoutEffect, useReducer, useRef, useState } from "react";
import type { CanvasSession, CanvasNode, RunEvidence } from "@skyturn/project-core";
import type { ArtifactViewResult } from "@skyturn/persistence";
import { Eye, X, AlertTriangle } from "lucide-react";
import "./RunArtifacts.css";

export interface RunArtifactsProps {
  projectRoot: string;
  session: CanvasSession;
  node: CanvasNode;
  runEvidence?: RunEvidence | null;
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
}: RunArtifactsProps) {
  const artifacts = runEvidence?.artifacts ?? [];
  const runId = runEvidence?.runId === node.runId ? runEvidence?.runId : undefined;

  const [active, setActive] = useState<{ scopeId: string; path: string } | null>(null);

  const scopeId = `${projectRoot}:${session.id}:${node.id}:${runId}`;
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
}

export type ArtifactViewState = {
  result: ArtifactViewResult | null;
  loading: boolean;
  imageError: boolean;
};

export function createArtifactViewController(read: () => ArtifactViewProps, changed: () => void) {
  let state: ArtifactViewState = { result: null, loading: true, imageError: false };
  let active = false;

  return {
    get state() { return state; },
    setImageError(value: boolean) {
      if (state.imageError !== value) {
        state = { ...state, imageError: value };
        changed();
      }
    },
    mount() {
      active = true;
      state = { result: null, loading: true, imageError: false };
      changed();

      if (!window.devflow?.artifacts?.read) {
        state = {
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
        return () => { active = false; };
      }

      const props = read();
      window.devflow.artifacts.read({
        projectRoot: props.projectRoot,
        sessionId: props.sessionId,
        nodeId: props.nodeId,
        runId: props.runId,
        artifactPath: props.artifactPath
      }).then(res => {
        if (!active) return;
        state = { ...state, result: res, loading: false };
        changed();
      }).catch(err => {
        if (!active) return;
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

      return () => { active = false; };
    }
  };
}

export function ArtifactView(props: ArtifactViewProps) {
  const latest = useRef(props);
  const [, redraw] = useReducer((value: number) => value + 1, 0);
  const [controller] = useState(() => createArtifactViewController(() => latest.current, redraw));
  useLayoutEffect(() => { latest.current = props; });
  useLayoutEffect(() => controller.mount(), [controller]);

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
                onError={() => controller.setImageError(true)}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
