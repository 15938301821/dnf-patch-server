/**
 * @fileoverview 定义 Worker 读取 Profession 多技能生产进度的租约 DTO 与有限 ViewModel；
 * 不暴露 production 数据库行、模型 ID、Artifact ID、错误正文或本机信息。
 * @module modules/job/profession-production-progress-contracts
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 当前 Profession Worker 纵向闭环直接需求
 *
 * 调用关系：JobController 校验当前 Worker/lease/attempt 后委托 PatchTaskService；Worker Handler
 * 用返回的冻结顺序状态跳过旧 attempt 已通过技能，并只在全部通过时消费 resultSha256。
 * 副作用：本文件只做内存校验。安全边界：resultSha256 只能由 Server 从完整生产证据复算，
 * pending/failed/blocked 不得夹带结果摘要，未知字段一律拒绝。
 */
import { z } from "zod";
import { sha256Schema } from "../../common/contracts/index.js";

/** 当前 Profession Job 进度读取必须携带的完整 fencing 身份。 */
export const professionProductionProgressInputSchema = z
  .object({
    workerId: z.uuid(),
    leaseId: z.uuid(),
    attempt: z.number().int().min(1).max(10),
  })
  .strict();

/** Worker 可见的冻结技能状态；pending 合并 planned 与三个活动阶段。 */
const professionProductionProgressSkillSchema = z
  .object({
    skillId: z.uuid(),
    status: z.enum(["pending", "passed", "failed", "blocked"]),
  })
  .strict();

/** 当前 Job 全部冻结技能的有序进度，仅全 passed 时允许携带完成摘要。 */
export const professionProductionProgressViewSchema = z
  .object({
    schemaVersion: z.literal(1),
    skills: z
      .array(professionProductionProgressSkillSchema)
      .min(1)
      .max(500)
      .refine(
        (skills) =>
          new Set(skills.map((skill) => skill.skillId)).size === skills.length,
        { message: "职业生产进度不能包含重复技能。" },
      ),
    resultSha256: sha256Schema.optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const allPassed = value.skills.every((skill) => skill.status === "passed");
    if (allPassed !== (value.resultSha256 !== undefined)) {
      context.addIssue({
        code: "custom",
        path: ["resultSha256"],
        message: "完成摘要必须且只能在全部技能通过时出现。",
      });
    }
  });

/** Worker 当前租约下读取进度的严格输入，不等于 Job lease 数据库行。 */
export type ProfessionProductionProgressInput = z.infer<
  typeof professionProductionProgressInputSchema
>;

/** Worker 可消费的有限多技能进度，不证明客户端兼容、审核或部署。 */
export type ProfessionProductionProgressView = z.infer<
  typeof professionProductionProgressViewSchema
>;
