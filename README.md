# DNF Patch Server

DNF Patch Studio 的本地后端由本 NestJS 服务、MySQL、私有对象存储和仓库外独立 Windows Worker 组成。本仓库提供业务编排、版本化 API、任务租约、固定角色模型、审计持久化与对象授权；`../dnf-patch` 只作为开发期职业规则、manifest、Prompt、工具和验证结果的事实源。

## 架构边界

- NestJS：Factory、Project、Run、Job、Worker、Artifact、NPK、Image、Guardrail、固定角色模型、对象授权与 outbox；不访问游戏目录，也不执行本机工具。
- Windows Worker：只读扫描 ImagePacks2，并在隔离工作区执行已登记的 ExtractorSharp、Aseprite、DirectXTex、封包器和验证器；不接收任意命令、用户模型密钥或部署指令。
- 私有对象存储：保存源帧、模型输出、中间工程、验证证据和新候选包；不保存官方 NPK 镜像，bucket 不公开。
- Electron 主进程：安全桌面容器、服务认证、REST/Socket.IO 连接与离线回退；不读取游戏资源、不执行补丁工具，也不监管 Worker 业务执行。
- Renderer：只调用受控 API，不持有数据库连接或服务令牌；用户模型密钥仅可在专用配置表单和 HTTPS 保存请求中短暂存在，不得持久化或回显。
- MySQL：只存元数据、对象引用、哈希和 provenance，不存官方 NPK、源帧或 runtime 图片 BLOB。
- 普通 API 和模型不能把部署、全技能覆盖或客户端兼容状态提升为 true。

## 目录

```text
├─ .codebuddy/rules/  服务端工程与信任边界规则
├─ plan/              版本化任务层级与受限模板，不是资源映射事实源
├─ mcp.json           默认拒绝网络和任意执行的适配器注册策略
├─ drizzle/           可审查的 MySQL migration 与 journal
├─ scripts/           结构、凭据、migration、构建与运行门禁
└─ src/
   ├─ common/       数据库、安全、HTTP、共享契约
   ├─ config/       环境变量与模型端点校验
   └─ modules/
      ├─ artifact/   产物引用与哈希
      ├─ auth/       浏览器账号、会话与稳定用户身份
      ├─ factory/    工厂配置
      ├─ guardrail/  追加式策略决策
      ├─ health/     服务与 MySQL 健康状态
      ├─ image/      参考图尝试和帧约束
      ├─ job/        任务、租约与 attempt
      ├─ model-configuration/ 用户固定角色模型与加密凭据元数据
      ├─ npk/        NPK/IMG inventory 元数据
      ├─ openai/     固定三模型调用记录
      ├─ profession/ 职业、技能、主题与生产状态
      ├─ project/    项目和仓库快照
      ├─ run/        Run、事件、outbox 与 WebSocket
      └─ worker/     数据库注册的 Worker 能力
```

## 环境配置

1. 从 `.env.example` 建立本机 `.env`，替换数据库密码、客户端令牌和 Worker 令牌。
2. `CLIENT_SHARED_TOKEN` 与 `WORKER_SHARED_TOKEN` 必须不同且至少 32 字符。
3. 首次启动前生成并稳定保管 32 字节 base64url `MODEL_CREDENTIAL_MASTER_KEY`；服务端缺少该主密钥时拒绝启动，不能等到用户保存模型配置时才失败。
4. 模型调用使用用户在前端专用设置页通过 HTTPS 提交的 BYOK Key；服务端使用 AES-256-GCM 按稳定用户身份与固定角色认证加密保存，并按 Run owner 解析，不能配置或回退到全局模型 Key。明文不得落库、回显或进入日志。
5. 服务默认只监听 `127.0.0.1:56789`，API 前缀为 `/v1`。

本地对象存储使用以下服务端参数：

