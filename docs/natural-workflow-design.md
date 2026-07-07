# 自然流式开发流程设计

本文描述 SkyTurn 下一阶段的工作方式：用户输入一个新需求后，画布不是一次性生成静态计划，而是随着真实运行证据持续生长。Hermes 负责理解需求和提出流程意图，SkyTurn 负责保存事实、校验流程、调度节点、呈现过程，并在出现失败或重大设计分歧时把选择权交还给人。

这份设计只讨论能落地到当前仓库的功能。无法确认的能力放在文末，不进入近期实现范围。

## 设计判定

这条方向可以继续。它借用成熟系统里最硬的模式：追加式事件账本、确定性投影、用户门禁、隔离执行和证据优先。它不能照搬那些系统的产品形态。

## 代码事实快照

截至当前代码，SkyTurn 已经接入真实桌面开发闭环的关键路径：打开本地 git 项目，底部输入需求，Hermes 产出 `WorkflowIntent`，Flow Kernel 编译成 lane/edge，SQLite 记录 workflow events，Electron main 通过 `agent-bridge` 启动 Hermes/Codex，终态由 `RunEvidence` 回写，画布从投影更新状态，`Changes` 页签可用结构化 live changes 和 git 对账展示变更。

已经落地的主能力包括：SQLite workflow session / ledger / projection，Hermes ledger 注入，Hermes/Codex `experimental-run` 真实适配器，Current branch / New worktree 会话目标，用户决策回答写入 SQLite，节点详情三页签 `Output` / `Changes` / `Context`，Context 中的 run evidence，Changes 中的 live changes、git reconciliation、delivery commit / push / PR / exact-head checks / merge / sync / cleanup 显式动作，selected-node composer 的 repair / variant / rollback 操作，以及 rollback eligibility / apply 的 remote side-effect gate 和 local commit safety gate。

这个能力仍是实验路径，不是完整产品闭环。Hermes/Codex 适配器仍标为 `experimental-run`，不是 `supported-run`。真实桌面 workflow 路径已经使用 SQLite projection，但 renderer 仍保留 browser/mock fallback 和局部 local state。worktree create/compare/adopt/clean 后端和 IPC 已经可用，但完整双轨比较、采纳、清理体验还不是默认主路径。失败后的 `ReplanFromEvidence` / repair / regression 已有内核和调度基础，但还没有形成完整 desktop 默认体验。PTY 只用于 Hermes planner 的状态、检查和接管传输边界；当前不是生产 PTY runtime，不是全局 terminal dashboard，也不是 Codex 默认执行器。PR 创建只是交付事件和证据，不代表任务完成；merge、post-merge sync、cleanup 必须由用户显式确认，不会由 PR 创建或 green checks 自动触发。

下面各功能的“需求 / 落地方案 / 验收”保留产品目标；“现状”段落描述当前代码事实。不要把目标段落当作已经完成，也不要因为部分目标已实现就删除后续方向。

可参考的成熟模式：

- Temporal 的 Event History、replay、幂等和历史大小限制。
- LangGraph 的 stateful graph、持久化和 human-in-the-loop。
- Dagger 的本地可重复执行、typed artifacts 和可观察执行证据。
- OpenHands 和 SWE-agent 的本地 coding-agent 轨迹与证据记录。

不照搬的东西：

- 不引入 Temporal server、task queue 或 worker 模型。
- 不用 LangGraph runtime 替换 `workflow-kernel`。
- 不把 Dagger container runtime、GraphQL 或 OpenTelemetry 全套拉进 MVP。
- 不把 SkyTurn 做成 OpenHands 式 IDE、no-code workflow builder 或单 agent 自由循环。

## 目标

用户在一个会话里输入需求后，SkyTurn 应该自然推进整个开发流程。节点会随着 Hermes 的规划、代码执行、测试结果和用户选择逐步出现。节点之间的连线表达真实依赖，不是装饰。节点状态来自运行证据，不来自 agent 的文字承诺。

同一个会话里的 Hermes 应该看起来像同一个“大脑”。即使底层每次调用都是新的进程，Hermes 也必须能读到本会话的目标、决策、失败证据和当前阶段。这个连续性由 SkyTurn 的事件账本保证，而不是靠长连接幻想。

失败必须显式出现在画布上。一次实现失败后，原节点保留失败状态，SkyTurn 拉出新的修复节点和回归验证节点，让用户看到问题如何被定位和修复。

当 Hermes 发现早期设计可能有重大问题时，SkyTurn 不允许它直接重写历史。系统要生成用户决策节点，由用户选择回溯、继续当前方案，或按用户显式选择开一条隔离工作树进行双轨验证。

节点选择不是打开详情。用户选中节点后，底部输入框进入节点上下文，可以对这个节点发起修复、变体或回滚动作。节点详情只能通过节点卡片的 **More** 按钮打开，避免把主画布做成 IDE、文件标签页或全局终端。

## 不做什么

SkyTurn 不是流程图编辑器，不让用户手工拼一堆业务流程节点。

SkyTurn 不是网页，也不是完整 IDE。主界面仍然以画布为中心，不加文件标签、全局终端、内置代码编辑器。

渲染进程不执行 git、shell、文件系统操作，也不启动 agent。Electron main 和 `agent-bridge` 仍然负责本机执行。

Hermes 不直接创建 UI 节点，也不直接把节点标成完成。Hermes 输出流程意图，SkyTurn 编译和校验。

PTY 不进入节点完成判定。终端文本只能作为 planner 状态、检查和显式接管时的运行输出，不能替代 `RunEvidence`、workflow events、git/check/artifact/review/commit evidence。

## 全局硬约束

这些约束比具体功能优先。后续实现如果和它们冲突，功能要改。

SQLite 工作流事件流是唯一事实源。Electron main 和 Node-only persistence 层负责编译 intent、写事件、调度、生成投影和回放。渲染进程只显示投影，并把用户动作发回 Electron main。

