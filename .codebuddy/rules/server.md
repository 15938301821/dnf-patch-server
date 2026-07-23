# Server 端代码规范

## 1. 服务定位与信任边界

- DNF Patch Studio 的完整本地后端由本 NestJS 服务、MySQL、私有对象存储和仓库外独立 Windows Worker 组成。本服务负责 Factory、Project、Snapshot、Run、Job、Worker 注册、租约、事件、对象授权、Artifact 元数据、NPK inventory、Image attempt、职业生产状态、Guardrail、固定角色模型调用和 outbox。
- NestJS 进程不是本机工具执行器：不得读取、写入、部署或修改游戏目录，不得检查或控制游戏进程，不得执行二进制、shell、命令或脚本。
- Worker API 只传输版本化声明式 Job payload、能力、租约 token、状态和证据哈希；不得下发 executable、shell、脚本路径、绝对路径或未验证参数。
- 仓库外独立 Worker 是本地后端的受控执行面，承担只读资源扫描以及固定 ExtractorSharp、Aseprite、DirectXTex、封包器和验证器的执行；它不得接收任意命令、用户模型密钥、部署指令或未经注册的工具路径。
- Renderer 与 Electron 只负责受认证交互和安全桌面容器，不读取游戏资源、不执行补丁工具，也不监管 Worker 业务执行。
- `../dnf-patch` 中的根/职业/主题规则、manifest、Prompt、工具目录和验证报告是开发期 DNF 领域事实源；运行时只能使用经导入、审核、冻结并带来源哈希的模板和证据，NestJS 不得补猜缺失映射。

## 2. 稳定目录与领域职责

目录说明以职责为准，不维护易过期的逐文件或 migration 名称快照：

```text
dnf-patch-server/
├─ .codebuddy/rules/        # 全局与 Server 端工程规则
├─ drizzle/                 # drizzle-kit 生成的 MySQL migration、journal 与 snapshot
├─ plan/                    # 版本化任务需求、步骤和层级；不是资源映射事实源
├─ scripts/                 # 结构、凭据、migration、构建、冒烟和 MySQL 运行门禁
├─ src/
│  ├─ common/
│  │  ├─ contracts/         # 跨模块基础 Zod schema 与安全状态契约
│  │  ├─ db/                # Drizzle schema、连接、migration 和数据库错误识别
│  │  ├─ http/              # 统一校验与脱敏异常响应
│  │  ├─ security/          # 客户端、Worker 与统一 API 鉴权
│  │  └─ utils/             # 无领域状态的通用纯工具
│  ├─ config/               # 环境变量与模型端点运行时校验
│  ├─ modules/              # 纵向领域模块
│  │  ├─ artifact/          # 相对存储引用、长度、SHA-256 与 provenance
│  │  ├─ factory/           # 工厂版本、冻结策略和允许的 Job contract
│  │  ├─ guardrail/         # 声明式任务与帧不变量的追加式决策
│  │  ├─ health/            # 服务和 MySQL 健康状态
│  │  ├─ image/             # 图片生成/适配尝试元数据
│  │  ├─ job/               # Job、attempt、租约 fencing、reaper 与终态聚合
│  │  ├─ npk/               # 只读 NPK/IMG inventory 元数据
│  │  ├─ openai/            # 固定角色模型调用与脱敏证据
│  │  ├─ project/           # 项目登记与事实源快照哈希
│  │  ├─ run/               # Run、幂等、权威事件、outbox 与 WebSocket 通知
│  │  └─ worker/            # Worker 注册、能力、禁用状态和心跳
│  ├─ app.module.ts         # 根依赖装配
│  └─ main.ts               # 全局前缀、过滤器、CORS、监听与关闭钩子
└─ package.json             # 依赖和门禁入口
```

- `dist/`、`node_modules/`、`.git/`、本机 `.env` 和临时数据库目录不属于源码结构。
- 新增领域能力优先扩展现有模块；创建新模块时必须同步更新根模块、结构验证脚本、README 和相关测试。
- 不得新增 `src/controllers`、`src/services`、`src/repositories`、`src/shared` 或 `src/server` 等兼容双轨目录。

