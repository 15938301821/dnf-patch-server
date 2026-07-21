# DNF Patch Server — AI 协作规则

本文件是 `dnf-patch-server` 全仓库的 AI 协作入口。任何分析、规划、代码生成、重构、迁移、测试或文档修改都必须遵守本文件；不得以“原型”“兼容旧客户端”“临时排障”或“模型建议”为由放宽安全边界。

## 1. 规则范围与优先级

开始工作前，按以下顺序读取并应用规则：

1. `AGENTS.md`：仓库定位、信任边界、安全不变量和交付要求。
2. `.codebuddy/rules/global.md`：文件规模、注释、命名、类型、安全和 AI 自检清单。
3. `.codebuddy/rules/server.md`：NestJS 分层、Drizzle、Run/Job/租约、模型及验证细则。
4. 与任务有关的 `plan/jobs/<JOB-ID>/requirements.md`、`task.md`、相邻源码、公开契约和测试。
5. 涉及 DNF 资源语义时，读取 `../dnf-patch` 中对应的规则、manifest、Prompt、工具目录和验证报告。

规则冲突时，依次以不可变安全条件、经验证事实源、本文件、全局规范、Server 规范和具体任务计划为准；采用更严格的要求，不得自行折中。仓库中不存在的规范、类型或工具不能被当作强制前提，也不得据此虚构 `BaseWorker`、Scheduler、CLI 封装或并行架构。

## 2. 项目定位与信任边界

本项目是 DNF Patch Studio 的 NestJS/MySQL 审计型控制面，负责：

- Factory、Project、Snapshot、Run、Job 和 Worker 注册及能力管理。
- attempt、租约、心跳、超时回收、权威事件和 outbox 持久化。
- Artifact 相对引用、NPK/IMG inventory 元数据和 Image attempt 证据。
- Guardrail 决策、固定角色模型调用状态、请求/响应哈希和脱敏审计记录。
- 通过版本化 REST 与 Socket.IO 接口向桌面端和受控 Worker 提供调度能力。

本项目不是本机补丁执行器，不负责：

- 访问、扫描、写入、部署或修改游戏目录，以及检查、启动或终止游戏进程。
- 解包、改写或发布官方 NPK、IMG、ImagePacks2 和 runtime 文件。
- 执行或下发任意 executable、shell、命令、脚本路径、绝对路径或未验证参数。
- 保存官方资源、源帧、runtime 图片或其他大文件 BLOB。
- 提供任意 Prompt、任意模型、任意工具调用、通用模型推理或网络代理 API；受认证的用户模型配置写入端点不属于模型推理 API。
- 根据名称猜测 NPK、IMG、技能、帧映射、全技能覆盖或客户端兼容性。

`../dnf-patch` 是 DNF 领域事实源和桌面端实现仓库，不是本服务可随意读取的运行时文件系统依赖。本机固定工具和文件操作属于 Electron 主进程或仓库外受控 Worker；服务端只接收版本化声明式任务、相对引用、状态和可验证证据。

## 3. 不可变安全条件

- `deploymentAuthorized`、`deploymentPerformed`、`fullSkillCoverageProven`、`clientCompatibilityProven` 必须在 DTO、Service 和数据库 CHECK 中保持 `false`；普通 API、Worker 或模型不能提升这些状态。
- 官方 NPK 与 ImagePacks2 始终只读；MySQL 只保存相对引用、长度、SHA-256、版本、状态和有界 provenance。
- Worker 只能领取数据库已注册且属于自身 capabilities 的 Job kind；服务端的 Worker 是身份、能力和租约主体，不是可执行 `BaseWorker`。
- Job payload 必须符合 Factory 冻结的版本化声明式契约；终态、Artifact、Image、Inventory 和 Guardrail 引用必须具有匹配的哈希与 Run/Project 归属证据。
- Guardrail、Run 请求指纹、幂等键、租约 fencing、attempt 上限、事务和限制性外键不得绕过。
- 每个 HTTP、WebSocket、环境变量、数据库 JSON 和模型响应入口都必须执行运行时校验；开放式 JSON、字符串、集合和二进制必须设置与风险相称的大小、深度或数量边界。
- 客户端 token 与 Worker token 必须使用不同值。模型密钥可以由用户通过受认证的专用 HTTPS 配置端点提交，但不得通过查询、业务任务、通用模型代理或 WebSocket 接口接收。
- 用户模型密钥明文只能在服务进程内存中短暂存在，不得回显或进入日志、错误、事件、outbox、证据、模型调用记录及测试快照。持久化只允许外部 Secret Manager 引用，或由环境/KMS 主密钥保护的认证加密密文；主密钥和解密材料不得进入数据库。
- 用户模型配置必须绑定经过持久化验证的稳定用户身份；共享客户端令牌、请求提供的用户名或可变 displayName 不能单独作为租户归属证据。读取、更新、轮换、删除和 Run 调用均须执行所有权校验并 fail-closed。
- 缺少映射、哈希、策略、能力、租约、配置、归属或授权证据时必须 fail-closed，不得猜测后继续。