渲染进程不得从 `CanvasSession` 反推事实，也不得本地决定 lane 是否可调度。刷新 UI 时只能 replay 投影，不能重新运行 Hermes、Codex、git 或任何有副作用的命令。

browser-safe 包只暴露类型、contracts 和 mock。真实 git、diff、worktree、SQLite native 逻辑必须放在 Electron main 或 Node-only 子路径后面。`@skyturn/git-worktree` 根入口不能导出会在 renderer 中执行 git 的实现。

调度权限必须从 SkyTurn 编译后的可信 workflow state 推导。不能从 Hermes 文本、`display.meta`、lane title 或 agent 输出中继承 `workspace-write` / `danger-full-access`。

用户决策节点是不可执行节点。它可以投影成 `CanvasNode` 供 UI 显示，但必须有可信字段表明它不是 agent task；scheduler 和 `startAgentRun` 都必须拒绝启动它。

事件账本注入 Hermes 前必须经过 Node 侧脱敏和降采样。只允许 allowlist 字段进入 prompt；禁止完整日志、完整 diff、完整 prompt、`.env`、token、私钥片段和无限 stderr。脱敏失败时拒绝注入账本。

所有 git/worktree 操作都必须有可恢复状态机。SQLite 事件不能假装文件系统操作已经成功；文件系统操作成功后也必须能在重启时对账并恢复。

默认开发目标永远是当前项目的选定分支和当前项目工作区。新建隔离 worktree 只能作为 New Session 输入里的显式选项出现，不能成为默认路径。

节点检查点的粒度是 node/run boundary。before checkpoint 和 after checkpoint 是用户可理解的工作流概念，不是底层工具日志。Hermes 或其他 agent 适配器可以有 tool-level filesystem checkpoint 作为安全网，但不能把它暴露成产品 UI 模型。

回滚必须同时约束图状态、agent thread/history 和本地文件系统。Codex 自身的 rollback 只表示 thread/history 回退，不能单独代表 SkyTurn 已经恢复了 graph 或 repository。

## 当前基础

当前代码已经有几个关键地基。

`CanvasSession` 保存 `hermesPlannerSessionId`、`plannerNodeId` 和 `target`，可以表达“一张画布一个逻辑 Hermes 规划身份”和会话执行目标。相关类型在 `packages/project-core/src/index.ts`。

`workflow-kernel` 已经有 `WorkflowIntent`、`SplitLane`、`JoinLanes`、`RequestUserDecision`、`ReplanFromEvidence`，也有事件投影、门禁校验、修复/回归 lane 编译和可运行任务调度。

`ui-canvas` 会通过 Electron workflow IPC 创建会话、追加用户输入、读取投影、启动 agent run，并在终态 evidence 后写回 workflow store。它仍保留 browser/mock fallback 和部分本地 canvas 操作。

`agent-bridge` 已经能把 Hermes/Codex CLI 的输出、退出码、失败原因、结构化 Codex 文件变更和证据转成运行事件。节点完成状态由 `RunEvidence` 推导。

`persistence` 已经有 SQLite 工作流事件表、workflow session、lane、segment、ledger summary、`materializeFlowProjection` 和 `materializeCanvasSession`。真实桌面 workflow 路径已经使用它，但 renderer 还没有完全消除所有本地状态路径。

`git-worktree` 的根入口保留 browser-safe contracts/mocks；Node 子路径已经有真实 worktree service、git changeset reconciliation、delivery commit、delivery push 和 delivery PR helper。桌面 worktree create/adopt/clean IPC 已经调用真实 Node side effect，并把 requested、terminal 或 failed 事件写回 SQLite。delivery push 和 PR IPC 会写入 `workflow.delivery.pushed`、`workflow.pull_request.created`，但这些事件当前只进入事件流和投影，不完成 Flow Kernel lane。

## 功能一：会话事件账本

### 需求

SkyTurn 要为每个画布会话维护一份事件账本。账本记录用户输入、Hermes 规划、任务通道、连线、运行片段、输出摘要、证据、用户决策和检查点。

Hermes 每次被唤醒时，SkyTurn 要把这份账本压缩成短上下文传给它。Hermes 不需要读完整历史，但必须知道当前目标、已经做过的关键决定、最近失败、仍未解决的问题和当前节点的依赖证据。

### 现状

`packages/persistence/src/workflowStore.ts` 已经有 workflow session、events、lanes、segments 和 SQLite-backed projection。事件追加有顺序号和幂等键，Electron workflow IPC 已经提供 create session、append input、ledger、apply intent、schedule ready、record run result 和 projection。

真实桌面路径已经从 SQLite 生成 `materializeCanvasSession` 并广播给 UI。剩余差距是迁移完整性：`ui-canvas` 仍保留从 `CanvasSession` 重建投影的 browser-safe fallback，部分交互仍直接改本地 state。

Hermes 提示词已经能读取 workflow ledger summary。账本摘要是短摘要，不是完整历史；脱敏和降采样仍需要继续作为安全边界加固。

### 落地方案

第一步，把 SQLite 工作流事件流定为会话事实源。渲染进程只显示投影，不拥有事实，不本地编译 intent，不本地调度 lane。

新增或补齐这些主路径：

- `workflow:createSession`：创建画布会话时，同时创建 SQLite 工作流会话。
- `workflow:appendUserInput`：用户在底部输入新需求时，先写入 `workflow.user_input`。
- `workflow:ledger`：启动 Hermes 前，Electron main 从 SQLite 读取最新检查点和最近事件，经过脱敏后返回短账本。
- `workflow:applyIntent`：Electron main 接收 Hermes 的 `WorkflowIntent`，由 Node 侧 store 编译、校验、写入事件流，再广播投影。
- `workflow:scheduleReady`：Electron main 从当前投影选出可运行 lane，渲染进程只能请求启动这些 lane。
- `workflow:recordRunResult`：agent 运行结束后，Electron main 把运行事件和证据写回工作流事件流，再广播投影。
- `workflow:projection`：刷新 UI 或切换会话时，渲染进程只从 Electron main 读取投影。

