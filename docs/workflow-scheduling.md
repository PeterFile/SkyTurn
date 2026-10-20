# Pause and resume desktop scheduling

Desktop integrations can call `devflow.workflow.pauseScheduling(projectRoot, request)` and
`devflow.workflow.resumeScheduling(projectRoot, request)`. The desktop canvas toolbar shows **Pause**
for active scheduling and **Resume** for paused scheduling. Both leave existing runs running.

Both methods take `{ sessionId, requestId, expectedStatus, expectedRevision }`. Read the session's
current scheduling state before constructing a request. Pause expects `active`; resume expects
`paused`. Use a new request ID for each transition and reuse the exact request when retrying.
Invalid, stale, or conflicting requests reject through the existing workflow IPC error contract.

The toolbar disables the control while a request is pending and never changes scheduling state
optimistically. A successful control response must match the original request ID, desired status,
and `expectedRevision + 1`. If a same-session broadcast or authoritative session refresh already
installed that exact scheduling state, the response acknowledges the request without replacing
the newer canvas, including its run state and output. Global response-generation guards still
govern canvas installation.

Responses from another project/root or session, backwards or conflicting scheduling revisions,
and responses after navigating away and back do not acknowledge the request or replace the canvas.
The toolbar offers **Reload scheduling** before a new transition. Unknown transport or advance
outcomes instead retain the original action, request ID, and CAS tuple for **Retry Pause** or
**Retry Resume**. Retry first recovers the authoritative projection, then replays that exact request;
a failed recovery retains the same identity.

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

The sidebar shows one compact attention button beside each canvas session: **Input** for a pending
user decision, **Action** for a current manual next action, or **Paused** for paused scheduling, in
that priority order. This includes sessions in other open projects. Ordinary task execution and
pending checks do not create attention buttons, and historical failed tasks alone do not count.
Missing authority, resolved decisions, and missing, inactive, or rolled-back targets do not create
task attention buttons. The buttons update as authoritative session facts change.

Click an attention button to switch to its project and session and select the exact eligible task.
**Paused** can open the session without a task selection. These buttons do not open task details;
use the task's **More** button for details. They never answer decisions, resume scheduling, repair,
retry, refresh checks, launch work, or perform delivery actions.

Attention navigation stays selection-only if the active project, root, or session changes or
temporarily disappears. Background updates cannot enable scheduling, and checkpoint actions still
require matching current authority. Ordinary project, session, task, **More**, and next-action
navigation retain their usual behavior when explicitly selected.

When a next-action hint points to an active task on the current canvas, **Locate blocked task**
selects that exact task and binds the composer without opening its details. **Review pending checks**
selects the task and opens its existing **Changes** tab to inspect checks. These shortcuts only
navigate; they do not refresh checks, repair, resume, merge, or execute work. If the referenced task
is missing, inactive, or rolled back, the hint remains a passive **Workflow blocked** or
**Wait for checks** status and never selects a different task. The original reason stays unchanged.
