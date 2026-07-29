/**
 * @fileoverview 解析浏览器任务中一个技能的固定参考图、源帧或 Aseprite 结果 PNG；不签发 URL、
 * 读取图片正文或允许调用方提交 Artifact ID，也不修改模型执行与技能生产状态。
 * @module modules/job/patch-task-reference-image-repository-support
 * @author AI生成
 * @created 2026-07-28
 * @relatedPlan /memories/session/plan.md - 制作任务详情与模型吞吐监控
 *
 * 调用关系：PatchTaskService 经 Repository 调用本查询，输入为 Controller 已校验的 Run/skill UUID
 * 与 Access Token 解析出的用户 ID；返回内部可用于 ArtifactService 二次归属检查的图片元数据。
 * 副作用仅为有界只读数据库查询。安全边界：浏览器认证不能替代 Run 所有权，旧 attempt、非固定
 * 角色、非 passed 执行、跨 Run Artifact、双侧 provenance 漂移或非 PNG 都返回 undefined。
 */
import { and, eq, inArray, sql } from "drizzle-orm";
import { artifactUploadSessions } from "../../common/db/artifact-schema.js";
import type { DatabaseService } from "../../common/db/database.service.js";
import { professionSkillModelExecutions } from "../../common/db/profession-model-execution-schema.js";
import { artifacts, imageAttempts, runs } from "../../common/db/schema.js";
import { styleSkillProductions } from "../../common/db/studio-schema.js";
import { sha256JcsV1 } from "../../common/utils/canonical.js";
import type {
  PatchTaskReferenceImageView,
  PatchTaskSkillPreviewRole,
  PatchTaskSkillPreviewView,
} from "./patch-task.contracts.js";
import { publicPatchTaskSkillPreviewFrame } from "./patch-task-preview-frame.js";
import {
  professionSkillOutputProvenanceSchema,
  type ProfessionSkillOutputProvenance,
} from "./profession-skill-output-evidence.js";
import { readableProfessionReferenceImageStages } from "./profession-model-execution.js";

const productionPreviewRoles = {
  "source-frame": {
    logicalName: "profession-source-frame-preview.png",
  },
  "aseprite-result": {
    logicalName: "profession-aseprite-result-preview.png",
  },
} as const;

type ProductionPreviewRole = keyof typeof productionPreviewRoles;
type ValidationProvenance = Extract<
  ProfessionSkillOutputProvenance,
  {
    kind: "profession-aseprite-validation-v1" | "profession-reference-validation-v2";
  }
>;
type SourcePreviewProvenance = Extract<
  ProfessionSkillOutputProvenance,
  {
    kind:
      | "profession-source-frame-preview-v1"
      | "profession-source-frame-preview-v2";
  }
>;
type ResultPreviewProvenance = Extract<
  ProfessionSkillOutputProvenance,
  {
    kind:
      | "profession-aseprite-result-preview-v1"
      | "profession-reference-result-preview-v2";
  }
>;

/** 按浏览器固定角色分派查询；角色已由 Controller schema 限定，不能退化为任意逻辑名。 */
export async function findPatchTaskSkillPreview(
  connection: DatabaseService,
  runId: string,
  skillId: string,
  role: PatchTaskSkillPreviewRole,
  ownerUserId: string,
): Promise<PatchTaskSkillPreviewView | undefined> {
  if (role === "reference-image") {
    const image = await findPatchTaskReferenceImage(
      connection,
      runId,
      skillId,
      ownerUserId,
    );
    return image ? { ...image, role } : undefined;
  }
  return findProductionPreview(connection, runId, skillId, role, ownerUserId);
}

/**
 * 查找当前用户任务中技能当前 attempt 的 passed 参考图。
 *
 * @param connection Job 模块数据库连接，本方法不启动事务或锁定历史证据。
 * @param runId 浏览器 path 中已验证的任务 UUID。
 * @param skillId 浏览器 path 中已验证的技能 UUID，不是 Artifact ID。
 * @param ownerUserId 从浏览器 Access Token 解析的稳定用户 ID。
 * @returns 所有权和证据链完整时返回 PNG 元数据，否则返回 undefined 且调用方不得签名 URL。
 */
