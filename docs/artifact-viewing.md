# 查看已登记的运行产物

此切片提供 Electron 后端与 preload API，尚未接入 UI。后续 UI 在现有节点弹窗的 `Output` 中使用此接口；不新增标签页、编辑器或通用文件预览入口。

## 调用接口

类型定义位于 `@skyturn/persistence`：`ArtifactViewRequest`、`ArtifactViewResult`、`ArtifactViewApi`。IPC 通道为 `artifact:read`，preload 入口为：

```ts
const result = await window.devflow.artifacts.read({
  projectRoot, // An already-open project identity.
  sessionId,
  nodeId,
  runId,
  artifactPath: ".devflow/acceptance/report.md",
});
```

请求必须且只能包含这五个字符串字段。`artifactPath` 是终态 `RunEvidence.artifacts` 中的精确条目，大小写也须一致；不接受绝对文件路径、worktree 路径或 renderer 提供的 evidence。沿用 project-core 的严格产物解析器，只允许 `.devflow/acceptance/` 下的安全相对路径，并拒绝遍历、敏感文件名及重复声明。普通文件存在、Agent 输出或项目内事件镜像均不构成登记。

session/node/run ID 上限各为 256 个 UTF-16 code units，项目根路径和产物路径各为 4,096；产物路径还受 reader 的 4,096 UTF-8 bytes 上限约束。字段必须非空、无首尾空白、无 ASCII 控制字符。

成功返回：

```ts
{
  protocolVersion: 1,
  ok: true,
  artifact: {
    artifactPath: string,
    name: string,
    type: "png" | "jpeg" | "txt" | "md" | "json",
    runId: string,
    status: "succeeded" | "failed" | "cancelled" | "timed-out",
    byteLength: number
  },
  contentIdentity: "current-file-unhashed",
  content:
    | { encoding: "utf8", mimeType: "text/plain", text: string }
    | {
        encoding: "base64",
        mimeType: "image/png" | "image/jpeg",
        base64: string,
        width: number,
        height: number
      }
}
```

`.jpg` 和 `.jpeg` 均返回 `type: "jpeg"`。文字保持原始换行与空白，不截断、不自动脱敏后冒充原文；检测到不安全内容时整项拒绝。JSON 额外检查语法，并对解码后的字段应用相同敏感文本规则。

UI 将文字作为纯文本渲染，包括 Markdown 中的 HTML；不得使用 `innerHTML`、HTML 文档、iframe 或 Markdown 的原始 HTML 执行功能。图片只通过返回的固定 MIME 和 base64 创建图片数据源，处理图片解码失败；不得将产物路径变成 `file:` URL 或交给外部应用。后端检查图片签名、结构与尺寸，不执行图片完整解码，也不对图片内容做保密信息识别。

## 授权与时效

每次读取都验证已打开项目的 canonical identity，从已完成初始化的 workflow store 获取会话投影，确认最新且未回滚的 node/run segment。私有 start claim 的 session、node、run、agent 必须一致；从 app-private RunEvents 严格解析得到的终态 RunEvidence 必须与 SQLite 的 evidence 完全一致。项目 `.devflow/runs/**/events.ndjson` 不参与授权或恢复。

该 run 必须有唯一且精确匹配的 before/after checkpoint。复用 checkpoint 配对、Git ancestry proof 和 managed worktree reconciliation；当前分支只能绑定项目根目录，新 worktree 必须匹配已记录的 managed identity。分支或 HEAD 改变、旧 run 被新尝试取代、worktree 被清理、绑定缺失，均拒绝读取。没有完整 checkpoint 的历史运行及 planner 产物不可查看。

主进程打开已授权的目录描述符并检查设备/inode，helper 从这个描述符使用逐级 `openat`、`O_DIRECTORY`、`O_NOFOLLOW` 读取。最终文件须为单链接的普通文件；拒绝 symlink、hardlink、FIFO、目录及其他特殊文件。读取前后检查文件 identity、size、mtime、ctime；任何失败都不返回内容。读取完成后再次验证项目、私有证据、checkpoint、Git 与目录 identity。查看动作不会初始化 workflow store、推进调度或启动 Agent。

**内容并非完成时快照。** 现有 evidence 只记录路径，没有产物内容哈希。成功表示读取时的文件通过授权与边界检查，不能证明这些字节与 run 完成时相同。文件在两次查看之间被改写或替换，若绑定仍有效，可能返回新内容；因此固定返回 `contentIdentity: "current-file-unhashed"`，不伪造 immutable hash。此边界不防御拥有同一宿主用户权限的攻击者篡改 app-private 状态。

## 限制与错误

