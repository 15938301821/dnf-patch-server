/**
 * @fileoverview 定义 Profession Worker 请求服务端执行固定生产步骤时的内部租约 DTO；不包含 Prompt、
 * 模型配置、API Key、工具路径、图片字节或任意执行参数。
 * @module modules/job/profession-execution-contracts
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan /memories/session/plan.md - 单技能 Profession Worker 纵向链路
 *
 * 调用关系：Worker 内部 Controller 将请求 body 交给本 schema，Profession 执行 Service 再结合数据库中
 * 已锁定的 Job 和冻结 payload 解析真实上下文。输入只标识当前 Worker、lease、attempt 与已选技能；
 * 输出是已校验 DTO，不是数据库行或模型请求。副作用：本文件只做内存校验。
 * 安全边界：新接口不保留首次 attempt 省略 leaseId 的旧协议兼容；四个字段必须全部精确匹配当前 claim，
 * 且调用方不能通过 DTO 选择 Prompt、endpoint、模型、命令、脚本或本机路径。
 */
import { z } from "zod";

/** Worker 请求固定 Profession 技能步骤时必须提交的完整 fencing 身份。 */
export const requestProfessionSkillExecutionSchema = z
  .object({
    workerId: z.uuid(),
    leaseId: z.uuid(),
    attempt: z.number().int().min(1).max(1_000_000),
    skillId: z.uuid(),
  })
  .strict();

/** 经运行时校验的 Profession 技能执行请求，不携带可执行内容或用户凭据。 */
export type RequestProfessionSkillExecutionInput = z.infer<
  typeof requestProfessionSkillExecutionSchema
>;

const engineerPlanExecutionViewSchema = z
  .object({
    executionId: z.uuid(),
    modelCallId: z.uuid(),
    outputArtifactId: z.uuid(),
    mediaType: z.literal("application/json"),
    byteLength: z
      .number()
      .int()
      .positive()
      .max(16 * 1024),
    sha256: z.string().regex(/^[A-F0-9]{64}$/u),
  })
  .strict();

const referenceImageExecutionViewSchema = z
  .object({
    executionId: z.uuid(),
    modelCallId: z.uuid(),
    imageAttemptId: z.uuid(),
    outputArtifactId: z.uuid(),
    mediaType: z.literal("image/png"),
    byteLength: z.number().int().positive().max(4_294_967_295),
    sha256: z.string().regex(/^[A-F0-9]{64}$/u),
  })
  .strict();

/** Worker 仅获得两个固定阶段的下载/报告证据，不获得 Prompt、对象 key、模型配置或对象字节。 */
export const professionSkillExecutionViewSchema = z.discriminatedUnion(
  "status",
  [
    z
      .object({
        status: z.literal("in-progress"),
        executionId: z.uuid(),
      })
      .strict(),
    z
      .object({
        status: z.literal("passed"),
        engineerPlan: engineerPlanExecutionViewSchema,
        referenceImage: referenceImageExecutionViewSchema,
      })
      .strict(),
  ],
);

/** 单技能固定参考图步骤的脱敏结果。 */
export type ProfessionSkillExecutionView = z.infer<
  typeof professionSkillExecutionViewSchema
>;
