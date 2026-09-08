# Pause and resume desktop scheduling

Desktop integrations can call `devflow.workflow.pauseScheduling(projectRoot, request)` and
`devflow.workflow.resumeScheduling(projectRoot, request)`. There are no scheduling controls in the UI yet.

Both methods take `{ sessionId, requestId, expectedStatus, expectedRevision }`. Read the session's
current scheduling state before constructing a request. Pause expects `active`; resume expects
`paused`. Use a new request ID for each transition and reuse the exact request when retrying.
Invalid, stale, or conflicting requests reject through the existing workflow IPC error contract.

The response contains the authoritative session envelope, projection, `schedulingState`, and
`nextAction`. `mutation` identifies the applied event and reports `created`, its requested status,
and its revision. On a retry, that mutation can be historical: always use `schedulingState` for the
current state. Internal event payloads are not included in the mutation result.

Pause shares the canonical project queue with scheduling, public starts, and planner starts.
It waits for already admitted preflight and process starts, then blocks further starts for that
session. Existing runs continue; their terminal evidence persists while downstream work stays
paused. The queue does not wait for a run to finish or acquire a session mutation lock.

A newly applied resume advances that session once inside the queue and returns a fresh snapshot.
Duplicate controls do not advance. SQLite preserves control revisions across reopen; recovery
retains existing run ownership and does not relaunch historical runs. Other sessions keep their
own scheduling state. These controls do not cancel runs or change rollback semantics.
