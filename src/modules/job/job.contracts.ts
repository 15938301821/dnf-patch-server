/**
 * @fileoverview 定义 Worker Job 的创建、领取、心跳、完成输入和公开状态 ViewModel；不签发 lease、不执行
 * 状态转换、不查询数据库，也不接收任意命令、工具路径或游戏资源。
 * @module modules/job/contracts
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：RunService 使用 createJobSchema 接收嵌入 Run 的声明式 Job；JobController 使用 claim/heartbeat/
 * complete schema 解析受 Worker token 保护的请求；JobRepository/Service 使用推导类型维护 attempt 和 lease。
 * 输入输出：输入是受限 kind、bounded JSON payload、Worker id、可选 fencing token 和完成证据；输出是脱敏
 * JobView/JobStateView，不返回 Worker token、本机路径、执行命令、Artifact URL 或模型凭据。
 * 副作用：本文件只有内存 schema 校验，不执行数据库、Worker、网络或对象存储操作。
 * 安全边界：Job 载荷在创建后仍须按 Factory 版本化 contract 解析；`passed` 必须提供 result SHA-256，
 * failed/blocked 必须提供稳定错误码。leaseId 对首 attempt 可暂缺以兼容 v1，重试由 lease validator 强制升级。
 */
import { z } from "zod";
import { boundedJsonRecordSchema } from "../../common/contracts/index.js";
import { allowedJobKindSchema } from "../guardrail/guardrail.contracts.js";

/**
 * jobs 表允许持久化的生命周期状态。
 * queued/leased 为非终态，passed/failed/blocked 为终态；Run 终结由全部 Job 聚合逻辑决定，不可由 DTO 直接改写。
 */
export const persistedJobStatusSchema = z.enum([
  "queued",
  "leased",
  "passed",
  "failed",
  "blocked",
]);

/**
 * 嵌入 CreateRun DTO 的严格 Job 定义。
 * payload 只有 JSON 预算约束；RunService 必须用 Factory 的 kind/schemaVersion/profile/策略契约再次解析。
 */
export const createJobSchema = z
  .object({
    kind: allowedJobKindSchema,
    payload: boundedJsonRecordSchema,
    maxAttempts: z.number().int().min(1).max(10).default(3),
  })
  .strict();

/** Worker 领取下一个兼容 Job 的最小内部 DTO，不允许 Worker 自选 Job id、路径或 payload。 */
export const claimJobSchema = z.object({ workerId: z.uuid() }).strict();

/** Worker 心跳 DTO，leaseId 缺失只在首次 attempt 的兼容期内可能被 lease validator 接受。 */
export const heartbeatJobSchema = z
  .object({
    workerId: z.uuid(),
    leaseId: z.uuid().optional(),
  })
  .strict();

/**
 * Worker 完成一个已领取 Job 的严格 DTO。
 * 通过必须用 resultSha256 绑定输出证据；失败/阻断必须带稳定 errorCode，防止仅凭文本消息被下游当作成功。
 */
export const completeJobSchema = z
  .object({
    workerId: z.uuid(),
    leaseId: z.uuid().optional(),
    status: z.enum(["passed", "failed", "blocked"]),
    resultSha256: z
      .string()
      .regex(/^[A-Fa-f0-9]{64}$/u)
      .optional(),
    errorCode: z.string().max(80).optional(),
    errorMessage: z.string().max(2_000).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "passed" && value.resultSha256 === undefined) {
      context.addIssue({
        code: "custom",
        path: ["resultSha256"],
        message: "通过的 Job 必须提供结果 SHA-256。",
      });
    }
    if (value.status !== "passed" && value.errorCode === undefined) {
      context.addIssue({
        code: "custom",
        path: ["errorCode"],
        message: "失败或阻断的 Job 必须提供稳定错误码。",
      });
    }
  });

/** Run 创建内使用的已解析 Job 输入，不是持久化 Job 行或可执行 Worker 指令。 */
export type CreateJobInput = z.infer<typeof createJobSchema>;

/** Worker 领取请求的已解析身份输入。 */
export type ClaimJobInput = z.infer<typeof claimJobSchema>;

/** Worker 续租请求的已解析身份和可选 fencing token。 */
export type HeartbeatJobInput = z.infer<typeof heartbeatJobSchema>;

/** Worker 完成请求的已解析终态与结果/错误证据。 */
export type CompleteJobInput = z.infer<typeof completeJobSchema>;

/**
 * 对 Worker/内部调用方公开的 Job 状态 ViewModel。
 * payload 仍是声明式 JSON，收到它不授权执行任意内容；lease 字段仅描述当前 attempt，不证明之后仍有效。
 */
export interface JobView {
  id: string;
  runId: string;
  kind: z.infer<typeof allowedJobKindSchema>;
  status: string;
  payload: Record<string, unknown>;
  payloadSha256: string;
  leaseOwnerId?: string;
  leaseId?: string;
  leaseExpiresAtUtc?: string;
  attemptCount: number;
  maxAttempts: number;
  createdAtUtc: string;
  updatedAtUtc: string;
}

/** 不含 payload/lease 的轻量状态视图，供 Run/任务聚合读取终态。 */
export interface JobStateView {
  id: string;
  runId: string;
  status: z.infer<typeof persistedJobStatusSchema>;
  createdAtUtc: string;
  updatedAtUtc: string;
}
