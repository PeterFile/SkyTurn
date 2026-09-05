import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { createSourceModuleLoader } from "./sourceModuleLoader.mjs";

const require = createRequire(import.meta.url);

test("loads transitive TypeScript from each source origin and preserves explicit mocks", async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "skyturn-source-loader-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const featureRoot = join(fixtureRoot, "feature");
  const entryPath = join(fixtureRoot, "entry.ts");
  const featureAdapterPath = join(featureRoot, "adapter.ts");
  await mkdir(featureRoot);

  await Promise.all([
    writeFile(entryPath, `
      import { runFutureModule } from "./feature/future.js";
      import { adapterName as rootAdapterName } from "./adapter";
      export function runFixture() {
        return { future: runFutureModule(), rootAdapter: rootAdapterName() };
      }
    `),
    writeFile(join(fixtureRoot, "adapter.ts"), `
      export function adapterName() { return "root-real"; }
    `),
    writeFile(join(featureRoot, "future.ts"), `
      import { nestedValue } from "./nested.js";
      import { adapterName } from "./adapter.js";
      export function runFutureModule() {
        return \`future-ran:\${nestedValue()}:\${adapterName()}\`;
      }
    `),
    writeFile(join(featureRoot, "nested.ts"), `
      globalThis.fixtureState.nestedExecutions += 1;
      export function nestedValue() { return "source-relative"; }
    `),
    writeFile(featureAdapterPath, `
      export function adapterName() { return "feature-real"; }
    `),
  ]);

  const fixtureState = { nestedExecutions: 0 };
  const loader = createSourceModuleLoader({
    typescript: require("typescript"),
    globals: { fixtureState },
    mocks: new Map([
      [featureAdapterPath, { adapterName: () => "feature-mock" }],
    ]),
  });
  const loaded = loader.load(entryPath);
  const result = loaded.runFixture();

  assert.equal(result.future, "future-ran:source-relative:feature-mock");
  assert.equal(result.rootAdapter, "root-real");
  assert.equal(fixtureState.nestedExecutions, 1);
  assert.equal(loader.load(entryPath), loaded);
});

test("rejects a missing local source with its importer and specifier", async (t) => {
  const fixtureRoot = await mkdtemp(join(tmpdir(), "skyturn-source-loader-missing-"));
  t.after(() => rm(fixtureRoot, { recursive: true, force: true }));
  const entryPath = join(fixtureRoot, "entry.ts");
  await writeFile(entryPath, `import "./missing.js";`);
  const loader = createSourceModuleLoader({ typescript: require("typescript") });

  assert.throws(
    () => loader.load(entryPath),
    (error) => error instanceof Error
      && error.message.includes(entryPath)
      && error.message.includes('"./missing.js"'),
  );
});
