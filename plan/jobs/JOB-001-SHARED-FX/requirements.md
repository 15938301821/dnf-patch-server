# JOB-001-SHARED-FX

## 目标

建立 `shared-fx` v1 共享特效业务编排模板。服务端只冻结经验证的 Project Snapshot、Factory 策略、声明式六阶段计划和审计证据；实际 inventory、素材处理、Aseprite、runtime、NPK 与独立验证由仓库外受控 Windows Worker 执行。

## 不变量

- 浏览器创建入口只接受 `projectId`、`snapshotId` 和 `clientRunId`，并绑定合法幂等键与稳定用户身份；来源哈希、策略、Worker payload 和安全状态均由服务端生成。
- Job payload 固定为 `inventory`、`material`、`aseprite`、`runtime`、`npk`、`independent-validation` 六阶段，不包含任意命令、可执行路径、脚本、绝对路径、游戏目录或部署指令。
- 每个阶段只能由当前精确 `workerId + leaseId + attempt` 提交同 Job 已 finalize 的 Artifact ID；服务端从可信 Artifact 读取 SHA-256，不接收 Worker 自报阶段哈希。
- `passed` 完成必须同时满足固定六阶段各一条证据、上传会话仍为 finalized、upload/Artifact/Run/Job/Worker/lease/attempt 归属一致、持久化 Artifact 哈希未漂移，且 Worker 的完成哈希等于独立验证 Artifact 的服务端哈希。
- 完成门禁、Job/Attempt/Run 状态、权威事件、outbox 和绑定独立验证 Artifact 的单一 `pending` 人工审核记录必须在同一事务中保持一致；证据缺失或审核冲突时不得写入终态。
- Run 的 `passed` 只表示 Worker 六阶段证据已完成，不表示人工审核通过、发布、部署、全技能覆盖或客户端兼容。
- `deploymentAuthorized`、`deploymentPerformed`、`fullSkillCoverageProven`、`clientCompatibilityProven` 始终保持 `false`。

## 验收

- 专用浏览器入口和通用 Run 入口都复核 Snapshot 与 Factory v2 的 `shared-fx` v1 绑定，缺少 manifest、策略、契约或 Worker capability 时 fail-closed。
- Worker 阶段证据接口使用严格 DTO，只接受固定阶段、Artifact ID 与精确租约；同阶段同 Artifact 可幂等重放，替换 Artifact 被拒绝。
- 数据库以 CHECK、唯一索引和限制性复合外键约束固定阶段、上传会话、Artifact、Run、Job、Worker、attempt 与 lease 的完整归属链。
- `passed` 完成使用独立验证 Artifact 的服务端 SHA-256 写入 Attempt，并创建或复用同一 Artifact 的 `pending` 人工审核；其他审核状态或证据冲突必须拒绝完成。
- 单元测试覆盖严格 DTO、六阶段完整性、稳定错误映射、Worker guard 与控制器委托；migration SQL、snapshot 与 journal 通过静态一致性检查。
- 真实 MySQL migration/事务/CHECK/外键、真实 MinIO、外部 Worker、Aseprite、NPK 封包、独立验证器、人工审核 API 和发布流程仍须在对应隔离环境另行实现或验证，不得由静态检查或单元测试推定已完成。
