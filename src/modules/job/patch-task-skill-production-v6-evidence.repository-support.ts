/**
 * @fileoverview 在Profession V6 passed事务中复核target manifest、全部逐帧模型结果与四个输出Artifact；
 * 不读取对象正文、不执行模型/Aseprite，也不写production终态。
 * @module modules/job/patch-task-skill-production-v6-evidence-repository-support
 * @author AI生成
 * @created 2026-08-01
 * @relatedPlan N/A - 用户直接要求实现Profession V6
 *
 * 调用关系：单技能接收事务已锁定Job和production后调用；下游复用冻结来源解析、target-set纯函数
 * 和finalized Artifact锁定器。输入是严格V6 DTO与冻结Job上下文，输出是可写入production的有限证据。
 * 副作用：只在调用方transaction内查询并锁定frame target及输出上传会话，不访问对象存储。
 * 安全边界：固定锁序为全部frame target（frameOrdinal升序）-> 四输出；只接受当前Job/lease/attempt
 * 的完整集合。跨attempt拼接、未passed帧、算法漂移、manifest漂移或身份复用均fail-closed。
 */
import { and, asc, eq } from "drizzle-orm";
import type { DatabaseService } from "../../common/db/database.service.js";
import { professionSkillFrameTargets } from "../../common/db/profession-frame-target-schema.js";
import { artifacts } from "../../common/db/schema.js";
import type { ReportPatchTaskSkillProductionInput } from "./patch-task.contracts.js";
import type { FrozenProfessionSkillExecutionContext } from "./profession-execution-context.js";
import {
  currentProfessionSkillOutputProvenanceSchema,
  type CurrentProfessionSkillOutputProvenance,
} from "./profession-skill-output-evidence.js";
import {
  lockedFinalizedOutputArtifact,
  resolveOutputProvenance,
  type FinalizedOutputArtifact,
} from "./patch-task-skill-production-artifact-evidence.repository-support.js";
import {
  resolveSourceEvidence,
  type SourceEvidence,
} from "./patch-task-skill-production-evidence.repository-support.js";
import { createProfessionV6TargetSetSha256 } from "./profession-v6-target-set.js";

type Transaction = Parameters<
  Parameters<DatabaseService["database"]["transaction"]>[0]
>[0];
type V6PassedReport = Extract<
  ReportPatchTaskSkillProductionInput,
  { status: "passed"; productionContractVersion: 6 }
>;
type V6Provenance = Extract<
  CurrentProfessionSkillOutputProvenance,
  { schemaVersion: 6 }
>;
type V6BaseProvenance = Omit<
  Extract<V6Provenance, { kind: "profession-target-projects-v6" }>,
  "kind"
>;
type FrameRow = typeof professionSkillFrameTargets.$inferSelect;

/** V6 passed可持久化的manifest与双ZIP上传绑定；预览只用于终态交叉复核，不重复存列。 */
export type ResolvePassedProductionV6EvidenceResult =
  | {
      status:
        | "skill-production-evidence-mismatch"
        | "artifact-evidence-mismatch";
    }
  | {
      status: "accepted";
      manifestArtifactId: string;
      manifestSha256: string;
      targetSetSha256: string;
      targetFrameCount: number;
      projects: FinalizedOutputArtifact;
      validation: FinalizedOutputArtifact;
    };

/**
 * 从Server事实独立恢复V6终态证据。
 * @returns accepted仅证明当前attempt逐帧集合和四Artifact provenance一致，不证明NPK兼容或部署。
 */
