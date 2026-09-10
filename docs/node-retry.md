# Retry a node

Open a task card through **More**, then select **Retry**. Retry is available for an ordinary executable task whose latest attempt failed, was cancelled, or timed out, once SkyTurn has its authoritative terminal evidence and original backend checkpoint.

Review the confirmation, then choose **Start new attempt**. The new attempt uses the **current workspace**, including existing file changes. Retry does not reset Git, roll back changes, or restore a checkpoint. **Cancel Retry** closes the confirmation without submitting a Retry request.

The backend assigns a new run and segment. The original attempt, output, and evidence remain in the workflow history. **Output** keeps the original output and includes subsequent output as it arrives. **Context** shows the current run identity and status, plus retained attempt identities and terminal facts. The node details still have exactly **Output**, **Changes**, and **Context** tabs.

Paused scheduling stays paused. A Retry can be reserved while paused and will wait for scheduling to resume. **Stop** controls a running agent; **Pause** controls workflow scheduling. Neither is a Retry or a rollback.

Retry stays disabled for planner and delivery tasks, running or successful attempts, inactive or rolled-back tasks, missing authority, and unsafe downstream or delivery progress. The reason appears beside the node actions. The backend performs the final eligibility check, including activity elsewhere in the project.

While a request is pending, repeated clicks do not submit another attempt. If the response is lost, Retry checks current backend state before sending again and reuses the same request identity within this app process. An already reserved attempt is not resubmitted. Errors appear inline. Reopen node details to reload unavailable authority; switching projects, sessions, nodes, or attempts invalidates old UI responses, including switching away and back. This does not cancel a request already admitted by the backend.