| 变量                                    | 默认值                  | 用途                                                            |
| --------------------------------------- | ----------------------- | --------------------------------------------------------------- |
| `OBJECT_STORAGE_ENABLED`                | `false`                 | 显式启用私有对象存储；启用时应用凭据必填。                      |
| `OBJECT_STORAGE_ENDPOINT`               | `http://127.0.0.1:9000` | 仅接受不含凭据、路径或查询的本机回环 HTTP(S) URL。              |
| `OBJECT_STORAGE_REGION`                 | `us-east-1`             | S3 签名区域。                                                   |
| `OBJECT_STORAGE_BUCKET`                 | `dnf-patch-artifacts`   | 私有 Artifact bucket；浏览器和 Worker 不能自行选择。            |
| `OBJECT_STORAGE_ACCESS_KEY`             | 无                      | NestJS 使用的最小权限应用身份，不得与 MinIO Root 相同。         |
| `OBJECT_STORAGE_SECRET_KEY`             | 无                      | 应用 Secret，不得与客户端、Worker 或浏览器会话凭据复用。        |
| `OBJECT_STORAGE_FORCE_PATH_STYLE`       | `true`                  | 本机 MinIO 使用 path-style S3 地址。                            |
| `OBJECT_STORAGE_SIGNED_URL_TTL_SECONDS` | `300`                   | 后续短期上传/下载授权有效期，限制为 30 至 900 秒。              |
| `OBJECT_STORAGE_MAX_OBJECT_BYTES`       | `2147483648`            | 单对象最大字节数。                                              |
| `OBJECT_STORAGE_MAX_RUN_BYTES`          | `10737418240`           | 单 Run 对象总配额，不能小于单对象上限。                         |
| `ARTIFACT_ORPHAN_REAPER_INTERVAL_MS`    | `30000`                 | 单进程过期或拒绝上传会话对象的扫描周期，范围为 1000 至 300000。 |
| `ARTIFACT_ORPHAN_REAPER_BATCH_SIZE`     | `25`                    | 每次最多回收的对象数，范围为 1 至 100。                         |

Compose 还要求 `MINIO_ROOT_USER` 与 `MINIO_ROOT_PASSWORD`。它们只供一次性 bootstrap 管理 bucket、策略和应用用户，不进入 NestJS 环境契约；bootstrap 拒绝 Root 与应用凭据复用。MinIO API/Console 分别只绑定 `127.0.0.1:9000` 与 `127.0.0.1:9001`，bucket 明确保持私有。

当前 `JOB-006-LOCAL-OBJECT-STORAGE` 已建立严格配置、Compose、bootstrap、内部对象存储端口和 S3/MinIO 适配器单元语义，并实现 Artifact 上传会话、finalized 元数据、短期下载授权和 orphan 清理。仓库提供隔离的真实 MySQL 与官方 NPK Inventory 门禁；只有对应命令在当前环境实际通过时，才能报告该次真实 migration、MinIO 权限、Worker 或浏览器链路通过，不能因 SQL 已生成或 mock 单测通过而视为已经完成。

Worker 只能按当前精确 `workerId + leaseId + attempt` 使用以下三步协议，不能提交 bucket 或 object key：

1. `POST /v1/internal/jobs/:jobId/artifacts/uploads` 提交受限的名称、媒体类型、长度、SHA-256 和 provenance；服务端锁定 Job/Run、检查配额、生成 key，并签发短期 PUT URL。
2. Worker 使用返回的必需请求头上传；签名包含 `If-None-Match: *`，对象不能覆盖既有 key。
3. `POST /v1/internal/jobs/:jobId/artifacts/uploads/:uploadId/finalize` 重新校验同一租约，并由服务端流式重读对象复核媒体类型、长度和 SHA-256；只有证据匹配时才在事务内创建最终 Artifact。

最终 Artifact 和 `GET /v1/runs/:runId/artifacts` 只返回元数据，不返回内部对象 key。当前有效 Worker 如需读取同 Run Artifact，必须调用 `POST /v1/internal/jobs/:jobId/artifacts/:artifactId/download-authorizations` 取得短期 GET URL。失配会话会被拒绝；即时删除失败或签名窗口内可能重传的对象，会在会话到期后由有界 reaper 再次删除。

