# Flow Kernel v1 Goal

Use this full prompt as the active Codex goal for the Flow Kernel v1 milestone.

```text
/goal 在 /Volumes/HDD/MyStorage/Projects/SkyTurn 中完整交付 Flow Kernel v1：用户输入需求后，Hermes 只输出 WorkflowIntent，SkyTurn 确定性验证/编译 intent 为动态 DAG lanes/edges，SQLite event stream 成为唯一事实源，Agent Bridge 执行 segments，Canvas 实时投影开发过程。这个 Goal 只有在下面所有实现、集成、测试、真实场景验收、提交和证据报告全部完成后才算 complete；不要在设计稿、脚手架、mock-only demo、单个 milestone 或单个场景通过后结束。

工作边界：
- 先确认当前 git 状态；从当前基线创建新分支 codex/flow-kernel-v1，不直接在 main 上改。
- 遵守仓库 AGENTS.md：SkyTurn 是 desktop workflow platform，不是网页/IDE；canvas-first；不加 file tabs/global terminal/code editor。
- 保持边界：renderer 只做 UI/投影；Electron main 拥有 filesystem/git/process/SQLite/IPC；agent-runtime 只放 contract；agent-bridge 执行本地 agents，不做 DAG 编排。
- 不破坏现有 MVP：bottom workflow input 仍创建 Hermes planning card 并走真实 workflow-card tools；RunEvidence 仍是 node completion 的依据。
- 不把流程写成固定模板；必须实现 policy + gate + intent compiler。不要写死 “React 流程/Go 流程/Python 流程”。
- 不引入 credential 存储、--yolo、renderer shell/git 执行、browser-facing better-sqlite3 import，或绕过现有安全边界。
- 如需新依赖，先查当前官方文档/Context7，选择最小依赖，并说明原因。

必须交付的实现：
1. 新增 packages/workflow-kernel：
   - WorkflowIntent schema：AnalyzeRequirement、DiscoverProject、ProposeLanes、SplitLane、JoinLanes、StartImplementation、RequestValidation、RequestReview、RequestUserDecision、ReplanFromEvidence。
   - Lane/Edge/Segment/Evidence/ProjectProfile/RequirementProfile/FlowPolicy/JoinRule/GateRule 类型。
   - deterministic compiler、gate engine、ready-lane scheduler、projection reducer、policy-pack 机制。
   - policy packs 只声明 detection/capability/evidence/validation/suggested lanes，不拥有完整写死流程。
2. SQLite event store 接入主路径：
   - `.devflow/skyturn-workflow.sqlite` 记录 workflow.user_input、profile、intent accepted/rejected、lane/edge/segment/evidence/join/replan/user-decision/commit 等 events。
   - Electron main 持有 store；renderer 通过 preload/IPC 订阅 projection。
   - 刷新或重开 UI 后，canvas 从 event stream replay，不丢 DAG、lane state、segment output、evidence、rejection reason。
3. Hermes Intent Protocol：
   - Hermes prompt v2 让 Hermes 输出 intent，不输出 UI card mutation。
   - parser/validator 能接受合法 intent、拒绝非法 intent、持久化 rejected event。
   - 重复 Hermes 输出必须 idempotent，不重复创建 lane/edge。
4. Dynamic Flow Scheduling：
   - 支持 ready lanes、allowed parallelism、file/package scope conflict、join rules、failure -> fix/replan。
   - gate 必须拒绝：implementation before discovery、review before implementation evidence、join before upstream complete、commit before review+validation、cycle edge、planner/intake incoming edge、Hermes 设置 completed。
5. Agent Segment Execution：
   - Codex segment runner、validation runner、diff collector、evidence collector 接到 workflow events。
   - completed 只能由 concrete evidence 推导；agent stdout 和 Hermes 文本不能直接设置 completed。
   - timeout/cancel/failure 必须生成 terminal RunEvidence/status 和 failed segment，不能留下永远 running 的 lane。
6. Canvas Streaming UI：
   - Canvas 实时显示动态生成 lanes/edges、running output、gate rejection、join node、failed/fix/replan 状态。
   - Operation log 可以让用户看到 accepted/rejected intents 和原因。
   - UI 必须保持 compact node + canvas-first，不把 logs/prompts/config/code 塞进 node 卡片正文。

验收必须自动化，不能要求用户手工判断：
- 新增一个可复现的 flow-kernel 验收命令，优先按仓库 script 风格命名；若无现成模式，用 package-level script + root turbo delegator。
- 该命令必须覆盖 4 个真实场景，不允许只做 toy unit demo：
  A. Frontend UI：搜索过滤控件，期望 discovery -> design -> implementation -> browser_validation -> review -> commit，并有 screenshot/browser evidence。
  B. Backend API：新增 endpoint，期望 discovery -> contract_analysis -> implementation -> unit_test -> integration_test -> review，并有 test evidence。
  C. Data/script：CSV 清洗和校验，期望 data_contract_analysis -> implementation -> fixture_validation -> regression_check，并有 fixture evidence。
  D. Complex fullstack：新增用户设置项，前端/后端/persistence 分叉，integration_join 后 validation/review，并能在 projection 中证明 fork/join。
- 场景可以使用临时真实 git fixture repos 或仓库内 fixtures，但必须真实跑 compiler/store/scheduler/projection/validation/evidence path；不能只 snapshot 静态 JSON。
- 如果本机 Hermes/Codex credentials 可用，必须运行真实 Hermes-to-Codex MVP 验证：`pnpm --filter @skyturn/desktop run demo:mvp`。如果 credentials 缺失，不能标记 complete；必须停为 blocked，并给出缺失项、已验证范围、解锁步骤。

通用验证：
- 跑并修复：pnpm install 如需要、typecheck、lint、unit tests、build、新增 flow-kernel 验收命令、desktop renderer/browser 或 Electron 可行路径验证。
- 对 UI 变化，必须生成可审查 screenshot/artifact path；不要让用户自己打开界面找问题。
- 对 SQLite/replay，必须有测试证明同一 event stream 投影完全一致。
- 对 gate，必须有测试证明非法 transition 产生 rejected event，而不是静默失败。
- 对 idempotency，必须有测试证明重复 Hermes intent 不重复创建 lane。
- 对 evidence-only completion，必须有测试证明 Hermes/agent 文本声明完成不会让 lane completed。

迭代策略：
- 先读现有代码、scripts、tests、AGENTS.md，列出最小集成路线；然后实现，不要停在计划。
- 维护一个 repo 内进度/验收文件（例如 docs/flow-kernel-v1-acceptance.md），记录每个 milestone 的证据、命令和当前 blocker；这只是工作日志，不是完成证据。
- 每次失败先定位根因；疑似瞬时问题只重试一次；第二次失败必须记录 fallback/blocker。
- 如果 context/budget 接近限制，更新进度文件并继续从证据状态恢复；不要因为预算或上下文压缩把 Goal 标记 complete。
- 只有真正缺权限、缺 credentials、缺外部服务或存在会破坏用户数据的动作时才问用户；其他情况做最小正确决定并记录。

完成前必须：
- 检查 edited directories 是否有值得保留的 AGENTS.md reusable learning；只有 genuinely reusable 才更新。
- 提交所有相关变更，commit message 清楚说明 Flow Kernel v1。
- 最终报告必须包含：branch、commit hash、关键文件路径、验证命令及 pass/fail 摘要、4 个场景证据、UI artifact path、已知风险。没有全部通过就不能说 complete。
```

To start from a short reference instead of pasting the whole block:

```text
/goal Read docs/flow-kernel-v1-goal.md and execute the full Flow Kernel v1 goal exactly as written. Treat that file as the completion contract: do not mark the goal complete until every implementation, integration, automated acceptance scenario, real verification command, commit, and evidence report required there is done.
```
