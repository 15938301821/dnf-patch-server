/**
 * @fileoverview 在已锁定的 npk-package Job transaction 中复算 Package V3 context；不创建 HTTP
 * 响应、不写入 package 状态、不签发对象 URL，也不执行封包工具。
 * @module modules/job/style-package-context-repository-support
 * @author AI生成
 * @created 2026-07-25
 * @relatedPlan N/A - Package V3 报告接收与 attempt 证据持久化
 *
 * 调用关系：StylePackageContextRepository 与 StylePackageProductionRepository 都先锁定 Job 并取得
 * 数据库时间，再调用本函数。输入输出：输入是当前 Job、精确 lease 和同一 transaction，输出为规范
 * context 信封或有限拒绝状态。副作用：只读查询会锁定 style_packages 行以避免报告/完成同时改变聚合。
 * 安全边界：不得信任先前 HTTP context、Artifact ID 或同 Run 外键；每次都从生产记录、Artifact 与
 * finalized upload session 三侧重新复核，并只接受当前 lease/attempt 的 package context。
 */
import { and, eq, inArray } from "drizzle-orm";
import { hasExactJobLease } from "../../common/contracts/index.js";
import { artifactUploadSessions } from "../../common/db/artifact-schema.js";
import { artifacts, type jobs } from "../../common/db/schema.js";
import { stylePackages } from "../../common/db/style-package-schema.js";
import { styleSkillProductions } from "../../common/db/studio-schema.js";
import { sha256Json } from "../../common/utils/canonical.js";
import type { JobTransaction } from "./job-run-event.repository-support.js";
import { resolveStylePackageSkillInputs } from "./style-package-context-evidence.js";
import {
  createStylePackageContextEnvelopeV3,
  stylePackageProductionJobPayloadV3Schema,
  type RequestStylePackageContextV3,
  type StylePackageContextEnvelopeV3,
} from "./style-package-production.contracts.js";

/** 不暴露具体缺失行、对象 key 或 provenance 差异的 context 聚合结果。 */
export type ResolveStylePackageContextResult =
  | {
      status:
        | "lease-mismatch"
        | "job-kind-mismatch"
        | "job-integrity-failed"
        | "package-not-found"
        | "package-evidence-incomplete";
    }
  | { status: "accepted"; envelope: StylePackageContextEnvelopeV3 };

/**
 * 在当前 transaction 内重新生成 package attempt 的冻结 context。
 *
 * @param transaction 调用方拥有的 transaction；Job 行必须已按固定锁顺序先锁定。
 * @param job 已锁定的 Job 数据库行；不会从外部重新选择另一个 Job。
 * @param input Worker 当前 claim 的 workerId、leaseId 和 attempt。
 * @param now 同一 transaction 从数据库取得的权威时间，避免 Nest/Worker 时钟参与 lease 判断。
 * @returns 完整规范信封或有限拒绝状态；accepted 不代表封包、验证、兼容或部署已发生。
 */
