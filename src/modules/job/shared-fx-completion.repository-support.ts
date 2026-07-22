/**
 * @fileoverview 查询当前租约的共享特效阶段证据并判定完成条件；不写 Job 状态、不创建 HTTP 响应。
 * @module job
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-001-SHARED-FX
 */
import { and, eq } from "drizzle-orm";
import {
  artifactUploadSessions,
  sharedFxStageEvidences,
} from "../../common/db/artifact-schema.js";
import { artifacts } from "../../common/db/schema.js";
import type { jobs } from "../../common/db/schema.js";
import type { JobTransaction } from "./job-run-event.repository-support.js";
import {
  resolveSharedFxCompletionEvidence,
  type SharedFxCompletionEvidence,
  type SharedFxStoredEvidence,
} from "./shared-fx-evidence-integrity.js";
import { sharedFxJobPayloadV1Schema } from "./shared-fx.contracts.js";

export interface SharedFxCompletionLease {
  runId: string;
  jobId: string;
  workerId: string;
  leaseId: string;
  attempt: number;
  payload: unknown;
}

/** 将已锁定 Job 的当前 lease 转为完成证据查询；缺少精确 fencing token 时 fail-closed。 */
export function findSharedFxCompletionEvidenceForJob(
  transaction: JobTransaction,
  job: typeof jobs.$inferSelect,
  resultSha256: string | undefined,
): Promise<SharedFxCompletionEvidence | undefined> {
  if (!job.leaseOwnerId || !job.leaseId) return Promise.resolve(undefined);
  return findSharedFxCompletionEvidence(
    transaction,
    {
      runId: job.runId,
      jobId: job.id,
      workerId: job.leaseOwnerId,
      leaseId: job.leaseId,
      attempt: job.attemptCount,
      payload: job.payload,
    },
    resultSha256,
  );
}

/**
 * 从当前 lease 的数据库证据链解析完成凭据；任意 payload、会话或 Artifact 不一致均返回 undefined。
 * 读取时再次连接 finalized upload session 与 Artifact，防止仅凭 evidence 表的历史字段完成 Job。
 */
export async function findSharedFxCompletionEvidence(
  transaction: JobTransaction,
  lease: SharedFxCompletionLease,
  resultSha256: string | undefined,
): Promise<SharedFxCompletionEvidence | undefined> {
  const payload = sharedFxJobPayloadV1Schema.safeParse(lease.payload);
  if (!payload.success) return undefined;
  const rows = await transaction
    .select({
      stage: sharedFxStageEvidences.stage,
      artifactId: sharedFxStageEvidences.artifactId,
      artifactSha256: sharedFxStageEvidences.artifactSha256,
      persistedArtifactSha256: artifacts.sha256,
      uploadArtifactId: artifactUploadSessions.artifactId,
      uploadStatus: artifactUploadSessions.status,
      uploadFinalizedAt: artifactUploadSessions.finalizedAt,
    })
    .from(sharedFxStageEvidences)
    .innerJoin(
      artifactUploadSessions,
      and(
        eq(sharedFxStageEvidences.uploadId, artifactUploadSessions.id),
        eq(sharedFxStageEvidences.runId, artifactUploadSessions.runId),
        eq(sharedFxStageEvidences.jobId, artifactUploadSessions.jobId),
        eq(sharedFxStageEvidences.workerId, artifactUploadSessions.workerId),
        eq(sharedFxStageEvidences.leaseId, artifactUploadSessions.leaseId),
        eq(sharedFxStageEvidences.attempt, artifactUploadSessions.attempt),
        eq(
          sharedFxStageEvidences.artifactId,
          artifactUploadSessions.artifactId,
        ),
      ),
    )
    .innerJoin(
      artifacts,
      and(
        eq(sharedFxStageEvidences.runId, artifacts.runId),
        eq(sharedFxStageEvidences.artifactId, artifacts.id),
      ),
    )
    .where(
      and(
        eq(sharedFxStageEvidences.runId, lease.runId),
        eq(sharedFxStageEvidences.jobId, lease.jobId),
        eq(sharedFxStageEvidences.workerId, lease.workerId),
        eq(sharedFxStageEvidences.leaseId, lease.leaseId),
        eq(sharedFxStageEvidences.attempt, lease.attempt),
      ),
    )
    .for("update");
  const evidence: SharedFxStoredEvidence[] = rows.map((row) => ({
    stage: row.stage,
    artifactId: row.artifactId,
    artifactSha256: row.artifactSha256,
    persistedArtifactSha256: row.persistedArtifactSha256,
    uploadArtifactId: row.uploadArtifactId,
    uploadFinalized:
      row.uploadStatus === "finalized" && row.uploadFinalizedAt !== null,
  }));
  return resolveSharedFxCompletionEvidence(
    payload.data.parameters.review.requiredEvidenceStages,
    resultSha256,
    evidence,
  );
}
