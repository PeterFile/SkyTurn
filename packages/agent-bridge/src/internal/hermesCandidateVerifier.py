#!/usr/bin/env python3
"""Run one isolated, zero-tool Hermes candidate review turn."""

import json
import os
import sys


MAX_PROMPT_BYTES = 24 * 1024 * 1024
MAX_RESPONSE_BYTES = 1024
FRAME_PREFIX = b"SKYTURN_HERMES_REVIEW_V1 "
TOOL_METADATA_KEYS = {
    "function_call",
    "function_calls",
    "tool_call",
    "tool_calls",
    "tool_call_id",
    "tool_result",
    "tool_results",
}


def _write_frame(output, payload):
    encoded = json.dumps(
        payload,
        ensure_ascii=True,
        separators=(",", ":"),
        sort_keys=False,
    ).encode("ascii")
    output.write(FRAME_PREFIX + str(len(encoded)).encode("ascii") + b"\n" + encoded)
    output.flush()


def _contains_tool_metadata(value, depth=0, visited=None):
    if depth > 32:
        return True
    if visited is None:
        visited = set()
    if isinstance(value, (dict, list, tuple)):
        identity = id(value)
        if identity in visited:
            return False
        if len(visited) >= 4096:
            return True
        visited.add(identity)
    if isinstance(value, dict):
        for key, item in value.items():
            normalized_key = str(key).strip().lower().replace("-", "_")
            if normalized_key in TOOL_METADATA_KEYS:
                return True
            if normalized_key == "role" and item == "tool":
                return True
            if _contains_tool_metadata(item, depth + 1, visited):
                return True
        return False
    if isinstance(value, (list, tuple)):
        return any(_contains_tool_metadata(item, depth + 1, visited) for item in value)
    return False


def _is_strict_decision(value):
    if not isinstance(value, dict) or list(value.keys()) != [
        "version",
        "requestSha256",
        "manifestSha256",
        "disposition",
    ]:
        return False
    if value.get("version") != 1 or value.get("disposition") not in {"allow", "block"}:
        return False
    for key in ("requestSha256", "manifestSha256"):
        digest = value.get(key)
        if not isinstance(digest, str) or len(digest) != 64:
            return False
        if any(character not in "0123456789abcdef" for character in digest):
            return False
    return not _contains_tool_metadata(value)


def _is_acp_transport(value):
    if not isinstance(value, str):
        return False
    normalized = value.strip().lower().replace("_", "-").replace("/", "-")
    return "acp" in normalized.split("-")


def _is_external_process_runtime(runtime):
    command = runtime.get("command")
    args = runtime.get("args")
    provider = runtime.get("provider")
    if isinstance(command, str) and command:
        return True
    if args is not None and (not isinstance(args, list) or len(args) != 0):
        return True
    if (
        isinstance(provider, str)
        and provider.strip().lower().replace("_", "-") == "copilot-acp"
    ):
        return True
    return _is_acp_transport(runtime.get("api_mode"))


def _create_runtime_home():
    import yaml

    requested_scratch = os.environ.get("TMPDIR", "")
    if not requested_scratch or not os.path.isabs(requested_scratch):
        return None
    scratch_root = os.path.realpath(requested_scratch)
    if not os.path.isdir(scratch_root):
        return None
    runtime_home = os.path.join(scratch_root, "hermes-runtime-home")
    os.mkdir(runtime_home, mode=0o700)
    config = {
        "context": {"engine": "compressor"},
        "hooks": {},
        "plugins": {"enabled": []},
    }
    config_path = os.path.join(runtime_home, "config.yaml")
    with open(config_path, "x", encoding="utf-8", newline="\n") as handle:
        yaml.safe_dump(
            config,
            handle,
            allow_unicode=False,
            default_flow_style=False,
            sort_keys=True,
        )
    os.chmod(config_path, 0o600)
    os.environ["HERMES_HOME"] = runtime_home
    return runtime_home


def _has_plugin_side_effects():
    from hermes_cli.middleware import VALID_MIDDLEWARE
    from hermes_cli.plugins import VALID_HOOKS, get_plugin_manager

    manager = get_plugin_manager()
    plugins = manager.list_plugins()
    if not isinstance(plugins, list):
        return True
    for plugin in plugins:
        if not isinstance(plugin, dict):
            return True
        if plugin.get("enabled") is True:
            return True
        for key in ("tools", "hooks", "middleware", "commands"):
            if plugin.get(key, 0) != 0:
                return True
    if any(manager.has_hook(name) for name in VALID_HOOKS):
        return True
    if any(manager.has_middleware(name) for name in VALID_MIDDLEWARE):
        return True
    if manager.get_slack_action_handlers():
        return True
    return manager.has_portable_mcp_servers()