## 3. NestJS 分层与依赖注入

- `*.module.ts`：只负责 provider、controller、import 和 export 装配，不承载业务逻辑。
- `*.controller.ts`：只负责路由声明、参数提取、Zod DTO 校验和响应映射；不得访问 Drizzle、拼装事务或实现状态机。
- `*.gateway.ts`：只负责 WebSocket 握手鉴权、载荷校验、房间订阅和广播；不得把内存消息当作权威状态。
- `*.service.ts`：负责业务规则、跨 repository 编排、授权判断和稳定业务异常映射。
- `*.repository.ts`：负责 Drizzle 查询、行锁、事务内持久化和数据库行到 ViewModel 的映射；不得包含 HTTP 或 WebSocket 逻辑。
- `*.contracts.ts`：定义请求 Zod schema、输入类型和 API ViewModel；不得导出凭据或直接复用数据库行作为响应。
- 所有 Nest provider 使用构造函数注入。禁止在业务代码中手动 `new` service、repository、gateway 或 guard。
- 跨模块调用只依赖对方公开 service 或契约，禁止导入其他领域模块的 repository 和内部辅助函数。
- 当前简单的 `health`、`image`、`openai`、`worker` 及帧 Guardrail service 可直接使用 `DatabaseService`；一旦出现复用查询、事务编排、多表更新或复杂映射，必须拆出本模块 repository。

### 3.1 各分层的中文备注要求

- `*.module.ts` 文件头说明装配哪些 Controller/Provider、导入哪些模块、向外导出哪个公开 Service，
  以及为什么不在 Module 中实现业务逻辑。简单装饰器数组无需逐项翻译。
- `*.controller.ts` 文件头说明路由前缀、认证方式和调用的 Service。每个公开端点备注 HTTP 方法、
  path/body/query/header 来源、Zod 校验位置、用户身份来源、返回 ViewModel 和稳定错误映射。
  Controller 备注不得暗示它直接保证数据库事务或领域所有权。
- `*.gateway.ts` 文件头说明 namespace、握手鉴权、房间/订阅语义和数据库事件恢复方式。广播方法
  必须说明只能在事务提交后调用，以及 Socket.IO 通知不是权威状态源。
- `*.service.ts` 文件头说明业务用例、上游 Controller/后台调用者、下游 Repository/Service，
  以及它负责的授权、状态机和错误码。多阶段方法必须按“校验 -> 决策 -> 持久化 -> 提交后动作”
  添加中文步骤备注。
- `*.repository.ts` 文件头说明拥有的数据表和查询职责。每个复杂方法备注事务是否由调用方传入、
  锁定哪些行、预期读写集合、零行结果语义、唯一键/外键冲突映射和返回对象类型。
- `*.contracts.ts` 说明每个 DTO/ViewModel 的生产方、消费方和协议版本；写入 DTO、数据库结构、
  加密行与读取 ViewModel 不得共用一条模糊备注。
- Guard、Interceptor、Filter 和中间件说明它们处于请求生命周期哪一步、能保证什么、不能替代
  哪些领域所有权或事务检查。

### 3.2 事务、状态机与并发备注要求

- 每个事务入口必须在事务开始前用中文列出需要原子完成的写入集合，以及任一失败时必须回滚
  的对外状态。事务内按关键阶段备注锁、校验、写入、事件/outbox 和聚合顺序。
- 行锁旁说明锁定的权威记录、要防止的竞态和固定锁顺序；不得只写“加锁”。多表锁顺序必须
  保持稳定并在相关方法 JSDoc 中说明，避免后期维护引入死锁。
- Run、Job、Attempt、Guardrail、Artifact 和模型调用状态转换必须说明允许前态、目标态、重复
  请求语义和拒绝非法转换的稳定错误码。
- 幂等逻辑备注完整请求指纹包含哪些经解析字段、同键同请求如何返回、同键异请求为何冲突，
  以及历史缺失指纹为何不能重放。
- 租约逻辑首次出现时用前端工程师可理解的语言解释“带过期时间和唯一编号的任务编辑锁”，
  再准确说明 owner、leaseId、数据库时间、attempt 和 fencing 校验。
