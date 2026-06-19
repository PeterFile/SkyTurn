# Git And Worktree Design

The default SkyTurn development target is the currently selected project branch in the current project worktree. A new managed worktree is an explicit per-session option, not the default.

The New Session input has two separate controls:

1. An execution-target choice:
   - Current branch: default. The session develops directly on the selected branch in the current project worktree.
   - New worktree: opt-in. The session creates an isolated managed worktree from the selected branch as its base.
2. A branch selector populated from the current project's local branches.

The branch selector has different meaning depending on the execution-target choice. In Current branch mode it is the branch to start development on. In New worktree mode it is the base branch/ref used to create the candidate worktree.

Managed worktrees are candidate spaces. They must not become the product's default path, and a candidate should not be treated as a user-facing project branch until the user accepts it. If a future implementation uses detached HEAD for managed candidates, the candidate identity must come from SkyTurn metadata, not from a branch name.

Preferred managed worktree location:

```text
<project-name>.worktrees/session-<id>-variant-<id>/
```

## Interfaces

MVP service contracts live in `packages/git-worktree/src/index.ts`.

- `GitService`
- `WorktreeService`
- `ChangesetService`
- `EditorAdapter`

## Changesets

The node modal `Changes` tab must use `ChangesetService`. It must not trust agent self-reported file changes as completion evidence.

The source of current code changes should follow the Codex TUI pattern: changes are structured run events, not prose. Codex models this as file-level `FileChange` data (`Add`, `Delete`, `Update` with `unified_diff` and optional move path), patch lifecycle events, and a per-turn unified diff. Its TUI renders patch summaries from that structured change model rather than scraping assistant text.

SkyTurn should use the same separation:

- Live change display comes from structured agent/run events when available, especially Codex patch/file-change events.
- The final changeset is reconciled with git data from the selected execution target: current project branch/worktree or managed worktree.
- Agent text can explain a change, but it is not the source of changed-file truth.

For the current project branch path, the diff baseline is the branch state at session start. For the managed worktree path, the diff baseline is the selected base branch/ref used to create the candidate worktree.

The MVP may still return deterministic mocked diff data. Real implementation should collect changed files, diff stat, bounded diff preview, and review notes from the actual execution target, then tag the result with its source.

Codex reference points inspected in `openai/codex`:

- `codex-rs/protocol/src/protocol.rs`: `PatchApplyBeginEvent`, `PatchApplyUpdatedEvent`, `PatchApplyEndEvent`, `TurnDiffEvent`.
- `codex-rs/tui/src/diff_model.rs`: minimal TUI `FileChange` model.
- `codex-rs/tui/src/history_cell/patches.rs`: TUI patch summary cell renders from `FileChange`.
- `codex-rs/core/src/turn_diff_tracker.rs`: per-turn diff tracking from exact patch deltas.

## Completion Evidence

A node cannot be marked complete only because an agent says it is done.

Completion evidence should include at least one concrete source:

- run exit state
- git diff or clean worktree state
- test/typecheck/build result
- review result
- generated artifact

## Editor Adapters

Required editor launch targets:

- VSCode
- Cursor
- Zed

The MVP exposes buttons and adapter calls, but external launches are mocked unless Electron main process implements the specific editor command safely.
