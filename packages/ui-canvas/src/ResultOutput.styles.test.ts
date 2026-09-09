import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const readSource = (path: string) => readFile(new URL(path, import.meta.url), "utf8");

// Source-level cascade contracts only; native Electron owns geometry verification.
function declarations(styles: string, selector: string): Map<string, string> {
  const result = new Map<string, string>();
  const css = styles.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    if (!rule[1].split(",").some((part) => part.trim() === selector)) continue;
    for (const declaration of rule[2].split(";")) {
      const colon = declaration.indexOf(":");
      if (colon < 0) continue;
      const property = declaration.slice(0, colon).trim();
      const value = declaration.slice(colon + 1).trim();
      if (!result.get(property)?.includes("!important") || value.includes("!important")) {
        result.set(property, value);
      }
    }
  }
  return result;
}

function luminance(value: string, tokens: Map<string, string>): number {
  const seen = new Set<string>();
  while (value.startsWith("var(")) {
    expect(seen.has(value), "Token aliases must not cycle").toBe(false);
    seen.add(value);
    value = tokens.get(value.slice(4, -1)) ?? "";
  }
  expect(value, "Resolve the final product color, not an earlier light-theme token").toMatch(/^#[\da-f]{6}$/i);
  const channels = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(value.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

describe("ResultOutput product styles", () => {
  it("keeps selected Preview and Raw text contrast at least 4.5 with final dark tokens", async () => {
    const product = await readSource("./styles.css");
    expect(product).toContain('@import "./ResultOutput.css";');
    const styles = product.replace('@import "./ResultOutput.css";', await readSource("./ResultOutput.css"));
    const tokens = declarations(styles, ":root");
    expect(tokens.get("--sk-ink")).toBe("#f2f2f2");
    const base = declarations(styles, ".result-output .result-output-toolbar button");
    const active = declarations(styles, '.result-output .result-output-toolbar button[aria-pressed="true"]');
    const colors = new Map([...base, ...active]);
    const foreground = luminance(colors.get("color") ?? "", tokens);
    const background = luminance(colors.get("background") ?? "", tokens);
    const contrast = (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05);
    expect(contrast).toBeGreaterThanOrEqual(4.5);
  });

  it("sizes the optional direct-child summary before the flexible scrolling body", async () => {
    const styles = await readSource("./styles.css");
    const app = await readSource("./App.tsx");
    expect(app).toMatch(/\{\(nodeFailureSummary \|\| nodeLatestFailedCheck \|\| nodeLastEvidence\) && \([\s\S]*?className="node-failure-summary"[\s\S]*?\)\}\s*<div className="modal-body">/);
    expect(declarations(styles, ".node-modal").get("grid-template-rows"))
      .toBe("auto auto auto minmax(0, 1fr)");
    expect(declarations(styles, ".node-modal:has(> .node-failure-summary)").get("grid-template-rows"))
      .toBe("auto auto auto auto minmax(0, 1fr)");
    expect(declarations(styles, ".modal-body").get("min-height")).toBe("0");
    expect(declarations(styles, ".node-modal .modal-body").get("overflow")).toBe("auto");
    // Auto placement must select row four without a summary and row five with it.
    for (const selector of [".modal-body", ".node-modal .modal-body", ".node-modal > .modal-body"]) {
      const body = declarations(styles, selector);
      for (const property of ["grid-row", "grid-row-start", "grid-area"]) {
        expect(body.get(property), `${selector} ${property}`).toBeUndefined();
      }
    }
  });
});
