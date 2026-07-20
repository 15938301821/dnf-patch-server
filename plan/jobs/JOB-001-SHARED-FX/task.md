# 执行任务

1. 校验项目快照、manifest 与 Prompt 包哈希。
2. 创建白名单 `shared-fx` job，不包含任意命令或绝对路径。
3. 本地 Worker 通过注册 profile 执行 inventory、素材、Aseprite、runtime、NPK 和验证阶段。
4. 服务端接收状态、事件与证据哈希，保持所有安全状态为 false，等待人工审核与本地发布闭环。
