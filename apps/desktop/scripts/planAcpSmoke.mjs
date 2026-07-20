import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function runPlanAcpSmoke(options = {}) {
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const createClient = options.createClient ?? defaultClientFactory;
  const buildPrompt = options.buildPrompt ?? defaultPromptBuilder;
  const client = await createClient();
  let chunkCount = 0;
  try {
    const sessionId = await client.newSession(projectRoot);
    const result = await client.prompt(
      sessionId,
      await buildPrompt(projectRoot),
      {
        timeoutMs: 120_000,
        onText: () => {
          chunkCount += 1;
        },
      },
    );
    return {
      status: "ok",
      stopReason: result.stopReason,
      markdownLength: result.markdown.length,
      chunkCount,
    };
  } finally {
    await client.close();
  }
}

async function defaultClientFactory() {
  const { createHermesAcpClient } = await import("@skyturn/agent-bridge");
  return createHermesAcpClient({
    ...(process.env.SKYTURN_HERMES_PATH ? { executablePath: process.env.SKYTURN_HERMES_PATH } : {}),
  });
}

async function defaultPromptBuilder(projectRoot) {
  const { buildPlanPrompt } = await import("@skyturn/planner");
  return buildPlanPrompt({
    operation: "generate",
    stage: "requirements",
    goal: "Validate staged Plan mode ACP Requirements generation.",
    projectContext: `Project root: ${projectRoot}`,
    requirements: "",
    design: "",
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runPlanAcpSmoke().then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
  }).catch(() => {
    process.stderr.write("Live Hermes ACP smoke failed.\n");
    process.exitCode = 1;
  });
}
