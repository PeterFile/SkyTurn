# Composer drafts

SkyTurn keeps unfinished composer text as you navigate and restores it when you reopen the desktop with the same local storage. Spaces, tabs, blank lines, and trailing newlines are preserved.

Each input has its own scope:

| Input | Draft belongs to |
| --- | --- |
| New Session | Project and Fast/Plan mode |
| Followup | Project and canvas session |
| Node action | Project, canvas session, node, and Repair/Variant/Rollback action |

Switching back to a node restores its last selected action during the current app session. Action selection, checkpoint eligibility, safety state, and busy state are not persisted. After restarting, choose the action again to see its draft. Development-target controls keep their existing defaults.

## Submit and retry

Submitting captures the current draft in the input event, before the optional animation. Inputs stay editable while a request is pending; another submission to the same pending scope is suppressed synchronously.

A valid authoritative success clears only the captured draft version. Text edited during the request survives, even if you change it away and back to the original text. Success may arrive after a broadcast has already installed a newer workflow projection: SkyTurn acknowledges the request without replacing that newer state. Node feedback remains guarded by the current selection and workflow generation.

Failures, blocked or unavailable responses, and invalid or mismatched authority leave the draft intact. Reopening never submits a draft automatically.

Followup retries retain their input ID across a normal restart. Fast New Session retries retain their seed ID and creation time when the goal, mode, and development target match. To retry after reopening, select the same target settings and submit explicitly. An acknowledged request retires its captured identity, so submitting the same text later creates a new request. Node actions do not gain backend retry or replay semantics.

## Reuse a recent task goal

In New Session, **Recent tasks** lists up to eight Canvas tasks from the selected project. Tasks appear by most recent update, with creation time as the fallback and session ID breaking ties. Each choice shows its title and session ID, so tasks with the same title remain distinct. Plan sessions and blank goals are excluded.

Select a task to preview its goal, then click **Use**. If the current draft contains any text, click **Replace** in the inline confirmation or **Cancel** to keep the draft. Editing the draft, changing project or mode, or changing or deleting the source goal invalidates pending confirmation. A draft edited away and back still needs fresh confirmation.

Reuse copies the exact goal into an editable draft. It preserves the original task and its history, keeps the selected execution target and branch, and does not copy graph state, output, checkpoints, run handles, or Plan stages. **Current branch** remains the default target; **New worktree** stays an explicit choice. Click **Create** separately to start work.

Explicit reuse retires settled create identities only for the reused goal in the current project and mode, across target choices. Creating that goal again gets a fresh session, planner, and run identity. Ordinary failed **Retry** keeps its existing identity, and unrelated goals and draft scopes retain their retries. Reuse is unavailable while a create for the current project and mode is pending, including a different goal or target. An older acknowledgement cannot clear the replacement draft.

## When local storage fails

A visible alert explains when drafts and retry identities are kept in memory only. You can keep editing and switching scopes, but reopening may lose recent changes. SkyTurn does not claim persistence when storage is denied or full.

Drafts use the renderer-local `skyturn_composer_drafts` key, schema 2. Invalid stored data is preserved without overwrite during that store's lifetime. Storage holds at most 256 combined draft/retry records and 1,048,576 UTF-16 code units; exceeding either limit keeps the full in-memory state and shows the warning. No draft is silently truncated or evicted. A later edit or explicit retry attempts to save again after a write/quota failure.

## Verification boundary

`composerDrafts.test.ts` covers storage, immutable capture, restart identity, explicit reuse, limits, and fault handling. `RecentTaskReuse.test.ts` checks the chooser and confirmation boundaries. `App.test.ts` executes the current App handlers through TypeScript AST extraction with controlled IPC, and checks render wiring, target preservation, scoped reuse, and fresh identity versus Retry. These regressions complement the real Electron acceptance; they do not mount the full desktop or prove an operating-system restart.