export async function findPatchTaskReferenceImage(
  connection: DatabaseService,
  runId: string,
  skillId: string,
  ownerUserId: string,
): Promise<PatchTaskReferenceImageView | undefined> {
  const rows = await connection.database
    .select({
      artifactId: artifacts.id,
      skillId: styleSkillProductions.skillId,
      artifactName: artifacts.logicalName,
      mediaType: artifacts.mediaType,
      byteLength: artifacts.byteLength,
      sha256: artifacts.sha256,
    })
    .from(styleSkillProductions)
    .innerJoin(runs, eq(runs.id, styleSkillProductions.runId))
    .innerJoin(
      professionSkillModelExecutions,
      and(
        eq(professionSkillModelExecutions.runId, styleSkillProductions.runId),
        eq(
          professionSkillModelExecutions.skillId,
          styleSkillProductions.skillId,
        ),
        eq(professionSkillModelExecutions.jobId, styleSkillProductions.jobId),
        eq(
          professionSkillModelExecutions.attempt,
          styleSkillProductions.attempt,
        ),
      ),
    )
    .innerJoin(
      imageAttempts,
      and(
        eq(imageAttempts.runId, professionSkillModelExecutions.runId),
        eq(imageAttempts.id, professionSkillModelExecutions.imageAttemptId),
        eq(
          imageAttempts.modelCallId,
          professionSkillModelExecutions.modelCallId,
        ),
        eq(
          imageAttempts.outputArtifactId,
          professionSkillModelExecutions.outputArtifactId,
        ),
      ),
    )
    .innerJoin(
      artifacts,
      and(
        eq(artifacts.runId, professionSkillModelExecutions.runId),
        eq(artifacts.id, professionSkillModelExecutions.outputArtifactId),
        eq(artifacts.sha256, professionSkillModelExecutions.outputSha256),
        eq(
          artifacts.byteLength,
          professionSkillModelExecutions.outputByteLength,
        ),
      ),
    )
    .where(
      and(
        eq(styleSkillProductions.runId, runId),
        eq(styleSkillProductions.skillId, skillId),
        eq(runs.ownerUserId, ownerUserId),
        inArray(
          professionSkillModelExecutions.stage,
          readableProfessionReferenceImageStages,
        ),
        eq(professionSkillModelExecutions.status, "passed"),
        eq(artifacts.mediaType, "image/png"),
      ),
    )
    .limit(2);
  const image = rows.length === 1 ? rows[0] : undefined;
  return image?.mediaType === "image/png"
    ? { ...image, mediaType: "image/png" }
    : undefined;
}

/**
 * 解析当前 passed production 的同帧 PNG。
 * 第一步读取用户所有权、当前 attempt 与 validation 权威证据；第二步读取固定逻辑名的 finalized
 * 上传。结果角色会额外读取源图，以复核两图帧身份和反向绑定。任一行不唯一时失败关闭。
 */
async function findProductionPreview(
  connection: DatabaseService,
  runId: string,
  skillId: string,
  role: ProductionPreviewRole,
  ownerUserId: string,
): Promise<PatchTaskSkillPreviewView | undefined> {
  const contexts = await connection.database
    .select({
      jobId: styleSkillProductions.jobId,
      workerId: styleSkillProductions.workerId,
      leaseId: styleSkillProductions.leaseId,
      attempt: styleSkillProductions.attempt,
      validationArtifactId: styleSkillProductions.validationArtifactId,
      validationSha256: artifacts.sha256,
      validationProvenance: artifacts.provenance,
      validationUploadProvenance: artifactUploadSessions.provenance,
    })
    .from(styleSkillProductions)
    .innerJoin(runs, eq(runs.id, styleSkillProductions.runId))
    .innerJoin(
      artifacts,
      and(
        eq(artifacts.runId, styleSkillProductions.runId),
        eq(artifacts.id, styleSkillProductions.validationArtifactId),
      ),
    )
    .innerJoin(
      artifactUploadSessions,
      and(
        eq(artifactUploadSessions.id, styleSkillProductions.validationUploadId),
        eq(artifactUploadSessions.runId, styleSkillProductions.runId),
        eq(artifactUploadSessions.jobId, styleSkillProductions.jobId),
        eq(artifactUploadSessions.workerId, styleSkillProductions.workerId),
        eq(artifactUploadSessions.leaseId, styleSkillProductions.leaseId),
        eq(artifactUploadSessions.attempt, styleSkillProductions.attempt),
        eq(
          artifactUploadSessions.artifactId,
          styleSkillProductions.validationArtifactId,
        ),
      ),
    )
    .where(
      and(
        eq(styleSkillProductions.runId, runId),
        eq(styleSkillProductions.skillId, skillId),
        eq(styleSkillProductions.status, "passed"),
        eq(runs.ownerUserId, ownerUserId),
        eq(artifacts.mediaType, "application/zip"),
        eq(artifactUploadSessions.status, "finalized"),
        eq(artifactUploadSessions.mediaType, "application/zip"),
      ),
    )
    .limit(2);
  const context = contexts.length === 1 ? contexts[0] : undefined;
  const validation = parseValidationProvenance(context?.validationProvenance);
  const validationUpload = parseValidationProvenance(
    context?.validationUploadProvenance,
  );
  if (
    !context?.jobId ||
    !context.workerId ||
    !context.leaseId ||
    context.attempt === null ||
    !context.validationArtifactId ||
    !validation ||
    !validationUpload ||
    sha256JcsV1(validation) !== sha256JcsV1(validationUpload) ||
    validation.jobId !== context.jobId ||
    validation.attempt !== context.attempt ||
    validation.skillId !== skillId
  ) {
    return undefined;
  }
  const previewContext: ProductionPreviewContext = {
    jobId: context.jobId,
    workerId: context.workerId,
    leaseId: context.leaseId,
    attempt: context.attempt,
    validationArtifactId: context.validationArtifactId,
    validationSha256: context.validationSha256,
  };
  const source = await findFinalizedPreview(
    connection,
    runId,
    skillId,
    "source-frame",
    previewContext,
    validation,
  );
  if (!source) return undefined;
  if (role === "source-frame") return source.view;
  const result = await findFinalizedPreview(
    connection,
    runId,
    skillId,
    "aseprite-result",
    previewContext,
    validation,
    source,
  );
  return result?.view;
}

