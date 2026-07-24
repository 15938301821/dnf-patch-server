/**
 * @fileoverview 在调用方 transaction 中读取 Profession 多技能生产与双 Artifact 摘要，并委托
 * 共享纯函数复核完成证据；不锁 Job、不校验 lease、不更新终态或读取对象正文。
 * @module modules/job/profession-completion-repository-support
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 当前 Profession Worker 纵向闭环直接需求
 *
 * 调用关系：PatchTask 进度查询和 Job complete 都必须先锁定 Job，再调用本函数；本函数按固定
 * production -> Artifact 顺序加锁/读取，返回有限完整性状态与冻结顺序进度。
 * 安全边界：调用方持有 Job row lock（事务内修改锁），因此单技能报告不能在两次查询间改变证据；
 * Artifact 只读取数据库 finalized 元数据，不信任 Worker 自报摘要，也不访问对象存储正文。
 */
import { eq, inArray } from "drizzle-orm";
import type { DatabaseService } from "../../common/db/database.service.js";
import { artifacts, type jobs } from "../../common/db/schema.js";
import { styleSkillProductions } from "../../common/db/studio-schema.js";
import {
  resolveProfessionCompletionEvidence,
  type ResolveProfessionCompletionEvidenceResult,
} from "./profession-completion-evidence.js";

type Transaction = Parameters<
  Parameters<DatabaseService["database"]["transaction"]>[0]
>[0];

/**
 * 读取并复核一个已锁定 Profession Job 的全部技能证据。
 * @param transaction 调用方已开启且持有 Job 行锁的 Drizzle transaction。
 * @param job 当前锁定 Job；payload 与 payloadSha256 仍由共享解析器重新校验。
 * @returns accepted 时为有限进度和可选完成摘要；完整性失败时不得继续 passed。
 */
export async function resolveProfessionCompletionInTransaction(
  transaction: Transaction,
  job: typeof jobs.$inferSelect,
): Promise<ResolveProfessionCompletionEvidenceResult> {
  // 第一步：锁定该 Run 的全部 production，保持与单技能接收路径相同的 Job -> production 锁顺序。
  const productions = await transaction
    .select({
      runId: styleSkillProductions.runId,
      professionId: styleSkillProductions.professionId,
      styleId: styleSkillProductions.styleId,
      skillId: styleSkillProductions.skillId,
      jobId: styleSkillProductions.jobId,
      workerId: styleSkillProductions.workerId,
      leaseId: styleSkillProductions.leaseId,
      attempt: styleSkillProductions.attempt,
      sourceRunId: styleSkillProductions.sourceRunId,
      sourceFrameManifestArtifactId:
        styleSkillProductions.sourceFrameManifestArtifactId,
      promptSha256: styleSkillProductions.promptSha256,
      modelCallId: styleSkillProductions.modelCallId,
      imageAttemptId: styleSkillProductions.imageAttemptId,
      asepriteProfileId: styleSkillProductions.asepriteProfileId,
      asepriteBinarySha256: styleSkillProductions.asepriteBinarySha256,
      asepriteAdapterSha256: styleSkillProductions.asepriteAdapterSha256,
      asepriteArtifactId: styleSkillProductions.asepriteArtifactId,
      validationArtifactId: styleSkillProductions.validationArtifactId,
      status: styleSkillProductions.status,
      errorCode: styleSkillProductions.errorCode,
    })
    .from(styleSkillProductions)
    .where(eq(styleSkillProductions.runId, job.runId))
    .for("update");

  // 第二步：只读取 production 实际引用的双 Artifact；缺失、跨 Run 或复用由纯解析器整体拒绝。
  const artifactIds = productions.flatMap((production) =>
    [production.asepriteArtifactId, production.validationArtifactId].filter(
      (artifactId): artifactId is string => artifactId !== null,
    ),
  );
  const artifactRows =
    artifactIds.length === 0
      ? []
      : await transaction
          .select({
            id: artifacts.id,
            runId: artifacts.runId,
            sha256: artifacts.sha256,
          })
          .from(artifacts)
          .where(inArray(artifacts.id, artifactIds))
          .for("update");
  return resolveProfessionCompletionEvidence(job, productions, artifactRows);
}