Worker 租约使用以下服务端参数：

| 变量                        | 默认值 | 用途                                        |
| --------------------------- | ------ | ------------------------------------------- |
| `WORKER_LEASE_SECONDS`      | `60`   | claim 或 heartbeat 后的租约有效期。         |
| `WORKER_REAPER_INTERVAL_MS` | `5000` | 单进程过期租约回收周期。                    |
| `WORKER_REAPER_BATCH_SIZE`  | `25`   | 每次事务最多回收的任务数，范围为 1 至 100。 |

Run outbox 使用以下服务端参数：

| 变量                          | 默认值 | 用途                                                  |
| ----------------------------- | ------ | ----------------------------------------------------- |
| `OUTBOX_DISPATCH_INTERVAL_MS` | `1000` | 无待发布事件时的单进程扫描周期，范围为 100 至 60000。 |
| `OUTBOX_DISPATCH_BATCH_SIZE`  | `25`   | 每批最多发布的 `run.event` 数，范围为 1 至 100。      |

浏览器资源导入入口使用以下服务端上下文：

| 变量                                    | 默认值  | 用途                                                         |
| --------------------------------------- | ------- | ------------------------------------------------------------ |
| `RESOURCE_IMPORT_SERVER_MIRROR_ENABLED` | `false` | 显式确认受控 Worker 已配置只读资源镜像；服务端不接收其路径。 |
| `RESOURCE_IMPORT_PROJECT_ID`            | 无      | 资源 Inventory 所属的已登记 Project UUID。                   |
| `RESOURCE_IMPORT_SNAPSHOT_ID`           | 无      | 本次导入绑定的已冻结 Snapshot UUID。                         |

启用资源导入时必须同时配置两个 UUID，对应 Factory 必须启用 `inventory` v1 契约，并至少注册一个未禁用且声明 `inventory` capability 的 Worker。资源根路径只存在于仓库外受控 Worker 的本地配置中，不进入环境契约、Job payload、数据库、API 或日志。

当前 reaper 和 outbox dispatcher 均按单机、单 Nest 进程部署设计。启用多进程或多副本前，必须增加数据库级 leader/dispatcher 协调，不能依赖各进程本地定时器互斥。

Electron 主进程使用以下变量接入：

| 变量                            | 默认值                      | 用途                                                              |
| ------------------------------- | --------------------------- | ----------------------------------------------------------------- |
| `DNF_PATCH_SERVER_URL`          | `http://127.0.0.1:56789/v1` | 版本化 API 地址；非回环地址必须 HTTPS。                           |
| `DNF_PATCH_SERVER_CLIENT_TOKEN` | 无                          | 与 `CLIENT_SHARED_TOKEN` 相同，只由主进程读取。                   |
| `DNF_PATCH_SERVER_AUTOSTART`    | `false`                     | 设为 `true` 时仅启动固定的 `dist/main.js`，不接受 renderer 命令。 |

## MySQL 与迁移

Compose 不提供固定密码。启动前在本机环境或未提交的 `.env` 中设置 `MYSQL_PASSWORD` 和 `MYSQL_ROOT_PASSWORD`，再启动 MySQL 服务。

迁移分为两个独立阶段：

1. `npm run db:generate`：根据 Drizzle schema 生成可审查 SQL，不连接数据库。
2. `npm run db:migrate`：使用 `DATABASE_URL` 在真实 MySQL 上执行 migration。

只有第二步成功并完成服务健康检查，才能报告数据库运行集成通过。生成 SQL 或 `npm run gate` 成功都不代表 migration 已执行。