interface ProductionPreviewContext {
  jobId: string;
  workerId: string;
  leaseId: string;
  attempt: number;
  validationArtifactId: string;
  validationSha256: string;
}

interface ResolvedProductionPreview {
  view: PatchTaskSkillPreviewView;
  provenance: SourcePreviewProvenance | ResultPreviewProvenance;
}

/** 读取一个固定角色的唯一 finalized PNG，并复核会话与 Artifact 两份元数据及 provenance。 */
async function findFinalizedPreview(
  connection: DatabaseService,
  runId: string,
  skillId: string,
  role: ProductionPreviewRole,
  context: ProductionPreviewContext,
  validation: ValidationProvenance,
  source?: ResolvedProductionPreview,
): Promise<ResolvedProductionPreview | undefined> {
  const expected = productionPreviewRoles[role];
  const rows = await connection.database
    .select({
      artifactId: artifacts.id,
      artifactName: artifacts.logicalName,
      artifactMediaType: artifacts.mediaType,
      artifactByteLength: artifacts.byteLength,
      artifactSha256: artifacts.sha256,
      artifactProvenance: artifacts.provenance,
      sessionLogicalName: artifactUploadSessions.logicalName,
      sessionMediaType: artifactUploadSessions.mediaType,
      sessionByteLength: artifactUploadSessions.expectedByteLength,
      sessionSha256: artifactUploadSessions.expectedSha256,
      sessionProvenance: artifactUploadSessions.provenance,
    })
    .from(artifactUploadSessions)
    .innerJoin(
      artifacts,
      and(
        eq(artifacts.runId, artifactUploadSessions.runId),
        eq(artifacts.id, artifactUploadSessions.artifactId),
      ),
    )
    .where(
      and(
        eq(artifactUploadSessions.runId, runId),
        eq(artifactUploadSessions.jobId, context.jobId),
        eq(artifactUploadSessions.workerId, context.workerId),
        eq(artifactUploadSessions.leaseId, context.leaseId),
        eq(artifactUploadSessions.attempt, context.attempt),
        eq(artifactUploadSessions.status, "finalized"),
        eq(artifactUploadSessions.logicalName, expected.logicalName),
        eq(artifactUploadSessions.mediaType, "image/png"),
        sql`JSON_UNQUOTE(JSON_EXTRACT(
          ${artifactUploadSessions.provenance},
          '$.skillId'
        )) = ${skillId}`,
      ),
    )
    .limit(2);
  const row = rows.length === 1 ? rows[0] : undefined;
  const sessionProvenance = professionSkillOutputProvenanceSchema.safeParse(
    row?.sessionProvenance,
  );
  const artifactProvenance = professionSkillOutputProvenanceSchema.safeParse(
    row?.artifactProvenance,
  );
  if (
    !row ||
    row.sessionLogicalName !== expected.logicalName ||
    row.artifactName !== expected.logicalName ||
    row.sessionMediaType !== "image/png" ||
    row.artifactMediaType !== "image/png" ||
    row.sessionByteLength !== row.artifactByteLength ||
    row.sessionSha256.toUpperCase() !== row.artifactSha256.toUpperCase() ||
    !sessionProvenance.success ||
    !artifactProvenance.success ||
    sha256JcsV1(sessionProvenance.data) !==
      sha256JcsV1(artifactProvenance.data) ||
    !isMatchingPreviewProvenance(sessionProvenance.data, role, validation)
  ) {
    return undefined;
  }
  const provenance = sessionProvenance.data;
  if (
    provenance.jobId !== context.jobId ||
    provenance.attempt !== context.attempt ||
    provenance.skillId !== skillId ||
    provenance.asepriteValidation.artifactId !== context.validationArtifactId ||
    provenance.asepriteValidation.sha256.toUpperCase() !==
      context.validationSha256.toUpperCase() ||
    !sameBaseEvidence(provenance, validation)
  ) {
    return undefined;
  }
  if (isResultPreviewProvenance(provenance)) {
    if (
      !source ||
      !isSourcePreviewProvenance(source.provenance) ||
      !isMatchingPreviewProvenance(
        source.provenance,
        "source-frame",
        validation,
      ) ||
      provenance.sourcePreview.artifactId !== source.view.artifactId ||
      provenance.sourcePreview.sha256.toUpperCase() !==
        source.view.sha256.toUpperCase() ||
      sha256JcsV1(provenance.frame) !== sha256JcsV1(source.provenance.frame)
    ) {
      return undefined;
    }
  }
  return {
    view: {
      artifactId: row.artifactId,
      skillId,
      role,
      artifactName: row.artifactName,
      mediaType: "image/png",
      byteLength: row.artifactByteLength,
      sha256: row.artifactSha256,
      frame: publicPatchTaskSkillPreviewFrame(provenance.frame),
      ...(validation.kind === "profession-reference-validation-v2"
        ? {
            referenceTransferQuality:
              validation.referenceTransferQuality,
          }
        : {}),
    },
    provenance,
  };
}