`buildHermesWorkflowPrompt` 增加 `sessionLedger` 输入。账本摘要包含：

```ts
{
  throughSeq: number;
  checkpointSummary: string | null;
  facts: string[];
  recentEvents: Array<{
    seq: number;
    kind: string;
    summary: string;
    laneId?: string;
  }>;
  openQuestions: string[];
}
```

账本摘要由 Node 侧 `LedgerSanitizer` 生成。它只保留这些字段：

- 事件序号、事件类型、lane id、短摘要。
- 已确认的用户决策。
- 最近失败的错误类别和检查名。
- 证据状态、命令名和 artifact 路径摘要。

它不得包含：

- 完整 stdout/stderr。
- 完整 diff 或 patch。
- 完整 prompt。
- `.env`、token、私钥、cookie、认证头。
- 未截断的大块日志。

提示词里明确说明：如果没有真实 Hermes 原生恢复句柄，连续性来自 SkyTurn 事件账本。

检查点只用于压缩历史，不替代事实。完整事实仍然是事件流。

刷新 UI 时只允许重放事件生成投影，不能重放 side effects。已经执行过的 Hermes、Codex、git、worktree、merge、cherry-pick 操作不得因为 replay 再执行一次。

### 验收

新建一个会话，输入两次需求。第二次 Hermes 提示词里必须出现第一次需求的关键决策和最近事件摘要。

刷新 UI 后，画布必须能从事件流回放出相同节点、边、状态和证据。

重复写入同一个事件幂等键时，不得重复生成节点或边。

构造包含 token、`.env`、完整 diff 和 stderr 的事件后，`workflow:ledger` 必须过滤或拒绝输出这些内容。

刷新 UI 不得触发任何新的 Hermes/Codex/git/worktree side effect。

## 功能二：显式修复节点

### 需求

当实现、验证或评审节点失败时，SkyTurn 不要把原节点改回运行中。原节点保留失败状态。系统生成一个新的修复节点，再生成一个回归验证节点。

用户应该能在画布上看到：哪个节点失败、失败证据是什么、哪个修复节点负责处理、修复后通过了哪一次验证。

### 现状

`workflow-kernel` 已经能把 `ReplanFromEvidence` 编译成修复 lane 和回归验证 lane，并避免同一失败证据重复生成或对 repair lane 生成二级自动修复。

调度器已经允许可信 `fix` lane 从失败依赖启动，普通验证、评审、提交仍要求依赖完成。

剩余差距是产品主路径：失败后自动触发 `ReplanFromEvidence` 还不是完整 UI/desktop 默认体验；`ui-canvas` 仍保留 `retryCanvasNode` 这种本地重试动作。

### 落地方案

失败证据进入事件流后，SkyTurn 生成一次 `ReplanFromEvidence`。

`ReplanFromEvidence` 编译必须在 Node 侧 workflow store 中完成。它继续生成：

- `workflow.replan.requested`
- 一个 `fix` 任务通道，语义键为 `repair:<failedLaneId>:<evidenceId>`
- 一个回归验证任务通道，语义键为 `regression:<failedLaneId>:<evidenceId>`
- `failedLane -> fixLane` 连线
- `fixLane -> regressionLane` 连线

原失败节点不改状态。失败节点输出、检查项和错误原因作为修复节点的依赖证据传入提示词。

调度器增加一条窄规则：普通任务仍然要求依赖已完成，只有可信 workflow state 中的 `fix` lane 允许依赖一个失败节点启动。验证、评审、提交不能依赖失败节点启动。

权限不能靠 lane title、`display.meta` 或 Hermes 输出猜。Node 侧投影必须给 `fix` lane 标出可信 sandbox policy，`sandboxForNodeRun` 只能读取这个可信字段。`fix` 使用 `workspace-write`，提交权限仍然只给提交或采纳节点。

`codexLaneInstruction` 增加修复节点说明：读取失败证据，做最小修复，运行相关回归验证，不提交。

lane kind 必须先统一。`workflow-kernel`、`persistence` 和 `ui-canvas` 至少要对这些语义达成一致：

- `implementation` 或 `coding`：代码实现。
- `fix`：针对具体失败证据的修复。
- `validation`：普通验证。
- `regression`：修复后的回归验证。
- `review`：评审。
- `commit`：提交。

如果底层持久化需要更窄的枚举，必须显式映射，不能让同一条 lane 在不同包里有不同含义。

### 验收

构造一个失败实现节点，合并失败运行事件后：

- 原节点状态保持失败。
- 画布新增修复节点，状态进入运行或等待调度。
- 画布新增回归验证节点，依赖修复节点。
- 修复节点可以从失败依赖启动。
- 普通验证、评审、提交节点不能从失败依赖启动。

同一个失败证据重复处理时，不得重复生成修复节点。

用户手动取消不触发自动修复。取消是人的中止，不是需要自动修的失败。

修复失败后近期不自动生成二级修复。除非用户明确选择继续，否则同一个原始失败证据只允许一条修复链。

## 功能三：用户决策节点

### 需求

当 Hermes 发现当前方案可能存在架构风险、需求歧义或重大返工成本时，它不能直接修改流程。SkyTurn 要生成一个用户决策节点，向用户展示问题、建议和可选操作。

用户选择必须持久化。刷新 UI 或恢复会话后，系统必须知道当时用户选了什么，以及为什么进入后续流程。

### 现状

`workflow-kernel` 已经要求 `RequestUserDecision` 携带 `decisionId`、`prompt`、`options`、`reason` 和可选目标对象，也支持 `workflow.user_decision.answered`。

`persistence` 能把决策请求投影成不可执行的 user decision node，Electron main 也有 `workflow:userDecision:answer` IPC。

当前 Electron UI 回答用户决策时会调用 `workflow:userDecision:answer`，写入 SQLite `workflow.user_decision.answered`，再用投影返回的 `CanvasSession` 更新 UI。browser/mock fallback 仍直接更新本地 canvas state。

### 落地方案

扩展事件模型：

