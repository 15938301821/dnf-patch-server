# NestJS + Drizzle + Guardrail 规则

- Controller 不直接操作 Drizzle，Repository 不依赖 HTTP 或 WebSocket。
- 创建任务必须带幂等键；Worker claim 使用数据库事务和租约。
- WebSocket 只负责低延迟通知，数据库事件流才是权威事实源。
- 模型调用必须绑定 Run、固定角色和配置哈希；模型不能选择工具或提升安全状态。
- MySQL 只存元数据和哈希，不存官方 NPK、源帧、模型密钥或任意命令。
