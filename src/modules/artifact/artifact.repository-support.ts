/**
 * @fileoverview 提供 Artifact 仓储的事务行锁、状态解析与数据库映射；不暴露 HTTP 或对象存储能力。
 * @module artifact
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-006-LOCAL-OBJECT-STORAGE
 */
import { and, eq, sql } from "drizzle-orm";
import type { DatabaseService } from "../../common/db/database.service.js";
import { artifactUploadSessions } from "../../common/db/artifact-schema.js";
import { artifacts, jobs, runs } from "../../common/db/schema.js";
import type { ObjectStorageEvidence } from "../../common/storage/object-storage.client.js";
import type {
  ArtifactView,
  FinalizeArtifactUploadInput,
} from "./artifact.contracts.js";
import { artifactProvenanceSchema } from "./artifact.contracts.js";
import {
  artifactUploadSessionStatusSchema,
  type ArtifactUploadSessionRecord,
  type PrepareArtifactFinalizeResult,
} from "./artifact.repository-contracts.js";

export type ArtifactTransaction = Parameters<
  Parameters<DatabaseService["database"]["transaction"]>[0]
>[0];

export type LockedJob = Pick<
  typeof jobs.$inferSelect,
  | "attemptCount"
  | "leaseExpiresAt"
  | "leaseId"
  | "leaseOwnerId"
  | "runId"
  | "status"
> & { now: Date };

export async function lockedJob(
  transaction: ArtifactTransaction,
  jobId: string,
): Promise<LockedJob | undefined> {
  const [row] = await transaction
    .select({
      runId: jobs.runId,
      status: jobs.status,
      leaseOwnerId: jobs.leaseOwnerId,
      leaseId: jobs.leaseId,
      leaseExpiresAt: jobs.leaseExpiresAt,
      attemptCount: jobs.attemptCount,
      now: sql<Date>`CURRENT_TIMESTAMP(3)`,
    })
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .limit(1)
    .for("update");
  return row ? { ...row, now: dateValue(row.now) } : undefined;
}

export async function lockRun(
  transaction: ArtifactTransaction,
  runId: string,
): Promise<void> {
  const [run] = await transaction
    .select({ id: runs.id })
    .from(runs)
    .where(eq(runs.id, runId))
    .limit(1)
    .for("update");
  if (!run) throw new Error("ARTIFACT_RUN_INVARIANT_FAILED");
}

export async function lockedSession(
  transaction: ArtifactTransaction,
  uploadId: string,
): Promise<typeof artifactUploadSessions.$inferSelect | undefined> {
  const [session] = await transaction
    .select()
    .from(artifactUploadSessions)
    .where(eq(artifactUploadSessions.id, uploadId))
    .limit(1)
    .for("update");
  return session;
}

export async function resolvePreparedSession(
  transaction: ArtifactTransaction,
  jobId: string,
  runId: string,
  row: typeof artifactUploadSessions.$inferSelect | undefined,
  lease: FinalizeArtifactUploadInput,
  now: Date,
): Promise<PrepareArtifactFinalizeResult> {
  if (!row || row.runId !== runId || row.jobId !== jobId) {
    return { status: "upload-not-found" };
  }
  if (
    row.workerId !== lease.workerId ||
    row.leaseId !== lease.leaseId ||
    row.attempt !== lease.attempt
  ) {
    return { status: "lease-mismatch" };
  }
  if (row.status === "finalized") {
    const artifact = row.artifactId
      ? await findArtifact(transaction, row.artifactId, runId)
      : undefined;
    if (!artifact) throw new Error("ARTIFACT_FINALIZED_SESSION_INVALID");
    return { status: "finalized", artifact };
  }
  if (row.status !== "authorized") return { status: "upload-terminal" };
  if (dateValue(row.expiresAt).getTime() <= now.getTime()) {
    await transaction
      .update(artifactUploadSessions)
      .set({
        status: "rejected",
        errorCode: "ARTIFACT_UPLOAD_EXPIRED",
        updatedAt: now,
      })
      .where(eq(artifactUploadSessions.id, row.id));
    return { status: "upload-expired" };
  }
  return { status: "accepted", session: toSessionRecord(row) };
}

export function hasExactLease(
  job: LockedJob,
  lease: FinalizeArtifactUploadInput,
): boolean {
  return (
    job.status === "leased" &&
    job.leaseOwnerId === lease.workerId &&
    job.leaseId === lease.leaseId &&
    job.attemptCount === lease.attempt &&
    job.leaseExpiresAt !== null &&
    dateValue(job.leaseExpiresAt).getTime() > job.now.getTime()
  );
}

export function matchesEvidence(
  session: ArtifactUploadSessionRecord,
  evidence: ObjectStorageEvidence,
): boolean {
  return (
    evidence.objectKey === session.objectKey &&
    evidence.mediaType === session.mediaType &&
    evidence.byteLength === session.expectedByteLength &&
    evidence.sha256.toUpperCase() === session.expectedSha256.toUpperCase()
  );
}

export function numericTotal(value: string | number | undefined): number {
  const total = Number(value ?? 0);
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error("ARTIFACT_QUOTA_TOTAL_INVALID");
  }
  return total;
}

export async function databaseNow(
  transaction: ArtifactTransaction,
): Promise<Date> {
  const [row] = await transaction
    .select({
      value: sql<Date | string>`CURRENT_TIMESTAMP(3)`,
    })
    .from(sql`DUAL`);
  if (!row) throw new Error("DATABASE_TIME_UNAVAILABLE");
  return dateValue(row.value);
}

export function toArtifactView(
  row: typeof artifacts.$inferSelect,
): ArtifactView {
  return {
    id: row.id,
    runId: row.runId,
    logicalName: row.logicalName,
    mediaType: row.mediaType,
    byteLength: row.byteLength,
    sha256: row.sha256.toUpperCase(),
    provenance: artifactProvenanceSchema.parse(row.provenance),
    createdAtUtc: dateValue(row.createdAt).toISOString(),
  };
}

async function findArtifact(
  transaction: ArtifactTransaction,
  artifactId: string,
  runId: string,
): Promise<ArtifactView | undefined> {
  const [row] = await transaction
    .select()
    .from(artifacts)
    .where(and(eq(artifacts.id, artifactId), eq(artifacts.runId, runId)))
    .limit(1);
  return row ? toArtifactView(row) : undefined;
}

function toSessionRecord(
  row: typeof artifactUploadSessions.$inferSelect,
): ArtifactUploadSessionRecord {
  return {
    id: row.id,
    runId: row.runId,
    jobId: row.jobId,
    workerId: row.workerId,
    leaseId: row.leaseId,
    attempt: row.attempt,
    objectKey: row.objectKey,
    logicalName: row.logicalName,
    mediaType: row.mediaType,
    expectedByteLength: row.expectedByteLength,
    expectedSha256: row.expectedSha256.toUpperCase(),
    provenance: artifactProvenanceSchema.parse(row.provenance),
    status: artifactUploadSessionStatusSchema.parse(row.status),
    expiresAt: dateValue(row.expiresAt),
    createdAt: dateValue(row.createdAt),
    ...(row.artifactId ? { artifactId: row.artifactId } : {}),
  };
}

function dateValue(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
