/**
 * @fileoverview 复核当前 Profession Job attempt 的模型链、冻结来源与双输出上传证据；
 * 不更新 production、不读取对象正文、不执行模型或 Aseprite，也不完成 Job/Run 终态。
 * @module modules/job/patch-task-skill-production-evidence-repository-support
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 当前 Profession 单技能真实生产链补全
 *
 * 调用关系：单技能接收事务在已锁定 Job 和 production 后调用；本文件按 Engineer -> Artist ->
 * source -> projects upload -> validation upload -> 双预览的固定顺序查询并加锁。输入是当前 lease 的 passed DTO
 * 与已恢复的冻结上下文，输出为有限证据结果。副作用仅为 transaction 内的数据库读取与行锁。
 * 安全边界：模型 ID 只能来自 Server 执行记录，Artifact 必须由同一 Job/Worker/lease/attempt 的
 * finalized 会话产生；两侧 provenance、对象元数据和固定安全 false 任一漂移都 fail-closed。
 */
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { clientIdSchema, sha256Schema } from "../../common/contracts/index.js";
import type { DatabaseService } from "../../common/db/database.service.js";
import { professionSkillModelExecutions } from "../../common/db/profession-model-execution-schema.js";
import { artifacts, npkInventories } from "../../common/db/schema.js";
import type { ReportPatchTaskSkillProductionInput } from "./patch-task.contracts.js";
import {
  currentProfessionSkillOutputProvenanceSchema,
  type CurrentProfessionSkillOutputProvenance,
} from "./profession-skill-output-evidence.js";
import type { FrozenProfessionSkillExecutionContext } from "./profession-execution-context.js";
import {
  classifyProfessionModelExecution,
  professionEngineerPlanStage,
  professionReferenceImageStage,
} from "./profession-model-execution.js";
import {
  lockedFinalizedOutputArtifact,
  resolveOutputProvenance,
  type FinalizedOutputArtifact,
} from "./patch-task-skill-production-artifact-evidence.repository-support.js";

const sourceManifestProvenanceSchema = z
  .object({
    schemaVersion: z.literal(1),
    kind: z.literal("source-frame-manifest"),
    sourceId: clientIdSchema,
    sourceSha256: sha256Schema,
    toolSha256: sha256Schema,
    jobPayloadSha256: sha256Schema,
    deploymentAuthorized: z.literal(false),
  })
  .strict();

type Transaction = Parameters<
  Parameters<DatabaseService["database"]["transaction"]>[0]
>[0];
type PassedReport = Extract<
  ReportPatchTaskSkillProductionInput,
  { status: "passed" }
>;
type ModelEvidence = Exclude<
  Awaited<ReturnType<typeof lockedPassedModelEvidence>>,
  undefined
>;
type CurrentProjectsProvenance = Extract<
  CurrentProfessionSkillOutputProvenance,
  { kind: "profession-creative-projects-v5" }
>;
type CurrentBaseProvenance = Omit<CurrentProjectsProvenance, "kind">;

/** V5/V6输出共同依赖的冻结官方来源摘要；由Server Inventory与manifest Artifact恢复。 */
export interface SourceEvidence {
  runId: string;
  inventoryId: string;
  sourceSha256: string;
  frameManifestArtifactId: string;
  frameManifestSha256: string;
  frameManifestToolSha256: string;
}

/** 当前 attempt 的 passed 证据结果；拒绝状态不暴露内部缺失行或跨 attempt 标识。 */
export type ResolvePassedProductionEvidenceResult =
  | {
      status:
        | "model-execution-evidence-mismatch"
        | "skill-production-evidence-mismatch"
        | "artifact-evidence-mismatch";
    }
  | {
      status: "accepted";
      modelCallId: string;
      imageAttemptId: string;
      projects: FinalizedOutputArtifact;
      validation: FinalizedOutputArtifact;
      sourcePreview: FinalizedOutputArtifact;
      resultPreview: FinalizedOutputArtifact;
    };

