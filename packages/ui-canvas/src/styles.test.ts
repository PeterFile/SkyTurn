import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

async function readSource(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), "utf8");
}

describe("SkyTurn UI style tokens", () => {
  it("keeps the existing font stack and theme colors stable", async () => {
    const styles = await readSource("./styles.css");

    expect(styles).not.toContain("@fontsource-variable");
    expect(styles).not.toContain("Space Grotesk");
    expect(styles).toContain("--sk-accent: #0ea5e9");
    expect(styles).toContain("--sk-accent-strong: #0284c7");
    expect(styles).toContain("--sk-status-running: #6366f1");
    expect(styles).toContain("--sk-running-gradient-start: #22d3ee");
    expect(styles).toContain("--sk-running-gradient-mid: #818cf8");
    expect(styles).toContain("--sk-running-gradient-end: #a78bfa");
    expect(styles).toContain("--sk-edge-active: #7c8cff");
    expect(styles).toContain("--sk-shadow-running: rgba(79, 70, 229, 0.15)");
    expect(styles).toContain("--sk-loop-running-deep: rgba(139, 92, 246, 0.86)");
  });

  it("routes runtime paint decisions through CSS tokens", async () => {
    const appSource = await readSource("./App.tsx");

    expect(appSource).toContain('color="var(--sk-canvas-grid)"');
    expect(appSource).toContain('stopColor="var(--sk-running-gradient-start)"');
    expect(appSource).toContain('stopColor="var(--sk-running-gradient-mid)"');
    expect(appSource).toContain('stopColor="var(--sk-running-gradient-end)"');
    expect(appSource).toContain('return "var(--sk-edge-active)"');
    expect(appSource).toContain('return "var(--sk-frame-completed)"');
    expect(appSource).toContain('return "var(--sk-glint-failed)"');
    expect(appSource).toContain('return "var(--sk-status-running)"');
  });

  it("does not reintroduce the discarded token-branch theme direction", async () => {
    const source = `${await readSource("./styles.css")}\n${await readSource("./App.tsx")}`;

    expect(source).not.toContain("--sk-accent: #38a8ff");
    expect(source).not.toContain("--sk-status-running: #38a8ff");
    expect(source).not.toContain("56, 168, 255");
    expect(source).not.toContain("56 168 255");
  });
});