## 4. 架构硬约束

- Controller 只负责路由、输入校验和响应映射；Gateway 只负责鉴权、订阅和提交后通知；业务规则放在 Service；复杂查询、行锁和事务持久化放在本模块 Repository。
- 跨模块只调用公开 Service 或契约，禁止导入其他模块的 Repository、内部辅助函数或数据库行类型。
- Drizzle schema、Zod DTO 和 API ViewModel 必须分离；数据库 JSON 写入前和读取后均需校验。
- 用户凭据 DTO、加密持久化行和只读 API ViewModel 必须分离；响应只能返回配置元数据和 `keyConfigured`，不得返回密钥、密文、nonce、认证标签、Secret Manager 引用或解密失败细节。
- 数据库中的权威事件与 outbox 是事实源；WebSocket 不能成为唯一状态来源，客户端必须能按 sequence 恢复。
- Run、Job、Attempt、Guardrail、事件和 outbox 的关联状态变更必须保持事务一致；事务提交后才能广播。
- 项目使用严格 TypeScript 和 ESM；禁止 `any`、`@ts-ignore` 和关闭严格检查，外部输入从 `unknown` 开始，类型导入使用 `import type`，相对源码导入沿用 `.js` 后缀。
- `.ts`、`.tsx`、`.js`、`.mjs` 单文件不得超过 500 行；接近 400 行时按领域职责评估拆分。新增或实质性重写的源码必须满足全局规范的文件头元数据与注释要求。
- 不得新增与现有纵向模块并行的兼容目录、第二套 API、服务端本机执行框架或虚构的 CLI 工具层；公开契约演进必须显式版本化。
- 不得修改生成产物代替源码修复，也不得回滚、覆盖或格式化与当前任务无关的用户改动。

## 5. 变更工作流

1. **研究**：读取目标文件、直接调用方、公开契约、数据库 schema、相邻测试和相关任务计划；以实际控制行为的代码为准，不依据目录名或需求标题推断。
2. **假设**：在编辑前明确一个可证伪的局部假设和最便宜的验证方式；若证据足够，直接实施最小改动，不进行无边界探索。
3. **自检**：逐项核对 `.codebuddy/rules/global.md` 的“AI 生成前自检清单”，确认变更仍在服务职责和安全边界内。
4. **实施**：修复根因，保持现有风格、公开 API 和模块职责；不得顺带重构无关代码。
5. **验证**：首次实质编辑后立即运行最窄的可执行验证；失败时先修复同一切片并重跑，再扩大范围。
6. **测试**：为新增契约、状态转换、冲突、租约、Guardrail、证据归属和安全分支补充测试。用户凭据变更还必须覆盖跨用户隔离、不回显、轮换、删除、认证加密失败和日志脱敏。数据库结构变更必须修改 Drizzle schema、生成并审查 migration。
7. **交付**：运行与变更范围匹配的门禁，只报告实际成功的命令、结果和未执行项；不得扩大证明范围。

## 6. 验证与证明范围

- 窄验证优先使用相关 Vitest 文件、`npm run typecheck` 或目标模块的可执行检查。
- `npm run gate` 覆盖凭据扫描、项目结构、严格类型、Lint、单元测试、migration/journal 一致性、生产构建和降级冒烟。
- `npm run test:mysql` 仅在显式提供隔离 MySQL 前置条件时执行，用于验证真实 migration、REST、Socket.IO、事务、CHECK、限制性外键、幂等和租约运行语义。
- 外部模型能力、真实 Electron/Worker 集成、Windows/Linux 双平台行为和部署流程必须在对应环境独立验证。
- 纯文档变更至少执行目标文件诊断和 `git diff --check`；若文档描述项目结构、命令或安全边界，还应执行对应的结构或凭据检查。

以下推论一律禁止：

- `npm run gate` 通过不代表真实 MySQL 集成通过。
- migration SQL 已生成不代表 migration 已执行。
- 模型 ID 已配置不代表外部端点支持该模型或调用成功。
- mock 或单元测试通过不代表客户端兼容、全技能覆盖或部署已证明。
- 服务健康不代表游戏目录、Worker 工具链或发布链路可用。