审计字段 migration 使用 fail-closed preflight：旧 `npk_inventories` 已有记录但缺少 producing Run 时返回 `NPK_INVENTORY_RUN_OWNERSHIP_MIGRATION_BLOCKED`；旧 `model_calls` 已有记录但缺少实际 egress 事实时返回 `MODEL_CALL_EGRESS_MIGRATION_BLOCKED`。服务不会根据终态、授权或其他间接字段猜测回填历史证据。

## API 契约

所有非健康 REST 请求使用 `Authorization: Bearer <CLIENT_SHARED_TOKEN>`；`/v1/internal/*` 使用独立 `X-Worker-Token`。请求和响应均按模块 Zod 契约校验。

浏览器兼容入口保持前端 `{ data: ... }` 响应信封：`POST /v1/auth/login` 使用账号密码换取短期浏览器 access token，`POST /v1/auth/refresh` 只通过 HttpOnly refresh cookie 轮换 access token，`GET /v1/auth/me` 返回当前浏览器用户。模型配置端点 `GET|PUT /v1/users/me/model-configuration` 只返回固定角色、端点、模型、版本和 Key 配置状态；PUT 接收的 Key 仅在认证加密期间短暂存在。

职业、技能目录视图和风格属于浏览器用户的个人内容。所有 `/v1/professions` 浏览器操作都会从 access token 解析稳定用户 ID，并只读取或修改该用户拥有的职业聚合；共享客户端令牌不能代替浏览器用户归属。迁移前无法可靠确认 owner 的历史职业行保持未归属且对浏览器不可见，服务端不会按名称、账号数量或其他间接信息猜测回填。

模型推理仍只由后端业务工作流调用，不提供通用模型代理 API。缺少 Run owner、个人配置、配置版本或解密证据时调用会稳定阻断，不回退到其他用户或全局 Key。

主要端点：

- `GET /v1/health`：公开服务与数据库健康状态，不返回配置或凭据。
- `GET|POST /v1/factories`：工厂配置元数据。
- `GET|POST /v1/projects`：项目登记；`POST /v1/projects/:id/snapshots` 写入冻结哈希。
- `POST /v1/runs`、`GET /v1/runs/:id`、`GET /v1/runs/:id/events`：Run 和权威事件。
- `POST /v1/shared-fx/tasks`：浏览器使用稳定用户身份、合法 `Idempotency-Key` 和已有 Project Snapshot 创建冻结的 `shared-fx` v1 Run；调用方不能提交来源哈希、Worker payload 或安全状态。
- `POST /v1/internal/jobs/claim`、`POST /v1/internal/jobs/:id/heartbeat|complete`：受能力注册和租约约束的 Worker 协议。
- `POST /v1/internal/jobs/:id/shared-fx-stage-evidence`：Worker 按当前精确 lease/attempt 为固定六阶段提交已 finalize 的 Artifact ID；不接受阶段哈希、对象 key、路径或工具参数。
- `POST /v1/internal/jobs/:id/profession-production-progress`：Worker 按当前精确 lease/attempt 读取冻结技能顺序与 `pending|passed|failed|blocked` 有限状态；只有全部技能 passed 时返回 Server 从持久化证据复算的结果摘要。
- `POST /v1/internal/jobs/:id/profession-skill-executions|profession-skill-source-context`：Worker 为 payload 已冻结技能读取固定双模型聚合状态与官方源证据；响应不返回 Prompt、模型配置、对象 key、本机路径或正文。
- `POST /v1/internal/jobs/:jobId/artifacts/uploads|uploads/:uploadId/finalize|:artifactId/download-authorizations`：仅 Worker 可用的 Artifact 上传、服务端完整性 finalize 与短期下载授权；全部请求绑定当前精确 lease/attempt，不接受 bucket、对象 key、命令或路径。
- `POST /v1/internal/jobs/:jobId/npk-inventories`：Worker 仅提交当前 exact lease、已 finalize 的 Inventory Artifact ID 和规范化元数据；Project 与 Run 从 Job 派生，Worker 不能自报归属。租约、`inventory` Job kind、Run/Project 及同 attempt 上传会话在一个事务中验证。
- `GET|POST /v1/professions`、`GET /v1/professions/:id/skills|styles`、`POST|PUT /v1/professions/:id/styles`：前端职业、技能和主题元数据。
- `POST /v1/jobs`、`GET /v1/jobs`、`GET /v1/jobs/:id/artifact`：前端制作任务兼容入口，内部映射为受 Guardrail 保护的 Run 与 profession Worker Job。artifact 端点返回最终包 Artifact 的相对存储引用、媒体类型、长度和哈希元数据，不让 NestJS 读取本机文件或游戏目录。
- `GET /v1/resource-imports/overview`、`POST /v1/resource-imports/jobs`：前端资源导入状态与空请求体任务入口，保持 `{ data: ... }` 信封。POST 内部创建受 Factory v2、Guardrail、幂等和 Worker capability 约束的 `inventory` Run；只有同 Run 的 frozen Inventory 存在时才报告最近导入成功。
- `PUT /v1/internal/professions/:id/skill-catalog`、`POST /v1/internal/jobs/:id/skill-production|package`：仅 Worker 可用的职业技能目录导入、逐技能生产证据和主题包证据入口；仍需 Worker token、租约 owner 和 fencing token。当前 V2 Job 只冻结 `aseprite-cli`，没有封包器、独立验证器或 package provenance 契约，因此 package 入口固定返回 `STYLE_PACKAGE_CAPABILITY_NOT_FROZEN` 且零写入，不能用任意同 Run Artifact 冒充最终包。
- Artifact、NPK、Image、Guardrail 与 OpenAI 模块提供各自受限记录接口；不提供通用 Prompt 或任意命令 API。

