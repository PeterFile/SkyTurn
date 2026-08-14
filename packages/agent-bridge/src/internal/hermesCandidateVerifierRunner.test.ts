import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const pythonPath = (process.env.PATH ?? "")
  .split(delimiter)
  .map((directory) => join(directory, "python3"))
  .find(existsSync) ?? "/usr/bin/python3";
const runnerPath = fileURLToPath(new URL("./hermesCandidateVerifier.py", import.meta.url));
const roots: string[] = [];
const prompt = "canonical prompt with private-patch-sentinel";
const response = JSON.stringify({
  version: 1,
  requestSha256: "8".repeat(64),
  manifestSha256: "7".repeat(64),
  disposition: "allow",
});

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("Hermes candidate verifier Python runner", () => {
  it("re-homes AIAgent onto a minimal config before the zero-tool provider call", async () => {
    const fixture = await fakeHermesRuntime();
    const result = runRunner(fixture, { FAKE_RESPONSE: response });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(parseResultFrame(result.stdout)).toEqual({ version: 1, status: "ok", response });
    expect(result.stdout).not.toContain(prompt);
    const trace = JSON.parse(await readFile(fixture.tracePath, "utf8"));
    expect(trace.constructor).toMatchObject({
      model: "configured-model",
      provider: "openai-codex",
      requested_provider: "openai-codex",
      api_mode: "codex_responses",
      base_url: "https://resolved.invalid/v1",
      enabled_toolsets: [],
      save_trajectories: false,
      quiet_mode: true,
      skip_context_files: true,
      skip_memory: true,
      skip_background_review: true,
      session_db: null,
      checkpoints_enabled: false,
    });
    expect(trace.runtimeArguments).toEqual({ requested: "configured-provider" });
    expect(trace.sourceConfigHome).toBe(fixture.root);
    expect(trace.runtimeHome).not.toBe(fixture.root);
    expect(trace.runtimeConfig).toEqual({
      context: { engine: "compressor" },
      hooks: {},
      plugins: { enabled: [] },
    });
    expect(JSON.stringify(trace.runtimeConfig)).not.toContain("private-source-config-field");
    expect(trace.pluginSideEffects).toEqual({
      hooks: 0,
      middleware: 0,
      plugins: 0,
      tools: 0,
    });
    expect(trace.apiKeyMatches).toBe(true);
    expect(trace.credentialPoolMatches).toBe(true);
    expect(trace.initialPersistence).toEqual({
      persistDisabled: false,
      sessionDbIsNone: false,
      sessionJsonEnabled: true,
    });
    expect(trace.initialSkipMcpRefresh).toBe(false);
    expect(trace.providerPersistence).toEqual({
      persistDisabled: true,
      sessionDbIsNone: true,
      sessionJsonEnabled: false,
    });
    expect(trace.providerSkipMcpRefresh).toBe(true);
    expect(trace.configLoads).toBe(1);
    expect(trace.runtimeCalls).toBe(1);
    expect(trace.agentConstructions).toBe(1);
    expect(trace.constructor).not.toHaveProperty("disabled_toolsets");
    expect(trace.constructor).not.toHaveProperty("command");
    expect(trace.constructor).not.toHaveProperty("args");
    expect(trace.constructor).not.toHaveProperty("acp_command");
    expect(trace.constructor).not.toHaveProperty("acp_args");
    expect(trace.constructor).not.toHaveProperty("api_key");
    expect(trace.constructor).not.toHaveProperty("credential_pool");
    expect(trace.providerCalls).toBe(1);
    expect(trace.closed).toBe(true);
  });

  it("fails closed when the built-in context compressor identity cannot be proven", async () => {
    const fixture = await fakeHermesRuntime();
    const result = runRunner(fixture, {
      FAKE_CONTEXT_COMPRESSOR_DRIFT: "1",
      FAKE_RESPONSE: response,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(parseResultFrame(result.stdout)).toEqual({ version: 1, status: "rejected" });
    const trace = JSON.parse(await readFile(fixture.tracePath, "utf8"));
    expect(trace.agentConstructions).toBe(1);
    expect(trace.providerCalls).toBe(0);
    expect(trace.closed).toBe(true);
  });

  it("fails closed before constructing an agent when Hermes config loading fails", async () => {
    const fixture = await fakeHermesRuntime();
    const result = runRunner(fixture, { FAKE_CONFIG_FAILURE: "1", FAKE_RESPONSE: response });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(parseResultFrame(result.stdout)).toEqual({ version: 1, status: "rejected" });
    const trace = JSON.parse(await readFile(fixture.tracePath, "utf8"));
    expect(trace.configLoads).toBe(1);
    expect(trace.runtimeCalls).toBe(0);
    expect(trace.agentConstructions).toBe(0);
    expect(trace.providerCalls).toBe(0);
  });

  it("fails closed before constructing an agent when runtime resolution fails", async () => {
    const fixture = await fakeHermesRuntime();
    const result = runRunner(fixture, { FAKE_RUNTIME_FAILURE: "1", FAKE_RESPONSE: response });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(parseResultFrame(result.stdout)).toEqual({ version: 1, status: "rejected" });
    const trace = JSON.parse(await readFile(fixture.tracePath, "utf8"));
    expect(trace.configLoads).toBe(1);
    expect(trace.runtimeCalls).toBe(1);
    expect(trace.agentConstructions).toBe(0);
    expect(trace.providerCalls).toBe(0);
  });

  for (const testCase of [
    {
      name: "a runtime command",
      environment: { FAKE_RUNTIME_COMMAND: "/resolved/provider-command" },
    },
    {
      name: "nonempty runtime arguments",
      environment: { FAKE_RUNTIME_ARGS: JSON.stringify(["--resolved-arg"]) },
    },
    {
      name: "malformed runtime arguments",
      environment: { FAKE_RUNTIME_ARGS: JSON.stringify("--resolved-arg") },
    },
    {
      name: "the copilot-acp provider",
      environment: { FAKE_RUNTIME_PROVIDER: "copilot-acp" },
    },
    {
      name: "an ACP API transport",
      environment: { FAKE_RUNTIME_API_MODE: "acp_stdio" },
    },
  ]) {
    it(`fails closed before constructing an agent for ${testCase.name}`, async () => {
      const fixture = await fakeHermesRuntime();
      const result = runRunner(fixture, {
        ...testCase.environment,
        FAKE_RESPONSE: response,
      });

      expect(result.status).toBe(0);
      expect(result.stderr).toBe("");
      expect(parseResultFrame(result.stdout)).toEqual({ version: 1, status: "rejected" });
      const trace = JSON.parse(await readFile(fixture.tracePath, "utf8"));
      expect(trace.runtimeCalls).toBe(1);
      expect(trace.agentConstructions).toBe(0);
      expect(trace.providerCalls).toBe(0);
    });
  }

  it("rejects nonempty effective tools before calling the fake provider", async () => {
    const fixture = await fakeHermesRuntime();
    const result = runRunner(fixture, { FAKE_RESPONSE: response, FAKE_TOOLS: "filesystem" });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(parseResultFrame(result.stdout)).toEqual({ version: 1, status: "rejected" });
    const trace = JSON.parse(await readFile(fixture.tracePath, "utf8"));
    expect(trace.providerCalls).toBe(0);
    expect(trace.closed).toBe(true);
  });

  it("rejects provider tool-call metadata instead of forwarding a valid-looking allow decision", async () => {
    const fixture = await fakeHermesRuntime();
    const result = runRunner(fixture, { FAKE_RESPONSE: response, FAKE_TOOL_METADATA: "1" });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(parseResultFrame(result.stdout)).toEqual({ version: 1, status: "rejected" });
    expect(result.stdout).not.toContain("tool_calls");
  });

  it("rejects tool metadata embedded in the provider response", async () => {
    const fixture = await fakeHermesRuntime();
    const result = runRunner(fixture, {
      FAKE_RESPONSE: JSON.stringify({ ...JSON.parse(response), tool_result: "private" }),
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(parseResultFrame(result.stdout)).toEqual({ version: 1, status: "rejected" });
    expect(result.stdout).not.toContain("tool_result");
  });

  it("fails closed when Hermes persistence isolation drifts during provider execution", async () => {
    const fixture = await fakeHermesRuntime();
    const result = runRunner(fixture, {
      FAKE_PERSISTENCE_DRIFT: "1",
      FAKE_RESPONSE: response,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(parseResultFrame(result.stdout)).toEqual({ version: 1, status: "rejected" });
    const trace = JSON.parse(await readFile(fixture.tracePath, "utf8"));
    expect(trace.providerPersistence).toEqual({
      persistDisabled: true,
      sessionDbIsNone: true,
      sessionJsonEnabled: false,
    });
    expect(trace.providerCalls).toBe(1);
    expect(trace.closed).toBe(true);
  });

  it("fails closed when the hard-disabled MCP refresh setting drifts during provider execution", async () => {
    const fixture = await fakeHermesRuntime();
    const result = runRunner(fixture, {
      FAKE_MCP_REFRESH_DRIFT: "1",
      FAKE_RESPONSE: response,
    });

    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");
    expect(parseResultFrame(result.stdout)).toEqual({ version: 1, status: "rejected" });
    const trace = JSON.parse(await readFile(fixture.tracePath, "utf8"));
    expect(trace.initialSkipMcpRefresh).toBe(false);
    expect(trace.providerSkipMcpRefresh).toBe(true);
    expect(trace.providerCalls).toBe(1);
    expect(trace.closed).toBe(true);
  });
});

async function fakeHermesRuntime(): Promise<{ root: string; tracePath: string }> {
  const root = await mkdtemp(join(tmpdir(), "skyturn-hermes-review-runner-"));
  roots.push(root);
  const tracePath = join(root, "trace.json");
  const hermesCliRoot = join(root, "hermes_cli");
  const agentRoot = join(root, "agent");
  await mkdir(hermesCliRoot);
  await mkdir(agentRoot);
  await writeFile(join(root, "config.yaml"), JSON.stringify({
    context: { engine: "malicious-context-engine" },
    hooks: { pre_llm_call: [{ command: "private-source-hook" }] },
    mcp_servers: { private: { command: "private-source-mcp" } },
    memory: { provider: "private-source-memory" },
    model: { default: "configured-model", provider: "configured-provider" },
    plugins: { enabled: ["private-source-plugin"] },
    sourceSecret: "private-source-config-field",
    toolsets: ["private-source-toolset"],
  }));
  await writeFile(tracePath, JSON.stringify({
    configLoads: 0,
    runtimeCalls: 0,
    runtimeArguments: null,
    agentConstructions: 0,
    providerCalls: 0,
    pluginSideEffects: { hooks: 0, middleware: 0, plugins: 0, tools: 0 },
    closed: false,
  }));
  await writeFile(join(root, "fake_trace.py"), [
    "import json",
    "import os",
    "",
    "TRACE_PATH = os.environ['FAKE_TRACE_PATH']",
    "",
    "def read_trace():",
    "    with open(TRACE_PATH, 'r', encoding='utf-8') as handle:",
    "        return json.load(handle)",
    "",
    "def write_trace(value):",
    "    with open(TRACE_PATH, 'w', encoding='utf-8') as handle:",
    "        json.dump(value, handle, sort_keys=True)",
  ].join("\n"));
  await writeFile(join(root, "yaml.py"), [
    "import json",
    "",
    "def safe_dump(value, stream, **kwargs):",
    "    json.dump(value, stream, sort_keys=kwargs.get('sort_keys', False), separators=(',', ':'))",
    "    stream.write('\\n')",
  ].join("\n"));
  await writeFile(join(hermesCliRoot, "__init__.py"), "");
  await writeFile(join(hermesCliRoot, "config.py"), [
    "import json",
    "import os",
    "from fake_trace import read_trace, write_trace",
    "",
    "def _read_config():",
    "    with open(os.path.join(os.environ['HERMES_HOME'], 'config.yaml'), 'r', encoding='utf-8') as handle:",
    "        return json.load(handle)",
    "",
    "def load_config():",
    "    trace = read_trace()",
    "    trace['configLoads'] += 1",
    "    trace['sourceConfigHome'] = os.environ['HERMES_HOME']",
    "    write_trace(trace)",
    "    if os.environ.get('FAKE_CONFIG_FAILURE'):",
    "        raise RuntimeError('private config failure')",
    "    return _read_config()",
    "",
    "def load_config_readonly():",
    "    config = _read_config()",
    "    trace = read_trace()",
    "    trace['runtimeHome'] = os.environ['HERMES_HOME']",
    "    trace['runtimeConfig'] = config",
    "    write_trace(trace)",
    "    return config",
  ].join("\n"));
  await writeFile(join(hermesCliRoot, "runtime_provider.py"), [
    "import json",
    "import os",
    "from fake_trace import read_trace, write_trace",
    "",
    "CREDENTIAL_POOL = object()",
    "",
    "def resolve_runtime_provider(**kwargs):",
    "    trace = read_trace()",
    "    trace['runtimeCalls'] += 1",
    "    trace['runtimeArguments'] = kwargs",
    "    write_trace(trace)",
    "    if os.environ.get('FAKE_RUNTIME_FAILURE'):",
    "        raise RuntimeError('private runtime failure')",
    "    return {",
    "        'provider': os.environ.get('FAKE_RUNTIME_PROVIDER', 'openai-codex'),",
    "        'requested_provider': 'openai-codex',",
    "        'api_mode': os.environ.get('FAKE_RUNTIME_API_MODE', 'codex_responses'),",
    "        'base_url': 'https://resolved.invalid/v1',",
    "        'api_key': 'private-runtime-key',",
    "        'credential_pool': CREDENTIAL_POOL,",
    "        'command': os.environ.get('FAKE_RUNTIME_COMMAND'),",
    "        'args': json.loads(os.environ.get('FAKE_RUNTIME_ARGS', '[]')),",
    "    }",
  ].join("\n"));
  await writeFile(join(agentRoot, "__init__.py"), "");
  await writeFile(join(agentRoot, "context_compressor.py"), [
    "class ContextCompressor:",
    "    pass",
    "",
    "class PluginContextCompressor:",
    "    pass",
  ].join("\n"));
  await writeFile(join(hermesCliRoot, "plugins.py"), [
    "from fake_trace import read_trace, write_trace",
    "from hermes_cli.config import load_config_readonly",
    "",
    "class PluginManager:",
    "    def __init__(self):",
    "        self.hooks = set()",
    "        self.middleware = set()",
    "        self.plugins = []",
    "        self.tools = 0",
    "    def discover_and_load(self):",
    "        config = load_config_readonly()",
    "        enabled = config.get('plugins', {}).get('enabled', [])",
    "        hooks = config.get('hooks', {})",
    "        self.plugins = [{'enabled': True, 'tools': 1, 'hooks': 1, 'middleware': 1, 'commands': 0}] if enabled else []",
    "        self.hooks = set(hooks.keys())",
    "        self.tools = len(config.get('toolsets', [])) + len(config.get('mcp_servers', {}))",
    "        trace = read_trace()",
    "        trace['pluginSideEffects'] = {'hooks': len(self.hooks), 'middleware': len(self.middleware), 'plugins': len(self.plugins), 'tools': self.tools}",
    "        write_trace(trace)",
    "    def list_plugins(self):",
    "        return self.plugins",
    "    def has_hook(self, name):",
    "        return name in self.hooks",
    "    def has_middleware(self, name):",
    "        return name in self.middleware",
    "    def get_slack_action_handlers(self):",
    "        return []",
    "    def has_portable_mcp_servers(self):",
    "        return self.tools > 0",
    "",
    "MANAGER = PluginManager()",
    "VALID_HOOKS = {'pre_llm_call', 'post_llm_call', 'pre_tool_call', 'post_tool_call'}",
    "",
    "def get_plugin_manager():",
    "    return MANAGER",
  ].join("\n"));
  await writeFile(join(hermesCliRoot, "middleware.py"), [
    "VALID_MIDDLEWARE = {'tool_request', 'tool_execution', 'llm_request', 'llm_execution'}",
  ].join("\n"));
  await writeFile(join(root, "run_agent.py"), [
    "import os",
    "from agent.context_compressor import ContextCompressor, PluginContextCompressor",
    "from fake_trace import read_trace, write_trace",
    "from hermes_cli.config import load_config_readonly",
    "from hermes_cli.plugins import get_plugin_manager",
    "from hermes_cli.runtime_provider import CREDENTIAL_POOL",
    "",
    "class AIAgent:",
    "    def __init__(self, **kwargs):",
    "        self._persist_disabled = False",
    "        self._session_db = object()",
    "        self._session_json_enabled = True",
    "        self._skip_mcp_refresh = False",
    "        self.context_compressor = PluginContextCompressor() if os.environ.get('FAKE_CONTEXT_COMPRESSOR_DRIFT') else ContextCompressor()",
    "        self.tools = [] if not os.environ.get('FAKE_TOOLS') else [{'function': {'name': os.environ['FAKE_TOOLS']}}]",
    "        self.valid_tool_names = set() if not self.tools else {os.environ['FAKE_TOOLS']}",
    "        load_config_readonly()",
    "        get_plugin_manager().discover_and_load()",
    "        self.trace = read_trace()",
    "        self.trace['agentConstructions'] += 1",
    "        self.trace['constructor'] = {key: value for key, value in kwargs.items() if not callable(value) and key not in {'api_key', 'credential_pool'}}",
    "        self.trace['apiKeyMatches'] = kwargs.get('api_key') == 'private-runtime-key'",
    "        self.trace['credentialPoolMatches'] = kwargs.get('credential_pool') is CREDENTIAL_POOL",
    "        self.trace['initialPersistence'] = {'persistDisabled': self._persist_disabled, 'sessionDbIsNone': self._session_db is None, 'sessionJsonEnabled': self._session_json_enabled}",
    "        self.trace['initialSkipMcpRefresh'] = self._skip_mcp_refresh",
    "        write_trace(self.trace)",
    "    def run_conversation(self, prompt):",
    "        self.trace['providerCalls'] += 1",
    "        self.trace['providerPersistence'] = {'persistDisabled': self._persist_disabled, 'sessionDbIsNone': self._session_db is None, 'sessionJsonEnabled': self._session_json_enabled}",
    "        self.trace['providerSkipMcpRefresh'] = self._skip_mcp_refresh",
    "        write_trace(self.trace)",
    "        if os.environ.get('FAKE_PERSISTENCE_DRIFT'):",
    "            self._session_json_enabled = True",
    "        if os.environ.get('FAKE_MCP_REFRESH_DRIFT'):",
    "            self._skip_mcp_refresh = False",
    "        messages = [{'role': 'assistant', 'content': os.environ['FAKE_RESPONSE']}]",
    "        if os.environ.get('FAKE_TOOL_METADATA'):",
    "            messages[0]['tool_calls'] = [{'id': 'call-1', 'function': {'name': 'filesystem'}}]",
    "        return {'final_response': os.environ['FAKE_RESPONSE'], 'messages': messages, 'completed': True, 'failed': False, 'interrupted': False}",
    "    def close(self):",
    "        self.trace['closed'] = True",
    "        write_trace(self.trace)",
  ].join("\n"));
  return { root, tracePath };
}

function runRunner(
  fixture: { root: string; tracePath: string },
  extraEnv: Record<string, string>,
) {
  return spawnSync(pythonPath, [runnerPath], {
    cwd: fixture.root,
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin",
      HOME: fixture.root,
      TMPDIR: fixture.root,
      DARWIN_USER_TEMP_DIR: fixture.root,
      PYTHONPATH: fixture.root,
      HERMES_HOME: fixture.root,
      HERMES_SAFE_MODE: "1",
      FAKE_TRACE_PATH: fixture.tracePath,
      ...extraEnv,
    },
    input: prompt,
    shell: false,
    timeout: 10_000,
  });
}

function parseResultFrame(value: string): unknown {
  const match = /^SKYTURN_HERMES_REVIEW_V1 ([0-9]+)\n/.exec(value);
  expect(match).not.toBeNull();
  const payload = value.slice(match![0].length);
  expect(Buffer.byteLength(payload)).toBe(Number(match![1]));
  return JSON.parse(payload);
}
