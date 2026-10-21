import { useLayoutEffect, useMemo, useRef, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { CanvasNode } from "@skyturn/project-core";
import { findOutputMatches, OUTPUT_FIND_MATCH_LIMIT } from "./outputFind.js";

type CopyStatus = "idle" | "copying" | "copied" | "unavailable" | "failed";
type ClipboardWriter = Pick<Clipboard, "writeText">;
type OutputProps = {
  node: Pick<CanvasNode, "id" | "runId" | "status" | "output">;
  clipboard?: ClipboardWriter | null;
  initialMode?: "preview" | "raw";
};

export function createOutputCopier() {
  let revision = 0;
  return {
    invalidate() { revision += 1; },
    async copy(raw: string, report: (status: CopyStatus) => void, clipboard?: ClipboardWriter | null) {
      const attempt = ++revision;
      if (raw.length === 0) { report("idle"); return; }
      report("copying");
      let status: CopyStatus;
      try {
        const writer = clipboard === undefined ? globalThis.navigator?.clipboard : clipboard;
        if (typeof writer?.writeText !== "function") status = "unavailable";
        else { await writer.writeText(raw); status = "copied"; }
      } catch { status = "failed"; }
      if (attempt === revision) report(status);
    },
  };
}

function safeWebUrl(url: string): string | undefined {
  if (!/^https?:\/\//i.test(url) || /[\s\\]/.test(url)) return undefined;
  try {
    const parsed = new URL(url);
    return parsed.hostname && !parsed.username && !parsed.password ? url : undefined;
  } catch { return undefined; }
}

const markdownComponents: Components = {
  // No image element means no fetch or React image preload, even during SSR.
  img: ({ alt }) => <span className="result-output-image">{alt || "Image omitted"}</span>,
  a: ({ href, children }) => href
    ? <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
    : <span>{children}</span>,
  pre: ({ children }) => <pre tabIndex={0} aria-label="Code block">{children}</pre>,
  table: ({ children }) => <div className="result-output-table" tabIndex={0} role="region" aria-label="Output table"><table>{children}</table></div>,
};
const copyMessages: Record<CopyStatus, string> = {
  idle: "", copying: "Copying…", copied: "Copied",
  unavailable: "Clipboard unavailable. Select and copy Raw text.",
  failed: "Copy failed. Try again or select Raw text.",
};

export function ResultOutput(props: OutputProps) {
  return <ResultOutputSession key={JSON.stringify([props.node.id, props.node.runId])} {...props} />;
}

function ResultOutputSession({ node, clipboard, initialMode = "preview" }: OutputProps) {
  // Output entries are exact ordered stream fragments, not lines.
  const raw = node.output.join("");
  const [mode, setMode] = useState(initialMode);
  const [copyStatus, setCopyStatus] = useState<CopyStatus>("idle");
  const [findOpen, setFindOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [requestedIndex, setActiveIndex] = useState(0);
  const findButton = useRef<HTMLButtonElement>(null);
  const findInput = useRef<HTMLInputElement>(null);
  const activeMatch = useRef<HTMLElement>(null);
  const matches = useMemo(() => findOutputMatches(raw, findOpen ? query : ""), [raw, query, findOpen]);
  const activeIndex = Math.min(requestedIndex, Math.max(0, matches.positions.length - 1));
  const matchStart = matches.positions[activeIndex];
  useLayoutEffect(() => { setActiveIndex(activeIndex); }, [activeIndex]);
  useLayoutEffect(() => { if (findOpen) findInput.current?.focus(); }, [findOpen]);
  useLayoutEffect(() => {
    activeMatch.current?.scrollIntoView({ block: "center", inline: "nearest" });
  }, [findOpen, matchStart, query]);
  const copier = useMemo(createOutputCopier, []);
  useLayoutEffect(() => {
    setCopyStatus("idle");
    return () => copier.invalidate();
  }, [copier, raw]);
  const live = node.status === "running" || node.status === "retrying";
  const status = node.status === "failed" ? "Run failed."
    : live ? `${node.status === "retrying" ? "Retrying" : "Running"} — output is live.` : "";
  const copyError = copyStatus === "failed" || copyStatus === "unavailable";
  const findStatus = query.length === 0 ? "Enter a query. Spaces are literal."
    : matches.positions.length === 0 ? "No matches."
    : `${activeIndex + 1} of ${matches.positions.length} matches${matches.capped ? ` (capped; first ${OUTPUT_FIND_MATCH_LIMIT} only)` : ""}`;
  function clearFind() { setQuery(""); setActiveIndex(0); }
  function closeFind() { setFindOpen(false); clearFind(); findButton.current?.focus(); }
  function moveMatch(step: number) {
    if (matches.positions.length > 0) setActiveIndex((activeIndex + step + matches.positions.length) % matches.positions.length);
  }

  return (
    <section className="result-output" aria-label="Node output">
      <div className="result-output-toolbar" role="group" aria-label="Output display, find and copy">
        <button type="button" aria-pressed={mode === "preview"} onClick={() => { setMode("preview"); setFindOpen(false); clearFind(); }}>Preview</button>
        <button type="button" aria-pressed={mode === "raw"} onClick={() => setMode("raw")}>Raw text</button>
        <button type="button" disabled={raw.length === 0} onClick={() => { void copier.copy(raw, setCopyStatus, clipboard); }}>Copy</button>
        <button ref={findButton} type="button" aria-expanded={findOpen} onClick={() => {
          if (findOpen) closeFind(); else { setMode("raw"); setFindOpen(true); }
        }}>Find</button>
        <span className="result-output-feedback" role={copyError ? "alert" : "status"}>{copyMessages[copyStatus]}</span>
      </div>
      {findOpen && <div className="result-output-find" role="search" aria-label="Find in node output">
        <input ref={findInput} className="result-output-find-input" type="search" aria-label="Find in captured output"
          title="Case-sensitive literal search of captured text" autoComplete="off" spellCheck={false} value={query}
          onChange={(event) => { setQuery(event.currentTarget.value); setActiveIndex(0); }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); moveMatch(event.shiftKey ? -1 : 1); }
            else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeFind(); }
          }} />
        <button type="button" aria-label="Previous match" disabled={matches.positions.length === 0} onClick={() => moveMatch(-1)}>Previous</button>
        <button type="button" aria-label="Next match" disabled={matches.positions.length === 0} onClick={() => moveMatch(1)}>Next</button>
        <button type="button" aria-label="Clear search" disabled={query.length === 0} onClick={() => { clearFind(); findInput.current?.focus(); }}>Clear</button>
        <button type="button" aria-label="Close find" onClick={closeFind}>Close</button>
        <span className="result-output-find-count" role="status" aria-live="polite" aria-atomic="true">{findStatus}</span>
        <small className="result-output-find-hint">Search captured text, not Markdown display; case-sensitive and literal. Enter: next · Shift+Enter: previous · Escape: close.</small>
      </div>}
      <p className="result-output-status" role="status">{status}</p>
      {raw.length === 0 ? <p>No node output yet.</p>
        : mode === "raw" ? <pre className="result-output-raw" tabIndex={0} aria-label="Raw output"><code>{matchStart === undefined ? raw
          : <>{raw.slice(0, matchStart)}<mark ref={activeMatch} className="result-output-active-match">{raw.slice(matchStart, matchStart + query.length)}</mark>{raw.slice(matchStart + query.length)}</>}</code></pre>
        : /^\s+$/.test(raw) ? <p>Captured output contains only whitespace. Use Raw text to inspect it.</p>
        : <div className="result-output-preview"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml
            urlTransform={(url, key) => key === "href" ? safeWebUrl(url) : undefined}
            components={markdownComponents}>{raw}</ReactMarkdown></div>}
    </section>
  );
}