```ts
workflow.user_decision.requested
payload: {
  decisionId: string;
  prompt: string;
  options: string[];
  reason: string;
  targetLaneId?: string;
  targetSegmentId?: string;
}

workflow.user_decision.answered
payload: {
  decisionId: string;
  selectedOption: string;
  action: "backtrack" | "parallel_worktree" | "continue" | "abort";
  comment?: string;
  targetLaneId?: string;
  targetSegmentId?: string;
}
```

`decisionId` 必须稳定，避免重复请求生成多个同样的决策节点。

`WorkflowIntent` 里的 `RequestUserDecision` 也必须携带同一组关键字段：

```ts
{
  type: "RequestUserDecision";
  decisionId: string;
  prompt: string;
  options: string[];
  reason: string;
  targetLaneId?: string;
  targetSegmentId?: string;
}
```

投影层把 requested 显示为决策节点，状态为等待输入。answered 后，决策节点完成，后续流程按用户选择继续。

决策节点可以复用 `CanvasNode` 的显示结构，但不能伪装成可执行 Hermes task。投影必须包含可信的非执行字段，例如：

```ts
{
  nodeKind: "user_decision";
  executable: false;
}
```

如果短期无法扩展 `CanvasNode`，必须在 Node 侧投影、scheduler 和 `startAgentRun` 入口同时硬拒绝 `display.meta` 包含 `user_decision` 的节点。这个兼容做法只能作为迁移，不作为长期模型。

界面上只显示问题、影响和可选操作。不要展示 Hermes 原始 JSON。

### 验收

Hermes 输出 `RequestUserDecision` 后，画布出现一个等待用户输入的决策节点。

用户选择后，事件流写入 `workflow.user_decision.answered`，刷新 UI 后仍能看到已选择的选项。

同一个 `decisionId` 重放不会重复生成多个决策节点。

尝试启动决策节点时，Electron main 必须拒绝，并返回明确错误。

## 功能四：会话执行目标和可选工作树

### 需求

New Session 输入框必须把“在哪里改代码”说清楚。默认是在当前项目工作区的选定分支上继续开发。隔离 worktree 是用户主动选择的模式，用于候选方案、双轨验证或不想污染当前工作区的实验。

输入区拆成两个组件：第一个组件选择执行目标，第二个组件选择当前项目里的一个分支。执行目标有两个选项：Current branch 和 New worktree。Current branch 是默认值。分支选择器默认选当前 checkout 的分支。

如果用户选择 Current branch，SkyTurn 以分支选择器里的分支开始开发，运行、diff、验证都归属当前项目工作区。如果用户选择 New worktree，分支选择器里的分支只作为 base，SkyTurn 从它创建候选工作树。候选工作树可以用于 detached HEAD 或其他内部候选形态，但在用户确认采纳前，不应该被产品语义当成正式项目分支。

最终用户可以选择采纳候选。采纳时才把候选提升为正式分支、提交、合并或 PR。未采纳的工作树不能立即粗暴删除，必须先确认没有运行中的任务，再安全清理。

### 现状

`CanvasNode` 和 `CanvasSession` 已经有 worktree/session target 元数据。New Session 输入已经提供 Current branch 和 New worktree 两个控件，Current branch 是默认值，分支选择会写入 session target。

`startBridgeRun` 会按 session target 决定 worktree path：Current branch 落到项目根目录；New worktree 优先复用节点上的绝对 worktree path，没有路径时会通过 `workflow:worktree:create` 先创建并绑定 managed worktree，再启动非 planner run。

`packages/git-worktree/src/node.ts` 已经有真实 `NodeGitWorktreeService`、比较、采纳、清理和恢复逻辑。Electron main 的 `workflow:worktree:create/adopt/clean` 已经调用这个 Node service，并把真实 side effect 的 requested、terminal 或 failed 事件写入 SQLite。

调度策略已经允许 read-only lane 并行，也允许不同真实 managed worktree 中的写 lane 并行；完整的双轨比较、采纳和清理产品 UI 还没打通。

### 落地方案

会话开始时先持久化用户选择的执行目标和分支选择。这个事实属于工作流事件流，不能只存在于 renderer state。渲染进程只展示和提交选择，不能执行 git 或决定真实路径。

Current branch 模式代表“直接在选定分支上开发”。它不创建候选 worktree，也不暗中创建新分支。这个模式是默认产品路径。

New worktree 模式代表“从选定分支派生候选空间”。这个候选空间的身份来自 SkyTurn 的 session、variant、worktree 元数据，而不是用户能看到的正式分支名。只有用户选择采纳后，SkyTurn 才进入创建正式分支、提交、合并或 PR 的流程。

并行调度要理解隔离边界。同一文件在不同候选工作树里修改可以并行；当前项目工作区内仍按文件范围冲突保守调度。

不同工作树并行不代表共享副作用也安全。每个变体必须有独立 artifact 目录、截图目录、run log 目录和 `.devflow/tasks/<session>/<variant>/` 子目录。需要 dev server 的验证必须拿到独立端口或端口锁。

比较流程：

- 收集两个工作树的测试、构建、评审和截图证据。
- 收集 `git diff --stat`、变更文件、受控大小的 diff 摘要。
- 进行采纳前冲突检查。
- 把结果呈现在裁决节点或节点详情里。

采纳流程：

- Current branch 模式不需要“采纳为分支”；变更已经发生在用户选定分支上，采纳语义主要是确认变更、提交、继续验证或回滚。
- New worktree 模式的候选在采纳前不是正式项目分支。
- 采纳前确认候选身份、base、当前 HEAD、路径和 gitdir 仍然匹配事件记录。
- 采纳前做冲突和可合并性检查。
- 用户确认采纳后，才创建正式分支、提交、合并、cherry-pick 或 PR。
- 未采纳的变体写入拒绝事实，等待清理。

清理流程：

