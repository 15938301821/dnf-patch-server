/**
 * @fileoverview 持久化最终 Artifact 与 Worker 租约绑定上传会话；不访问对象正文或签发 URL。
 * @module artifact
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-006-LOCAL-OBJECT-STORAGE
 */
import { Injectable } from "@nestjs/common";
import { and, asc, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { DatabaseService } from "../../common/db/database.service.js";
import { artifactUploadSessions } from "../../common/db/artifact-schema.js";
import { artifacts } from "../../common/db/schema.js";
import type { ObjectStorageEvidence } from "../../common/storage/object-storage.client.js";
import type {
  ArtifactView,
  FinalizeArtifactUploadInput,
} from "./artifact.contracts.js";
import { artifactProvenanceSchema } from "./artifact.contracts.js";
import type {
  ArtifactDownloadLookupResult,
  ArtifactOrphanRecord,
  ArtifactRepositoryPort,
  FinalizeArtifactUploadResult,
  PrepareArtifactFinalizeResult,
  ReserveArtifactUploadRecord,
  ReserveArtifactUploadResult,
} from "./artifact.repository-contracts.js";
import {
  databaseNow,
  hasExactLease,
  lockRun,
  lockedJob,
  lockedSession,
  matchesEvidence,
  numericTotal,
  resolvePreparedSession,
  toArtifactView,
} from "./artifact.repository-support.js";

@Injectable()
export class ArtifactRepository implements ArtifactRepositoryPort {
  constructor(private readonly connection: DatabaseService) {}

  async findRunId(id: string): Promise<string | undefined> {
    const [row] = await this.connection.database
      .select({ runId: artifacts.runId })
      .from(artifacts)
      .where(eq(artifacts.id, id))
      .limit(1);
    return row?.runId;
  }

  async listByRun(runId: string): Promise<ArtifactView[]> {
    const rows = await this.connection.database
      .select()
      .from(artifacts)
      .where(eq(artifacts.runId, runId))
      .orderBy(asc(artifacts.createdAt));
    return rows.map(toArtifactView);
  }

  /** 锁定 Job 与 Run 后校验精确 lease/attempt，并把活跃会话计入 Run 配额。 */
  async reserveUpload(
    jobId: string,
    reservation: ReserveArtifactUploadRecord,
    lease: FinalizeArtifactUploadInput,
    sessionTtlSeconds: number,
    maxRunBytes: number,
  ): Promise<ReserveArtifactUploadResult> {
    return this.connection.database.transaction(async (transaction) => {
      const job = await lockedJob(transaction, jobId);
      if (!job || !hasExactLease(job, lease)) {
        return { status: "lease-mismatch" };
      }
      await lockRun(transaction, job.runId);
      const [artifactTotal] = await transaction
        .select({
          value: sql<string>`coalesce(sum(${artifacts.byteLength}), 0)`,
        })
        .from(artifacts)
        .where(eq(artifacts.runId, job.runId));
      const [sessionTotal] = await transaction
        .select({
          value: sql<string>`coalesce(sum(${artifactUploadSessions.expectedByteLength}), 0)`,
        })
        .from(artifactUploadSessions)
        .where(
          and(
            eq(artifactUploadSessions.runId, job.runId),
            eq(artifactUploadSessions.status, "authorized"),
            gt(artifactUploadSessions.expiresAt, job.now),
          ),
        );
      const total =
        numericTotal(artifactTotal?.value) +
        numericTotal(sessionTotal?.value) +
        reservation.expectedByteLength;
      if (total > maxRunBytes) return { status: "run-quota-exceeded" };
      const expiresAt = new Date(job.now.getTime() + sessionTtlSeconds * 1_000);
      const provenance = artifactProvenanceSchema.parse(reservation.provenance);
      await transaction.insert(artifactUploadSessions).values({
        id: reservation.id,
        runId: job.runId,
        jobId,
        workerId: lease.workerId,
        leaseId: lease.leaseId,
        attempt: lease.attempt,
        objectKey: reservation.objectKey,
        logicalName: reservation.logicalName,
        mediaType: reservation.mediaType,
        expectedByteLength: reservation.expectedByteLength,
        expectedSha256: reservation.expectedSha256.toUpperCase(),
        provenance,
        status: "authorized",
        expiresAt,
        createdAt: job.now,
        updatedAt: job.now,
      });
      return {
        status: "accepted",
        session: {
          ...reservation,
          runId: job.runId,
          jobId,
          workerId: lease.workerId,
          leaseId: lease.leaseId,
          attempt: lease.attempt,
          expectedSha256: reservation.expectedSha256.toUpperCase(),
          provenance,
          status: "authorized",
          expiresAt,
          createdAt: job.now,
        },
      };
    });
  }

  async prepareFinalize(
    jobId: string,
    uploadId: string,
    lease: FinalizeArtifactUploadInput,
  ): Promise<PrepareArtifactFinalizeResult> {
    return this.connection.database.transaction(async (transaction) => {
      const job = await lockedJob(transaction, jobId);
      if (!job || !hasExactLease(job, lease)) {
        return { status: "lease-mismatch" };
      }
      await lockRun(transaction, job.runId);
      const session = await lockedSession(transaction, uploadId);
      return resolvePreparedSession(
        transaction,
        jobId,
        job.runId,
        session,
        lease,
        job.now,
      );
    });
  }

  /** 再次校验租约和证据，在同一事务中创建最终 Artifact 并封存会话。 */
  async finalizeUpload(
    jobId: string,
    uploadId: string,
    artifactId: string,
    evidence: ObjectStorageEvidence,
    lease: FinalizeArtifactUploadInput,
  ): Promise<FinalizeArtifactUploadResult> {
    return this.connection.database.transaction(async (transaction) => {
      const job = await lockedJob(transaction, jobId);
      if (!job || !hasExactLease(job, lease)) {
        return { status: "lease-mismatch" };
      }
      await lockRun(transaction, job.runId);
      const session = await lockedSession(transaction, uploadId);
      const prepared = await resolvePreparedSession(
        transaction,
        jobId,
        job.runId,
        session,
        lease,
        job.now,
      );
      if (prepared.status !== "accepted") return prepared;
      if (!matchesEvidence(prepared.session, evidence)) {
        await transaction
          .update(artifactUploadSessions)
          .set({
            status: "rejected",
            errorCode: "ARTIFACT_EVIDENCE_MISMATCH",
            updatedAt: job.now,
          })
          .where(eq(artifactUploadSessions.id, uploadId));
        return { status: "evidence-mismatch" };
      }
      const storageKey = evidence.objectKey;
      const artifact: ArtifactView = {
        id: artifactId,
        runId: job.runId,
        logicalName: prepared.session.logicalName,
        mediaType: evidence.mediaType,
        byteLength: evidence.byteLength,
        sha256: evidence.sha256.toUpperCase(),
        provenance: prepared.session.provenance,
        createdAtUtc: job.now.toISOString(),
      };
      await transaction.insert(artifacts).values({
        id: artifact.id,
        runId: artifact.runId,
        logicalName: artifact.logicalName,
        storageKey,
        mediaType: artifact.mediaType,
        byteLength: artifact.byteLength,
        sha256: artifact.sha256,
        provenance: artifact.provenance,
        createdAt: job.now,
      });
      await transaction
        .update(artifactUploadSessions)
        .set({
          status: "finalized",
          artifactId,
          finalizedAt: job.now,
          updatedAt: job.now,
        })
        .where(eq(artifactUploadSessions.id, uploadId));
      return { status: "accepted", artifact };
    });
  }

  async rejectUpload(
    uploadId: string,
    errorCode: string,
  ): Promise<string | undefined> {
    return this.connection.database.transaction(async (transaction) => {
      const session = await lockedSession(transaction, uploadId);
      if (!session || session.status !== "authorized") return undefined;
      const now = await databaseNow(transaction);
      await transaction
        .update(artifactUploadSessions)
        .set({ status: "rejected", errorCode, updatedAt: now })
        .where(eq(artifactUploadSessions.id, uploadId));
      return session.objectKey;
    });
  }

  async findForDownload(
    jobId: string,
    artifactId: string,
    lease: FinalizeArtifactUploadInput,
  ): Promise<ArtifactDownloadLookupResult> {
    return this.connection.database.transaction(async (transaction) => {
      const job = await lockedJob(transaction, jobId);
      if (!job || !hasExactLease(job, lease)) {
        return { status: "lease-mismatch" };
      }
      const [artifact] = await transaction
        .select({ storageKey: artifacts.storageKey })
        .from(artifacts)
        .where(
          and(eq(artifacts.id, artifactId), eq(artifacts.runId, job.runId)),
        )
        .limit(1);
      return artifact
        ? { status: "accepted", objectKey: artifact.storageKey }
        : { status: "artifact-not-found" };
    });
  }

  /** 返回有界 orphan 批次；对象 DELETE 幂等，成功后再标记清理完成。 */
  async findOrphans(batchSize: number): Promise<ArtifactOrphanRecord[]> {
    return this.connection.database.transaction(async (transaction) => {
      const now = await databaseNow(transaction);
      const rows = await transaction
        .select({
          uploadId: artifactUploadSessions.id,
          objectKey: artifactUploadSessions.objectKey,
          status: artifactUploadSessions.status,
        })
        .from(artifactUploadSessions)
        .where(
          and(
            isNull(artifactUploadSessions.objectDeletedAt),
            lte(artifactUploadSessions.expiresAt, now),
            or(
              eq(artifactUploadSessions.status, "rejected"),
              eq(artifactUploadSessions.status, "authorized"),
            ),
          ),
        )
        .orderBy(asc(artifactUploadSessions.expiresAt))
        .limit(batchSize)
        .for("update", { skipLocked: true });
      for (const row of rows) {
        if (row.status !== "authorized") continue;
        await transaction
          .update(artifactUploadSessions)
          .set({
            status: "rejected",
            errorCode: "ARTIFACT_UPLOAD_EXPIRED",
            updatedAt: now,
          })
          .where(eq(artifactUploadSessions.id, row.uploadId));
      }
      return rows.map(({ uploadId, objectKey }) => ({ uploadId, objectKey }));
    });
  }

  async markObjectDeleted(uploadId: string): Promise<void> {
    await this.connection.database.transaction(async (transaction) => {
      const now = await databaseNow(transaction);
      await transaction
        .update(artifactUploadSessions)
        .set({ objectDeletedAt: now, updatedAt: now })
        .where(
          and(
            eq(artifactUploadSessions.id, uploadId),
            eq(artifactUploadSessions.status, "rejected"),
            lte(artifactUploadSessions.expiresAt, now),
          ),
        );
    });
  }
}
