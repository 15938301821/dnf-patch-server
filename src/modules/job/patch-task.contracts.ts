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

/** 浏览器详情页统一使用的阶段状态；unknown 表示历史证据不足，禁止前端自行猜测。 */
export type PatchTaskStepStatus =
  | "pending"
  | "running"
  | "passed"
  | "failed"
  | "blocked"
  | "unknown";

/** 任务详情固定的四个顶层工作流阶段。 */
export type PatchTaskWorkflowStageKey =
  | "planning"
  | "skill-production"
  | "package-validation"
  | "complete";

/** 顶层工作流的脱敏状态，不暴露 Job、lease 或 Worker 身份。 */
export interface PatchTaskWorkflowStageView {
  key: PatchTaskWorkflowStageKey;
  status: PatchTaskStepStatus;
}

/** 单技能固定生产链；模型阶段与本机工具阶段都只能由服务端证据映射。 */
export type PatchTaskSkillStageKey =
  | "engineer-plan"
  | "reference-image"
  | "aseprite-adaptation"
  | "runtime-validation";

/** 单技能一个固定阶段的浏览器 ViewModel。 */
export interface PatchTaskSkillStageView {
  key: PatchTaskSkillStageKey;
  status: PatchTaskStepStatus;
}

/** 任务详情中的单技能进度；参考图标记只说明可申请预览，不包含 Artifact ID 或 URL。 */
export interface PatchTaskSkillProgressView {
  skillId: string;
  displayName: string;
  status: PatchTaskStepStatus;
  stages: PatchTaskSkillStageView[];
  errorCode?: string;
  referenceImageAvailable: boolean;
}

/** 浏览器可见的固定模型角色；unknown 只用于数据库异常的保守展示。 */
export type PatchTaskModelRole =
  | "orchestrator"
  | "engineer"
  | "artist"
  | "unknown";

/** 模型调用的脱敏状态；unknown 防止未知数据库值被误显示为成功。 */
export type PatchTaskModelCallStatus =
  | "running"
  | "passed"
  | "failed"
  | "blocked"
  | "abandoned"
  | "unknown";

/** 最近一次模型调用趋势样本；nullable 计量表示 Provider 未提供可靠 usage。 */
export interface PatchTaskModelCallSampleView {
  id: string;
  role: PatchTaskModelRole;
  model: string;
  status: PatchTaskModelCallStatus;
  createdAt: string;
  finishedAt?: string;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  providerLatencyMs: number | null;
  outputTokensPerSecond: number | null;
}

/** 按角色和模型聚合的吞吐分组，用于详情页图例与对比。 */
export interface PatchTaskModelGroupView {
  role: PatchTaskModelRole;
  model: string;
  calls: number;
  measuredCalls: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  averageOutputTokensPerSecond: number | null;
  averageProviderLatencyMs: number | null;
}

/** 一次制作任务的模型吞吐摘要；计量覆盖率与成功率使用不同分母，不能混用。 */
export interface PatchTaskModelThroughputView {
  totalCalls: number;
  egressCalls: number;
  runningCalls: number;
  measuredCalls: number;
  successRate: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  averageOutputTokensPerSecond: number | null;
  averageProviderLatencyMs: number | null;
  groups: PatchTaskModelGroupView[];
  recentCalls: PatchTaskModelCallSampleView[];
}

/** 浏览器任务详情完整 ViewModel；不包含 Prompt、模型凭据、Worker 租约、对象 key 或短期 URL。 */
export interface PatchTaskDetailView extends PatchTaskView {
  updatedAt: string;
  finishedAt?: string;
  currentStage: PatchTaskWorkflowStageKey;
  totalSkills: number;
  passedSkills: number;
  workflow: PatchTaskWorkflowStageView[];
  skills: PatchTaskSkillProgressView[];
  packageStatus: "queued" | "building" | "passed" | "failed" | "blocked";
  modelThroughput: PatchTaskModelThroughputView;
}

/** Package V3 固定输出角色 schema；HTTP path 只能从三种受控角色中选择。 */
export const patchTaskArtifactRoleSchema = z.enum([
  "candidate",
  "manifest",
  "validation",
]);
/** 由固定角色 schema 推导的浏览器 Package Artifact 角色。 */
export type PatchTaskArtifactRole = z.infer<typeof patchTaskArtifactRoleSchema>;

/** 浏览器可查看的最终产物摘要；不暴露内部对象 key、下载授权或正文。 */
export interface PatchTaskArtifactView {
  artifactId: string;
  role: PatchTaskArtifactRole;
  artifactName: string;
  mediaType: string;
  byteLength: number;
  sha256: string;
}

/** 当前用户按固定角色取得的短期下载授权；URL 到期失效且不表示部署或兼容。 */
export interface PatchTaskArtifactDownloadView extends PatchTaskArtifactView {
  downloadUrl: string;
  expiresAtUtc: string;
}

/**
 * 当前任务技能的固定模型参考图元数据；由服务端从 reference-image-v1 证据解析，
 * 浏览器不能通过此结构选择任意 Artifact。
 */
export interface PatchTaskReferenceImageView {
  artifactId: string;
  skillId: string;
  artifactName: string;
  mediaType: "image/png";
  byteLength: number;
  sha256: string;
}

/** 固定技能参考图的短期读取授权；URL 到期失效且不得进入持久化状态。 */
export interface PatchTaskReferenceImageDownloadView extends PatchTaskReferenceImageView {
  downloadUrl: string;
  expiresAtUtc: string;
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