- 确认没有运行中的任务。
- 用 `git worktree list --porcelain` 确认目标路径确实是 git 工作树。
- 确认 `worktreeId`、`realPath`、`gitdir`、base 和当前 HEAD 与事件记录一致；如果候选已经转正为分支，再确认分支名。
- 只允许清理 SkyTurn 管理目录下的工作树。
- 写入 `workflow.worktree.clean_requested`。
- 使用 `git worktree remove <path>`。
- 删除正式分支要单独确认，不能默认删除。
- 写 `workflow.worktree.cleaned`。

### 安全要求

这是会修改本机仓库和文件系统的功能，必须先按最小权限做。

所有路径都要 `realpath` 后校验，必须落在已打开项目或 SkyTurn 管理的工作树目录下。

`realpath` 包含性检查不够。采纳和清理必须绑定候选身份、repo root、gitdir、base 和当前 HEAD；如果候选已经转正为分支，再绑定分支名。不能只凭路径属于管理目录就执行。

所有 git 调用使用参数数组，不走 shell 拼接。branch、ref、base commit 和路径必须是 SkyTurn 内部生成或经过严格校验的值。需要区分 option 和 path/ref 的命令必须使用 `--` 终止选项解析。

创建、采纳、清理都要有试运行或可回滚步骤。合并失败时必须执行 `git merge --abort` 或 `git cherry-pick --abort`。

`danger-full-access` 只允许提交和采纳节点按需使用，不能变成默认权限。

### 验收

New Session 默认显示 Current branch，并默认选中当前 checkout 的分支。

选择 Current branch 时，运行目标是选定分支所在的当前项目工作区，不创建 managed worktree。

选择 New worktree 时，分支选择器里的分支被当成候选工作树 base。

两个候选变体节点使用不同绝对路径运行。

比较节点能返回两个变体的测试证据和 git 变更摘要。

采纳其中一个变体后，事件流记录采纳信息。

清理另一个变体时，确认路径属于 SkyTurn 管理范围，且候选身份、gitdir、base 和当前 HEAD 与事件记录一致，再使用 `git worktree remove`。

## 功能五：节点检查点和回滚

### 需求

SkyTurn 要把节点当成可恢复的工作流边界。每次节点运行都有两个用户可理解的检查点：

- before checkpoint：这个 run 开始前的工作流和本地文件边界。
- after checkpoint：这个 run 结束并写入 `RunEvidence` 后的边界。

用户选中节点时不打开详情，只把底部输入框绑定到该节点。节点详情只能通过节点卡片的 **More** 按钮打开。

选中节点后，底部输入框至少支持三类节点动作：

- repair from after checkpoint：保留当前节点的运行结果和证据，从 after checkpoint 之后生成修复节点。
- variant from before checkpoint：从 before checkpoint 派生替代方案，不把当前节点输出当作新方案的前提。
- rollback selected node and downstream：回滚选中节点和所有下游节点。

回滚不是删除历史。被回滚的节点、下游节点、输出、证据和决策记录都必须保留，只是状态变成 rolled back 或 inactive。rolled-back / inactive 节点不能再被 scheduler 启动。

### 现状

当前代码已有节点弹窗、`RunEvidence`、SQLite workflow events、git changeset reconciliation、delivery commit/push/PR actions 和 managed worktree side effects。选中节点已经绑定底部 composer scope，节点详情仍通过 **More** 打开且只有 `Output`、`Changes`、`Context`。selected-node composer 已经能基于投影和 checkpoint 状态显示 repair、variant、rollback 操作及 checkpoint / affected downstream / remote blocker / manual repair 摘要。

后端也已经有 rollback eligibility / apply IPC、cascade projection、remote side-effect blocker、in-flight remote mutation blocker、local commit / worktree / branch safety gate、rollback request/apply/reject 事件和 crash-window retry 处理。仍需继续收敛的是：把 renderer local fallback 迁出真实桌面主路径，把 adapter thread/history rollback 与 SkyTurn graph/filesystem rollback 分层记录做成默认体验，并持续打磨 repair / variant / rollback 的用户路径。

### 落地方案

投影层保留节点选择的轻量语义。选择节点只设置 `selectedNodeId` 和 composer scope，不打开 modal。节点卡片的 **More** 按钮才打开详情。modal 仍然只有 `Output`、`Changes`、`Context` 三个页签。

checkpoint 记录必须绑定这些事实：

- `sessionId`
- `nodeId`
- `runId`
- checkpoint kind: `before` 或 `after`
- workflow event sequence
- execution target: current branch 或 managed worktree
- repo root / worktree path
- git HEAD、base ref、local commit evidence，如果存在
- checkpoint 关联的 `RunEvidence` 或 pending run identity

checkpoint 粒度固定在 node/run boundary。不要把每一次工具调用、每一次 patch apply、每一次 shell 命令都变成用户可选检查点。底层 Hermes-style filesystem checkpoint 可以用于 adapter 安全恢复，但它只是实现细节。

三类节点动作分别进入事件流：

- `workflow.node_repair.requested`：以 after checkpoint 为起点，生成修复节点和必要的回归验证节点。
- `workflow.node_variant.requested`：以 before checkpoint 为起点，生成替代实现节点。需要隔离时，必须走 New worktree 或受控候选空间。
- `workflow.node_rollback.requested`：请求回滚选中节点和下游节点。

回滚执行前先计算影响范围：

- 选中节点。
- 所有依赖选中节点的下游节点。
- 下游节点关联的 run、changeset、commit、push、PR、merge、main sync 和 cleanup 事件。

如果影响范围内存在 push、PR 创建、merge 或 main sync，回滚必须停止，并把原因显示给用户。这些已经越过远端副作用边界，SkyTurn 不能假装本地回滚能撤销远端事实。

本地 commit 不是远端副作用，但也不能草率处理。跨本地 commit 回滚必须满足安全门禁：

- 有精确 commit hash、parent/base、branch 和 worktree 证据。
- 当前 branch/worktree 身份仍和事件记录一致。
- 没有未归属的后续变更或下游 remote side effect。
- 用户显式确认。
- 能记录 terminal success/failure event。

