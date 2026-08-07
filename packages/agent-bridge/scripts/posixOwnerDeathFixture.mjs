import { spawn } from "node:child_process";
import { closeSync, constants as fsConstants, openSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const [worktreePath, targetPath, cleanupTimeoutMs] = process.argv.slice(2);
const worktreeFd = openSync(
  worktreePath,
  fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
);
const owner = spawn(
  join(packageRoot, "src/native/posix-process-owner"),
  [cleanupTimeoutMs, join(packageRoot, "src/native/fd-launch"), "--require-git", targetPath],
  {
    detached: true,
    env: process.env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe", worktreeFd, "pipe"],
  },
);
closeSync(worktreeFd);
if (!owner.pid || !owner.stdin || !owner.stdio[4]) process.exit(70);
writeFileSync(process.env.SKYTURN_HELPER_PID_PATH, String(owner.pid));

let status = "";
owner.stdio[4].setEncoding("utf8");
owner.stdio[4].on("data", (chunk) => {
  status += chunk;
  if (status.startsWith("R ")) {
    writeFileSync(process.env.SKYTURN_OWNER_READY_PATH, "ready");
  }
});
owner.once("error", () => process.exit(70));
owner.once("close", () => process.exit(70));
setInterval(() => {}, 1_000);
