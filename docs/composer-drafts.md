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

## When local storage fails

A visible alert explains when drafts and retry identities are kept in memory only. You can keep editing and switching scopes, but reopening may lose recent changes. SkyTurn does not claim persistence when storage is denied or full.

Drafts use the renderer-local `skyturn_composer_drafts` key, schema 2. Invalid stored data is preserved without overwrite during that store's lifetime. Storage holds at most 256 combined draft/retry records and 1,048,576 UTF-16 code units; exceeding either limit keeps the full in-memory state and shows the warning. No draft is silently truncated or evicted. A later edit or explicit retry attempts to save again after a write/quota failure.

## Verification boundary

`composerDrafts.test.ts` covers storage, immutable capture, restart identity, limits, and fault handling. `App.test.ts` executes the current App handlers through TypeScript AST extraction with controlled IPC, and checks render-scope and warning wiring. These regressions complement the real Electron acceptance; they do not mount the full desktop or prove an operating-system restart.