回滚成功后，图状态级联更新：

- 选中节点和下游节点标记为 rolled back 或 inactive。
- 下游边保留，但显示为不再参与调度。
- 旧证据、输出、diff、commit 记录和用户决策仍可读。
- scheduler 拒绝启动 rolled-back / inactive 节点。
- 新的 repair 或 variant 必须作为新节点出现，不能复活旧节点。

Codex rollback 只处理 Codex thread/history。SkyTurn 可以调用或记录这种 adapter-level recovery，但它不能代替 workflow event、graph projection 或 filesystem rollback。SkyTurn 必须把三层状态分开记录：graph state、agent thread/history state、filesystem/worktree state。

rollback 也不能做 delivery cleanup。它绝不自动 close PR、delete remote branch、merge、sync main 或 delete local branch。需要这些动作时，仍然走独立的显式 delivery action 和确认。

### 验收

点击节点只改变选中态和底部输入框 scope，不打开详情。

点击节点卡片 **More** 才打开节点详情，且详情仍只有 `Output`、`Changes`、`Context`。

选中节点后，底部输入框能发起 repair、variant 和 rollback 三类 node-scoped action。

repair 从 after checkpoint 生成修复链，原节点保留已有输出和证据。

variant 从 before checkpoint 派生替代节点，不把原节点 after 状态当作前提。

rollback selected node and downstream 后，选中节点和全部下游节点变成 rolled back 或 inactive，证据和历史仍可读。

rolled-back / inactive 节点不能被 scheduler 启动。

影响范围内存在 push、PR 创建、merge 或 main sync 时，rollback 被阻止并显示远端副作用原因。

影响范围内只有 local commit 时，必须通过 exact commit evidence 和安全确认后才能继续。

rollback 不会自动关闭 PR、删除 remote branch、merge、sync main 或删除 local branch。

## 功能六：自然流式画布

### 需求

画布要表现为“流程正在生长”，但这个生长必须来自真实事件。节点出现、边出现、状态变化、输出短句更新都应该由事件流驱动。

节点保持紧凑。节点卡片显示任务标题、agent、状态、短执行动作和少量上下文。完整输出、diff 和依赖证据放在节点弹窗里。

### 现状

画布已经使用 `@xyflow/react`。节点和边由 `CanvasSession.nodes`、`CanvasSession.edges` 渲染，真实桌面路径会从 SQLite workflow projection materialize 出 `CanvasSession`。

`motion.ts` 已经集中管理节点入场、运行、完成、失败和边流动。GSAP 只做视觉状态，不控制图坐标。

UI 已经订阅 Electron 的 `workflow:event` 广播并拉取 `workflow:projection`。`mergeRunEventsIntoWorkspace` 仍负责 run event 对 UI 的即时反馈和 browser fallback。

缺口是节点位置和部分用户动作仍是本地 state；节点短句也还偏保守，未完全由结构化 workflow/action 字段驱动。

### 落地方案

继续保持一个入口：运行事件和工作流事件先进入 Node 侧状态投影，再由画布渲染。不要新增独立动画系统。

进度短句只使用安全字段，例如阶段、动作、命令名、检查名。不要把 stderr 原文、提示词、完整 JSON、完整日志塞进节点卡片。

节点位置要稳定。Node 侧投影重新生成时，应优先保留已有节点位置；只有新节点才使用自动布局。用户拖动节点后，渲染进程写入位置更新事件，不能只改本地内存。

边的状态由目标节点状态决定。运行中的目标节点让边流动，失败节点让边显示中断，完成节点让边静止。

节点弹窗继续只保留三个页签：

- `Output`：运行输出摘要。
- `Changes`：真实变更摘要和 diff 预览。
- `Context`：目标、依赖、工作树、分支、证据来源。

### 验收

模拟 Hermes 逐步输出 intent，画布按事件增量出现节点和边。

运行事件里的阶段变化能更新节点短句。

完整日志、提示词、WorkflowIntent JSON 不出现在节点卡片正文。

重复投影后，已存在节点的位置不被重置。

开启减少动态效果设置时，节点和边动画降级，但流程仍可读。

刷新 UI 或切换会话后，节点位置来自事件投影，不来自 renderer 的临时状态。

## 功能七：真实变更和裁决证据

### 需求

节点详情里的变更必须来自可验证来源，不能来自 Hermes 或 Codex 的自然语言总结。当前运行中的 live changes 优先来自结构化 agent/run 事件；最终 changeset 再用 git 数据对账。

SkyTurn 可以让 Hermes 总结证据，但胜负依据必须来自测试、构建、评审、截图、性能测试和 git 变更差异。

### 现状

`Changeset` 和 `FinalChangesetReconciliation` 已经支持 `source: "git"`。Electron main 的 changeset IPC 会调用 Node 侧 git service 读取 status、diff、numstat 和 bounded patch preview。

`agent-bridge` 已经能记录测试、构建、退出码、artifact，并能把 Codex `file_change` / `turn.diff` 类结构化输出映射成 `changes` run events；agent 自然语言不会被当作变更事实。

`Changes` 页签已经能展示 live structured changes、git reconciliation、mismatch 和空证据状态。合格的 commit lane 可以通过 `workflow:delivery:commit` 创建受控本地提交，也可以在提交后显式 push delivery branch，并在存在依赖 `pull_request` lane 时显式 create PR。`workflow.commit.created` 可以完成 commit lane；`workflow.delivery.pushed` 和 `workflow.pull_request.created` 当前只记录事件，不完成 Flow Kernel lane。`workflow.pull_request.checks_recorded` 记录 exact-head PR check evidence，只有当前 PR head 的 passed checks 可以满足 check/gate lane。merge、post-merge sync 和 delivery cleanup 已有显式请求路径，但必须由用户确认，不能由 PR 创建或 green checks 自动触发。

### 落地方案

真实变更来源分两层：