/**
 * 按固定顺序恢复并复核 passed 所需的全部 Server 事实。
 * @param transaction 已持有 Job 与 production row lock 的接收事务。
 * @param jobId 当前 Profession Job UUID，不接受 provenance 替代。
 * @param runId 从冻结 Job context 恢复的 producing Run UUID。
 * @param input 当前 Worker/lease/attempt 与双 Artifact 声明，已经过严格 DTO 校验。
 * @param context 已核对 payload SHA 和 skill 归属的冻结上下文。
 * @returns accepted 时给出可写入 production 的模型与双 upload 证据；其他状态禁止 passed 写入。
 */
export async function resolvePassedProductionEvidence(
  transaction: Transaction,
  jobId: string,
  runId: string,
  input: PassedReport,
  context: FrozenProfessionSkillExecutionContext,
): Promise<ResolvePassedProductionEvidenceResult> {
  const modelEvidence = await lockedPassedModelEvidence(
    transaction,
    jobId,
    input,
    context,
  );
  if (!modelEvidence) {
    return { status: "model-execution-evidence-mismatch" };
  }
  const sourceEvidence = await resolveSourceEvidence(transaction, context);
  if (!sourceEvidence) {
    return { status: "skill-production-evidence-mismatch" };
  }
  // 质量摘要不来自 Worker Report；先要求 projects 的 upload session 与 Artifact 双侧 JSON 完全一致，
  // 再把其中的受限摘要作为四角色共同期望值，防止各角色分别伪造一套指标。
  const projectsProvenance = await resolveOutputProvenance(
    transaction,
    input.asepriteArtifactId,
  );
  const currentProjects =
    currentProfessionSkillOutputProvenanceSchema.safeParse(projectsProvenance);
  if (
    !currentProjects.success ||
    currentProjects.data.kind !== "profession-creative-projects-v5"
  ) {
    return { status: "artifact-evidence-mismatch" };
  }
  const baseProvenance = createBaseProvenance(
    jobId,
    input,
    sourceEvidence,
    modelEvidence,
    currentProjects.data.referenceTransferQuality,
  );
  const projects = await lockedFinalizedOutputArtifact(
    transaction,
    jobId,
    runId,
    input,
    input.asepriteArtifactId,
    {
      ...baseProvenance,
      kind: "profession-creative-projects-v5",
    },
  );
  if (!projects) return { status: "artifact-evidence-mismatch" };
  const validation = await lockedFinalizedOutputArtifact(
    transaction,
    jobId,
    runId,
    input,
    input.validationArtifactId,
    {
      ...baseProvenance,
      kind: "profession-creative-validation-v5",
      asepriteProjects: {
        artifactId: projects.artifactId,
        sha256: projects.sha256,
      },
    },
  );
  if (!validation) return { status: "artifact-evidence-mismatch" };
  const sourceProvenance = await resolveOutputProvenance(
    transaction,
    input.sourcePreviewArtifactId,
  );
  const currentSource =
    currentProfessionSkillOutputProvenanceSchema.safeParse(sourceProvenance);
  if (
    !currentSource.success ||
    currentSource.data.kind !== "profession-creative-source-frame-preview-v5"
  ) {
    return { status: "artifact-evidence-mismatch" };
  }
  const sourcePreview = await lockedFinalizedOutputArtifact(
    transaction,
    jobId,
    runId,
    input,
    input.sourcePreviewArtifactId,
    {
      ...baseProvenance,
      kind: "profession-creative-source-frame-preview-v5",
      frame: currentSource.data.frame,
      asepriteValidation: {
        artifactId: validation.artifactId,
        sha256: validation.sha256,
      },
    },
    "image/png",
  );
  if (!sourcePreview) return { status: "artifact-evidence-mismatch" };
  const resultPreview = await lockedFinalizedOutputArtifact(
    transaction,
    jobId,
    runId,
    input,
    input.resultPreviewArtifactId,
    {
      ...baseProvenance,
      kind: "profession-creative-result-preview-v5",
      frame: currentSource.data.frame,
      asepriteValidation: {
        artifactId: validation.artifactId,
        sha256: validation.sha256,
      },
      sourcePreview: {
        artifactId: sourcePreview.artifactId,
        sha256: sourcePreview.sha256,
      },
    },
    "image/png",
  );
  if (!resultPreview) return { status: "artifact-evidence-mismatch" };
  return {
    status: "accepted",
    modelCallId: modelEvidence.referenceImage.modelCallId,
    imageAttemptId: modelEvidence.referenceImage.imageAttemptId,
    projects,
    validation,
    sourcePreview,
    resultPreview,
  };
}