| 内容 | 上限或行为 |
| --- | --- |
| UTF-8 `.txt`、`.md`、`.json` | 262,144 bytes，严格 UTF-8，禁止二进制控制字符；复用 public payload sanitizer 检测敏感文本，拒绝其需要改写的内容，也拒绝私钥块 |
| PNG、baseline/progressive JPEG | 8,388,608 bytes；单边不超过 8,192 pixels，总像素不超过 16,000,000；PNG 不支持 APNG |
| HTML、SVG、其他格式 | 不支持；不执行活动文档 |
| Windows | 此查看切片返回 `UNAVAILABLE`，不降级为路径读取；现有 Windows verification helper 保持不变 |
| 单次 helper | 10 秒后请求终止，始终等待实际 `close`；不把 kill 返回值、`exit` 或额外清理超时当作回收完成 |

上限包含边界值，超过一字节也失败。敏感文本检测沿用已有规则，可能拒绝包含绝对路径或敏感术语的报告；不宣称能识别任意未标记的秘密或截图中的秘密。

失败返回 `{ protocolVersion: 1, ok: false, code, message }`，没有 `content` 或原始异常。UI 必须显示失败信息：

| `code` | 含义 |
| --- | --- |
| `INVALID_INPUT` | 请求字段或产物路径不合法，包括敏感文件名 |
| `UNKNOWN_PROJECT` | 项目未打开或身份改变 |
| `SCOPE_MISMATCH` | project/session/node/run/agent 绑定不匹配 |
| `EVIDENCE_UNAVAILABLE` | 持久化终态证据、私有 claim 或 workflow authority 不可用/冲突 |
| `UNREGISTERED_ARTIFACT` | 文件未登记在该 run 的终态 evidence 中 |
| `BINDING_UNAVAILABLE` | 缺少精确 checkpoint 或 managed worktree 绑定 |
| `STALE_ARTIFACT` | run、checkpoint proof 或 Git identity 已过期/回滚 |
| `OUTSIDE_ROOT` | worktree 不属于授权项目范围 |
| `UNAVAILABLE` | 平台不支持或 helper 失败/终止/协议不完整 |
| `MISSING` | 已登记文件不存在 |
| `UNSAFE_FILE` | symlink、hardlink、特殊文件或不安全目录 |
| `OVERSIZE` | 字节数或图片尺寸超过上限 |
| `CHANGED` | 读取期间文件变化 |
| `UNSUPPORTED_CONTENT` | 格式、图片结构、UTF-8 或 JSON 不合法 |
| `UNSAFE_CONTENT` | 文本被敏感内容规则拒绝 |

## 复用读取原语

`@skyturn/agent-bridge/bounded-file-reader` 导出 `readBoundedFile({ rootFd, relativePath, maxBytes, signal? })`，返回 `{ ok: true, bytes: Buffer }` 或 `{ ok: false, code }`。调用方持有并授权目录 fd，在 promise 结束前保持打开，同时负责自己的路径登记和敏感文件策略。原语不绑定 artifacts 前缀，可供后续项目文件引用功能复用，但不能直接暴露给 renderer。

`maxBytes` 必须是 1 至 33,554,432 的整数，路径的 UTF-8 编码不超过 4,096 bytes；只接受安全相对组件。沿用已有 `artifact-gate` 二进制，新增 `read <relativePath> <maxBytes>`，通过继承的 fd 3 接收目录。`READY`、`OPENED` 阶段后，各接收一个换行；仅完整检查通过后输出 `RESULT ok <byteLength>\n` 和精确字节。错误只输出固定状态。原有 verify 与 `write` 协议保持兼容。stdout 接收缓冲区有固定上限；部分、额外或异常输出不会变成成功结果。

## 聚焦验证

在当前 worktree 确认 package、`src/native`、脚本及 node_modules 的 realpath 均位于当前根目录后，使用 `pnpm@10.28.2`：

```sh
pnpm --filter @skyturn/agent-bridge run native:build
pnpm --filter @skyturn/agent-bridge exec node --test scripts/boundedFileReader.test.mjs
pnpm --filter @skyturn/desktop exec node --test scripts/artifactViewRuntime.test.mjs
pnpm --filter @skyturn/desktop exec tsc --noEmit -p tsconfig.electron.json --incremental false --composite false
pnpm --filter @skyturn/agent-bridge exec tsc --ignoreConfig --noEmit --module Node16 --moduleResolution Node16 --target ES2022 --strict --esModuleInterop --skipLibCheck --types node src/boundedFileReader.ts
```

现有 native build 脚本会在本 worktree 的 `packages/agent-bridge/src/native/` 生成 `artifact-gate`、`fd-launch`、`posix-process-owner`。测试直接加载 TypeScript 源码；真实文件系统、Git worktree、现有 SQLite 二进制及私有事件存储参与测试，不需要 root build、Electron native rebuild 或 GUI。IPC 测试执行 main/preload 中的真实注册代码，不代表桌面 UI 验收。发布时 `dist/native/artifact-gate` 仍由已有 package build/copy 流程负责。
