/goal Design and scaffold the MVP of a desktop development workflow platform based on Hermes-agent as the orchestrator, verified by a runnable desktop app shell, documented architecture, typed domain models, working canvas-session UI, mocked agent execution stream, git/worktree service abstractions, and passing local build/typecheck.

Product outcome:
Build a minimal but coherent desktop application, not a web-only page. The product is a canvas-first development task orchestration workspace.

The core product model must be:
Project = one imported local folder.
Tab = one task canvas session.
Canvas = the visual task graph for that session.
Node = one executable agent task bound to a run and preferably a worktree.
Node modal = only Output, Changes, and Context.

Required user flow:
1. Home page:
   - Show a minimal input box.
   - Show Fast and Plan mode selection.
   - Show Open Project, which imports a local folder as a project.
   - Do not call this Open File because it imports a folder/project.

2. Project workspace:
   - Top area shows multiple tabs.
   - Each tab is a canvas session, not a file tab.
   - Clicking + New Tab opens a new task input box.
   - The new task can choose Fast or Plan.
   - Fast creates a new session, asks Hermes to directly orchestrate the task graph, then enters the xyflow canvas.
   - Plan creates a Kiro-spec-style planning view with rendered Markdown sections: requirements, design, tasks. After confirmation, tasks are converted into a canvas graph.

3. Canvas:
   - Use @xyflow/react / xyflow for graph rendering. Do not implement a custom graph engine.
   - Canvas must dominate the screen.
   - Left sidebar is collapsible and lists projects and major sessions.
   - Bottom input bar is the reduced version of the home input. It is used for inserting new requirements, global agent control, and creating additional nodes.
   - Do not add a global bottom Agent Console.

4. Node design:
   - Each node shows title, assigned agent, short progress label, and traffic-light status.
   - Completed = green.
   - Failed = red.
   - Retrying = yellow.
   - Running = animated three-color blinking.
   - Pending = low-contrast neutral state.
   - Node UI must remain compact and not show logs, prompts, configs, or code inline.

5. Node modal:
   - Only three tabs are allowed: Output, Changes, Context.
   - Output shows streaming agent output for this node only.
   - Changes shows real git/worktree changes, not agent self-reported changes.
   - Context shows task brief, session goal, related requirements/design/tasks source, dependencies, assigned agent, worktree path, branch name, base commit, and constraints.
   - Actions may be visible as buttons, but do not add more content tabs.
   - Required actions: Stop, Retry, Reassign, Insert Before, Open Worktree in VSCode, Open Worktree in Cursor, Open Worktree in Zed.

6. Agent integration:
   - Treat Hermes-agent as the primary orchestrator/project manager.
   - Other coding agents must be pluggable through adapter interfaces: codex, gemini, claude-code, hermes.
   - Each coding agent must load its own native configuration, skills, MCP, AGENTS.md, CLAUDE.md, GEMINI.md, or equivalent files without polluting other agents.
   - The app must also provide a shared project memory folder for cross-agent coordination.
   - Do not deeply couple the app to any single agent CLI internals in the MVP. Use adapter interfaces and mock implementations first.

7. Shared project memory:
   Create a .devflow directory in the imported project root with this intended structure:

   .devflow/
     project.md
     decisions.md
     architecture.md
     constraints.md
     specs/
       session-<id>/
         requirements.md
         design.md
         tasks.md
     graph/
       session-<id>.graph.json
     tasks/
       task-<id>/
         brief.md
         status.json
         result.md
         files.json
         changeset.json
     runs/
       run-<id>/
         output.jsonl
         summary.md
         exit.json
     git/
       worktrees.json
       branches.json
       merges.json
     changes/
       changeset-<id>/
         diff.patch
         diff-stat.json
         files.json
         review.md
     memory/
       summaries.md
       open-questions.md

   Rule:
   Individual agents may write task-local result files, but only Hermes/orchestrator may merge important results into shared project memory files such as decisions.md, architecture.md, and summaries.md.

8. Git and worktree design:
   - Design every executable node to optionally bind to a dedicated git worktree.
   - Worktrees should preferably live outside the project root, for example:
     <project-name>.worktrees/session-<id>-task-<id>/
   - Create typed service interfaces for:
     GitService
     WorktreeService
     ChangesetService
     EditorAdapter
   - Editor adapters must support opening a worktree in VSCode, Cursor, or Zed.
   - The MVP may mock editor detection and worktree creation if full native behavior is not safe yet, but the interfaces must be real and documented.

