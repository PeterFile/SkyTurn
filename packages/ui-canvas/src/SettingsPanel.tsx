import { useEffect, useState, useRef, useCallback } from "react";
import { X, RefreshCw, CheckCircle2, AlertTriangle } from "lucide-react";
import type { SettingsSnapshot, SkyTurnSettings } from "@skyturn/persistence";

export function SettingsPanel({
  projectRoot,
  onClose,
}: {
  projectRoot: string;
  onClose: () => void;
}) {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null);
  const [error, setError] = useState<string | null>(() => 
    (typeof window === "undefined" || !window?.devflow?.settings) ? "Desktop settings API is missing. Settings are unavailable." : null
  );
  const [saveStatus, setSaveStatus] = useState<{ type: 'error' | 'success', message: string } | null>(null);
  
  const [hermesOverride, setHermesOverride] = useState<string | undefined>(undefined);
  const [codexOverride, setCodexOverride] = useState<string | undefined>(undefined);
  
  const [isPending, setIsPending] = useState(() => (typeof window !== "undefined" && !!window?.devflow?.settings));
  const generationRef = useRef(0);
  const initialFocusRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);

  const handleRefresh = useCallback(() => {
    if (typeof window === "undefined" || !window.devflow?.settings) {
      setError("Desktop settings API is missing. Settings are unavailable.");
      setIsPending(false);
      return;
    }
    const gen = ++generationRef.current;
    setIsPending(true);
    setError(null);
    setSaveStatus(null);
    
    window.devflow.settings.get(projectRoot)
      .then(res => {
        if (gen === generationRef.current) {
          setSnapshot(res);
          setIsPending(false);
        }
      })
      .catch(err => {
        if (gen === generationRef.current) {
          setError(err instanceof Error ? err.message : String(err));
          setIsPending(false);
        }
      });
  }, [projectRoot]);

  useEffect(() => {
    handleRefresh();
    return () => {
      generationRef.current++;
    };
  }, [handleRefresh]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  useEffect(() => {
    const handleTab = (e: KeyboardEvent) => {
      if (e.key === "Tab" && panelRef.current) {
        const focusables = panelRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href]:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"]):not([disabled])'
        );
        if (focusables.length === 0) return;
        const first = focusables[0];
        const last = focusables[focusables.length - 1];
        
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last?.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first?.focus();
        }
      }
    };
    document.addEventListener("keydown", handleTab);
    return () => document.removeEventListener("keydown", handleTab);
  }, []);

  useEffect(() => {
    initialFocusRef.current?.focus();
  }, []);

  const handleSave = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (!snapshot || typeof window === "undefined" || !window.devflow?.settings) return;
    
    const gen = ++generationRef.current;
    setIsPending(true);
    setSaveStatus(null);
    
    const hRaw = hermesOverride !== undefined ? hermesOverride : snapshot.settings.app.executableOverrides.hermes;
    const h = hRaw === "" ? null : hRaw;
    
    const cRaw = codexOverride !== undefined ? codexOverride : snapshot.settings.app.executableOverrides.codex;
    const c = cRaw === "" ? null : cRaw;
    
    const nextSettings: SkyTurnSettings = {
      ...snapshot.settings,
      app: {
        ...snapshot.settings.app,
        executableOverrides: {
          ...snapshot.settings.app.executableOverrides,
          hermes: h,
          codex: c,
        }
      }
    };
    
    window.devflow.settings.save(projectRoot, nextSettings)
      .then(res => {
        if (gen === generationRef.current) {
          setSnapshot(res);
          setSaveStatus({ type: 'success', message: 'Settings saved.' });
          setHermesOverride(undefined);
          setCodexOverride(undefined);
          setIsPending(false);
        }
      })
      .catch(err => {
        if (gen === generationRef.current) {
          setSaveStatus({ type: 'error', message: err instanceof Error ? err.message : String(err) });
          setIsPending(false);
        }
      });
  }, [snapshot, projectRoot, hermesOverride, codexOverride]);

  return (
    <div className="modal-backdrop settings-modal-backdrop" role="presentation">
      <section ref={panelRef} className="settings-modal" role="dialog" aria-modal="true" aria-label="Settings">
        <header className="modal-header">
          <div>
            <p className="eyebrow">Project Settings</p>
            <h2>Settings</h2>
          </div>
          <button ref={initialFocusRef} className="icon-button" title="Close" aria-label="Close" onClick={onClose}>
            <X size={18} />
          </button>
        </header>

        <div className="settings-modal-body">
          <div className="settings-actions-bar">
            <button className="plan-finish-button" type="button" onClick={handleRefresh} disabled={isPending}>
              <RefreshCw size={14} /> Refresh
            </button>
          </div>

          {error && (
            <div className="plan-error-banner" role="alert">
              <AlertTriangle size={16} />
              <span>{error}</span>
            </div>
          )}
          {saveStatus && (
            <div className={saveStatus.type === 'error' ? "plan-error-banner" : "plan-success-banner"} role={saveStatus.type === 'error' ? "alert" : "status"}>
              {saveStatus.type === 'error' ? <AlertTriangle size={16} /> : <CheckCircle2 size={16} />}
              <span>{saveStatus.message}</span>
            </div>
          )}

          {isPending && !snapshot ? (
            <div className="settings-loading-status">Loading...</div>
          ) : !snapshot ? (
             <div className="settings-retry-load">
               <button type="button" onClick={handleRefresh} className="plan-finish-button">Retry Load</button>
             </div>
          ) : (
            <form onSubmit={handleSave} className="settings-form">
              <h3 className="settings-section-title">Agent Executables</h3>
              <div className="settings-form-group">
                <label htmlFor="hermesOverride">Hermes Executable Override</label>
                <input
                  id="hermesOverride"
                  type="text"
                  className="settings-input"
                  value={hermesOverride !== undefined ? hermesOverride : (snapshot.settings.app.executableOverrides.hermes ?? "")}
                  onChange={e => setHermesOverride(e.target.value)}
                  placeholder="e.g. /opt/homebrew/bin/hermes"
                  disabled={isPending}
                />
              </div>
              <div className="settings-form-group">
                <label htmlFor="codexOverride">Codex Executable Override</label>
                <input
                  id="codexOverride"
                  type="text"
                  className="settings-input"
                  value={codexOverride !== undefined ? codexOverride : (snapshot.settings.app.executableOverrides.codex ?? "")}
                  onChange={e => setCodexOverride(e.target.value)}
                  placeholder="e.g. /usr/local/bin/codex"
                  disabled={isPending}
                />
              </div>

              <h3 className="settings-section-title">Last successful refresh snapshot</h3>
              <div className="settings-status-box">
                <div><strong>Project Root:</strong> <span className="settings-path-wrap">{snapshot.projectRoot}</span></div>
                <div><strong>Current Branch:</strong> {snapshot.prerequisites.project.git.currentBranch ?? "unknown"}</div>
              </div>
              
              <div className="settings-agent-list">
                {snapshot.prerequisites.agents.map(agent => (
                  <div key={agent.kind} className="settings-status-box">
                    <div className="settings-agent-kind">{agent.kind}</div>
                    <div className="settings-agent-details">
                      <div><strong>CLI:</strong> {agent.cli}</div>
                      <div><strong>Auth:</strong> {agent.auth}</div>
                      <div><strong>Runnable:</strong> {agent.runnable ? 'yes' : 'no'}</div>
                      <div><strong>Support:</strong> {agent.supportLevel}</div>
                    </div>
                  </div>
                ))}
              </div>

              <div className="settings-form-footer">
                <button type="submit" disabled={isPending || (hermesOverride === undefined && codexOverride === undefined && snapshot === null)} className="plan-finish-button settings-save-button">
                  {isPending ? "Saving..." : "Save Settings"}
                </button>
              </div>
            </form>
          )}
        </div>
      </section>
    </div>
  );
}
