# Choose a different agent

Open a node through **More**, choose **Reassign**, select a different agent, and click **Confirm reassignment**. The picker sits above the existing **Output**, **Changes**, and **Context** tabs. Nothing is preselected. **Cancel** closes the picker without reassigning anything and returns focus to **Reassign**.

Only pending or ready executable agent tasks can be reassigned. Planner roots, other node kinds, and rolled-back or inactive tasks are excluded. A blocked action displays its reason beside the modal actions.

Opening the picker discovers agents through the desktop bridge; it does not reuse the workspace catalog. All six agent kinds remain visible. The current agent and unavailable choices are disabled with a reason. Unknown authentication is explicitly unverified, including for legacy descriptors. Experimental adapter support does not promise a successful run. Descriptor paths are not displayed.

Confirmation refreshes discovery and checks the selected descriptor and current lane again before invoking the existing reassignment endpoint. Controls freeze during confirmation. Backend rejection retains the selection and displays the error; cancel and reopen to refresh the displayed catalog. Discovery failure is also visible. Readiness metadata is advisory: backend validation and the real-run safety gate remain authoritative, and readiness can change after discovery.

Only the returned authoritative CanvasSession can update the graph, through the existing App response guards. There is no local agent cycling or optimistic graph edit. Closing the modal, changing its node, switching sessions, or unmounting invalidates pending UI work. A generation guard also rejects old results after returning to the same scope. Closing does not undo a backend mutation already sent.

Validation covers the picker/controller and the App submission helper, including fresh discovery, stale readiness, explicit payloads, cancellation, single-flight confirmation, authoritative response guards, errors, and scope replay. Run `pnpm --filter @skyturn/ui-canvas exec vitest run src/ReassignAgentPicker.test.ts src/App.test.ts --no-cache` and `pnpm --filter @skyturn/ui-canvas typecheck`.

Controller and SSR tests are not desktop or real-agent acceptance. A compiled Electron chooser check verifies the visible action and production IPC with an isolated typed workflow fixture; it does not establish credentials or prove a real-agent loop. Reassignment does not bypass backend launch authorization.
