# Prepare the optional Hermes Linux image

Image preparation is an explicit developer operation. It leaves the existing native Hermes path unchanged. This slice does not launch containers, integrate a Docker adapter, configure Hermes, log in to a provider, or establish runtime/planner readiness.

## Review the pinned image

[`hermes-image.json`](../packages/agent-bridge/runtime/hermes-image.json) pins the official `docker.io/nousresearch/hermes-agent` Linux/amd64 manifest to `sha256:a11574b7fe8e1631d7d88d556677dac693bc058abf558cdeb899155688c1bf05`. Its config/image ID is `sha256:02e7aa0e84123fa0e9b22686e7a2bfb7d85fd59821d4d28812a3e07f3061cf41`.

The saved registry manifest/config declare only `/opt/data` as a volume, `/opt/hermes/docker/entrypoint-dispatch.sh` as the entrypoint, `root` as the image user, and `/opt/hermes` as the working directory. OCI labels are empty; no source revision or version is asserted. Mutable tags were used only for discovery. Preparation always pulls and inspects the immutable manifest reference; it never resolves a tag.

## Supply an explicit local daemon and private root

Use a trusted, absolute, canonical Docker executable path and a canonical `unix:///absolute/socket` endpoint. Every path component must exist without symlinks and be owned by the current user or root. Executable and directory components must not be group/world writable; root-owned sticky temporary ancestors are allowed. The executable must be a regular executable file without setuid/setgid bits. The endpoint must actually be a Unix socket. Remote endpoints and Docker contexts are unavailable through this command.

Provide an existing, dedicated, persistent state root owned by the current user with mode `0700`. Placement outside every imported project, native Hermes home, and existing Docker configuration is an operator obligation. The implementation validates canonical components, ownership, and permissions; it does not discover arbitrary Hermes homes or project roots, or read global configuration/environment to locate them. Passing one of those directories explicitly would create preparation state inside it. The command does not create or chmod the requested root or alter unrelated state. Obtain the expected daemon ID separately through a trusted operator check; this command never learns and silently accepts an identity.

### Prepare a private executable path on macOS

`/Applications` is normally `root:admin 0775`, so the standard `/Applications/Docker.app/Contents/Resources/bin/docker` execution path is intentionally rejected. A group-writable ancestor such as `/Volumes/HDD` with mode `0775` is also rejected. Do not chmod either shared directory or relax the checks.

An operator may copy **only the trusted Docker executable** byte-for-byte into a new owned `0700` `bin` directory beneath a private canonical root. First review the source's trust and canonical path and every existing destination ancestor's ownership and permissions. For example, `/Users/DEVELOPER/.skyturn-hermes-runtime` can hold persistent private state if its ancestors satisfy the rules above and it is outside all imported projects and Hermes homes. Replace `DEVELOPER` with the reviewed canonical user-directory component; do not substitute a group-writable volume path.

After that review, the following operator-only example creates a new root, private binary directory, and preparation root. It fails if the root already exists; the copy also refuses an existing destination. It copies no Docker.app bundle, configuration, credentials, or Hermes files:

```sh
(
  set -eu
  umask 077
  docker_source='/Applications/Docker.app/Contents/Resources/bin/docker'
  private_root='/Users/DEVELOPER/.skyturn-hermes-runtime'
  mkdir -m 700 "$private_root"
  mkdir -m 700 "$private_root/bin" "$private_root/preparation"
  node --input-type=module - "$docker_source" "$private_root/bin/docker" <<'NODE'
import { constants } from "node:fs";
import { copyFile } from "node:fs/promises";
await copyFile(process.argv[2], process.argv[3], constants.COPYFILE_EXCL);
NODE
  chmod 0700 "$private_root/bin/docker"
  cmp "$docker_source" "$private_root/bin/docker"
  /usr/bin/shasum -a 256 "$docker_source" "$private_root/bin/docker"
)
```

Require `cmp` to succeed and both complete SHA-256 values to match before using the private copy. Use `/Users/DEVELOPER/.skyturn-hermes-runtime/bin/docker` as `--docker-executable` and `/Users/DEVELOPER/.skyturn-hermes-runtime/preparation` as `--state-root`. Leave any partial preparation in place for inspection on failure; do not overwrite it on retry. This relocation alternative still requires parent real validation and is not proven by the offline tests.

The source, copy, private state, and daemon remain within same-UID and administrator host trust. A process with the same UID or an administrator can alter them. Private paths and byte/hash equality establish no host-code isolation and do not authenticate an untrusted source binary.

### Invoke preparation after prerequisites are resolved

Resolve daemon/VM storage capacity before another pull after an overlayfs extraction `ENOSPC` failure. A reaped client that exits nonzero proves process completion, not image availability. Keep further pulls blocked until the operator resolves storage; shared Docker/VM changes and provider/credential decisions remain separately authorized operations.

From the repository root, replace each placeholder with the reviewed local value:

```sh
pnpm --filter @skyturn/agent-bridge run hermes:image:prepare \
  --docker-executable '/absolute/canonical/docker' \
  --docker-host 'unix:///absolute/canonical/docker.sock' \
  --expected-daemon-id 'EXPECTED_DAEMON_ID' \
  --state-root '/absolute/private/hermes-image-preparation'
```

The equivalent direct command, without pnpm, is:

```sh
node packages/agent-bridge/scripts/prepareHermesRuntimeImage.mjs \
  --docker-executable '/absolute/canonical/docker' \
  --docker-host 'unix:///absolute/canonical/docker.sock' \
  --expected-daemon-id 'EXPECTED_DAEMON_ID' \
  --state-root '/absolute/private/hermes-image-preparation'
```

Preparation creates one owned `0700` `hermes-image-*` directory beneath that root with fresh empty `home` and `docker-config` directories. Every CLI invocation receives explicit `--host` and `--config` arguments, that private working directory, and only `HOME`, `DOCKER_CONFIG`, a fixed system `PATH`, `LANG`, and `LC_ALL`. It reads no existing Docker/Hermes configuration, auth files, credentials, proxy variables, or parent environment. Public registry pull is anonymous; authentication failure requires separate review, not credential reuse.

The complete Docker command sequence is `info --format '{{json .ID}}'`, `pull --quiet --platform linux/amd64 <pinned-reference>`, the same `info` again, and `image inspect <pinned-reference>`. Both identities must match the supplied ID. Inspection must match the immutable repo digest (with or without Docker Hub's `docker.io/` prefix), image ID, OS/architecture, volume, entrypoint, empty labels, user, and working directory. No `run`, `start`, `exec`, `create`, `build`, `login`, removal, or prune operation is available.

Normal commands have a 60-second deadline, including cold image inspection; pull has a 20-minute deadline. Each stdout/stderr stream is limited to 1 MiB. Timeout, abort, process error, and overflow share one kill attempt and wait for actual child `close`, which includes stdio completion. If killing fails or returns false, preparation continues waiting for `close`; no cleanup timeout, exit-code polling, or early success replaces reaping. Interruptions of the pull client do not promise cancellation of daemon-side downloads.

Success prints one JSON object with `status: "prepared"`, `preparationOnly: true`, `runtimeReady: false`, `plannerReady: false`, the pin, the expected `daemonId`, and `evidenceDirectory`. Failures exit nonzero and print sanitized JSON to stderr. The retained `0600` `preparation.json` records command stages, close/exit facts, bounded byte counts, and sanitized failure codes; it never stores raw CLI output or arbitrary error messages. A failure to write evidence is reported as `evidencePersisted: false`. Existing-state validation failures create no preparation directory. Created directories and pulled images are retained on success and failure; there is no automatic deletion or prune.

`preparation.json` is mutable local diagnostic evidence. Writes use neither fsync nor atomic replacement, so the file is not an authoritative or crash-durable preparation receipt. Its private permissions do not prevent changes by the same UID or an administrator.

## Keep the remaining gates separate

| Gate | Evidence still required |
| --- | --- |
| Image preparation | A real invocation of the command above against the reviewed daemon, plus matching retained evidence. Offline tests alone cannot prove the image is present. |
| Normal bootstrap | A separately authorized container launch using the official entrypoint and a new dedicated `/opt/data` home. Preparation performs no bootstrap. |
| Provider login | Explicit login/configuration inside that independent Hermes home. Never copy native Hermes credentials, sessions, configuration, or Docker auth into it. |
| Supervisor security | Review actual mounts, environment allowlist, user/capabilities, network policy, Docker socket exposure, cancellation/reaping, private persistence, and recovery before enabling execution. The image declares `root`; its digest, daemon identity, and `0700` preparation files do not establish container isolation. The trusted Docker executable and daemon retain host authority. |
| Adapter integration | Separate adapter/settings work with real lifecycle, failure, artifact, evidence, and reopen acceptance. Preparation does not change discovery or native adapter selection. |
| Full planner | The real Hermes-to-Codex workflow, including `pnpm --filter @skyturn/desktop run demo:mvp` under the selected runtime, independent checks, and planner completion evidence. An image pull is not planner acceptance. |

## Run offline checks

```sh
node --check packages/agent-bridge/scripts/prepareHermesRuntimeImage.mjs
node --check packages/agent-bridge/scripts/prepareHermesRuntimeImage.test.mjs
node --test packages/agent-bridge/scripts/prepareHermesRuntimeImage.test.mjs
git diff --check
```

The package's existing test command also includes these tests. They use Node stdlib only, injected child processes, real private filesystem fixtures, and a socket-type fixture without creating or connecting to sockets. Tests requiring POSIX ownership, permissions, or Unix socket paths explicitly skip on Windows; the platform-independent CLI invalid-argument test still runs there. This is proactive generic package-test portability work, not evidence of a current Windows CI failure; Windows CI uses the separate `test:windows` command. The CLI exposes no test bypass flags.