- reaper 或定时任务备注当前单实例限制、重复执行的幂等前提、失败后的恢复方式和关闭清理；
  不能让维护者误以为本地定时器天然支持多副本。
- 事务提交后的广播、对象删除或外部调用必须单独备注为什么不能放进事务，失败后由何种
  outbox、重试或补偿机制恢复；没有恢复机制时必须明确写出限制。

### 3.3 鉴权、凭据、Artifact 与模型备注要求

- 每个受保护入口说明使用浏览器 Access Token、共享 Client token 还是 `X-Worker-Token`，并
  区分认证成功与资源所有权检查成功。
- 用户模型配置写入、读取、轮换、删除和调用链必须说明稳定用户身份来源，禁止把 displayName、
  请求用户名或共享 token 描述为租户边界。
- 加密/解密方法 JSDoc 说明密钥来源、AES-256-GCM 的 nonce/tag/AAD 语义、密文持久化结构和
  解密失败行为，但不得在备注或示例中出现秘密材料。
- Artifact 授权、finalize 和下载说明对象引用、媒体类型、长度、SHA-256、Run/Project、Worker
  lease/attempt 归属如何校验，以及短期 URL 不等于公开对象权限。
- 模型调用说明固定角色配置、出站授权、用户配置版本、超时、重试、禁用工具/存储、响应校验、
  审计哈希和脱敏要求；不得把 Provider 原始错误或响应写进注释示例。

### 3.4 Server 测试备注要求

- Controller 测试说明它验证的是路由、鉴权、DTO 和响应映射，不能代替 Service 事务测试。
- Service/Repository 测试说明 Mock 的数据库或外部依赖边界；涉及事务、CHECK、外键、行锁和
  数据库时间的结论必须标明是否需要 `npm run test:mysql` 才能证明。
- 跨用户隔离、租约冲突、幂等冲突、Guardrail 拒绝、凭据不回显和日志脱敏测试必须写清
  失败时禁止发生的数据库写入、广播、模型调用或 Worker Job 创建。
- migration 测试说明检查的是 SQL/journal 一致性还是真实 MySQL 执行，二者不得混写为同一证明。

## 4. 契约与运行时校验

- 所有 HTTP body、query、path 参数和 WebSocket payload 必须在进入业务逻辑前通过 Zod 校验；不得依赖 TypeScript 类型代替运行时校验。
- 环境变量只通过 `validateEnvironment()` 解析；新增变量必须具有格式、范围、安全默认值和对应测试，并同步 `.env.example` 与 README。
- 数据库 JSON 写入前和读取后都必须通过对应 schema；禁止未经解析直接信任 JSON 列。
- 有界 JSON 必须继续限制编码大小、嵌套深度和节点数；新增递归结构不得绕过预算。
- 路径只接受经 schema 验证的仓库相对引用，拒绝盘符、根路径和父目录段。
- 所有请求 schema 默认使用严格对象，未知字段应拒绝；兼容演进必须显式版本化，不能静默吞掉字段。
- DTO、Drizzle schema 和 API ViewModel 分离；响应只暴露调用方需要的字段。

## 5. Factory、Run 与 Guardrail

- 新 Run 只能使用绑定 `policyId`、`policySha256`、`profileId`、`allowedJobKinds` 和逐 kind `jobContracts` 的 Factory v2；Factory v1 只能读取，不能创建新 Run。
- Job payload 必须是已注册、版本化、严格声明式契约。`profileId` 必须与 Factory 一致，parameters 仍需经过 JSON 预算和任意执行字段检查。
- Guardrail 只允许注册的 Job kind，并递归拒绝 command、executable、shell、script path、游戏路径或进程控制字段。
- Frame Guardrail 只能基于来源哈希、几何尺寸、画布、锚点和 alpha 等可验证证据判定；不得按名称推断帧映射。
- `POST /runs` 必须使用合法 `Idempotency-Key`。服务端对完整解析后的请求计算确定性 SHA-256 指纹：同键同请求返回原 Run，同键异请求返回冲突。
- 缺少服务器请求指纹的历史 Run 不得被不安全重放；同项目重复 `clientRunId` 必须返回稳定冲突码。
- Guardrail 决策、Run、Jobs、初始权威事件与 outbox 必须在同一事务中创建；任一决策拒绝时不得创建 Worker Job。

