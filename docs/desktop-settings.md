# SkyTurn Desktop Settings

The SkyTurn Desktop Settings modal provides a minimal interface for managing execution paths, editing preferences, and verifying prerequisites.

## Scope

- **External Editor**: Save a preference for VS Code, Cursor, Zed, or Finder. Unsupported legacy values are displayed with a warning and preserved until you select a supported choice. The default-selection helper uses Zed for missing or unsupported preferences. The canvas node **More -> Open worktree -> Open (Default)** action reads the saved preference to launch the chosen editor. Explicit editor choices in the same menu override the saved default for that action only. Missing or rejected settings result in a visible failure with no editor launch.
- **Agent Executables**: Configure custom executable overrides for the **Hermes** and **Codex** agents. Saving an empty executable override clears it to `null`, restoring default discovery.
- **Unexposed Settings Unchanged**: Default executor, notification preferences, project commands, and project execution targets are preserved exactly. This panel does not implement those settings' behavior.

## Prerequisites Snapshot

- **Last-Refresh Meaning**: The prerequisites section displays the state from the *last successful refresh*. It provides a snapshot of the CLI, authentication, and execution readiness of your agents at that moment in time.
- **Explicitly Unknown**: Any fields that cannot be reliably detected are shown as `unknown`.
- **Not Live**: This snapshot does not continuously poll or verify background agent tasks. It is purely an on-demand view triggered by loading or refreshing the settings panel.

## Usage

You can open the Settings modal from the sidebar.
- Use the **Refresh** button to pull the latest snapshot of your prerequisites and update the display.
- Edit the external editor preference or executable overrides as needed and hit **Save**. Saving does not launch an editor or run project commands.
- If a save fails, your unsaved draft edits will remain intact so you can retry.
