# 执行任务

1. 已完成服务端对 Project Snapshot、manifest、Factory v2 策略与 `shared-fx` v1 contract 的冻结和双入口绑定校验。
2. 已完成白名单 `shared-fx` Job 与六阶段声明式 payload；请求中不包含任意命令、可执行路径、绝对路径、游戏目录或部署指令。
3. 已完成精确租约绑定的阶段证据写入：Worker 只提交已 finalize 的 Artifact ID，服务端保存自己的 Artifact 哈希并追加权威事件与 outbox。
4. 已完成 `passed` 事务门禁：固定六阶段证据和独立验证哈希必须完整一致，随后创建或复用绑定验证 Artifact 的单一 `pending` 人工审核，并原子更新 Job、Attempt、Run、事件与 outbox。
5. 已生成并静态校验证据表、限制性复合外键、固定阶段 CHECK、上传绑定唯一键以及人工审核唯一键和状态 CHECK；该结果不表示 migration 已在 MySQL 执行。
6. 已补充共享特效契约、任务创建、证据完整性、证据 HTTP 边界与完成错误映射的聚焦单元测试。
7. 待仓库外 Windows Worker 按注册 profile 实际执行 inventory、素材、Aseprite、runtime、NPK 和独立验证，并为每阶段上传、finalize 和回填 Artifact。
8. 待实现人工审核批准/拒绝与受控本地发布闭环；Run `passed` 期间审核仍可为 `pending`，所有部署、覆盖和兼容性状态继续为 `false`。
9. 待在隔离环境执行真实 MySQL、MinIO、Worker、Aseprite、NPK 与验证器集成测试，分别记录可证明范围。
