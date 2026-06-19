你在 SkyTurn 仓库中实现“一个 SkyTurn 会话 = 一个持续 Hermes 主会话”的流式工作流内核。

目标：
把当前一次性卡片生成模型，重构为 SQLite 持久化的流式工作流模型。画布节点必须由事件流稳定推导出来，不能由临时内存或代理文本直接决定。

Hermes 是每个会话的主导演。Codex 等代理是被 Hermes 按门禁逐步启动的执行线。节点必须流式出现，不能让 Hermes 一次生成所有未来卡片。

核心产品规则：
1. 一个 CanvasSession 绑定一个稳定 Hermes 主会话。
2. Hermes 主会话必须是持续会话或官方可恢复会话，禁止用 hermes -z 假装长会话。
3. Hermes 主会话只生成当前门禁允许出现的节点增量。
4. 编码节点出现前，必须已有需求规划节点完成。
5. 如果需要查文件或 GitHub issue，必须先出现分析节点。
6. Codex 可以并行运行，但每条执行线必须有隔离工作树、允许范围、禁止范围、最快验证命令。
7. 评审节点必须在实现节点有可信变更和局部验证后才出现。
8. 提交、拉取请求、合并节点必须在评审节点完成后才允许出现。
9. 合并节点必须依赖当前拉取请求状态和评审事实，不能提前出现在画布。
10. 节点完成只看证据，不看代理自述。
11. 画布是 SQLite 事件流的投影，不是事实源。
12. 同一事件流重复投影，必须得到完全一致的画布。

Hermes 主会话要求：
SkyTurn 的一个 CanvasSession 必须绑定一个持续 Hermes 主会话。Hermes 主会话负责持续接收：
- 用户后续输入
- 项目现场事实
- 文件分析结果
- GitHub issue 分析结果
- Codex 执行结果
- 评审结果
- 验证证据
- 人工关卡输入

禁止：
- 使用 hermes -z 作为 Hermes 主会话入口
- 每次用户输入都运行一次 hermes -z
- 每次规划都启动一个新的 Hermes 一次性进程
- 用 hermes -z 的输出假装这是同一个 Hermes 会话
- 在 UI、事件、证据里把一次性重放标成原生长会话

必须优先实现以下之一：

方案一：长驻 Hermes chat 会话

启动形式应基于 Hermes 的完整 chat 入口，例如：

hermes -p <planner-profile> chat

SkyTurn 持有该 Hermes 主会话进程或会话句柄，并通过受控输入通道把后续用户输入、工作流事件摘要、执行结果继续送入同一个 Hermes 会话。

要求：
- 一个 CanvasSession 对应一个 Hermes 主会话进程或会话句柄
- 后续用户输入必须进入同一个 Hermes 主会话
- Hermes 输出必须以流式方式解析成工作流事件
- 进程退出、崩溃、取消必须写入 SQLite 事件
- transport 必须记录为 hermes_live_chat
- 必须有证据证明同一进程或同一会话句柄被复用

如果 Hermes 的 chat 入口实际无法持续接收后续输入，而只是一次性 chat -q 后退出，则它不能作为 Hermes 主会话实现。

方案二：Hermes 官方会话恢复接口

如果 Hermes 提供公开的 session id、resume id、daemon、网关、ACP 或等价接口，可以使用该接口恢复同一个 Hermes 会话。

要求：
- 只使用公开接口
- 不读取或依赖 Hermes 私有数据库
- 持久化 opaque session handle
- 恢复成功后 transport 记录为 hermes_session_resume
- 恢复失败必须写入事件
- 恢复失败后降级必须明确标记

降级规则：
只有在确认当前环境无法提供长驻 Hermes chat 或公开恢复接口时，才允许降级为恢复重放模式。

降级模式必须标记为：

transport = hermes_replay_recovery

并且必须在运行事件中写清楚：
- 当前不是同一个 Hermes 原生会话
- 连续性来自 SkyTurn SQLite 工作流事件流和检查点
- 本次是重新构造上下文后启动的新 Hermes 运行

降级模式仍然禁止使用 native-session、live-session、long-session 这类会误导的名称。

Hermes transport 类型：
- hermes_live_chat
  同一个长驻 Hermes chat 会话仍然存活，后续输入进入同一会话。

- hermes_session_resume
  通过 Hermes 公开恢复接口恢复了同一会话。

