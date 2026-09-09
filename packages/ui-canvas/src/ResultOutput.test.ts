import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ResultOutput, createOutputCopier } from "./ResultOutput.js";
import type { CanvasNode } from "@skyturn/project-core";

type OutputNode = Pick<CanvasNode, "id" | "runId" | "status" | "output">;
const node = (output: string[], status: OutputNode["status"] = "completed"): OutputNode =>
  ({ id: "node-1", runId: "run-1", status, output });
const render = (output: string[], status?: OutputNode["status"], initialMode?: "preview" | "raw") =>
  renderToStaticMarkup(createElement(ResultOutput, { node: node(output, status), initialMode }));

describe("ResultOutput", () => {
  it("joins ordered fragments without inserting word or fence separators", () => {
    const html = render(["# Hel", "lo\n\n- item\n\n`", "``ts\nconst x = 1;\n`", "``\n\n| A | B |\n| - | - |\n| 1 | 2 |"]);
    for (const part of ["<h1>Hello</h1>", "<li>item</li>", '<code class="language-ts">const x = 1;\n', "<table>", "<th>A</th>"]) {
      expect(html).toContain(part);
    }
    expect(html).toContain('aria-pressed="true">Preview');
    expect(html).toContain('aria-pressed="false">Raw text');
  });

  it("renders raw whitespace, CRLF, blank lines, empty fragments, and repeats exactly", () => {
    const fragments = ["  planner output\n", "", "\tplanner progress  \n", "\r\n", "same", "same", "  "];
    expect(render(fragments, "completed", "raw")).toContain(`<code>${fragments.join("")}</code>`);
    const raw = render(["# heading\n<script>alert(1)</script>"], "completed", "raw");
    expect(raw).toContain("# heading\n&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(raw).not.toContain("<h1>");
    expect(raw).toContain('aria-pressed="true">Raw text');
  });

  it.each([{ fragments: [] }, { fragments: [""] }])("disables copy only when exact text is empty: $fragments", ({ fragments }) => {
    const html = render(fragments);
    expect(html).toContain("No node output yet.");
    expect(html).toContain('disabled=""');
  });

  it.each(["preview", "raw"] as const)("keeps whitespace-only output captured in %s", (mode) => {
    const html = render(["", " \t\r\n  "], "completed", mode);
    expect(html).not.toContain('disabled=""');
    expect(html).not.toContain("No node output yet.");
    if (mode === "preview") expect(html).toContain("Captured output contains only whitespace.");
  });

  it.each(["running", "retrying", "failed"] as const)("shows %s without replacing output", (status) => {
    const html = render(["captured failure details"], status);
    expect(html).toContain("captured failure details");
    expect(html).toContain(status === "failed" ? "Run failed." : status === "retrying" ? "Retrying — output is live." : "Running — output is live.");
    expect(render([], status)).toContain("No node output yet.");
    expect(html).toContain('role="status"');
  });

  it("blocks HTML, image fetch/preload, and unsafe or local navigation while retaining labels", () => {
    const html = render([
      '<script>alert(1)</script>\n\n<img src="https://evil.test/raw.png" onerror="alert(1)">\n\n',
      '![Useful diagram](https://evil.test/tracker.png) ![Local diagram](file:///tmp/image.png)\n\n',
      '[script](javascript:alert%281%29) [data](data:text/html,evil) [file](file:///tmp/x) ',
      '[relative](../secret) [absolute](/etc/passwd) [network](//evil.test/x) [windows](C:\\secret) ',
      '[web](https://example.com/page)\n\n- [x] done\n\n~~removed~~',
    ]);
    expect(html).not.toMatch(/<(script|img|link|iframe)\b|\b(src|srcSet|onerror)=/i);
    expect(html).not.toMatch(/href="(?:javascript:|data:|file:|\.\.|\/|C:)/i);
    for (const label of ["Useful diagram", "Local diagram", "script", "data", "file", "relative", "absolute", "network", "windows"]) expect(html).toContain(label);
    expect(html).toContain('href="https://example.com/page"');
    expect(html).toContain('target="_blank" rel="noopener noreferrer"');
    expect(html).toContain("<del>removed</del>");
    expect(html).toContain('type="checkbox"');
  });
});

describe("output clipboard", () => {
  it("copies exact raw text and reports success only after native write resolves", async () => {
    let finish!: () => void;
    const writeText = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    const report = vi.fn();
    const raw = "  splitword\r\n\t\n  ";
    const pending = createOutputCopier().copy(raw, report, { writeText });
    expect(writeText).toHaveBeenCalledWith(raw);
    expect(report.mock.calls).toEqual([["copying"]]);
    finish();
    await pending;
    expect(report.mock.calls).toEqual([["copying"], ["copied"]]);
  });

  it("uses the native navigator clipboard by default", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    try {
      await createOutputCopier().copy("native", vi.fn());
      expect(writeText).toHaveBeenCalledWith("native");
    } finally { vi.unstubAllGlobals(); }
  });

  it("handles unavailable, rejected, throwing, and empty writes", async () => {
    const report = vi.fn();
    const copier = createOutputCopier();
    await copier.copy("text", report, null);
    expect(report).toHaveBeenLastCalledWith("unavailable");
    await copier.copy("text", report, { writeText: async () => { throw new Error("denied"); } });
    expect(report).toHaveBeenLastCalledWith("failed");
    await copier.copy("text", report, { writeText: () => { throw new Error("denied"); } });
    expect(report).toHaveBeenLastCalledWith("failed");
    const writeText = vi.fn();
    await copier.copy("", report, { writeText });
    expect(writeText).not.toHaveBeenCalled();
    expect(report).toHaveBeenLastCalledWith("idle");
  });

  it.each(["output change", "node/run switch", "new copy"])("ignores stale success after %s", async (change) => {
    let finish!: () => void;
    const copier = createOutputCopier();
    const report = vi.fn();
    const pending = copier.copy("old", report, { writeText: () => new Promise<void>((resolve) => { finish = resolve; }) });
    if (change === "new copy") await copier.copy("new", vi.fn(), null);
    else copier.invalidate();
    finish();
    await pending;
    expect(report.mock.calls).toEqual([["copying"]]);
  });
});