## 6. Worker、租约与状态机

- Worker 只能领取其数据库注册 capabilities 包含的 Job kind；禁用 Worker 不得领取新任务或通过 Worker 心跳恢复可用。已发出租约的禁用语义若要收紧，必须显式版本化并补充租约冲突测试，不能依赖推断。
- 每次 claim 生成不可预测的 UUID `leaseId`，并增加 attempt。heartbeat 与 complete 必须验证 owner、租约期限、attempt 和 fencing token。
- 为当前 `/v1` 的兼容演进，仅首次 attempt 可暂时省略 `leaseId`；发生重领后必须拒绝无 token 的旧协议请求。
- 租约期限和过期判断使用数据库时间，避免服务进程时钟差异破坏 fencing。
- reaper 对过期 attempt 标记 `timed_out`：未耗尽重试次数的 Job 重新排队，耗尽的 Job 进入 `failed`。
- Run 终态按 `failed > blocked > passed` 确定性聚合。Job/Attempt 更新、Run 聚合、权威事件和 outbox 必须在同一事务中完成，事务提交后才允许广播。
- 当前 reaper 仅支持单 Nest 进程。启用多进程或多副本前，必须增加数据库级 leader/dispatcher 协调，不能依赖各进程本地定时器互斥。
- 本服务当前不定义可执行 Worker 基类或 Scheduler；不得在服务端新增本机任务执行实现来绕过仓库外 Worker 边界。

## 7. 数据库、事务与 migration

- 当前 Drizzle schema 的稳定入口是 `src/common/db/schema.ts`。若表数量或职责需要拆分，可迁移到 `src/common/db/schema/`，但必须保留统一导出入口并同步 Drizzle 配置、结构门禁和导入方。
- 普通持久化查询集中在本模块 repository；只有第 3 节列出的简单模块可以暂时由 service 直接访问 `DatabaseService`。
- 除 Drizzle 表达式、数据库时间、检查约束等 ORM 必要片段外，业务代码禁止拼接手写 SQL 字符串；任何 `sql` 模板都不得包含外部插值。
- 多表一致性、状态转换、幂等创建、租约变更和事件/outbox 写入必须使用数据库事务及必要行锁。
- 外键默认使用 `ON DELETE RESTRICT`；禁止新增 `CASCADE` 或 `SET NULL` 来掩盖生命周期问题。
- 四个安全字段必须由 DTO literal、服务端赋值和数据库 CHECK 三层固定为 `false`：`deploymentAuthorized`、`deploymentPerformed`、`fullSkillCoverageProven`、`clientCompatibilityProven`。
- schema 变更流程固定为：修改 Drizzle schema → `npm run db:generate` → 审查 SQL 与 snapshot → `npm run check:migrations` → 在隔离真实 MySQL 上执行验证。
- 禁止手工修改生产数据库结构、改写已应用 migration，或把生成 SQL 描述为 migration 已执行。

## 8. REST、WebSocket 与鉴权

- `GET /v1/health` 可公开，但只能返回服务和数据库健康状态，不得返回配置、连接串或凭据状态细节。
- 普通业务 REST 使用浏览器 access token 或 `Authorization: Bearer <CLIENT_SHARED_TOKEN>`；用户模型配置写入、轮换和删除只接受绑定稳定持久化用户的浏览器 access token，不接受共享客户端 token 作为用户归属。`/v1/internal/*` 使用独立 `X-Worker-Token`。各类 token 必须在部署配置中使用不同值，并通过已有守卫进行恒定时间比较；若新增跨字段环境校验，必须同步测试与配置说明。
- Socket.IO `/runs` 命名空间使用握手 `auth.token` 校验客户端 token；订阅 payload 必须通过 Zod。
- WebSocket 只用于提交后通知。数据库中的 `run_events` 与 `outbox_events` 是权威记录，客户端必须能通过 sequence 断点恢复。
- 不得通过 REST 或 WebSocket 返回数据库驱动错误、堆栈、凭据、绝对游戏路径或模型原始响应。
- CORS 只允许环境配置中经校验的来源；不得为排障临时开放通配来源或 credentials。