- hermes_replay_recovery
  没有原生长会话。SkyTurn 用 SQLite 事件流和检查点重建上下文，然后启动新的 Hermes 运行。

禁止使用：
- native-session
- oneshot-fallback
- one-shot replay 假装长会话
- hermes -z 作为主规划会话

存储要求：
一步到位使用 SQLite。不要先做 JSON 文件事件流。

数据库放在导入项目根目录下：

.devflow/skyturn-workflow.sqlite

SQLite 连接只允许在 Electron main / agent-bridge / 后端侧持有。renderer 不直接访问数据库。renderer 通过现有 devflow API 或新增 IPC 调用读写投影和事件。

建议使用 better-sqlite3 或同等级本地 SQLite 库：
- 开启 WAL：journal_mode = WAL
- 开启 foreign_keys
- 所有写入使用事务
- 使用预编译语句
- 不在 renderer 中加载原生 SQLite 模块
- 不在事务函数里混用异步逻辑
- 所有写操作必须经过一个受控 workflow store

必须实现迁移系统：

schema_migrations(version, applied_at)

迁移必须幂等，重复启动不能破坏现有数据。

核心表：

workflow_sessions
- id 主键
- project_id
- hermes_session_id 唯一且稳定
- planner_lane_id 唯一且稳定
- title
- goal
- mode
- created_at
- updated_at

hermes_sessions
- id 主键
- workflow_session_id
- transport
- planner_profile
- process_id 可空
- opaque_handle 可空
- status
- started_at
- last_seen_at
- ended_at 可空
- recovery_reason 可空
- metadata_json

约束：
- workflow_session_id 唯一
- transport 只能是 hermes_live_chat、hermes_session_resume、hermes_replay_recovery
- hermes_live_chat 必须有 process_id 或等价 live handle
- hermes_session_resume 必须有 opaque_handle
- hermes_replay_recovery 必须有 recovery_reason
- 禁止把 hermes_replay_recovery 显示为原生长会话

workflow_events
- id 主键，建议使用可排序字符串或整数自增
- session_id
- seq 会话内单调递增
- kind
- source
- lane_id 可空
- segment_id 可空
- causation_id 可空
- correlation_id 可空
- idempotency_key 可空
- payload_json
- created_at

约束：
- unique(session_id, seq)
- unique(session_id, idempotency_key) where idempotency_key is not null
- 写事件必须在事务中分配下一个 seq
- 禁止删除事件；需要撤销时追加新事件
- 同一个 Hermes 输出重复解析，必须靠 idempotency_key 去重

workflow_lanes
- id 主键
- session_id
- node_id 唯一稳定
- semantic_key 可空
- lane_kind
- agent_kind
- title
- brief
- status
- phase
- archived
- created_at
- updated_at

lane_kind 至少包含：
- planner
- analysis
- planning
- coding
- review
- fix
- validation
- commit
- pull_request
- merge
- closeout

status 只能包含：
- pending
- blocked
- ready
- running
- waiting_input
- reviewing
- retrying
- completed
- failed
- archived

约束：
- unique(session_id, semantic_key) where semantic_key is not null
- planner lane 永远不能有父依赖
- lane.status 不允许任意工具直接写 completed
- completed 必须由证据事件驱动

workflow_edges
- id 主键
- session_id
- source_lane_id
- target_lane_id
- created_at

约束：
- unique(session_id, source_lane_id, target_lane_id)
- 禁止自环
- 写入前检查不能形成环
- 禁止任何 edge 指向 planner lane

workflow_segments
- id 主键
- session_id
- lane_id
- parent_segment_id 可空
- run_id 唯一
- agent_kind
- transport
- status
- worktree_path
- started_at
- ended_at 可空
- exit_code 可空
- evidence_json 可空
- error_reason 可空

约束：
- 同一 lane 可有多个 segment
- active segment 同一时间最多一个，除非明确是并行子执行线
- failed/retrying 必须保留旧 segment，不允许覆盖
- segment 结束后必须先写证据事件，再写状态事件

workflow_checkpoints
- id 主键
- session_id
- lane_id 可空
- through_seq
- summary
- facts_json
- created_at

约束：
- checkpoint 是压缩上下文，不是状态覆盖
- checkpoint 不能替代事件流事实
- checkpoint 必须记录 through_seq

