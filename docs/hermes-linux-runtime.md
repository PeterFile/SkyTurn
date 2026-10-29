# Prepare the optional Hermes Linux image

Image preparation is an explicit developer operation. It leaves the existing native Hermes path unchanged. The preparation command does not launch containers, integrate a Docker adapter, configure Hermes, log in to a provider, or establish runtime/planner readiness. The separate [experimental lifecycle acceptance](#run-the-experimental-lifecycle-acceptance) below launches only fixed no-credential fixtures.

## Review the pinned image

[`hermes-image.json`](../packages/agent-bridge/runtime/hermes-image.json) pins the official `docker.io/nousresearch/hermes-agent` Linux/amd64 manifest to `sha256:a11574b7fe8e1631d7d88d556677dac693bc058abf558cdeb899155688c1bf05`. Its config/image ID is `sha256:02e7aa0e84123fa0e9b22686e7a2bfb7d85fd59821d4d28812a3e07f3061cf41`.

The pin also records the exact manifest descriptor: media type `application/vnd.docker.distribution.manifest.v2+json`, the manifest digest above, and size `8054` bytes. The saved raw registry manifest hashes to that digest and its `config.digest` equals the pinned config ID. The descriptor digest must equal the immutable reference's digest before preparation can create state or launch a command.

Classic Docker stores report the config digest as inspect `Id`. The observed containerd store reports the manifest digest as `Id`, with the manifest `Descriptor`. Preparation accepts the config ID without a descriptor for legacy compatibility. A manifest ID requires the complete pinned descriptor; whenever a descriptor is supplied, including alongside a legacy config ID, it must match exactly. Missing required descriptors, malformed descriptors, conflicting digests, media types, sizes, and additional descriptor fields fail closed. No Docker version-string heuristic selects either identity.

Moby's [containerd inspect implementation](https://github.com/moby/moby/blob/master/daemon/containerd/image_inspect.go#L95-L97) assigns `ID` from `target.Digest.String()` and `Descriptor` from the target. The reviewed source blob was `f16cf09c0e02b737afaada7f95a0f25727eeeb54`; it was not version-matched to Docker `v29.6.2`, whose exact upstream tag was unavailable. The compatibility case is grounded in the retained inspect shape and hashed registry manifest.

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

The complete Docker command sequence is `info --format '{{json .ID}}'`, `pull --quiet --platform linux/amd64 <pinned-reference>`, the same `info` again, and `image inspect <pinned-reference>`. Both daemon identities must match the supplied ID. Inspection must match the immutable repo digest (with or without Docker Hub's `docker.io/` prefix), one of the strict image identities described above, OS/architecture, volume, entrypoint, empty labels, user, and working directory. No `run`, `start`, `exec`, `create`, `build`, `login`, removal, or prune operation is available.

Normal commands have a 60-second deadline, including cold image inspection; pull has a 20-minute deadline. Each stdout/stderr stream is limited to 1 MiB. Timeout, abort, process error, and overflow share one kill attempt and wait for actual child `close`, which includes stdio completion. If killing fails or returns false, preparation continues waiting for `close`; no cleanup timeout, exit-code polling, or early success replaces reaping. Interruptions of the pull client do not promise cancellation of daemon-side downloads.

Success prints one JSON object with `status: "prepared"`, `preparationOnly: true`, `runtimeReady: false`, `plannerReady: false`, the pin, the expected `daemonId`, and `evidenceDirectory`. Failures exit nonzero and print sanitized JSON to stderr. The retained `0600` `preparation.json` records command stages, close/exit facts, bounded byte counts, and sanitized failure codes; it never stores raw CLI output or arbitrary error messages. A failure to write evidence is reported as `evidencePersisted: false`. Existing-state validation failures create no preparation directory. Created directories and pulled images are retained on success and failure; there is no automatic deletion or prune.

The existing `imageId` output field remains the pinned config digest. After all image checks succeed, `inspectedImageId` records the actual local inspect `Id`, and `imageIdentityKind` is `"config"` or `"manifest"`. Both fields are retained in `preparation.json`; a rejected image publishes neither field. A successful image check proves no bootstrap, provider login, adapter, or planner readiness.

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

The package's existing test command also includes these tests. They use Node stdlib only, injected child processes, real private filesystem fixtures, and a socket-type fixture without creating or connecting to sockets. Coverage includes the observed containerd inspect shape, legacy config IDs, strict descriptor and metadata rejection, and the unchanged command, timeout, and close/reap boundaries. Offline success does not prove that real preparation has completed. Tests requiring POSIX ownership, permissions, or Unix socket paths explicitly skip on Windows; the platform-independent CLI invalid-argument test still runs there. This is proactive generic package-test portability work, not evidence of a current Windows CI failure; Windows CI uses the separate `test:windows` command. The CLI exposes no test bypass flags.

## Run the experimental lifecycle acceptance

This independently reviewable developer experiment belongs to AgentBridge. It is a next slice toward #206/#214, not completion of those changes. It does not change production adapters, Electron, native launch permissions, product claims/events, or planner readiness. The product's existing DurableRunClaim remains the future launch authority. The scripts export no package-root API and publish no RunEvidence.

Run only after the parent reviews the executable, socket, expected daemon, private state root, and security protocol. The four explicit preparation arguments and the committed pin use the **same strict validators**, including classic/containerd image identity support. The lifecycle never pulls or authenticates. Every Docker client gets a new empty HOME/config, explicit host/config flags, and the preparation allowlist; host credentials, global Docker configuration, and parent environment variables are unavailable to it.

The parent owns all real Docker operations and independent security review. Replace every placeholder below with reviewed values, including existing private canonical state-parent and scratch directories that satisfy the path rules above. Obtain the expected daemon ID through a trusted operator check. From the repository root, create a **new** acceptance root; the subshell exits before any Docker request if exclusive mkdir fails:

```sh
(
  set -eu
  umask 077
  docker_executable='/absolute/canonical/docker'
  docker_host='unix:///absolute/canonical/docker.sock'
  expected_daemon_id='EXPECTED_DAEMON_ID'
  state_parent='/absolute/private/hermes-container-lifecycle'
  scratch_root='/absolute/private/canonical/scratch'
  state_root="$state_parent/acceptance-state"
  mkdir -m 700 "$state_root"
  TMPDIR="$scratch_root" \
  pnpm --filter @skyturn/agent-bridge run hermes:container:acceptance \
    --docker-executable "$docker_executable" \
    --docker-host "$docker_host" \
    --expected-daemon-id "$expected_daemon_id" \
    --state-root "$state_root"
)
```

The equivalent dependency-free command replaces the pnpm prefix with `node packages/agent-bridge/scripts/acceptHermesContainerLifecycle.mjs`. If the root already exists, inspect it before choosing a new dedicated root; do not overwrite earlier evidence. The placeholders are not usable endpoint evidence. The command validates the supplied executable, socket, private state root, daemon identity, and image before execution; it never relaxes those checks to accommodate an example.

The command runs these real Engine cases serially. Each creates new bounded random names and retains its containers and labelled state volumes. It never touches prior bootstrap resources, removes objects, or prunes.

| Case | Required assertion |
| --- | --- |
| Bootstrap | Official entrypoint, stage2 configuration/PM initialization, privilege drop, normal `hermes --help`, UID/GID 10000, zero permitted/effective/ambient capabilities, and NNP 1. |
| Natural root exit | The fixture forks a real 600-second child, verifies it exists, then exits naturally. Exact daemon readback must show the container exited with PID 0. |
| Cancel and timeout | Wait for a real long-running fixture child; cancellation or a 30-second task deadline must produce confirmed exact-CID cleanup, with a failed task outcome. |
| Controller SIGKILL | Kill a separate real controller after its child fixture is live. Independently inspect the stopped container before recovery; the original owner must have cleaned up despite lost consumers. Only then use cleanup-only reconcile for a fresh durable acknowledgement, asserting no extra start or stop. |
| Create/start response loss | A private Unix HTTP proxy forwards to the reviewed real daemon, drains one successful create/start response, then drops it. The client must actually fail; cleanup must reconcile the real object. No fake runtime facts are substituted. |
| Daemon unavailable | The private proxy closes connections after a real child is live. Cleanup must remain unknown and repeated start must fail closed. Explicitly reconcile the same CID through the parent's reviewed direct socket to the same daemon, without another start. The real daemon is never stopped. |
| Name/ownership conflict | Exclusively create a differently labelled decoy after the owner's absence check. The owner's real create must fail. It must neither start nor stop the decoy; inspect must still show `created`. |

Any fixture, transport-fault, task-outcome, isolation, terminal-readback, or CLI-close assertion failure exits nonzero and records failed acceptance. A healthy real daemon and its immutable image are required; offline substitutes cannot satisfy this command. Successful output means this fixed no-credential experiment passed, not authenticated Hermes chat or planner acceptance. The proxy tests daemon *unreachability* without changing shared daemon settings; simultaneous owner/daemon loss has no immediate-stop guarantee.

### Keep lifecycle and task facts separate

`managedHermesContainer.mjs` starts a detached host owner with a private control pipe and a separate status pipe. The owner validates state and sends `ready`; only controller acknowledgement permits preflight. After persisted identity and absence checks, `armed` requires a second acknowledgement before any create. Docker children receive only ignored stdin and their own stdout/stderr pipes, never the control/status descriptors. EOF, cancel, startup abort, task timeout, and status EPIPE converge on one owner cleanup path. A command already in flight must reach actual `close` before reconciliation; the fixed command deadline may kill the client once, but no kill return value, exit event, or extra cleanup timeout substitutes for close.

Every container uses the immutable pin, normal entrypoint, `--pull never`, `--restart no`, `--init`, network none, a read-only root, no-new-privileges, cap-drop ALL with only CHOWN/DAC_OVERRIDE/SETUID/SETGID/KILL added for bootstrap, private tmpfs `/run` and `/tmp`, and one new labelled `/opt/data` volume. There are no host bind mounts, Docker socket mounts, credentials, alternate entrypoints, guessed venv executables, or fallback runtimes. The inspected dispatcher supports the non-PID1 `--init` path by running stage2 and main-wrapper; no full s6 service tree is claimed. Docker's [create](https://docs.docker.com/reference/cli/docker/container/create/) and [start](https://docs.docker.com/reference/cli/docker/container/start/) are separate operations; client completion alone is not container completion.

Only an exclusive create's full 64-hex CID receipt permits start. The ownership label is independently random and cannot be derived from the visible random resource name. Before a receipt is persisted, cleanup/reconcile can discover an object by the saved name, but must exact-match its CID if known, independent label, image pin, entrypoint, and fixed fixture command. Discovery never authorizes start. A name collision with conflicting ownership is quarantined without stopping it. Missing create receipts, unresolved start acceptance, malformed state, and daemon identity conflicts fail closed.

The supplied state root is **one operation only**: another start is always refused, even after success. PID owner tickets serialize writers and fail conservatively on PID reuse, unreadable/partial tickets, or a still-live owner. These are experimental diagnostic admission records, not product run claims. Reconciliation can use a later exclusive owner ticket only after prior owners are confirmed absent; it can stop the exact owned orphan but never create/start one. It retains previous per-attempt terminal snapshots.

To reconcile a retained operation directory from `acceptance.json`, use the original executable/daemon and a reviewed socket to that same daemon. Replace `--state-root` with that **case's** directory:

```sh
node packages/agent-bridge/scripts/managedHermesContainer.mjs --reconcile hold \
  --docker-executable '/absolute/reviewed/docker' \
  --docker-host 'unix:///reviewed/socket/to-the-same-daemon' \
  --expected-daemon-id 'ORIGINAL_DAEMON_ID' \
  --state-root '/absolute/private/retained-case-directory'
```

The original full launch fingerprint is retained. Cleanup-only recovery can explicitly select another socket that passes the unchanged strict path/socket validators, while the executable, expected daemon ID, and immutable pin must match the original authority fingerprint. The daemon identity is checked before cleanup. For a retained fault-proxy case, use the parent's reviewed direct socket; no proxy needs to be restored and no daemon restart is performed. Endpoint changes never authorize another launch. A partial identity journal requires operator review rather than guessing or relaunching.

`operation.json`, `owner-N.json`, and immutable-per-attempt `terminal-N.json` retain names, identity, CID, intents, sanitized errors, per-command actual close/exit facts, task exit, and cleanup outcome. Journal writes use exclusive private files, file fsync, atomic replacement for updates, and parent directory fsync; failed durability blocks success. `inspect.json` retains the owner's exact matched daemon readback; `parent-inspect.json` independently checks it. `fixture-output.json` holds only bounded known no-credential fixture stdout; arbitrary task commands/output are unavailable. Task stdout cannot forge status. Future production output must pass the existing streaming redactor/private-event path.

Ordinary preflight/create/start writes remain strict launch gates. During cleanup only, diagnostic write/fsync/rename failures are latched but cannot prevent the same strict private-path, daemon, and exact-ownership checks, stop attempt, actual CLI close, or terminal readback. This applies to command pre/post writes, inspect records, discovered CID receipts, and final records. A command's original failure is retained if its post-command receipt also fails to persist.

`containerCleanup: confirmed` records **observed** exact-owned daemon terminal facts. `cliClosed` records observed client close/stdio completion, without inventing a missing close when only its write failed. `cleanup: confirmed` and task success require those facts and an acknowledgement with `evidencePersisted: true` and `cliEvidencePersisted: true`, issued only after all final writes complete. On-disk snapshots retain both acknowledgement flags as false: readable draft bytes, including after a failed fsync, never prove durability. Any persistence failure latches `persistenceFailed: true`, keeps cleanup unknown and outcome failed, and rejects with fixed `STATE_PERSISTENCE_FAILED` after attempting validated physical cleanup; no terminal success is published. A later successful diagnostic write cannot clear the latch. Permanently failing final writes may leave an earlier unacknowledged draft; its proposed cleanup/outcome is not durable completion evidence.

A lost historical close record remains `cliClosed: false`, `cleanup: unknown`, even if later reconciliation stops the container. `outcome: succeeded` further requires natural task completion with exit zero. Cancel, timeout, startup failure, and reconciliation retain failed task outcomes; confirmed cleanup never turns them into task success. Local journals are mutable by the same UID/administrator and do not provide host isolation. This slice makes no guarantee after independent owner loss while the daemon is unavailable; retained state permits exact later stop/reconciliation without relaunch.

### Verify offline without dependencies

```sh
TMPDIR='/absolute/private/canonical/scratch' \
node --test packages/agent-bridge/scripts/hermesContainerLifecycle.test.mjs \
  packages/agent-bridge/scripts/prepareHermesRuntimeImage.test.mjs
```

`pnpm --filter @skyturn/agent-bridge run test:hermes:lifecycle` runs the focused suite; the existing package test includes it as well. It uses real private filesystem state, real detached controller/owner processes for SIGKILL/EPIPE, and an injected offline Docker boundary. The preparation regressions still validate the unchanged command semantics and strict pin/path/socket/identity checks. Syntax checks and these suites need Node only. The full package build/lint/Vitest gates still require workspace dependencies and are separate from real Docker acceptance.