9. Task control:
   - A running task must support stop/cancel at run level.
   - Stopping must persist current output and status.
   - Inserting a new requirement must create either:
     a) a new node,
     b) a new dependency before an existing node,
     c) a constraint update to relevant node context.
   - Do not simulate impossible model-level pausing. Implement run cancellation + checkpoint + resume brief.

10. Persistence:
   - Persist projects, sessions, tabs, graph nodes, graph edges, runs, status, and changesets.
   - Use SQLite if straightforward in the selected desktop stack.
   - If SQLite setup blocks progress, use a typed file-backed store first, but keep repository/service interfaces so SQLite can replace it later.

Technology direction:
- Prefer Electron + React + TypeScript + Vite for MVP because this app must manage local folders, git, external editors, and local CLI agents.
- Use @xyflow/react for the visual canvas.
- Use clean service boundaries so the renderer does not directly run shell commands.
- Main process owns filesystem, git, process execution, and editor launching.
- Renderer owns UI, canvas, tabs, modals, and interaction state.

Verification surface:
The goal is complete only when all of the following are true:
1. The app can be installed and started locally with documented commands.
2. TypeScript build/typecheck passes.
3. The UI shows:
   - Home page with Open Project, Fast, Plan, input box.
   - Project workspace with top session tabs.
   - + New Tab creates a new task session.
   - Fast path creates a mock graph and enters the canvas.
   - Plan path creates rendered Markdown requirements/design/tasks and can convert tasks into graph nodes.
   - xyflow canvas renders nodes and edges.
   - Node status lights render correctly.
   - Clicking a node opens a modal with exactly Output, Changes, Context.
4. Mock agent execution streams output into the selected node Output tab.
5. Changes tab can show mocked or real git diff data through ChangesetService.
6. Context tab shows the node brief, session goal, dependencies, agent, worktree metadata, and constraints.
7. .devflow project memory structure is created or documented with code-level helpers.
8. Architecture docs exist:
   - docs/product-model.md
   - docs/architecture.md
   - docs/agent-adapters.md
   - docs/git-worktree-design.md
   - docs/mvp-verification.md
9. No UI design should resemble a full IDE, file editor, or terminal dashboard.
10. The final report lists changed files, commands run, verification results, known gaps, and next implementation steps.

Constraints:
- Keep the UI minimal and canvas-first.
- Do not build a full code editor.
- Do not add file tabs.
- Do not add a global Agent Console.
- Do not expose complex model parameters on the main page.
- Do not hard-code one coding agent as the only execution backend.
- Do not let each agent freely rewrite shared memory files.
- Do not mark a node completed only because an agent says it is done; completion must be tied to run status, git changes, tests or verification evidence.
- Do not overbuild plugin marketplace, cloud sync, multi-user collaboration, permissions, or production packaging in this MVP.

Boundaries:
- If Hermes-agent is not installed or its API is unavailable, create a HermesAdapter interface and a mock Hermes orchestrator that produces deterministic task graphs.
- If actual Codex/Gemini/ClaudeCode CLIs are unavailable, create adapter stubs and document the expected integration contract.
- If real git worktree operations are risky in the current repo, implement dry-run or mock mode but preserve the WorktreeService interface.
- Avoid changing unrelated files outside the project scaffold.
- Ask for user input only when a blocker prevents safe progress. Otherwise make the best local decision and document it.

Iteration policy:
Before coding:
1. Inspect the repository structure.
2. Identify package manager and existing stack.
3. Create or update a short implementation plan in docs/mvp-verification.md.
4. Then implement in vertical slices:
   - app shell
   - project import model
   - session tabs
   - Fast/Plan entry flow
   - xyflow canvas
   - node status model
   - node modal Output/Changes/Context
   - .devflow helpers
   - agent adapter interfaces
   - git/worktree/editor service interfaces
   - verification docs

After each major slice:
- Run the most relevant build/typecheck/test command available.
- Record what changed.
- Record evidence.
- Decide the next smallest useful slice.
- Continue until the verification surface is satisfied.

Blocked stop condition:
If the app cannot be built, a required dependency cannot be installed, the runtime cannot access the filesystem, or agent/worktree integration cannot be safely tested, stop and report:
- attempted paths
- files changed
- command outputs
- blocker
- safest next action
- what input or environment change would unlock progress

Do not declare the Goal complete until the verification surface is satisfied by concrete files, commands, UI behavior, and generated artifacts.
