/**
 * @fileoverview 解析 Profession Job 的全部单技能生产行并生成确定性完成摘要；不查询数据库、
 * 不更新 Job/Run，也不读取对象正文。
 * @module modules/job/profession-completion-evidence
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 当前 Profession Worker 纵向闭环直接需求
 *
 * 调用关系：进度查询 Repository 与 Job 完成事务共用本纯函数；上游提供已锁定 Job、生产行和
 * Artifact 摘要，下游得到冻结顺序的有限状态及仅在全部技能通过时存在的 resultSha256。
 * 输入输出：输入均为数据库映射后的有限字段；输出不暴露模型、Artifact 或 lease 明细给 Worker。
 * 副作用：仅进行运行时 schema 校验、集合比较和 JCS v1 SHA-256 计算。
 * 安全边界：payload、来源、Prompt、模型、Aseprite 和双 Artifact 任一漂移都必须整体失败；
 * resultSha256 必须按 payload 冻结技能顺序计算，不能依赖数据库默认排序或 Worker 自报摘要。
 */
import { z } from "zod";
import { sha256Json, sha256JcsV1 } from "../../common/utils/canonical.js";
import { styleSkillProductionJobPayloadV2Schema } from "./style-skill-production.contracts.js";

const sha256Schema = z.string().regex(/^[A-Fa-f0-9]{64}$/u);
const productionStatusSchema = z.enum([
  "planned",
  "generating",
  "adapting",
  "validating",
  "passed",
  "failed",
  "blocked",
]);

/** 完成解析器所需的最小 Job 快照；调用方必须先锁定该 Job。 */
export interface ProfessionCompletionJobState {
  id: string;
  runId: string;
  kind: string;
  payload: unknown;
  payloadSha256: string;
}

/** 单技能生产行中用于复核冻结上下文和终态证据的有限字段。 */
export interface ProfessionProductionEvidenceRow {
  runId: string;
  professionId: string;
  styleId: string;
  skillId: string;
  jobId: string | null;
  workerId: string | null;
  leaseId: string | null;
  attempt: number | null;
  sourceRunId: string;
  sourceFrameManifestArtifactId: string;
  promptSha256: string;
  modelCallId: string | null;
  imageAttemptId: string | null;
  asepriteProfileId: string | null;
  asepriteBinarySha256: string | null;
  asepriteAdapterSha256: string | null;
  asepriteArtifactId: string | null;
  validationArtifactId: string | null;
  status: string;
  errorCode: string | null;
}

/** 完成解析器只信任 finalized Artifact 表中的归属和内容摘要，不使用上传请求自报值。 */
export interface ProfessionCompletionArtifactRow {
  id: string;
  runId: string;
  sha256: string;
}

/** Worker 可见的有限技能状态；pending 包含 planned 与三个活动状态。 */
export type ProfessionProductionProgressStatus =
  | "pending"
  | "passed"
  | "failed"
  | "blocked";

/** 当前 Profession Job 的冻结顺序进度；全部 passed 时才携带服务端结果摘要。 */
export interface ProfessionProductionProgress {
  schemaVersion: 1;
  skills: Array<{
    skillId: string;
    status: ProfessionProductionProgressStatus;
  }>;
  resultSha256?: string;
}

/** 完成证据解析结果；integrity-failed 时调用方不得返回部分技能状态。 */
export type ResolveProfessionCompletionEvidenceResult =
  | { status: "job-integrity-failed" | "production-integrity-failed" }
  | { status: "accepted"; progress: ProfessionProductionProgress };

/**
 * 复核冻结 payload 与全部生产证据，并在全部技能通过时生成唯一摘要。
 * @param job 当前事务已锁定的 Profession Job 快照。
 * @param productions 同 Run 的全部单技能生产行，不依赖其数据库返回顺序。
 * @param artifactRows productions 引用的 projects/validation Artifact 摘要行。
 * @returns accepted 时为有限进度；任一结构或证据漂移时不返回部分结果。
 */
