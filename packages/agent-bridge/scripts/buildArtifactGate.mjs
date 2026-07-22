import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const helpers = ["artifact-gate"];
const windowsHelpers = ["artifact-gate.ps1", "job-object-host.ps1"];
for (const legacyPath of [
  join(packageRoot, "src/native/durable-run-claim"),
  join(packageRoot, "dist/native/durable-run-claim"),
]) {
  rmSync(legacyPath, { force: true });
}

for (const helper of windowsHelpers) {
  if (!existsSync(join(packageRoot, "src/native", helper))) {
    throw new Error(`Windows native helper source is missing: ${helper}`);
  }
}

if (process.platform !== "win32") {
  const compiler = process.env.CC || "cc";
  for (const helper of helpers) {
    const source = join(packageRoot, `src/native/${helper}.c`);
    const sourceBinary = join(packageRoot, `src/native/${helper}`);
    const result = spawnSync(compiler, ["-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", source, "-o", sourceBinary], {
      stdio: "inherit",
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
    chmodSync(sourceBinary, 0o755);

    if (process.argv.includes("--copy-dist")) {
      const distBinary = join(packageRoot, `dist/native/${helper}`);
      mkdirSync(dirname(distBinary), { recursive: true });
      copyFileSync(sourceBinary, distBinary);
      chmodSync(distBinary, 0o755);
    }
  }
}

if (process.argv.includes("--copy-dist")) {
  for (const helper of windowsHelpers) {
    const source = join(packageRoot, "src/native", helper);
    const destination = join(packageRoot, "dist/native", helper);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
}
