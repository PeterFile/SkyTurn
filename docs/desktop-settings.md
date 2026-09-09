# SkyTurn Desktop Settings

The SkyTurn Desktop Settings modal provides a minimal interface for managing execution paths and verifying prerequisites.

## Scope

- **Overrides Only**: The interface currently only supports configuring custom executable paths for the **Hermes** and **Codex** agents.
- **Omitted Settings Unchanged**: Any settings left empty will map to their application defaults. All other configuration options (such as default executor, external editor, and notification preferences) are preserved exactly as they are without being modified by this modal.

## Prerequisites Snapshot

- **Last-Refresh Meaning**: The prerequisites section displays the state from the *last successful refresh*. It provides a snapshot of the CLI, authentication, and execution readiness of your agents at that moment in time.
- **Explicitly Unknown**: Any fields that cannot be reliably detected are shown as `unknown`.
- **Not Live**: This snapshot does not continuously poll or verify background agent tasks. It is purely an on-demand view triggered by loading or refreshing the settings panel.

## Usage

You can open the Settings modal from the sidebar.
- Use the **Refresh** button to pull the latest snapshot of your prerequisites and update the display.
- Edit the executable overrides as needed and hit **Save**.
- If a save fails, your unsaved draft edits will remain intact so you can retry.
