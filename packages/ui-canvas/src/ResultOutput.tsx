import { useLayoutEffect, useMemo, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { CanvasNode } from "@skyturn/project-core";

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
  const copier = useMemo(createOutputCopier, []);
  useLayoutEffect(() => {
    setCopyStatus("idle");
    return () => copier.invalidate();
  }, [copier, raw]);
  const live = node.status === "running" || node.status === "retrying";
  const status = node.status === "failed" ? "Run failed."
    : live ? `${node.status === "retrying" ? "Retrying" : "Running"} — output is live.` : "";
  const copyError = copyStatus === "failed" || copyStatus === "unavailable";

  return (
    <section className="result-output" aria-label="Node output">
      <div className="result-output-toolbar" role="group" aria-label="Output display and copy">
        <button type="button" aria-pressed={mode === "preview"} onClick={() => setMode("preview")}>Preview</button>
        <button type="button" aria-pressed={mode === "raw"} onClick={() => setMode("raw")}>Raw text</button>
        <button type="button" disabled={raw.length === 0} onClick={() => { void copier.copy(raw, setCopyStatus, clipboard); }}>Copy</button>
        <span className="result-output-feedback" role={copyError ? "alert" : "status"}>{copyMessages[copyStatus]}</span>
      </div>
      <p className="result-output-status" role="status">{status}</p>
      {raw.length === 0 ? <p>No node output yet.</p>
        : mode === "raw" ? <pre className="result-output-raw" tabIndex={0} aria-label="Raw output"><code>{raw}</code></pre>
        : /^\s+$/.test(raw) ? <p>Captured output contains only whitespace. Use Raw text to inspect it.</p>
        : <div className="result-output-preview"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml
            urlTransform={(url, key) => key === "href" ? safeWebUrl(url) : undefined}
            components={markdownComponents}>{raw}</ReactMarkdown></div>}
    </section>
  );
}
