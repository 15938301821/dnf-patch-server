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

## API 契约

所有非健康 REST 请求使用 `Authorization: Bearer <CLIENT_SHARED_TOKEN>`；`/v1/internal/*` 使用独立 `X-Worker-Token`。请求和响应均按模块 Zod 契约校验。

主要端点：

- `GET /v1/health`：公开服务与数据库健康状态，不返回配置或凭据。
- `GET|POST /v1/factories`：工厂配置元数据。
- `GET|POST /v1/projects`：项目登记；`POST /v1/projects/:id/snapshots` 写入冻结哈希。
- `POST /v1/runs`、`GET /v1/runs/:id`、`GET /v1/runs/:id/events`：Run 和权威事件。
- `POST /v1/internal/jobs/claim`、`POST /v1/internal/jobs/:id/heartbeat|complete`：受能力注册和租约约束的 Worker 协议。
- Artifact、NPK、Image、Guardrail 与 OpenAI 模块提供各自受限记录接口；不提供通用 Prompt 或任意命令 API。

Socket.IO 使用 `/runs` 命名空间，通过握手 `auth.token` 鉴权：

- 客户端发送 `run:subscribe`，载荷为 `{ runId, afterSequence }`。
- 服务端先发送 `run:snapshot`，随后发送 `run:event`。
- WebSocket 只用于通知；数据库事件和 outbox 才是权威记录。
- Worker 首次领取任务时，服务端在同一事务中把 Run 推进为 `running`；全部任务进入终态后按 `failed > blocked > passed` 聚合 Run，并在同一事务追加权威事件与 outbox，事务提交后才发送 Socket.IO 通知。

## 验证

- `npm run check:credentials`：扫描源码文本中的模型密钥、共享令牌和数据库密码形态，不回显匹配值。
- `npm run validate:project`：检查根控制面、Nest 三层源码、11 个领域模块、迁移和固定三模型入口，拒绝兼容双轨目录。
- `npm run typecheck`：严格 TypeScript。
- `npm run lint`：ESLint 与单文件职责门禁。
- `npm run test`：契约、安全和核心服务测试。
- `npm run check:migrations`：检查 SQL 与 journal 一致，并禁止破坏性级联删除。
- `npm run build`：NestJS 完整生产构建，验证所有相对 JS 导入均已生成，并扫描生产输出中的凭据形态。
- `npm run test:smoke`：以随机端口和不可达测试数据库启动生产输出，验证降级健康状态与 401 鉴权。
- `npm run test:mysql`：要求显式提供 `MYSQLD_PATH`，在随机端口和系统临时目录启动一次性 MySQL，执行真实 migration，并验证 REST、Socket.IO、Worker 租约、事务持久化和限制性外键；不读取现有数据库凭据，也不连接系统 3306。
- `npm run gate`：依次执行以上全部门禁。

真实 MySQL、迁移执行、HTTP/Socket.IO 运行集成和外部模型端点必须在环境可用时另行验证并如实记录。模型列表包含模型 ID 不代表对应 API 能力可用。