- Live layer：消费 agent/adapter 发出的结构化变更事件。对 Codex 来说，应优先接收 patch/file-change/turn-diff 类事件，并把文件级 `Add`、`Delete`、`Update`、move path 和 bounded diff 作为 UI 变化来源。
- Reconcile layer：在节点结束、用户打开 Changes 页签、裁决或采纳前，用 git 对当前执行目标做最终对账，返回变更文件、增删统计、bounded diff 预览和来源。

当前分支模式的对账基线是会话开始时选定分支的状态。New worktree 模式的对账基线是创建候选工作树时选择的 base 分支/ref。

`@skyturn/git-worktree` 根入口只保留 `ChangesetService` contract 和 mock，不导出真实 git 实现。真实实现不得进入 renderer bundle。

裁决节点只显示可验证指标：

- 测试是否通过
- 构建是否通过
- 类型检查是否通过
- 截图或产物路径
- 变更文件数量
- diff 摘要
- 性能测试输出
- 冲突检查结果

没有数据的指标显示为未知，不让 Hermes 补故事。结构化事件和 git 对账冲突时，UI 必须标出不一致，不能静默选择一个结果。

### 验收

Codex 产生结构化 patch/file-change 事件时，`Changes` 页签能显示 live 文件变更摘要。

在真实 git 仓库中修改文件后，`Changes` 页签能显示 git 对账后的变更摘要。

没有真实变更差异时，界面显示“没有可用变更证据”，而不是模拟数据。

双轨或候选比较时，裁决节点只使用已记录证据。

打包检查必须证明 renderer bundle 没有 Node git/diff 实现和 native dependency。

## 当前状态路线图

这份路线图按四条轨道推进。轨道之间共享同一条规则：完成状态只能来自 `RunEvidence`、workflow events、git/check/artifact/review/commit evidence，不能来自 agent prose、mock output、browser fallback state 或 terminal text。

### 轨道一：Current branch 主路径

已接入：

- SQLite workflow session、events、lane / segment / evidence 存储、ledger summary、projection replay 和 `materializeCanvasSession`。
- Hermes prompt 的 `sessionLedger` 注入，以及 Node 侧 ledger allowlist / 脱敏 / 长度限制。
- Current branch 默认执行目标，New worktree 显式 opt-in，分支选择写入 session target。
- Current branch 真实循环可以在项目根目录启动 Hermes/Codex、写回 `RunEvidence` 并做 git 对账。
- 用户决策节点可投影为不可执行节点，Electron UI 回答会写入 `workflow.user_decision.answered`。
- Node Modal 的 `Output` / `Changes` / `Context` 三页签；Context 显示 RunEvidence，Changes 显示 live changes、git reconciliation、mismatch 和 diff preview。

仍需收敛：

- 真实桌面 workflow 已经使用 SQLite projection，但 renderer 仍有 browser/mock fallback 和局部 local state。
- 后续目标是让真实桌面主路径只消费 Node 侧事实源，减少 renderer 从 `CanvasSession` 反推事实、本地调度和本地 retry/position-only 状态。

### 轨道二：失败修复和回归

已接入：

- `ReplanFromEvidence`、repair successor、variant successor 和 regression 基础已经存在。
- selected-node composer 已有 repair / variant / rollback 操作、checkpoint 摘要、rollback impact、remote blocker 和 manual repair 摘要。
- Rollback backend 已有 cascade projection、remote side-effect gate、in-flight remote mutation gate、local commit / branch / worktree safety gate、request-before-reset ordering 和 crash-window retry。

仍需收敛：

- 失败后自动生成修复链还不是完整 desktop 默认体验。
- 产品主路径必须保持原失败节点 failed，新增修复节点和回归验证节点，同一 evidence 不重复展开。
- repair 从 after checkpoint 开始，variant 从 before checkpoint 派生，rollback 覆盖选中节点和下游节点。旧证据和历史必须保留。

### 轨道三：New worktree 候选路径

已接入：

- Worktree create/compare/adopt/clean 后端和 IPC 已接入。
- `startBridgeRun` 在 New worktree 模式下会使用节点绝对 worktree path；缺少 path 时会先请求 managed worktree。
- Current branch 仍是默认主线。New worktree 只是 New Session 里显式选择的候选执行空间。

仍需收敛：

- 双轨比较、采纳、清理还需要更完整的产品路径和 artifact/log/screenshot/port 隔离。
- 产品化 worktree compare/adopt/clean 时必须使用现有节点详情和 Changes/Context surface，不新增 dashboard。

### 轨道四：显式交付门禁

已接入：

- Delivery commit、push、create PR、exact-head check、review gate、squash merge request、post-merge main sync 和 cleanup request 都是显式动作。
- `workflow.commit.created` 可以完成 commit lane；`workflow.delivery.pushed` 和 `workflow.pull_request.created` 当前只记录事件，不完成 Flow Kernel lane。
- `workflow.pull_request.checks_recorded` 记录 exact-head PR check evidence，只有当前 PR head 的 passed checks 可以满足 check/gate lane。

仍需收敛：

- PR 创建、green checks、merge、main sync 和 cleanup 不能自动串联执行。每一步都必须是用户显式动作，并通过 Electron main 的后端 gate。
- 对 delivery remote path 做显式 disposable smoke。普通用户项目仍必须通过手动 commit / push / PR / checks / merge / sync / cleanup 操作，不能自动开 PR 或自动 cleanup。

### 实验运行和 fallback 边界

- Hermes / Codex CLI real adapters 已接入，但仍标为 `experimental-run`，不是 `supported-run`。它们仍依赖本机 CLI、认证、输出格式、限流、timeout/cancel/retry 和 structured changes 映射。
- Mock/browser fallback 只用于开发测试、非桌面验证或 degraded runtime path，不能作为真实完成证据。
- Artifact evidence 已能进入 `RunEvidence` 并在 Context 展示，真实 MVP demo 也会捕获截图；但 artifact 的生成、登记和验收仍依赖具体 lane/script，还不是统一产品能力。
- Changes live layer 已能消费结构化 run changes；Codex-style patch/file-change/turn-diff 覆盖面仍需要随真实 CLI 输出继续加固。
- PTY 是 Hermes planner 状态、检查和接管传输边界。默认桌面 runtime 没有生产 PTY factory；PTY 不是全局 terminal dashboard，也不是 Codex 默认 executor。