/** 锁定并分类当前 attempt 的固定两阶段执行；任一行缺失、非 passed 或身份漂移都整体拒绝。 */
async function lockedPassedModelEvidence(
  transaction: Transaction,
  jobId: string,
  input: PassedReport,
  context: FrozenProfessionSkillExecutionContext,
): Promise<
  | {
      engineerPlan: Extract<
        ReturnType<typeof classifyProfessionModelExecution>,
        { status: "passed"; stage: typeof professionEngineerPlanStage }
      >;
      referenceImage: Extract<
        ReturnType<typeof classifyProfessionModelExecution>,
        { status: "passed"; stage: typeof professionReferenceImageStage }
      >;
    }
  | undefined
> {
  const engineer = await lockedExecution(
    transaction,
    jobId,
    input,
    professionEngineerPlanStage,
  );
  const artist = await lockedExecution(
    transaction,
    jobId,
    input,
    professionReferenceImageStage,
  );
  if (!engineer || !artist) return undefined;
  const identity = {
    runId: context.runId,
    jobId,
    workerId: input.workerId,
    leaseId: input.leaseId,
    attempt: input.attempt,
    skillId: input.skillId,
    promptSha256: context.skill.promptSha256,
  };
  const engineerPlan = classifyProfessionModelExecution(engineer, {
    ...identity,
    stage: professionEngineerPlanStage,
    sourceVisualArtifactId: engineer.sourceVisualArtifactId ?? "",
    sourceVisualSha256: engineer.sourceVisualSha256 ?? "",
    sourceVisualFrameMapSha256: engineer.sourceVisualFrameMapSha256 ?? "",
  });
  const referenceImage = classifyProfessionModelExecution(artist, {
    ...identity,
    stage: professionReferenceImageStage,
    sourceVisualArtifactId: artist.sourceVisualArtifactId ?? "",
    sourceVisualSha256: artist.sourceVisualSha256 ?? "",
    sourceVisualFrameMapSha256: artist.sourceVisualFrameMapSha256 ?? "",
  });
  return engineerPlan.status === "passed" &&
    engineerPlan.stage === professionEngineerPlanStage &&
    referenceImage.status === "passed" &&
    referenceImage.stage === professionReferenceImageStage
    ? { engineerPlan, referenceImage }
    : undefined;
}

/** 按唯一 attempt/skill/stage 锁定一条模型执行，保持 Engineer 在 Artist 之前的固定锁顺序。 */
async function lockedExecution(
  transaction: Transaction,
  jobId: string,
  input: PassedReport,
  stage:
    | typeof professionEngineerPlanStage
    | typeof professionReferenceImageStage,
): Promise<typeof professionSkillModelExecutions.$inferSelect | undefined> {
  const [execution] = await transaction
    .select()
    .from(professionSkillModelExecutions)
    .where(
      and(
        eq(professionSkillModelExecutions.jobId, jobId),
        eq(professionSkillModelExecutions.attempt, input.attempt),
        eq(professionSkillModelExecutions.skillId, input.skillId),
        eq(professionSkillModelExecutions.stage, stage),
      ),
    )
    .limit(1)
    .for("update");
  return execution;
}