export async function resolveStylePackageContextInTransaction(
  transaction: JobTransaction,
  job: typeof jobs.$inferSelect,
  input: RequestStylePackageContextV3,
  now: Date,
): Promise<ResolveStylePackageContextResult> {
  if (!hasExactJobLease(job, input, now)) {
    return { status: "lease-mismatch" };
  }
  if (job.kind !== "npk-package") {
    return { status: "job-kind-mismatch" };
  }
  const payload = stylePackageProductionJobPayloadV3Schema.safeParse(
    job.payload,
  );
  if (
    !payload.success ||
    sha256Json(payload.data) !== job.payloadSha256.toUpperCase()
  ) {
    return { status: "job-integrity-failed" };
  }

  // 第一步：锁定 package 聚合，避免本报告/完成与其他 Job 的终态收口交错覆盖。
  const [pack] = await transaction
    .select({
      professionId: stylePackages.professionId,
      styleId: stylePackages.styleId,
      status: stylePackages.status,
    })
    .from(stylePackages)
    .where(eq(stylePackages.runId, job.runId))
    .limit(1)
    .for("update");
  const parameters = payload.data.parameters;
  if (
    !pack ||
    pack.professionId !== parameters.professionId ||
    pack.styleId !== parameters.styleId ||
    (pack.status !== "queued" && pack.status !== "building")
  ) {
    return { status: "package-not-found" };
  }

  // 第二步：读取完整 production 集合，不只读取 payload 子集，防止遗漏或隐藏额外技能。
  const productions = await transaction
    .select({
      skillId: styleSkillProductions.skillId,
      professionId: styleSkillProductions.professionId,
      styleId: styleSkillProductions.styleId,
      jobId: styleSkillProductions.jobId,
      workerId: styleSkillProductions.workerId,
      leaseId: styleSkillProductions.leaseId,
      attempt: styleSkillProductions.attempt,
      sourceRunId: styleSkillProductions.sourceRunId,
      sourceFrameManifestArtifactId:
        styleSkillProductions.sourceFrameManifestArtifactId,
      promptSha256: styleSkillProductions.promptSha256,
      imageAttemptId: styleSkillProductions.imageAttemptId,
      asepriteProfileId: styleSkillProductions.asepriteProfileId,
      asepriteBinarySha256: styleSkillProductions.asepriteBinarySha256,
      asepriteAdapterSha256: styleSkillProductions.asepriteAdapterSha256,
      asepriteArtifactId: styleSkillProductions.asepriteArtifactId,
      asepriteUploadId: styleSkillProductions.asepriteUploadId,
      validationArtifactId: styleSkillProductions.validationArtifactId,
      validationUploadId: styleSkillProductions.validationUploadId,
      status: styleSkillProductions.status,
      errorCode: styleSkillProductions.errorCode,
      finishedAt: styleSkillProductions.finishedAt,
    })
    .from(styleSkillProductions)
    .where(eq(styleSkillProductions.runId, job.runId));
  const artifactIds = productions.flatMap((production) =>
    [production.asepriteArtifactId, production.validationArtifactId].filter(
      (artifactId): artifactId is string => artifactId !== null,
    ),
  );
  if (artifactIds.length === 0) {
    return { status: "package-evidence-incomplete" };
  }
  const artifactRows = await transaction
    .select({
      id: artifacts.id,
      runId: artifacts.runId,
      logicalName: artifacts.logicalName,
      storageKey: artifacts.storageKey,
      mediaType: artifacts.mediaType,
      byteLength: artifacts.byteLength,
      sha256: artifacts.sha256,
      provenance: artifacts.provenance,
    })
    .from(artifacts)
    .where(
      and(eq(artifacts.runId, job.runId), inArray(artifacts.id, artifactIds)),
    );

  // 第三步：输入 ZIP 必须仍由各自 producing attempt 的 finalized 会话绑定，不能只凭 Artifact 存在。
  const uploadIds = productions.flatMap((production) =>
    [production.asepriteUploadId, production.validationUploadId].filter(
      (uploadId): uploadId is string => uploadId !== null,
    ),
  );
  if (uploadIds.length === 0) {
    return { status: "package-evidence-incomplete" };
  }
  const uploadRows = await transaction
    .select({
      id: artifactUploadSessions.id,
      runId: artifactUploadSessions.runId,
      jobId: artifactUploadSessions.jobId,
      workerId: artifactUploadSessions.workerId,
      leaseId: artifactUploadSessions.leaseId,
      attempt: artifactUploadSessions.attempt,
      objectKey: artifactUploadSessions.objectKey,
      logicalName: artifactUploadSessions.logicalName,
      mediaType: artifactUploadSessions.mediaType,
      expectedByteLength: artifactUploadSessions.expectedByteLength,
      expectedSha256: artifactUploadSessions.expectedSha256,
      provenance: artifactUploadSessions.provenance,
      status: artifactUploadSessions.status,
      artifactId: artifactUploadSessions.artifactId,
      finalizedAt: artifactUploadSessions.finalizedAt,
      objectDeletedAt: artifactUploadSessions.objectDeletedAt,
    })
    .from(artifactUploadSessions)
    .where(
      and(
        eq(artifactUploadSessions.runId, job.runId),
        inArray(artifactUploadSessions.id, uploadIds),
      ),
    );
  const skills = resolveStylePackageSkillInputs(
    productions,
    artifactRows,
    uploadRows,
    {
      runId: job.runId,
      professionId: parameters.professionId,
      styleId: parameters.styleId,
      selectedSkillIds: parameters.selectedSkillIds,
    },
  );
  if (!skills) return { status: "package-evidence-incomplete" };

  // 第四步：最终公开 schema 重算 profile/context 哈希，数据库 JSON 漂移时不返回部分 context。
  try {
    return {
      status: "accepted",
      envelope: createStylePackageContextEnvelopeV3({
        schemaVersion: 3,
        workflow: "style-package-production-v3",
        jobId: job.id,
        runId: job.runId,
        professionId: parameters.professionId,
        styleId: parameters.styleId,
        attempt: input.attempt,
        packageProfile: parameters.packageProfile,
        packageProfileSha256: parameters.packageProfileSha256,
        skills,
        safety: parameters.safety,
      }),
    };
  } catch {
    return { status: "package-evidence-incomplete" };
  }
}