### Factory、Run 与幂等

- Factory v1 记录仍可读取，但不能用于创建新 Run。
- 可执行的 Factory v2 必须冻结 `policyId`、`policySha256`、`profileId`、`allowedJobKinds`，并为每个允许的 kind 提供一一对应的 `jobContracts` 版本。
- 每个 Job 的 v1 载荷是严格声明式信封：`{ schemaVersion: 1, profileId, parameters }`。`profileId` 必须与 Factory 一致；`parameters` 仍会经过大小、深度、节点数和 Guardrail 任意执行字段检查。
- `POST /v1/runs` 必须携带合法的 `Idempotency-Key`。服务端对完整、已解析请求生成确定性 SHA-256 指纹；相同键和相同请求返回原 Run，相同键但请求发生任何语义变化返回 `409 IDEMPOTENCY_KEY_REUSED`。
- 迁移前创建且没有服务器指纹的历史 Run 不会被不安全重放，返回 `409 IDEMPOTENCY_RECORD_LEGACY`。不同幂等键重复使用同一 `clientRunId` 返回 `409 CLIENT_RUN_ID_CONFLICT`。

### Worker 租约 fencing

- claim 响应包含 UUID `leaseId`；Worker 应在 heartbeat 和 complete 请求中原样回传该值。
- 为 `/v1` 兼容式演进，首次 attempt 暂时允许旧 Worker 省略 `leaseId`。任务一旦发生重领，省略 token 返回 `409 WORKER_PROTOCOL_UPGRADE_REQUIRED`。
- 过期、错误 owner 或旧 attempt 的 token 返回租约冲突；旧 Worker 不能覆盖新 attempt。
- reaper 使用数据库时间回收过期租约：未耗尽任务重新排队，耗尽任务标为 `failed`，对应 attempt 标为 `timed_out`，并在同一事务中聚合 Run 终态、事件和 outbox。
- claim 前会重新校验持久化 Job 与冻结 Factory contract；哈希、profile、kind 或 payload contract 不一致时，Job 会在事务中进入 `blocked`、清空租约、关闭旧 attempt，并追加完整性与终态事件。后续 claim 不会再次选择该 Job。
- 数据库 CHECK 约束限制 Run/Job/Attempt 状态、最大 attempt 数、Job 租约字段一致性以及四个不可提升的 Run 安全字段。

