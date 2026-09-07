# macOS desktop distribution

SkyTurn currently produces an unsigned, unnotarized application for the macOS host and architecture that runs the packaging command. The dependency graph is pinned by `pnpm-lock.yaml`; builds are repeatable from those pinned inputs, but the generated app and zip are not claimed to be bit-for-bit reproducible.

## Build

Use Node 20.19.0 and the repository-pinned pnpm 10.28.2 from the repository root:

```sh
pnpm install --frozen-lockfile --package-import-method=copy
pnpm --filter @skyturn/desktop run package:mac
```

The package-level command runs the Turbo build graph for `@skyturn/desktop`, stages a production-only dependency closure from the lockfile, and rebuilds the staged `better-sqlite3` copy for Electron 41.5.1. It fails if the checkout's Node ABI binary changes, a runtime/helper file is missing, a symlink escapes the bundle, or renderer assets are not relative for `file://` loading.

Outputs are written to `apps/desktop/release/`:

- `SkyTurn.app` — self-contained current-host application.
- `SkyTurn-0.1.0-macos-<arch>.zip` — distributable archive.
- `artifact-metadata.json` — product, Electron, platform, architecture, source revision/dirty state, lockfile hash, and archive hash.

The app payload also contains `skyturn-build.json` and `third-party-licenses.json`. Workspace packages contain only runtime `dist` files and package metadata; the third-party production closure retains its lock-resolved versions and published license files. Electron and Chromium notices are retained under `SkyTurn.app/Contents/Resources/`.

Before scanning dependency manifests, validating the staged tree, or rebuilding native modules, staging excludes these exact names anywhere in the copied production `node_modules`: `.git`, `.devflow`, `.codex`, `.claude`, `.gemini`, `.hermes`, `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.env`, and names starting with `.env.`. This handles agent configuration shipped inside published dependencies, including nanoid's `.claude` directory, without reading file contents. It does not otherwise prune third-party source, tests, runtime code, licenses, Vite, or native transform bindings, and it does not change installed checkout dependencies.

Exclusion traversal is limited to 100,000 entries and 64 directory levels below staged `node_modules`, including excluded subtrees. Staging rejects linked roots and links within excluded payloads; it never follows dependency links during exclusion. The full tree privacy and symlink checks still run before native rebuild and on the final payload. Escaped or dangling links, and forbidden payloads introduced after exclusion, still fail packaging.

## Install and verify

Extract the zip and move `SkyTurn.app` to a user-chosen location. Because the artifact is unsigned and unnotarized, macOS may require the user to approve its first launch through the normal Finder/Open security prompt. Do not disable Gatekeeper globally.

The focused packaged-app acceptance is:

```sh
pnpm --filter @skyturn/desktop run smoke:package -- \
  --app release/SkyTurn.app \
  --artifacts release/smoke
```

Filtered pnpm scripts run from `apps/desktop`, so explicit paths in this command are package-relative. Omitting `--app` and `--artifacts` uses the same defaults.

The smoke command preserves and checks every symlink in the full app bundle after copying it to an isolated temporary install path outside the checkout. It removes `VITE_DEV_SERVER_URL`, uses isolated Chromium user data and working directory, verifies the packaged Electron ABI with a real SQLite query, creates a packaged Vite server in middleware mode, and transforms a TypeScript module. It then proves the built renderer loads from `file://`, calls the preload `window.devflow.loadWorkspace()` IPC API, waits for a visible `.home-panel` or `.app-shell`, records renderer errors and DOM evidence, captures a screenshot, and waits for the Electron process to close. It does not run an agent or access agent credentials.

Distribution outside local testing still requires signing and notarization. Cross-architecture and cross-platform artifacts are not produced by this command.
