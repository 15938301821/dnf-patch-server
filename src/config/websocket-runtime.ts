/**
 * @fileoverview 在 Nest 与 WebSocket 依赖载入前固定 ws 运行时行为；不开放调用方可控的传输
 * 参数，不修改第三方包，也不承担 Socket.IO 握手认证或消息恢复。
 * @module config
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：main.ts 必须最先以副作用 import 载入本文件，下游 ws 包读取该进程变量。无外部输入
 * 或返回值；副作用是禁用可选原生 bufferutil 加速模块，以保持启动依赖确定性。
 * 安全边界：此设置不替代 `/runs` 握手 token Guard、订阅 DTO 校验或数据库权威事件恢复，且不应
 * 被扩展为接收 HTTP/WebSocket payload 的动态开关。
 */

// 必须早于 ws 包求值；赋固定常量，不读取用户请求，也不包含秘密。
process.env.WS_NO_BUFFER_UTIL = "1";
