import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

async function readSource(path: string): Promise<string> {
  return readFile(new URL(path, import.meta.url), "utf8");
}

describe("SkyTurn UI style tokens", () => {
  it("uses Space Grotesk and sky blue as the canonical UI direction", async () => {
    const styles = await readSource("./styles.css");

    expect(styles).toContain('@import "@fontsource-variable/space-grotesk/wght.css";');
    expect(styles).toContain('--sk-font-ui: "Space Grotesk"');
    expect(styles).toMatch(
      /@import "@fontsource-variable\/space-grotesk\/wght\.css";\s+:root\s*\{\s+color: var\(--sk-text-legacy\);\s+background: var\(--sk-bg-warm\);\s+font-family: var\(--sk-font-ui\);/,
    );
    expect(styles).toContain("--sk-accent: #38a8ff");
    expect(styles).toContain("--sk-status-running: #38a8ff");
    expect(styles).toContain("--sk-edge-active: rgba(56, 168, 255, 0.72)");
  });

  it("does not keep the previous cyan accent tokens", async () => {
    const source = `${await readSource("./styles.css")}\n${await readSource("./App.tsx")}`;

    expect(source).not.toContain("#0ea5e9");
    expect(source).not.toContain("#22d3ee");
    expect(source).not.toContain("34, 211, 238");
    expect(source).not.toContain("14, 165, 233");
  });

  it("keeps display styles wired through tokens instead of standalone literals", async () => {
    const styles = await readSource("./styles.css");
    const appSource = await readSource("./App.tsx");
    const stylesWithoutTokenBlocks = styles.replaceAll(/:root\s*\{[^}]*\}/g, "");
    const appDirectColors = appSource.match(/#[0-9a-fA-F]{3,8}|rgba?\(/g) ?? [];
    const cssDirectColors =
      stylesWithoutTokenBlocks.match(/#[0-9a-fA-F]{3,8}|rgba?\((?!var\()/g) ?? [];
    const directRadii = (stylesWithoutTokenBlocks.match(/border-radius:\s*[^;]+;/g) ?? []).filter(
      (declaration) => !/border-radius:\s*(?:var\(|inherit|calc\(|0\b)/.test(declaration),
    );

    expect(appDirectColors).toEqual([]);
    expect(cssDirectColors).toEqual([]);
    expect(directRadii).toEqual([]);
  });
});
