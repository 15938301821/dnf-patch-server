/**
 * @fileoverview 定义受控 Worker 的注册、心跳输入与公开状态 ViewModel；不接收本机工具路径、命令、脚本、
 * 游戏目录、模型密钥或任意执行参数。
 * @module modules/worker/contracts
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：WorkerController 使用 registerWorkerSchema 解析共享内部令牌认证后的注册 body；
 * WorkerService 使用 workerCapabilitiesSchema 重新解析数据库 JSON，并以推导类型更新 Worker 状态。
 * 输入输出：输入是稳定 UUID、显示名和受控 Job kind capabilities；输出是 WorkerView，不返回 token、
 * lease、Job payload、本机目录或工具配置。
 * 副作用：本文件只有内存 schema 校验；注册、心跳、禁用的数据库写入在 WorkerService 中发生。
 * 安全边界：capability 只是数据库登记的能力声明，不能下发执行内容，也不代表 Worker 在线、租约有效、
 * 本机工具哈希通过或具备任意命令权限。
 */
import { z } from "zod";
import { allowedJobKindSchema } from "../guardrail/guardrail.contracts.js";

/**
 * Worker 能声明的受控 Job kind 集合。
 * 最多 32 项且禁止重复，值来自全局 allowedJobKindSchema；通过解析不等于这些 Handler 已在该进程启动。
 */
export const workerCapabilitiesSchema = z
  .array(allowedJobKindSchema)
  .min(1)
  .max(32)
  .refine((values) => new Set(values).size === values.length, {
    message: "Worker capabilities 不能重复。",
  });

/**
 * Worker 注册的严格内部 DTO。
 * id 是稳定 Worker 身份，后续重复注册只能用相同显示名和 capability 集合刷新心跳，不能修改身份语义。
 */
export const registerWorkerSchema = z
  .object({
    id: z.uuid(),
    displayName: z.string().trim().min(1).max(160),
    capabilities: workerCapabilitiesSchema,
  })
  .strict();

/**
 * 为未来 body 形式心跳保留的严格 DTO；当前 Controller 从 path 参数接收 id，不能传入能力或本机路径。
 */
export const heartbeatWorkerSchema = z
  .object({
    id: z.uuid(),
  })
  .strict();

/** WorkerService 接受的已校验注册输入，不包含 Worker token 或本机执行配置。 */
export type RegisterWorkerInput = z.infer<typeof registerWorkerSchema>;

/** 已校验的心跳输入类型，只携带稳定 Worker id。 */
export type HeartbeatWorkerInput = z.infer<typeof heartbeatWorkerSchema>;

/**
 * 公开 Worker 注册状态 ViewModel。
 * `capabilities` 是声明，不证明当前 freshness、Job lease、资源映射或本机工具链已经验证。
 */
export interface WorkerView {
  id: string;
  displayName: string;
  capabilities: string[];
  disabled: boolean;
  lastHeartbeatAtUtc?: string;
  createdAtUtc: string;
}
