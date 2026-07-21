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
  leaseId: z.uuid().optional(),
};

export const reportPatchTaskSkillProductionSchema = z
  .object({
    ...workerLeaseSchema,
    skillId: z.uuid(),
    status: z.enum([
      "generating",
      "adapting",
      "validating",
      "passed",
      "failed",
      "blocked",
    ]),
    modelCallId: z.uuid().optional(),
    imageAttemptId: z.uuid().optional(),
    asepriteProfileId: z.string().trim().min(1).max(128).optional(),
    asepriteBinarySha256: sha256Schema.optional(),
    asepriteArtifactId: z.uuid().optional(),
    validationArtifactId: z.uuid().optional(),
    errorCode: z.string().trim().min(1).max(80).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "passed") {
      for (const key of [
        "modelCallId",
        "imageAttemptId",
        "asepriteProfileId",
        "asepriteBinarySha256",
        "asepriteArtifactId",
        "validationArtifactId",
      ] as const) {
        if (value[key] === undefined) {
          context.addIssue({
            code: "custom",
            path: [key],
            message:
              "通过的技能生产记录必须提供完整模型、图片、Aseprite 和验证证据。",
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
        message: "失败或阻断的技能生产记录必须提供稳定错误码。",
      });
    }
  });

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
  | "protocol-upgrade-required"
  | "lease-mismatch"
  | "job-kind-mismatch"
  | "skill-production-not-found"
  | "skill-production-terminal"
  | "package-not-found"
  | "package-terminal"
  | "package-skills-incomplete"
  | "model-call-not-found"
  | "model-call-run-mismatch"
  | "model-call-not-passed"
  | "image-attempt-not-found"
  | "image-attempt-run-mismatch"
  | "image-attempt-not-ready"
  | "artifact-not-found"
  | "artifact-run-mismatch";

export interface PatchTaskView {
  id: string;
  professionName: string;
  styleName: string;
  status: PatchTaskStatus;
  progress: number;
  createdAt: string;
  artifactName?: string;
  downloadUrl?: string;
}

export interface PatchTaskArtifactView {
  artifactName: string;
  storageKey: string;
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
  sourceMetadataSha256: string;
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
