# Git And Worktree Design

Every executable node can bind to a dedicated worktree.

Preferred worktree location:

```text
<project-name>.worktrees/session-<id>-task-<id>/
```

## Interfaces

MVP service contracts live in `packages/git-worktree/src/index.ts`.

- `GitService`
- `WorktreeService`
- `ChangesetService`
- `EditorAdapter`

## Changesets

The node modal `Changes` tab must use `ChangesetService`. It must not trust agent self-reported file changes as completion evidence.

The MVP returns deterministic mocked diff data. Real implementation should collect git diff, diff stat, changed files, and review notes from the worktree.

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