export async function resolvePassedProductionV6Evidence(
  transaction: Transaction,
  jobId: string,
  runId: string,
  input: V6PassedReport,
  context: FrozenProfessionSkillExecutionContext,
): Promise<ResolvePassedProductionV6EvidenceResult> {
  const source = await resolveSourceEvidence(transaction, context);
  if (!source) return { status: "skill-production-evidence-mismatch" };

  // frameOrdinal是官方manifest顺序；一次锁定完整集合，防止复算期间有帧被并发改写。
  const rows = await transaction
    .select()
    .from(professionSkillFrameTargets)
    .where(
      and(
        eq(professionSkillFrameTargets.jobId, jobId),
        eq(professionSkillFrameTargets.attempt, input.attempt),
        eq(professionSkillFrameTargets.skillId, input.skillId),
      ),
    )
    .orderBy(asc(professionSkillFrameTargets.frameOrdinal))
    .for("update");
  const targetSet = resolveTargetSet(rows, jobId, runId, input, context);
  if (!targetSet) return { status: "skill-production-evidence-mismatch" };

  const [manifest] = await transaction
    .select({
      id: artifacts.id,
      runId: artifacts.runId,
      mediaType: artifacts.mediaType,
      byteLength: artifacts.byteLength,
      sha256: artifacts.sha256,
    })
    .from(artifacts)
    .where(
      and(
        eq(artifacts.runId, runId),
        eq(artifacts.id, input.targetFrameManifestArtifactId),
      ),
    )
    .limit(1);
  if (
    !manifest ||
    manifest.mediaType !== "application/json" ||
    manifest.byteLength <= 0 ||
    manifest.byteLength > 16 * 1024 * 1024 ||
    manifest.sha256.toUpperCase() !==
      input.targetFrameManifestSha256.toUpperCase()
  ) {
    return { status: "artifact-evidence-mismatch" };
  }

  const base = createBaseProvenance(
    jobId,
    input,
    source,
    manifest.byteLength,
    targetSet.sha256,
  );
  const projects = await lockedFinalizedOutputArtifact(
    transaction,
    jobId,
    runId,
    input,
    input.asepriteArtifactId,
    { ...base, kind: "profession-target-projects-v6" },
  );
  if (!projects) return { status: "artifact-evidence-mismatch" };
  const validation = await lockedFinalizedOutputArtifact(
    transaction,
    jobId,
    runId,
    input,
    input.validationArtifactId,
    {
      ...base,
      kind: "profession-target-validation-v6",
      asepriteProjects: boundArtifact(projects),
    },
  );
  if (!validation) return { status: "artifact-evidence-mismatch" };

  const sourcePreview = await resolveV6Preview(
    transaction,
    input.sourcePreviewArtifactId,
    "profession-target-source-frame-preview-v6",
  );
  if (
    !sourcePreview ||
    !matchesTargetFrame(sourcePreview, targetSet.generated)
  ) {
    return { status: "artifact-evidence-mismatch" };
  }
  const lockedSourcePreview = await lockedFinalizedOutputArtifact(
    transaction,
    jobId,
    runId,
    input,
    input.sourcePreviewArtifactId,
    {
      ...base,
      kind: "profession-target-source-frame-preview-v6",
      frame: sourcePreview.frame,
      targetFrame: sourcePreview.targetFrame,
      asepriteValidation: boundArtifact(validation),
    },
    "image/png",
  );
  if (!lockedSourcePreview) return { status: "artifact-evidence-mismatch" };

  const resultPreview = await resolveV6Preview(
    transaction,
    input.resultPreviewArtifactId,
    "profession-target-result-preview-v6",
  );
  if (
    !resultPreview ||
    !samePreviewFrame(sourcePreview, resultPreview) ||
    !matchesTargetFrame(resultPreview, targetSet.generated)
  ) {
    return { status: "artifact-evidence-mismatch" };
  }
  const lockedResultPreview = await lockedFinalizedOutputArtifact(
    transaction,
    jobId,
    runId,
    input,
    input.resultPreviewArtifactId,
    {
      ...base,
      kind: "profession-target-result-preview-v6",
      frame: resultPreview.frame,
      targetFrame: resultPreview.targetFrame,
      asepriteValidation: boundArtifact(validation),
      sourcePreview: boundArtifact(lockedSourcePreview),
    },
    "image/png",
  );
  if (!lockedResultPreview) return { status: "artifact-evidence-mismatch" };
  return {
    status: "accepted",
    manifestArtifactId: manifest.id,
    manifestSha256: manifest.sha256.toUpperCase(),
    targetSetSha256: targetSet.sha256,
    targetFrameCount: targetSet.generated.length,
    projects,
    validation,
  };
}

function resolveTargetSet(
  rows: readonly FrameRow[],
  jobId: string,
  runId: string,
  input: V6PassedReport,
  context: FrozenProfessionSkillExecutionContext,
): { sha256: string; generated: FrameRow[] } | undefined {
  if (rows.length === 0) return undefined;
  const generated: FrameRow[] = [];
  const frameEvidence: Array<{
    entryIndex: number;
    frameIndex: number;
    width: number;
    height: number;
    artifactId: string;
    modelCallId: string;
    imageAttemptId: string;
    byteLength: number;
    sha256: string;
    sourceAlphaSha256: string;
  }> = [];
  for (const [ordinal, row] of rows.entries()) {
    if (
      row.frameOrdinal !== ordinal ||
      row.runId !== runId ||
      row.jobId !== jobId ||
      row.workerId !== input.workerId ||
      row.leaseId !== input.leaseId ||
      row.attempt !== input.attempt ||
      row.skillId !== input.skillId ||
      row.manifestArtifactId !== input.targetFrameManifestArtifactId ||
      row.manifestSha256.toUpperCase() !==
        input.targetFrameManifestSha256.toUpperCase() ||
      row.sourceRunId !== context.skill.sourceEvidence.sourceRunId ||
      row.sourceFrameManifestArtifactId !==
        context.skill.sourceEvidence.sourceFrameManifestArtifactId
    ) {
      return undefined;
    }
    if (row.targetPolicy !== "generate-same-size") continue;
    if (
      row.generationStatus !== "passed" ||
      row.generationOrdinal !== generated.length ||
      !row.generationModelCallId ||
      !row.generationImageAttemptId ||
      !row.targetPngArtifactId ||
      !row.targetPngSha256 ||
      !row.targetPngByteLength ||
      !row.sourceAlphaSha256 ||
      row.targetNormalizationAlgorithm !==
        "centered-exact-aspect-lanczos3-source-alpha-v1"
    ) {
      return undefined;
    }
    generated.push(row);
    frameEvidence.push({
      entryIndex: row.entryIndex,
      frameIndex: row.frameIndex,
      width: row.width,
      height: row.height,
      artifactId: row.targetPngArtifactId,
      modelCallId: row.generationModelCallId,
      imageAttemptId: row.generationImageAttemptId,
      byteLength: row.targetPngByteLength,
      sha256: row.targetPngSha256.toUpperCase(),
      sourceAlphaSha256: row.sourceAlphaSha256.toUpperCase(),
    });
  }
  if (generated.length !== input.targetFrameCount) return undefined;
  try {
    const sha256 = createProfessionV6TargetSetSha256(
      input.skillId,
      frameEvidence,
    );
    return sha256 === input.targetSetSha256.toUpperCase()
      ? { sha256, generated }
      : undefined;
  } catch {
    return undefined;
  }
}

