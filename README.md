# DNF Patch Server

NestJS + Drizzle + MySQL 控制面，为 DNF Patch Studio 提供项目元数据、Run、任务租约、事件、Guardrail 与模型调用证据。现有 `../dnf-patch` 仓库仍是职业规则、manifest、Prompt、工具和验证结果的领域事实源。

## 架构边界

- 服务端：Factory、Project、Run、Job、Worker、Artifact、NPK、Image、Guardrail、OpenAI 调用记录与 outbox。
- Electron 主进程：本机文件、固定工具执行、服务认证、REST/Socket.IO 连接与离线回退。
- Renderer：只调用受控 preload API，不持有数据库连接、服务令牌或模型密钥。
- MySQL：只存元数据、相对引用、哈希和 provenance，不存官方 NPK、源帧或 runtime 图片 BLOB。
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
      ├─ factory/    工厂配置
      ├─ guardrail/  追加式策略决策
      ├─ health/     服务与 MySQL 健康状态
      ├─ image/      参考图尝试和帧约束
      ├─ job/        任务、租约与 attempt
      ├─ npk/        NPK/IMG inventory 元数据
      ├─ openai/     固定三模型调用记录
      ├─ project/    项目和仓库快照
      ├─ run/        Run、事件、outbox 与 WebSocket
      └─ worker/     数据库注册的 Worker 能力
```

## 环境配置

1. 从 `.env.example` 建立本机 `.env`，替换数据库密码、客户端令牌和 Worker 令牌。
2. `CLIENT_SHARED_TOKEN` 与 `WORKER_SHARED_TOKEN` 必须不同且至少 32 字符。
3. `OPENAI_API_KEY` 仅在需要模型调用时配置，不得写入数据库、源码、日志或 Run 证据。
4. 服务默认只监听 `127.0.0.1:56789`，API 前缀为 `/v1`。

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

浏览器兼容入口保持前端 `{ data: ... }` 响应信封：`POST /v1/auth/login` 使用客户端共享凭据换取短期浏览器 access token，`POST /v1/auth/refresh` 只通过 HttpOnly refresh cookie 轮换 access token，`GET /v1/auth/me` 返回当前浏览器用户。模型配置端点 `GET|PUT /v1/users/me/model-configuration` 只暴露服务端环境托管的三角色模型和 Key 配置状态；浏览器提交 API Key 会被拒绝。

主要端点：

- `GET /v1/health`：公开服务与数据库健康状态，不返回配置或凭据。
- `GET|POST /v1/factories`：工厂配置元数据。
- `GET|POST /v1/projects`：项目登记；`POST /v1/projects/:id/snapshots` 写入冻结哈希。
- `POST /v1/runs`、`GET /v1/runs/:id`、`GET /v1/runs/:id/events`：Run 和权威事件。
- `POST /v1/internal/jobs/claim`、`POST /v1/internal/jobs/:id/heartbeat|complete`：受能力注册和租约约束的 Worker 协议。
- `GET|POST /v1/professions`、`GET /v1/professions/:id/skills|styles`、`POST|PUT /v1/professions/:id/styles`：前端职业、技能和主题元数据。
- `POST /v1/jobs`、`GET /v1/jobs`、`GET /v1/jobs/:id/artifact`：前端制作任务兼容入口，内部映射为受 Guardrail 保护的 Run 与 profession Worker Job。artifact 端点返回最终包 Artifact 的相对存储引用、媒体类型、长度和哈希元数据，不让 NestJS 读取本机文件或游戏目录。
- `PUT /v1/internal/professions/:id/skill-catalog`、`POST /v1/internal/jobs/:id/skill-production|package`：仅 Worker 可用的职业技能目录导入、逐技能生产证据和主题包证据回填；仍需 Worker token、租约 owner 和 fencing token。
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
- `npm run validate:project`：检查根控制面、Nest 三层源码、11 个领域模块、迁移和固定三模型入口，拒绝兼容双轨目录。
- `npm run typecheck`：严格 TypeScript。
- `npm run lint`：ESLint 与单文件职责门禁。
- `npm run test`：契约、安全和核心服务测试。
- `npm run check:migrations`：检查 SQL 与 journal 一致，并禁止破坏性级联删除。
- `npm run build`：NestJS 完整生产构建，验证所有相对 JS 导入均已生成，并扫描生产输出中的凭据形态。
- `npm run test:smoke`：以随机端口和不可达测试数据库启动生产输出，验证降级健康状态与 401 鉴权。
- `npm run test:mysql`：要求显式提供 `MYSQLD_PATH`，在随机端口和系统临时目录启动一次性 MySQL，执行真实 migration，并验证 REST、Socket.IO、Factory v2、Run 幂等冲突、租约 fencing/reaper、Job quarantine、NPK producing Run、跨 Run 复合外键、ModelCall 重启恢复、outbox pending 重放、CHECK、事务持久化和限制性删除；不读取现有数据库凭据，也不连接系统 3306。
- `npm run gate`：依次执行以上全部门禁。

真实 MySQL、迁移执行、HTTP/Socket.IO 运行集成和外部模型端点必须在环境可用时另行验证并如实记录。模型列表包含模型 ID 不代表对应 API 能力可用。