### 未完成或非目标

- 不做 IDE、文件标签页、内置代码编辑器、全局终端 dashboard 或 no-code workflow builder。
- New worktree 不是默认主线。
- 当前没有本地 agent adapter 可以写成 `supported-run`。

## 后续主要修改位置

`packages/persistence/src/workflowStore.ts`

继续收敛 Node 侧 canonical projection、repair / variant / rollback replay、ledger summary、side-effect recovery 和多会话唯一性。不要让 renderer 成为事实源。

`packages/workflow-kernel/src/index.ts`

继续维护 WorkflowIntent schema、replan / successor / gate / scheduler 规则、delivery gate 和 rollback projection。任何 merge-ready 或 schedulable 结论都必须来自明确 evidence。

`packages/ui-canvas/src/workflowRuntime.ts` 和 `packages/ui-canvas/src/App.tsx`

保留现有画布、节点、Node Modal 和 bottom composer surface。后续 UI 工作应消费投影与 typed preload API，不新增 evidence dashboard，不在 renderer 执行 git/fs/shell/SQLite。

`packages/agent-bridge/src/index.ts`

继续硬化 Hermes/Codex real adapters 的 readiness、timeout、cancel、output parsing、structured changes 和 RunEvidence 映射。`experimental-run` 不应被文档或 UI 误写成 supported。

`packages/git-worktree/src/node.ts`

继续维护 Node-only worktree、changeset、delivery、PR、merge、sync、cleanup 和 rollback filesystem safety。根入口继续只暴露 browser-safe contracts/mocks。

`apps/desktop/electron/main.ts` 和 `apps/desktop/electron/preload.ts`

继续作为本机 side effect 和 workflow IPC 边界。新增能力必须保持窄 preload API、路径/身份校验、状态机事件和重启后可恢复。

## 测试和验收命令

单元测试：

```bash
pnpm --filter @skyturn/workflow-kernel test
pnpm --filter @skyturn/ui-canvas test
pnpm --filter @skyturn/orchestrator test
```

工作流验收：

```bash
pnpm run flow-kernel:acceptance
```

真实 MVP 验证：

```bash
pnpm --filter @skyturn/desktop run demo:mvp
```

真实 GitHub disposable PR smoke 属于 delivery remote path 的验收/测试路径，不是导入用户项目后的默认行为。普通用户项目必须通过显式 commit、push、create PR 操作和后端校验，不能自动开 PR。

桌面或浏览器验收需要在构建后看真实界面。`apps/desktop` 可能消费 `packages/ui-canvas/dist`，所以 UI 修改后要先重建相关包，再判断界面结果。

## 安全和可靠性

Hermes 和 Codex 本地运行仍属于实验能力。输出格式、认证、限流、退出事件都可能变化。SkyTurn 必须容忍缺失、乱序、重复事件。

事件账本可能包含用户需求、路径、错误日志和测试输出。注入提示词前必须做长度限制和敏感内容过滤，不得把 `.env`、token、完整日志、完整变更差异无限制传给 Hermes。脱敏和降采样必须在 Electron main / Node-only persistence 层完成，不能在 renderer 做。

工作树、合并、清理都是安全敏感操作。所有操作必须由 Electron main 执行，使用最小权限、路径校验、身份绑定、试运行检查、状态机事件和回滚步骤。delivery merge、post-merge sync 和 delivery cleanup 已接入为显式用户请求；它们不能自动串联执行，cleanup 后的 branch deletion 默认关闭并需要二次确认。

节点回滚也是安全敏感操作。影响范围内只要存在 push、PR 创建、merge 或 main sync，就必须阻止 rollback。local commit 不是 remote side effect，但跨 commit rollback 必须有精确 commit evidence、branch/worktree 身份校验、干净的安全条件和用户确认。rollback 不得自动关闭 PR、删除 remote branch、merge、sync main 或删除 local branch。

SQLite 事件和 git side effect 是双写关系，必须显式处理崩溃恢复。任何 create/adopt/clean 只要写入了 requested 事件，重启后都要能对账磁盘状态，补齐完成事件、失败事件，或进入需要人工确认的 orphaned 状态。

参数数组只能避免 shell metacharacter，不等于完整安全。branch、ref、base commit、path 和 worktree id 必须有格式校验。git 命令需要区分 option 和 path/ref 时必须使用 `--`。

双轨并行只隔离源码目录是不够的。artifact、日志、截图、临时文件、端口和 dev server 都必须按 session/variant 隔离或加锁。

完成状态继续只认 `RunEvidence`。Hermes 的总结可以作为说明，不能作为完成证据。

## 还不确定的功能

是否需要真实 Hermes 原生会话恢复。当前可以优先用事件账本保证连续性。只有拿到稳定的 `opaqueHandle` 并确认 `--resume` 行为可靠后，才把它作为增强能力。

是否限制自动修复次数。建议近期按“同一个失败证据只生成一次修复”处理。是否允许修复失败后继续生成二级修复，需要产品决定。

双轨比较是否需要自动性能测试。近期可以先比较测试、构建、变更差异和冲突检查。性能测试要等项目自己提供可重复命令后再接入。

采纳变体当前使用 merge。当前 UI 的 Adopt Worktree 会先要求用户确认，并固定传 `merge`；本轮不暴露 cherry-pick 选择器。backend contract 仍能表达 `cherry-pick` 以保持兼容，但它不是当前产品界面能力。

决策节点是否需要单独的节点类型。近期可以复用 `CanvasNode` 的显示结构，但必须有可信的不可执行字段。长期如果决策节点交互变复杂，再考虑新增专门类型。

工作流事件流是否完全替代当前工作区 JSON。方向应该是 SQLite 事件流做事实源，但迁移要分阶段，避免一次性打断现有 MVP。