function parseValidationProvenance(
  value: unknown,
): ValidationProvenance | undefined {
  const parsed = professionSkillOutputProvenanceSchema.safeParse(value);
  return parsed.success &&
    (parsed.data.kind === "profession-aseprite-validation-v1" ||
      parsed.data.kind === "profession-reference-validation-v2")
    ? parsed.data
    : undefined;
}

/** 要求 preview 与 validation 属于同一代契约，禁止历史 V1 与当前 V2 交叉拼接。 */
function isMatchingPreviewProvenance(
  provenance: ProfessionSkillOutputProvenance,
  role: ProductionPreviewRole,
  validation: ValidationProvenance,
): provenance is SourcePreviewProvenance | ResultPreviewProvenance {
  if (validation.kind === "profession-reference-validation-v2") {
    return role === "source-frame"
      ? provenance.kind === "profession-source-frame-preview-v2"
      : provenance.kind === "profession-reference-result-preview-v2";
  }
  return role === "source-frame"
    ? provenance.kind === "profession-source-frame-preview-v1"
    : provenance.kind === "profession-aseprite-result-preview-v1";
}

/** 识别两代源帧 preview；调用方仍需用 validation 进一步约束代际。 */
function isSourcePreviewProvenance(
  provenance: SourcePreviewProvenance | ResultPreviewProvenance,
): provenance is SourcePreviewProvenance {
  return (
    provenance.kind === "profession-source-frame-preview-v1" ||
    provenance.kind === "profession-source-frame-preview-v2"
  );
}

/** 识别两代结果 preview；调用方仍需复核同代源帧和完整帧身份。 */
function isResultPreviewProvenance(
  provenance: SourcePreviewProvenance | ResultPreviewProvenance,
): provenance is ResultPreviewProvenance {
  return (
    provenance.kind === "profession-aseprite-result-preview-v1" ||
    provenance.kind === "profession-reference-result-preview-v2"
  );
}

/** 比较 validation 与预览共享的完整来源/模型/工具/安全证据，排除各角色专属字段。 */
function sameBaseEvidence(
  preview: SourcePreviewProvenance | ResultPreviewProvenance,
  validation: ValidationProvenance,
): boolean {
  const previewBase = commonOutputEvidence(preview);
  const validationBase = commonOutputEvidence(validation);
  return sha256JcsV1(previewBase) === sha256JcsV1(validationBase);
}

/** 删除角色专属绑定但保留 V2 质量摘要，供同代 validation/preview 逐值比较。 */
function commonOutputEvidence(
  provenance:
    | ValidationProvenance
    | SourcePreviewProvenance
    | ResultPreviewProvenance,
): Record<string, unknown> {
  return {
    schemaVersion: provenance.schemaVersion,
    jobId: provenance.jobId,
    attempt: provenance.attempt,
    skillId: provenance.skillId,
    source: provenance.source,
    engineerPlan: provenance.engineerPlan,
    referenceImage: provenance.referenceImage,
    ...("referenceTransferQuality" in provenance
      ? { referenceTransferQuality: provenance.referenceTransferQuality }
      : {}),
    aseprite: provenance.aseprite,
    safety: provenance.safety,
  };
}