export function resolveProfessionCompletionEvidence(
  job: ProfessionCompletionJobState,
  productions: readonly ProfessionProductionEvidenceRow[],
  artifactRows: readonly ProfessionCompletionArtifactRow[],
): ResolveProfessionCompletionEvidenceResult {
  const payload = styleSkillProductionJobPayloadV2Schema.safeParse(job.payload);
  if (
    job.kind !== "profession" ||
    !payload.success ||
    sha256Json(payload.data) !== job.payloadSha256.toUpperCase()
  ) {
    return { status: "job-integrity-failed" };
  }
  const frozenSkills = payload.data.parameters.promptPackage.skills;
  const productionsBySkillId = new Map(
    productions.map((production) => [production.skillId, production]),
  );
  if (
    productions.length !== frozenSkills.length ||
    productionsBySkillId.size !== frozenSkills.length
  ) {
    return { status: "production-integrity-failed" };
  }
  const artifactsById = new Map(
    artifactRows.map((artifact) => [artifact.id, artifact]),
  );
  const usedArtifactIds = new Set<string>();
  const progress: ProfessionProductionProgress["skills"] = [];
  const passedEvidence: unknown[] = [];

  for (const frozen of frozenSkills) {
    const production = productionsBySkillId.get(frozen.skillId);
    if (
      !production ||
      !matchesFrozenSkill(job, payload.data, frozen, production)
    ) {
      return { status: "production-integrity-failed" };
    }
    const status = productionStatusSchema.safeParse(production.status);
    if (!status.success) return { status: "production-integrity-failed" };
    const publicStatus = progressStatus(status.data);
    progress.push({ skillId: frozen.skillId, status: publicStatus });
    if (publicStatus !== "passed") continue;

    const evidence = passedProductionEvidence(
      job,
      frozen,
      production,
      artifactsById,
      usedArtifactIds,
    );
    if (!evidence) return { status: "production-integrity-failed" };
    passedEvidence.push(evidence);
  }

  if (!progress.every((skill) => skill.status === "passed")) {
    return {
      status: "accepted",
      progress: { schemaVersion: 1, skills: progress },
    };
  }
  return {
    status: "accepted",
    progress: {
      schemaVersion: 1,
      skills: progress,
      resultSha256: sha256JcsV1({
        schemaVersion: 1,
        kind: "profession-skill-production-result-v1",
        jobId: job.id,
        runId: job.runId,
        jobPayloadSha256: job.payloadSha256.toUpperCase(),
        profileId: payload.data.profileId,
        professionId: payload.data.parameters.professionId,
        styleId: payload.data.parameters.styleId,
        skills: passedEvidence,
        safety: {
          deploymentAuthorized: false,
          deploymentPerformed: false,
          fullSkillCoverageProven: false,
          clientCompatibilityProven: false,
        },
      }),
    },
  };
}

function matchesFrozenSkill(
  job: ProfessionCompletionJobState,
  payload: z.infer<typeof styleSkillProductionJobPayloadV2Schema>,
  frozen: z.infer<
    typeof styleSkillProductionJobPayloadV2Schema
  >["parameters"]["promptPackage"]["skills"][number],
  production: ProfessionProductionEvidenceRow,
): boolean {
  return (
    production.runId === job.runId &&
    production.professionId === payload.parameters.professionId &&
    production.styleId === payload.parameters.styleId &&
    production.skillId === frozen.skillId &&
    production.sourceRunId === frozen.sourceEvidence.sourceRunId &&
    production.sourceFrameManifestArtifactId ===
      frozen.sourceEvidence.sourceFrameManifestArtifactId &&
    production.promptSha256.toUpperCase() === frozen.promptSha256.toUpperCase()
  );
}

function progressStatus(
  status: z.infer<typeof productionStatusSchema>,
): ProfessionProductionProgressStatus {
  if (status === "passed" || status === "failed" || status === "blocked") {
    return status;
  }
  return "pending";
}

function passedProductionEvidence(
  job: ProfessionCompletionJobState,
  frozen: z.infer<
    typeof styleSkillProductionJobPayloadV2Schema
  >["parameters"]["promptPackage"]["skills"][number],
  production: ProfessionProductionEvidenceRow,
  artifactsById: ReadonlyMap<string, ProfessionCompletionArtifactRow>,
  usedArtifactIds: Set<string>,
): Record<string, unknown> | undefined {
  if (
    production.jobId !== job.id ||
    !production.workerId ||
    !production.leaseId ||
    production.attempt === null ||
    production.attempt < 1 ||
    !production.modelCallId ||
    !production.imageAttemptId ||
    production.asepriteProfileId !== "aseprite-cli" ||
    !production.asepriteBinarySha256 ||
    !production.asepriteAdapterSha256 ||
    !production.asepriteArtifactId ||
    !production.validationArtifactId ||
    production.asepriteArtifactId === production.validationArtifactId ||
    production.errorCode !== null
  ) {
    return undefined;
  }
  const projects = artifactsById.get(production.asepriteArtifactId);
  const validation = artifactsById.get(production.validationArtifactId);
  if (
    !projects ||
    !validation ||
    projects.runId !== job.runId ||
    validation.runId !== job.runId ||
    !sha256Schema.safeParse(projects.sha256).success ||
    !sha256Schema.safeParse(validation.sha256).success ||
    usedArtifactIds.has(projects.id) ||
    usedArtifactIds.has(validation.id)
  ) {
    return undefined;
  }
  usedArtifactIds.add(projects.id);
  usedArtifactIds.add(validation.id);
  return {
    skillId: frozen.skillId,
    promptSha256: frozen.promptSha256.toUpperCase(),
    sourceRunId: frozen.sourceEvidence.sourceRunId,
    sourceFrameManifestArtifactId:
      frozen.sourceEvidence.sourceFrameManifestArtifactId,
    productionAttempt: production.attempt,
    modelCallId: production.modelCallId,
    imageAttemptId: production.imageAttemptId,
    aseprite: {
      profileId: "aseprite-cli",
      binarySha256: production.asepriteBinarySha256.toUpperCase(),
      adapterSha256: production.asepriteAdapterSha256.toUpperCase(),
    },
    projects: {
      artifactId: projects.id,
      sha256: projects.sha256.toUpperCase(),
    },
    validation: {
      artifactId: validation.id,
      sha256: validation.sha256.toUpperCase(),
    },
  };
}
