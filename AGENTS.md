# DNF Patch Server 规则

本服务只负责项目元数据、工厂任务、事件、租约、Guardrail 决策与模型调用证据。现有 `../dnf-patch` 仓库中的根/职业/主题规则、manifest、Prompt、工具目录和验证报告仍是 DNF 领域事实源。

## 安全边界

- 不按职业名、技能名或 Prompt 标题猜测 NPK、IMG、帧映射。
- 官方 NPK 与 ImagePacks2 只读；MySQL 不保存官方包、源帧或 runtime 图片 BLOB，只保存相对引用、长度、SHA-256 和 provenance。
- 服务端不得访问、部署或修改游戏目录，不检查或控制游戏进程。
- `deploymentAuthorized`、`deploymentPerformed`、`fullSkillCoverageProven`、`clientCompatibilityProven` 默认固定为 `false`，不能由普通 API 或模型提升。
- Worker 只能领取注册的 job kind；服务端不下发任意 executable、shell、脚本路径或未验证参数。
- 模型密钥只从服务进程环境读取，不进入数据库、REST、WebSocket、日志、错误或证据正文。
- 每个请求和 WebSocket 载荷均执行运行时校验；错误信息不得包含凭据、绝对游戏路径或模型原始响应。

## 工程规则

- NestJS 控制器只做 DTO 校验与响应映射，业务逻辑放入 service；数据库访问集中在 repository。
- Drizzle schema、DTO 与 API view model 分离；JSON 字段读写必须经 Zod 校验。
- 单文件不超过 500 行，新增公共方法与复杂分支使用中文注释说明边界。
- Windows、Linux 均应通过 `npm run gate`；真实 MySQL 集成验证另行执行并如实报告。
