# Review an implementation against its original goal

Open a succeeded implementation or fix card with **More**, then choose **Review original goal**. The first slice supports **Current branch** and requires an exact saved source run, after checkpoint, full HEAD, Git changeset, and candidate manifest. The action shows why it is unavailable when these facts are missing. Pause remains explicit: resume scheduling before requesting a review. If the project is busy, wait for its active runs to finish and request the review again.

Each deliberate request creates a separate advisory Hermes card. Merely opening a card does not start a review. Retries of an unknown request outcome reuse the same request identity. A matching explicit replay can schedule its existing pending advisory card after a creation-before-schedule interruption. Running or terminal attempts are never relaunched; existing durable-claim recovery remains authoritative. A paused or busy project stays gated. The backend freezes the saved session goal and the applicable approved Plan Finish event that preceded the source execution. Later messages and Plan edits do not change that binding. Generated `relatedRequirements` text is not acceptance criteria. Missing explicit criteria stay **Unverified**.

The review uses a fresh Hermes process with an explicit read-only sandbox. It has no planner continuation, execution dependency, or delivery authority. Its **Context** tab shows the original goal, source identity, checkpoint, HEAD, candidate digest, and approved Plan provenance. **Output** retains the exact typed public output and shows an advisory status. A successful process does not mean the goal was accepted. Failed, cancelled, timed-out, or stale reviews remain unverified. Review text cannot approve delivery, create Repair or Replan work, or trigger other runs.

SkyTurn checks the source and live candidate before launch, after terminal reconciliation, and on reopen. Current files are not an immutable historical checkout. If they change, the review becomes stale; its actual output and RunEvidence remain saved. Request another review only after obtaining valid new source evidence.

## Run the real acceptance gate

The parent delivery task owns this gate. Build the current workspace first. The installed Electron native dependencies must already match Electron 41.5.1; this script does not rebuild or switch the native ABI. Local Hermes credentials, an available Hermes CLI, and the platform's restricted-launch helper are required. The adapter remains experimental.

```sh
pnpm run build
SKYTURN_GOAL_REVIEW_EVIDENCE_DIR=/path/to/controlled-evidence \
  pnpm --filter @skyturn/desktop run acceptance:goal-review-ui
```

The script uses isolated project, userData, and claim roots under `TMPDIR`. Its source implementation is synthetic; only the verifier uses a real provider process. The goal and approved Plan describe the desired `answer = 42` behavior. Each real gate writes an unpredictable different integer to `answer.js`, keeps that value out of goal and prompt prose, and requires Findings or Unverified to cite the file and the observed value. Echoing the goal cannot satisfy the oracle.

The gate clicks **More → Review original goal** and checks the visible terminal review card, exact Raw Output, advisory status, and frozen Context both before and after Electron restart. Restart DOM checks precede protected projection reads, so a backend query cannot supply the UI evidence. Saved SQLite facts corroborate the immutable binding, typed output, and a durable launch fingerprint reconstructed with explicit read-only policy and omitted continuity fields. Actual terminal RunEvidence remains the process-status authority.

Set `SKYTURN_GOAL_REVIEW_EVIDENCE_DIR` to a controlled directory outside the disposable project. The script creates a unique `goal-review-evidence-*` subdirectory there; without the variable, it uses a separate directory under `TMPDIR`. It saves `action.png`, report and provenance screenshots before and after restart, and a bounded `receipt.json` before removing any successful disposable project. The receipt includes the SkyTurn candidate HEAD, source/runtime file hashes, public source/review/run IDs, source manifest/checkpoint identity, exact Output hash, read-only/no-resume launch proof, SQLite/restart checks, and confirmed owned-process cleanup. It contains no raw provider stream, private runtime paths, or continuity capabilities. The retained evidence directory survives successful cleanup.

A failed gate keeps its outcome false, retains available screenshots and disposable state, and reports only a bounded stage/code plus the controlled evidence location. `cleanupConfirmed` records the actual cleanup result independently of acceptance success. Missing predicates, screenshots, receipts, or cleanup evidence fail the gate; no successful real-run result is synthesized.
