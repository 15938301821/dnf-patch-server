# 执行任务

1. 冻结本机 MinIO 环境变量、回环 endpoint、bucket、TTL 和配额契约。
2. 增加固定版本 MinIO 服务、私有持久卷、健康检查和最小权限 bootstrap。
3. 用环境单测、类型检查、项目结构门禁、凭据扫描和 Compose 静态解析验证配置。
4. 已在 Artifact 模块实现服务端生成 key、条件短期 PUT、流式长度/SHA-256 复核、finalized 元数据、Worker 短期 GET 授权和有界 orphan 清理。
5. 待在安装容器运行时的隔离环境执行真实 bucket、权限、篡改、过期授权与 orphan 清理测试；该验证还须执行真实 MySQL migration/事务路径。
