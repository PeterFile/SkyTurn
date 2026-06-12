# Product Model

SkyTurn is a desktop development workflow platform, not a web page and not a full IDE.

The product model is:

```text
Project -> Canvas Session Tab -> Canvas -> Node -> Node Modal
```

## Objects

- `Project`: one imported local folder.
- `Canvas Session Tab`: one task canvas session. These are not file tabs.
- `Canvas`: the visual task graph for one session.
- `Node`: one executable agent task bound to a run and preferably a worktree.
- `Node Modal`: the detail surface for one node.

## Required Modal Constraint

Node modal content tabs are exactly:

- `Output`
- `Changes`
- `Context`

Actions such as Stop, Retry, Reassign, Insert Before, and editor launch buttons may be visible, but they are not content tabs.

## UI Boundary

- Canvas dominates the workspace.
- The left sidebar is collapsible.
- The bottom input bar is a reduced task input.
- No file tabs.
- No global Agent Console.
- No inline code editor.