function createBaseProvenance(
  jobId: string,
  input: V6PassedReport,
  source: SourceEvidence,
  manifestByteLength: number,
  targetSetSha256: string,
): V6BaseProvenance {
  return {
    schemaVersion: 6,
    jobId,
    attempt: input.attempt,
    skillId: input.skillId,
    source,
    targetFrameManifest: {
      artifactId: input.targetFrameManifestArtifactId,
      mediaType: "application/json",
      byteLength: manifestByteLength,
      sha256: input.targetFrameManifestSha256.toUpperCase(),
    },
    targetSet: {
      schemaVersion: 1,
      sha256: targetSetSha256,
      targetFrameCount: input.targetFrameCount,
    },
    aseprite: {
      profileId: "aseprite-cli-v6",
      binarySha256: input.asepriteBinarySha256.toUpperCase(),
      adapterSha256: input.asepriteAdapterSha256.toUpperCase(),
    },
    safety: {
      targetFramesUsedAsRuntimeRgbSource: true,
      sourceAlphaUsedAsRuntimeAlpha: true,
      hiddenSourcePixelsPreserved: true,
      linkFramesPreserved: true,
      dxt1LowLightSourceRgbPreserved: true,
      transparentRgbCleared: true,
      sourceGeometryPreserved: true,
      sourceAlphaPreserved: true,
      deploymentAuthorized: false,
      deploymentPerformed: false,
      fullSkillCoverageProven: false,
      clientCompatibilityProven: false,
    },
  };
}

async function resolveV6Preview<Kind extends V6Provenance["kind"]>(
  transaction: Transaction,
  artifactId: string,
  kind: Kind,
): Promise<Extract<V6Provenance, { kind: Kind }> | undefined> {
  const provenance = await resolveOutputProvenance(transaction, artifactId);
  const parsed =
    currentProfessionSkillOutputProvenanceSchema.safeParse(provenance);
  return parsed.success && parsed.data.kind === kind
    ? (parsed.data as Extract<V6Provenance, { kind: Kind }>)
    : undefined;
}

function matchesTargetFrame(
  preview: Extract<V6Provenance, { targetFrame: unknown }>,
  generated: readonly FrameRow[],
): boolean {
  return generated.some(
    (row) =>
      row.entryIndex === preview.frame.entryIndex &&
      row.frameIndex === preview.frame.frameIndex &&
      row.targetPngArtifactId === preview.targetFrame.artifactId &&
      row.generationModelCallId === preview.targetFrame.modelCallId &&
      row.generationImageAttemptId === preview.targetFrame.imageAttemptId &&
      row.targetPngByteLength === preview.targetFrame.byteLength &&
      row.targetPngSha256?.toUpperCase() === preview.targetFrame.sha256 &&
      row.sourceAlphaSha256?.toUpperCase() ===
        preview.targetFrame.sourceAlphaSha256 &&
      row.targetNormalizationAlgorithm ===
        preview.targetFrame.normalizationAlgorithm,
  );
}

function samePreviewFrame(
  source: Extract<V6Provenance, { targetFrame: unknown }>,
  result: Extract<V6Provenance, { targetFrame: unknown }>,
): boolean {
  return (
    JSON.stringify(source.frame) === JSON.stringify(result.frame) &&
    JSON.stringify(source.targetFrame) === JSON.stringify(result.targetFrame)
  );
}

function boundArtifact(artifact: FinalizedOutputArtifact): {
  artifactId: string;
  sha256: string;
} {
  return { artifactId: artifact.artifactId, sha256: artifact.sha256 };
}