## 9. Artifact、NPK、Image 与模型边界

- MySQL 只保存元数据、对象引用、长度、SHA-256 和 provenance；不得保存官方 NPK、源帧、runtime 图片或其他大文件 BLOB。源帧、模型输出、中间工程、验证证据和候选包只能进入私有对象存储，并通过服务端受控上传、哈希复核和短期授权访问。
- 官方 NPK 与 ImagePacks2 保持只读。inventory 记录来源标签、长度、哈希、内部相对路径、IMG 版本、帧数和元数据哈希，不承担解包或部署。
- 图片模型输出字节只能短暂返回给受控的服务内调用方；数据库只记录调用和 attempt 元数据，且 `directRuntimeUseAllowed` 固定为 `false`。
- 模型角色由服务端固定映射。经过认证的用户可为固定角色配置受策略约束的 HTTPS endpoint、模型 ID 和 BYOK 密钥；业务任务调用方不得在 Run/Job payload 中临时选择任意模型、端点、密钥、工具或存储策略。
- `modelEgressAuthorized` 为 `false`、模型密钥缺失或端点不合法时必须记录 blocked，不得尝试外发。
- 模型请求使用固定超时、重试、空工具列表和禁用 provider 存储；响应必须按 Zod schema 解析或按字节哈希处理。
- 用户模型密钥只允许经专用认证 HTTPS 配置端点进入服务端，并在调用或加密期间短暂存在于进程内存。持久化仅允许外部 Secret Manager 引用，或使用环境/KMS 主密钥执行的认证加密密文；模型调用记录只能保存用户配置版本、端点身份、请求/响应哈希、provider response ID、状态和稳定错误码。
- 模型配置读取响应只能返回固定角色、endpoint、模型 ID、配置版本和 `keyConfigured`；不得返回密钥、密文、nonce、认证标签、Secret 引用或可用于离线猜测密钥的材料。配置写入成功后也不得回显提交值。
- 后台模型调用必须从 Run 的稳定 owner 解析同一用户的配置快照；缺少 owner、配置、密钥、配置版本或所有权证据时必须 blocked，不得回退到其他用户或全局 Key。

## 10. 错误、日志与安全响应

- 预期业务失败使用具体 Nest HTTP 异常和稳定大写错误码；消息使用中文且不得泄露内部实现。
- 非 HTTP 内部不变量可以抛出 `Error`，但必须在边界处映射为稳定状态或通用 500 响应；不得把原始 message 直接返回客户端。
- 全局异常过滤器必须保持统一 schema，并过滤堆栈、环境变量、数据库原始对象、模型原始响应和敏感路径。
- 服务日志使用 Nest `Logger` 或等价的依赖注入日志设施，只记录稳定事件/错误码和必要的脱敏标识。
- 不得记录 token、API Key、用户凭据密文材料、Secret 引用、数据库 URL、完整 payload、Prompt、模型输出或绝对路径。后台 reaper 等循环失败必须记录稳定码并继续受控调度。

## 11. 验证与交付

- 契约、状态机、幂等、租约、Guardrail、安全默认值和错误分支必须有 Vitest 单元测试。
- `npm run gate` 依次覆盖凭据扫描、项目结构、类型、Lint、单元测试、migration 一致性、生产构建和降级冒烟；修改服务端代码后必须执行。
- `npm run gate` 不执行真实 MySQL 运行测试。需要证明 migration、REST、Socket.IO、事务、CHECK、限制性外键或租约运行语义时，另行执行 `npm run test:mysql` 并满足其隔离 MySQL 前置条件。
- 外部模型能力、Windows/Linux 双平台行为、真实 Electron/Worker 集成和任何部署流程必须在对应环境单独验证。
- 交付报告必须列出实际执行的命令、结果和未执行项；不得把模型 ID 存在、SQL 已生成、mock 测试通过或服务可启动表述为外部集成已通过。
