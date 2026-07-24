/**
 * @fileoverview 定义浏览器制作任务兼容契约；内部映射到 Run、Worker Job 和主题包证据。
 * @module job
 * @author AI生成
 * @created 2026-07-21
 * @relatedPlan N/A（对应当前前端业务与后端工作流直接需求）
 */
import { z } from "zod";
import { sha256Schema } from "../../common/contracts/index.js";

export const createPatchTaskSchema = z
  .object({
    professionId: z.uuid(),
    styleId: z.uuid(),
  })
  .strict();

const workerLeaseSchema = {
  workerId: z.uuid(),
  leaseId: z.uuid(),
  attempt: z.number().int().min(1).max(10),
};

const workerSkillSchema = {
  ...workerLeaseSchema,
  skillId: z.uuid(),
};

const activeSkillProductionReportSchema = z
  .object({
    ...workerSkillSchema,
    status: z.enum(["generating", "adapting", "validating"]),
  })
  .strict();

const passedSkillProductionReportSchema = z
  .object({
    ...workerSkillSchema,
    status: z.literal("passed"),
    asepriteBinarySha256: sha256Schema,
    asepriteAdapterSha256: sha256Schema,
    asepriteArtifactId: z.uuid(),
    validationArtifactId: z.uuid(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.asepriteArtifactId === value.validationArtifactId) {
      context.addIssue({
        code: "custom",
        path: ["validationArtifactId"],
        message: "Aseprite 工程与 runtime 验证必须使用不同 Artifact。",
      });
    }
  });

const failedSkillProductionReportSchema = z
  .object({
    ...workerSkillSchema,
    status: z.enum(["failed", "blocked"]),
    errorCode: z
      .string()
      .min(1)
      .max(80)
      .regex(/^[A-Z][A-Z0-9_]*$/u),
  })
  .strict();

/**
 * Worker 回填单技能生产状态的互斥严格 DTO。
 * 进行中状态不能夹带终态证据；通过状态只提交本机工具摘要与两个 finalized Artifact，模型调用、
 * 图片尝试、固定 profile 和来源证据由 Server 从当前 attempt 反查；失败状态只允许稳定错误码。
 */
export const reportPatchTaskSkillProductionSchema = z.discriminatedUnion(
  "status",
  [
    activeSkillProductionReportSchema,
    passedSkillProductionReportSchema,
    failedSkillProductionReportSchema,
  ],
);

export const reportPatchTaskPackageSchema = z
  .object({
    ...workerLeaseSchema,
    status: z.enum(["building", "passed", "failed", "blocked"]),
    packageArtifactId: z.uuid().optional(),
    manifestSha256: sha256Schema.optional(),
    errorCode: z.string().trim().min(1).max(80).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "passed") {
      for (const key of ["packageArtifactId", "manifestSha256"] as const) {
        if (value[key] === undefined) {
          context.addIssue({
            code: "custom",
            path: [key],
            message: "通过的主题包必须提供包 Artifact 与 manifest 哈希。",
          });
        }
      }
    }
    if (
      (value.status === "failed" || value.status === "blocked") &&
      value.errorCode === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["errorCode"],
        message: "失败或阻断的主题包必须提供稳定错误码。",
      });
    }
  });

export type CreatePatchTaskInput = z.infer<typeof createPatchTaskSchema>;
export type ReportPatchTaskSkillProductionInput = z.infer<
  typeof reportPatchTaskSkillProductionSchema
>;
export type ReportPatchTaskPackageInput = z.infer<
  typeof reportPatchTaskPackageSchema
>;
export type PatchTaskStatus =
  | "queued"
  | "running"
  | "passed"
  | "failed"
  | "blocked";

export type PatchTaskReportStatus =
  | "accepted"
  | "lease-mismatch"
  | "job-kind-mismatch"
  | "skill-production-not-found"
  | "skill-production-terminal"
  | "skill-production-evidence-mismatch"
  | "model-execution-evidence-mismatch"
  | "artifact-evidence-mismatch"
  | "package-not-found"
  | "package-terminal"
  | "package-capability-not-frozen";

export interface PatchTaskView {
  id: string;
  professionName: string;
  styleName: string;
  status: PatchTaskStatus;
  progress: number;
  createdAt: string;
  artifactName?: string;
  artifactAvailable: boolean;
}

/** 浏览器可查看的最终产物摘要；不暴露内部对象 key、下载授权或正文。 */
export interface PatchTaskArtifactView {
  artifactName: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
}

export interface PlannedPatchTaskSkill {
  professionId: string;
  styleId: string;
  skillId: string;
  sourceRunId: string;
  sourceFrameManifestArtifactId: string;
  promptSha256: string;
}

export interface PlannedPatchTaskPackage {
  id: string;
  professionId: string;
  styleId: string;
  runId: string;
}

export interface PatchTaskReportResult {
  status: PatchTaskReportStatus;
}
