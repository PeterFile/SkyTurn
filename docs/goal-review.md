# Review an implementation against its original goal

Open a succeeded implementation or fix card with **More**, then choose **Review original goal**. The first slice supports **Current branch** and requires an exact saved source run, after checkpoint, full HEAD, Git changeset, and candidate manifest. The action shows why it is unavailable when these facts are missing. Pause remains explicit: resume scheduling before requesting a review. If the project is busy, wait for its active runs to finish and request the review again.

Each deliberate request creates a separate advisory Hermes card. Merely opening a card does not start a review. Retries of an unknown request outcome reuse the same request identity. The backend freezes the saved session goal and the applicable approved Plan Finish event that preceded the source execution. Later messages and Plan edits do not change that binding. Generated `relatedRequirements` text is not acceptance criteria. Missing explicit criteria stay **Unverified**.

The review uses a fresh Hermes process with an explicit read-only sandbox. It has no planner continuation, execution dependency, or delivery authority. Its **Context** tab shows the original goal, source identity, checkpoint, HEAD, candidate digest, and approved Plan provenance. **Output** retains the exact typed public output and shows an advisory status. A successful process does not mean the goal was accepted. Failed, cancelled, timed-out, or stale reviews remain unverified. Review text cannot approve delivery, create Repair or Replan work, or trigger other runs.

SkyTurn checks the source and live candidate before launch, after terminal reconciliation, and on reopen. Current files are not an immutable historical checkout. If they change, the review becomes stale; its actual output and RunEvidence remain saved. Request another review only after obtaining valid new source evidence.

## Run the real acceptance gate

The parent delivery task owns this gate. Build the current workspace first. The installed Electron native dependencies must already match Electron 41.5.1; this script does not rebuild or switch the native ABI. Local Hermes credentials, an available Hermes CLI, and the platform's restricted-launch helper are required. The adapter remains experimental.

```sh
pnpm run build
pnpm --filter @skyturn/desktop run acceptance:goal-review-ui
```

The script uses isolated project, userData, and claim roots under `TMPDIR`. It seeds a clearly identified synthetic implementation with a genuinely unmet goal (`answer = 42`, actual `41`). Only the verifier uses a real provider process. The script clicks the visible **More → Review original goal** action, checks real Hermes terminal RunEvidence, checks that the discrepancy appears under Findings or Unverified, reopens SQLite, restarts Electron, compares the immutable binding and typed output, and checks for Git mutations, unrelated run starts, and owned process leftovers. It never injects review output or terminal evidence. Failures emit bounded stage names without private paths or provider output. Temporary state is removed after success and retained on failure for controlled diagnosis.
