# JOB-006-LOCAL-OBJECT-STORAGE

## 目标

为完整本地后端建立私有 MinIO 配置与可信 Artifact 存储底座。NestJS 仍不读取游戏目录或执行本机工具；官方 NPK 不进入对象存储。

## 不变量

- MinIO API 与 Console 只绑定本机回环地址，bucket 保持私有。
- Root 凭据、对象存储应用凭据、客户端令牌、Worker 令牌和浏览器会话密钥必须使用不同值。
- MySQL 只保存对象引用、长度、SHA-256、状态和有界 provenance，不保存大文件 BLOB。
- 后续生产 Artifact 必须经过服务端重新读取对象并复核长度和 SHA-256，不能仅凭客户端声明创建可信证据。
- 对象 key 由服务端生成；浏览器和 Worker 不能选择 bucket、覆盖既有对象或取得长期 MinIO 凭据。
- `deploymentAuthorized`、`deploymentPerformed`、`fullSkillCoverageProven`、`clientCompatibilityProven` 保持 `false`。

## 本切片验收

- 环境契约默认禁用对象存储；启用时要求回环 endpoint、独立应用凭据、私有 bucket 名称、短期签名 TTL 和容量边界。
- Compose 使用固定 MinIO/MC 镜像、持久卷、健康检查和一次性 bootstrap。
- bootstrap 创建私有 bucket、最小权限应用用户，并拒绝 root 与应用凭据复用。
- `.env.example`、README、结构门禁、配置单元测试和凭据扫描同步更新。
- 单元验证内部 S3/MinIO 适配器、短期签名命令映射和服务端流式长度/SHA-256 复核。
- Artifact 上传会话在独立表中保存，绑定 Run、Job、Worker、attempt 和 leaseId；对象 key 仅由服务端生成，PUT 签名使用 `If-None-Match: *` 防止覆盖。
- finalize 在对象复核后事务性创建最终 Artifact，并在写入前再次验证精确租约和会话归属；Worker 下载只能取得短期 GET 授权，最终 Artifact API 不返回内部对象 key。
- rejected 或过期会话由有界 orphan reaper 删除，且只在预签名 PUT 到期后标记对象清理完成。
- 真实 MinIO bucket/权限、真实 MySQL migration/事务、过期授权和端到端 Worker 行为尚未在隔离运行环境验证；不得将单元测试、生成 SQL 或门禁通过视作这些集成已证明。