状态稳定性要求：
1. lane.status 只能由事件投影器计算或由同事务中的受控状态机更新。
2. 禁止任意工具调用直接把节点改成 completed。
3. completed 必须有证据事件支持：
   - 退出码为 0
   - 或测试/构建/审查证据通过
   - 或人工确认事件
4. failed 和 retrying 必须保留历史 segment，不允许覆盖旧运行。
5. running 必须有 active segment。
6. segment 结束后必须写 segment_evidence，再写 segment_finished，再由投影器推导 lane_status_changed。
7. 同一个事件重复写入时必须靠 idempotency_key 去重。
8. 同一个 Hermes 输出被重复解析时，不能重复生成节点。
9. semantic_key 相同的节点必须更新已有 lane，而不是创建重复 lane。
10. 投影器必须确定性：同一组事件按 seq 重放，输出完全一致。
11. 状态变化必须合法，不允许 completed 回到 running，除非追加 continuation_requested 并生成新 segment。
12. archived 只能由归档事件产生，不允许物理删除 lane 历史。

事件类型至少包含：
- user_input
- hermes_session_started
- hermes_session_reused
- hermes_session_recovered
- hermes_session_failed
- hermes_output_delta
- node_declared
- node_patched
- edge_declared
- gate_opened
- gate_satisfied
- segment_started
- segment_output_delta
- segment_tool_call
- segment_evidence
- segment_finished
- handoff_created
- checkpoint_created
- review_completed
- continuation_requested
- lane_status_changed

事件稳定性要求：
- 每个事件必须有稳定 id
- 每个事件必须有 session_id 和 seq
- 每个由工具调用产生的事件必须有 idempotency_key
- 每个由 Hermes 输出解析产生的事件必须包含 causation_id 或 correlation_id
- 写事件和更新 lane/segment 投影缓存必须在同一事务中完成
- 如果事务失败，不允许只写入一半状态

门禁规则：
实现一个 workflow_gate 模块。所有新节点声明前必须检查门禁。

规则：
- analysis 节点可由 user_input 直接触发
- planning 节点必须依赖 analysis 完成，除非用户显式跳过分析
- coding 节点必须依赖 planning 完成
- review 节点必须依赖 coding 节点产生变更和局部验证
- fix 节点必须依赖 review 的阻断问题
- candidate_validation 节点必须依赖 review 无阻断问题
- commit 节点必须依赖 candidate_validation 或明确人工批准
- pull_request 节点必须依赖 commit
- merge 节点必须依赖 pull_request 当前状态可信且 review 完成
- closeout 节点必须依赖 merge 事实确认

如果 Hermes 尝试提前创建不满足门禁的节点：
- 不要创建 lane
- 写 gate_opened 或 gate_blocked 事件
- 在 planner lane 输出中记录原因
- 不要让 UI 出现未授权未来卡片

流式节点生成要求：
Hermes 不允许一次性生成完整未来卡片清单。
它每次只能生成当前门禁允许的下一批节点。

示例：
- 用户刚输入需求，只允许出现 Hermes 主节点和现场核查节点。
- 现场核查完成后，才允许出现需求规划节点。
- 需求规划完成后，才允许出现 Codex 编码节点。
- 编码节点有可信变更和局部验证后，才允许出现评审节点。
- 评审完成后，才允许出现提交或拉取请求节点。
- 拉取请求状态可信且评审完成后，才允许出现合并节点。

Hermes 工具兼容：
保留现有 createWorkflowCard / updateWorkflowCard / deleteWorkflowCard 的输入格式，但改变落点：
- createWorkflowCard 写 node_declared / edge_declared 事件
- updateWorkflowCard 写 node_patched 事件
- deleteWorkflowCard 写 node_patched archived=true

这些工具不得直接修改 CanvasSession.nodes。
工具调用必须有 toolCallId，并作为 idempotency_key 的一部分。
同一个 toolCallId 重放时必须返回已有结果，不得重复写 lane 或 edge。

画布投影：
新增 materializeCanvasSession(sessionId)。

它从 SQLite 读取事件和 lanes/edges/segments，生成现有 CanvasSession 结构。
CanvasSession.nodes 和 CanvasSession.edges 只是投影缓存，不是事实源。