def _run_review(prompt):
    if os.environ.get("HERMES_SAFE_MODE") != "1":
        return None

    from hermes_cli.config import load_config
    from hermes_cli.runtime_provider import resolve_runtime_provider
    config = load_config()
    if not isinstance(config, dict):
        return None
    model_config = config.get("model")
    model = ""
    configured_provider = None
    if isinstance(model_config, dict):
        model = str(model_config.get("default") or "")
        configured_provider = model_config.get("provider")
    elif isinstance(model_config, str) and model_config.strip():
        model = model_config.strip()
    runtime = resolve_runtime_provider(requested=configured_provider)
    if not isinstance(runtime, dict) or _is_external_process_runtime(runtime):
        return None
    if _create_runtime_home() is None:
        return None

    from agent.context_compressor import ContextCompressor
    from run_agent import AIAgent

    tool_attempted = [False]

    def reject_tool_event(*_args, **_kwargs):
        tool_attempted[0] = True

    agent = None
    response = None
    clean_close = True
    try:
        agent = AIAgent(
            model=model,
            provider=runtime.get("provider"),
            requested_provider=runtime.get("requested_provider"),
            api_mode=runtime.get("api_mode"),
            base_url=runtime.get("base_url"),
            api_key=runtime.get("api_key"),
            credential_pool=runtime.get("credential_pool"),
            enabled_toolsets=[],
            save_trajectories=False,
            quiet_mode=True,
            skip_context_files=True,
            skip_memory=True,
            skip_background_review=True,
            session_db=None,
            checkpoints_enabled=False,
            max_iterations=1,
            max_tokens=512,
            platform="skyturn-review",
            tool_start_callback=reject_tool_event,
            tool_complete_callback=reject_tool_event,
        )
        agent._skip_mcp_refresh = True
        agent._persist_disabled = True
        agent._session_db = None
        agent._session_json_enabled = False
        if (
            agent._persist_disabled is not True
            or agent._skip_mcp_refresh is not True
            or agent._session_db is not None
            or agent._session_json_enabled is not False
            or type(agent.context_compressor) is not ContextCompressor
            or ContextCompressor.__module__ != "agent.context_compressor"
            or getattr(agent, "_memory_manager", None) is not None
            or agent.tools != []
            or agent.valid_tool_names != set()
            or _has_plugin_side_effects()
        ):
            return None
        result = agent.run_conversation(prompt)
        if (
            agent._persist_disabled is not True
            or agent._skip_mcp_refresh is not True
            or agent._session_db is not None
            or agent._session_json_enabled is not False
            or type(agent.context_compressor) is not ContextCompressor
            or ContextCompressor.__module__ != "agent.context_compressor"
            or getattr(agent, "_memory_manager", None) is not None
            or agent.tools != []
            or agent.valid_tool_names != set()
            or tool_attempted[0]
            or not isinstance(result, dict)
            or result.get("completed") is not True
            or result.get("failed") is not False
            or result.get("interrupted") is not False
            or result.get("cleanup_errors")
            or _contains_tool_metadata(result)
        ):
            return None
        candidate = result.get("final_response")
        if not isinstance(candidate, str):
            return None
        encoded = candidate.encode("utf-8", errors="strict")
        if not encoded or len(encoded) > MAX_RESPONSE_BYTES:
            return None
        if not _is_strict_decision(json.loads(candidate)):
            return None
        response = candidate
    finally:
        if agent is not None:
            try:
                agent.close()
            except BaseException:
                clean_close = False
    return response if clean_close else None


def main():
    result_output = os.fdopen(os.dup(sys.stdout.fileno()), "wb", closefd=True)
    null_fd = os.open(os.devnull, os.O_WRONLY)
    try:
        os.dup2(null_fd, sys.stdout.fileno())
        os.dup2(null_fd, sys.stderr.fileno())
    finally:
        os.close(null_fd)

    payload = {"version": 1, "status": "rejected"}
    try:
        prompt_bytes = sys.stdin.buffer.read(MAX_PROMPT_BYTES + 1)
        if 0 < len(prompt_bytes) <= MAX_PROMPT_BYTES and b"\x00" not in prompt_bytes:
            prompt = prompt_bytes.decode("utf-8", errors="strict")
            response = _run_review(prompt)
            if response is not None:
                payload = {"version": 1, "status": "ok", "response": response}
    except BaseException:
        payload = {"version": 1, "status": "rejected"}
    _write_frame(result_output, payload)
    result_output.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
