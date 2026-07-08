# Project Canvas Protocol

SkyTurn uses Project Canvas OS for evidence-backed project state.

## Human entrypoints

Humans read only:

```text
README.md
Project.canvas
```

`README.md` is the contract. `Project.canvas` is the cognition map. Git/CI/tests/artifacts are the fact source.

## Agent mutation rule

Prefer the Project Canvas OS CLI over hand-editing `.canvas` JSON:

```bash
python3 <skill>/scripts/project_canvas_os.py status <repo>
python3 <skill>/scripts/project_canvas_os.py validate <repo> --strict
python3 <skill>/scripts/project_canvas_os.py add-task <repo> --title "..."
python3 <skill>/scripts/project_canvas_os.py add-evidence <repo> --task "..." --test "..." --set-task-verify
python3 <skill>/scripts/project_canvas_os.py transition <repo> --task "..." --state Done --evidence "..." --gate "..."
```

Direct JSON edits are allowed only when the CLI cannot express the change, and must still pass strict validation.

## Do not create project-state document sprawl

Do not create these unless explicitly requested:

```text
progress.md
summary.md
handoff.md
status.md
latest-status.md
dev-log.md
implementation-log.md
task-log.md
```

Move live facts into Canvas cards instead.

## Card types

Only use:

```text
Goal
Module
Task
Evidence
Risk
Decision
```

## State model

Only use:

```text
Proposed
Active
Verify
Done
Blocked
```

Rules:

- Agent may set `Verify` when concrete evidence is attached.
- Agent may set `Blocked` when dependency/evidence is missing.
- Agent may not set `Done` without a concrete Evidence Card and explicit `Gate:` text from a human or named verification script.
- Placeholder evidence (`none`, `unknown`, `<...>`) does not count.

## Evidence requirements

Evidence must include at least one concrete proof:

- command + result
- CI URL + conclusion
- commit SHA
- screenshot/video/artifact path
- benchmark output
- manual observation with exact environment/result

No self-reported completion.

## Spatial layout

Preserve five regions:

1. Goal
2. System Structure
3. Current Work
4. Evidence
5. Risks & Decisions

Do not turn the map into a plain Kanban board. The value is dependency/evidence/risk relationships.

## Before work

```bash
python3 <skill>/scripts/project_canvas_os.py status <repo>
python3 <skill>/scripts/project_canvas_os.py validate <repo> --strict
```

Then pick one Active task or propose a small task.

## After work

1. Run real validation.
2. Add Evidence Card.
3. Move task to Verify.
4. Add Risk if incomplete/unverified/flaky.
5. Validate Canvas strictly.
6. Commit Canvas and code together when related.