投影必须处理：
- 同义节点合并
- planner root 无依赖
- review 节点依赖修复
- status 从 evidence 推导
- output 从 segment 输出聚合
- Changes tab 从最新 changeset/evidence 聚合
- Context tab 从 checkpoint、依赖交接、prior segments 聚合
- archived lane 默认不显示，但历史可查
- 同一事件流重放输出完全一致

Agent 运行：
把现有 startAgentRun 扩展为 startSegment。

输入必须包含：
- sessionId
- laneId
- segmentId
- runId
- agentKind
- transport
- worktreePath
- prompt
- contextCheckpointId 可空

Codex 执行线：
- 默认在 New Session 选定的当前分支/当前项目工作区运行
- 只有用户显式选择 New worktree 时，才从所选分支派生候选工作树
- 默认不允许 commit/push/merge，除非节点明确授权
- 默认 sandbox 仍保持安全
- Changes 来源优先使用结构化 patch/file-change/turn-diff 事件，最终用 git 对账
- 输出必须写 segment_output_delta
- 退出后写 segment_evidence 和 segment_finished
- Codex 自述完成不是完成证据
- Controller 必须检查 diff、测试、构建或审查证据

并行执行规则：
- 并行度由运行时能力和调度策略决定，不写死固定上限
- 热点文件重叠时禁止并行
- 每条执行线必须有允许范围、禁止范围、最快验证命令
- 多条候选实现并行时必须有独立 worktree 或等价隔离；当前分支模式不默认并行写同一个工作区
- 如果执行线产生超范围 diff，lane 必须进入 failed 或 waiting_input，不得自动推进

验证层级：
实现节点先跑快速局部验证。
评审早于重验证。
不要默认全量长验证。
候选验证只在评审阻断问题清零后出现。
完整验证可以作为后续或合并后节点，不要阻塞每个小改。

测试要求：
必须先写测试再实现。

覆盖：
1. 新 SQLite 数据库初始化和迁移幂等。
2. 事件 seq 单调递增。
3. idempotency_key 防止重复事件。
4. 重复 createWorkflowCard 不生成重复 lane。
5. planner lane 不能被 edge 指向。
6. 编码节点不能在规划完成前出现。
7. 评审节点不能在实现证据出现前出现。
8. 合并节点不能在评审完成前出现。
9. segment 成功但无证据时 lane 不得 completed。
10. 失败 segment 后 continuation 会生成新 segment，旧 segment 保留。
11. 同一事件流重放两次，CanvasSession 投影一致。
12. 应用重启后从 SQLite 恢复同一画布。
13. demo:mvp 验证节点是流式出现，而不是 Hermes 一次吐出所有卡片。
14. 创建 CanvasSession 时只创建一个 Hermes 主会话记录。
15. 第二次用户输入复用同一个 Hermes 主会话句柄。
16. Hermes 主会话启动路径不得调用 hermes -z。
17. 如果 transport 是 hermes_live_chat，必须证明同一进程或同一会话句柄被复用。
18. 如果无法复用，必须写 hermes_replay_recovery 事件，且 UI 不得显示原生长会话。
19. 任何使用 hermes -z 启动 planner 的代码路径都必须失败测试。
20. Hermes 尝试提前创建 commit/pull_request/merge 节点时，门禁必须拒绝。
21. toolCallId 重放不能产生重复事件。
22. 事务失败不能留下半写入 lane 或 edge。

验收命令：
pnpm typecheck
pnpm test
pnpm build
pnpm --filter @skyturn/desktop run demo:mvp

不要做：
- 不要引入看板列作为产品模型
- 不要让 renderer 直接访问 SQLite
- 不要让 agent 文本决定完成
- 不要一次性生成完整未来卡片
- 不要删除历史事件
- 不要用 JSON 文件临时代替 SQLite
- 不要把 workflow 内核塞进 agent-runtime
- 不要重构无关 UI
- 不要加入文件标签页、全局终端、代码编辑器
- 不要用 hermes -z 启动 Hermes 主会话
- 不要把恢复重放说成原生长会话

交付后报告：
列出修改文件和关键行号。
列出 SQLite schema。
列出状态机和门禁规则。
列出 Hermes transport 探测结果。
列出是否使用 hermes_live_chat、hermes_session_resume 或 hermes_replay_recovery。
如果使用 hermes_replay_recovery，必须明确说明这不是同一个 Hermes 原生会话。
列出验证命令结果。
不得假称原生长会话。