### Artifact、NPK 与模型证据

- `POST /v1/projects/:projectId/npk-inventories` 请求体必须携带 producing `runId`。该 Run 必须属于目标 Project；可选 `inventoryArtifactId` 必须属于同一 Run。
- Artifact、ModelCall、Run Event、Image Attempt、Manual Review 与 NPK Inventory 使用同 Run 复合归属约束。Service 先返回稳定 404/409，MySQL 复合外键作为最终防线。
- Artifact 上传中状态保存在独立 `artifact_upload_sessions`，最终 `artifacts` 表不承载未复核对象。上传会话以 Job、Run、Worker、attempt 和 `leaseId` 复合外键绑定到实际 Job attempt；finalize 事务会再次检查 lease 和会话归属。
- Worker Inventory 回填强制携带 `workerId + leaseId + attempt`，并要求 `inventoryArtifactId` 来自当前 Job、当前 attempt 已 finalize 的上传会话。同一 Artifact 的网络重试幂等返回原 Inventory；过期租约、重领 attempt、错误 Job kind 或跨 Job Artifact 均 fail-closed。
- `shared-fx` 的 `inventory`、`material`、`aseprite`、`runtime`、`npk` 与 `independent-validation` 阶段各绑定一条当前租约的 finalized Artifact。Job 只有在六阶段齐全、upload/Artifact 绑定和服务端哈希一致，且完成哈希等于独立验证 Artifact 哈希时才能进入 `passed`。
- `profession` 的逐技能 projects/validation Artifact 可来自不同 attempt；进度和完成摘要始终按 Job payload 的冻结技能顺序解析。Job `complete(passed)` 会在同一事务中锁定 Job、production 与 Artifact，独立复算摘要并与 Worker 提交值精确比较，技能缺失、来源/Prompt 漂移、Artifact 复用或摘要不一致都会拒绝终态写入。
- 当前 Profession Worker 只形成逐技能 projects/validation 双 Artifact，尚未构造或回填最终主题 package。逐技能证据完整时 Job 与 Run 可以通过，但同一事务会把仍为 `queued|building` 且没有 package Artifact 的 package 收口为 `blocked`；因此浏览器不会把它报告为 100% 可下载，也不证明 NPK 回灌、客户端兼容、全技能覆盖或部署。
- 成功完成 `shared-fx` Worker 阶段会在同一事务中创建绑定独立验证 Artifact 的单一 `pending` Manual Review。此时 Run 的 `passed` 仅表示 Worker 证据完成，不表示人工审核通过、发布、部署、全技能覆盖或客户端兼容。
- Run 配额在锁定 Run 后累计 finalized Artifact 与未过期授权会话。对象读取发生在事务外，但最终写入前必须再次取得行锁、检查当前租约和复核证据；缺少任何一项证据时不创建 Artifact。
- 上传证据失配、会话过期或对象存储授权失败会进入 rejected 状态。对象删除是幂等的，reaper 仅在预签名 PUT 到期后标记 `objectDeletedAt`，以避免有效签名窗口内的延迟上传留下永久 orphan。
- NPK inventory 只保存来源标签、长度、SHA-256、规范化内部相对路径、IMG 版本、帧数和元数据哈希；不读取或保存官方 NPK/IMG 正文。
- ModelCall 状态为 `running|passed|failed|blocked|abandoned`，并分别记录 `modelEgressAuthorized` 与 `modelEgressPerformed`。授权不等于已外发，provider 调用开始后即持久化 performed 事实。
- 启动恢复器将超过最大请求窗口的 `running` 记录标为 `abandoned`，写入固定错误码 `MODEL_CALL_ABANDONED_AFTER_RESTART`。数据库暂不可用时服务保持 degraded 启动并受控重试，不猜测调用结果。

Socket.IO 使用 `/runs` 命名空间，通过握手 `auth.token` 鉴权：