/** 从冻结 Inventory 与清单 Artifact 恢复 Worker 已见的来源摘要，不信任 output provenance 自报。 */
export async function resolveSourceEvidence(
  transaction: Transaction,
  context: FrozenProfessionSkillExecutionContext,
): Promise<SourceEvidence | undefined> {
  const expected = context.skill.sourceEvidence;
  const [source] = await transaction
    .select({
      runId: npkInventories.runId,
      inventoryId: npkInventories.id,
      sourceId: npkInventories.sourceId,
      sourceSha256: npkInventories.sourceSha256,
      manifestArtifactId: artifacts.id,
      manifestLogicalName: artifacts.logicalName,
      manifestMediaType: artifacts.mediaType,
      manifestSha256: artifacts.sha256,
      manifestProvenance: artifacts.provenance,
    })
    .from(npkInventories)
    .innerJoin(
      artifacts,
      and(
        eq(artifacts.runId, npkInventories.runId),
        eq(artifacts.id, npkInventories.sourceFrameManifestArtifactId),
      ),
    )
    .where(
      and(
        eq(npkInventories.id, expected.sourceInventoryId),
        eq(npkInventories.runId, expected.sourceRunId),
        eq(npkInventories.status, "frozen"),
        eq(
          npkInventories.sourceFrameManifestArtifactId,
          expected.sourceFrameManifestArtifactId,
        ),
      ),
    )
    .limit(1);
  const provenance = sourceManifestProvenanceSchema.safeParse(
    source?.manifestProvenance,
  );
  if (
    !source ||
    !source.sourceId ||
    !provenance.success ||
    source.manifestArtifactId !== expected.sourceFrameManifestArtifactId ||
    source.manifestLogicalName !== "source-frame-manifest.json" ||
    source.manifestMediaType !== "application/json" ||
    provenance.data.sourceId !== source.sourceId ||
    provenance.data.sourceSha256.toUpperCase() !==
      source.sourceSha256.toUpperCase()
  ) {
    return undefined;
  }
  return {
    runId: source.runId,
    inventoryId: source.inventoryId,
    sourceSha256: source.sourceSha256.toUpperCase(),
    frameManifestArtifactId: source.manifestArtifactId,
    frameManifestSha256: source.manifestSha256.toUpperCase(),
    frameManifestToolSha256: provenance.data.toolSha256.toUpperCase(),
  };
}

/** 构造四个当前 V5 输出共享且可由 Server 独立复核的 provenance，不含 leaseId、路径或对象正文。 */
function createBaseProvenance(
  jobId: string,
  input: PassedReport,
  source: SourceEvidence,
  model: ModelEvidence,
  referenceTransferQuality: CurrentProjectsProvenance["referenceTransferQuality"],
): CurrentBaseProvenance {
  return {
    schemaVersion: 5,
    jobId,
    attempt: input.attempt,
    skillId: input.skillId,
    source,
    engineerPlan: {
      artifactId: model.engineerPlan.outputArtifactId,
      sha256: model.engineerPlan.outputSha256,
    },
    referenceImage: {
      imageAttemptId: model.referenceImage.imageAttemptId,
      artifactId: model.referenceImage.outputArtifactId,
      sha256: model.referenceImage.outputSha256,
    },
    referenceTransferQuality,
    aseprite: {
      profileId: "aseprite-cli",
      binarySha256: input.asepriteBinarySha256.toUpperCase(),
      adapterSha256: input.asepriteAdapterSha256.toUpperCase(),
    },
    safety: {
      referenceImageUsedAsRuntimeRgbSource: false,
      referenceImageUsedAsStyleAndComposition: true,
      creativeVisibleRgbReconstruction: true,
      referenceImageDirectPixelReplacement: false,
      referenceTransferQualityPassed: true,
      sourceGeometryPreserved: true,
      sourceAlphaPreserved: true,
      deploymentAuthorized: false,
      deploymentPerformed: false,
      fullSkillCoverageProven: false,
      clientCompatibilityProven: false,
    },
  };
}