- 客户端发送 `run:subscribe`，载荷为 `{ runId, afterSequence }`。
- 服务端先发送 `run:snapshot`，随后发送 `run:event`。
- WebSocket 只用于通知；数据库事件和 outbox 才是权威记录。
- Worker 首次领取任务时，服务端在同一事务中把 Run 推进为 `running`；全部任务进入终态后按 `failed > blocked > passed` 聚合 Run，并在同一事务追加权威事件与 outbox。
- 单进程 dispatcher 启动即按 `(createdAt,id)` 扫描已提交的 pending `run.event`，广播成功后才更新 `publishedAt`。发布与标记之间崩溃会在重启后重复投递，因此语义为 at-least-once；客户端必须按 `(runId,sequence)` 去重，并通过事件 REST 接口补拉历史。
- 无订阅者也视为 Socket.IO 广播成功；权威恢复始终依赖 `run_events` sequence，而不是内存通知或 `publishedAt`。

## 验证

- `npm run check:credentials`：扫描源码文本中的模型密钥、共享令牌和数据库密码形态，不回显匹配值。
- `npm run validate:project`：检查根编排服务、Nest 三层源码、14 个领域模块、迁移、实施任务和固定三模型入口，拒绝兼容双轨目录。
- `npm run typecheck`：严格 TypeScript。
- `npm run lint`：ESLint 与单文件职责门禁。
- `npm run test`：契约、安全和核心服务测试。
- `npm run check:migrations`：检查 SQL 与 journal 一致，并禁止破坏性级联删除。
- `npm run build`：NestJS 完整生产构建，验证所有相对 JS 导入均已生成，并扫描生产输出中的凭据形态。
- `npm run test:smoke`：以随机端口和不可达测试数据库启动生产输出，验证降级健康状态与 401 鉴权。
- `npm run test:mysql`：要求显式提供 `MYSQLD_PATH`，在随机端口和系统临时目录启动一次性 MySQL，执行真实 migration，并验证 REST、Socket.IO、Factory v2、Run 幂等冲突、租约 fencing/reaper、Job quarantine、NPK producing Run、跨 Run 复合外键、ModelCall 重启恢复、outbox pending 重放、CHECK、事务持久化和限制性删除；不读取现有数据库凭据，也不连接系统 3306。
- `npm run test:inventory-real`：要求显式提供 `MYSQLD_PATH`、`REAL_INVENTORY_MINIO_PATH`、`REAL_INVENTORY_MC_PATH`、`DNF_PATCH_OFFICIAL_GAME_ROOT`、`DNF_PATCH_INVENTORY_SOURCE_RELATIVE_PATH`、`DNF_PATCH_INVENTORY_SOURCE_SHA256`、`DNF_PATCH_INVENTORY_PROFILE_ID`、`DNF_PATCH_INVENTORY_TOOL_PATH`、`DNF_PATCH_INVENTORY_TOOL_SHA256`、`DNF_PATCH_INVENTORY_EXTRACTOR_DIRECTORY`、`DNF_PATCH_INVENTORY_EXTRACTOR_CORE_SHA256`、`DNF_PATCH_INVENTORY_EXTRACTOR_JSON_SHA256`、`DNF_PATCH_INVENTORY_EXTRACTOR_ZLIB_SHA256` 与 `DNF_PATCH_POWERSHELL_PATH`，在随机端口和临时目录启动 MySQL、MinIO、Server、真实 Inventory Worker 与 remote Chromium；通过正式 API 完成官方 NPK 扫描、Artifact 上传/finalize、私有对象核验、浏览器登录/refresh/logout，并复核源文件前后长度与 SHA-256 不变。该门禁不调用外部模型、不生成最终主题 package，也不证明部署或客户端兼容。
- `npm run gate`：依次执行以上全部门禁。

真实门禁必须在环境可用时另行执行并如实记录，不包含在 `npm run gate` 中。外部模型端点还必须具备用户自行通过安全 UI/终端配置的凭据；模型列表包含模型 ID 不代表对应 API 能力可用。
