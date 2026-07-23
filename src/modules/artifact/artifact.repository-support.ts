/**
 * @fileoverview 提供 Artifact 仓储在单一数据库事务内使用的行锁、数据库时间、上传会话状态解析和
 * ViewModel 映射；不暴露 HTTP 路由、不签发对象存储 URL，也不直接执行上传或下载。
 * @module modules/artifact/repository-support
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-006-LOCAL-OBJECT-STORAGE
 *
 * 调用关系：ArtifactRepository 的 prepare/finalize/reap 等事务流程调用本文件；调用方先取得
 * ArtifactTransaction，再按 Job -> Run -> upload session 的顺序锁行，并把对象存储返回的证据交给
 * matchesEvidence 复核。Controller 和 Worker 不应直接调用这些低层函数。
 * 输入输出：输入是受当前事务约束的 id、lease、数据库行和对象存储 evidence；输出是锁定快照、有限
 * 状态结果或脱敏 ArtifactView，不返回 object URL、数据库连接、原始对象字节或 Worker token。
 * 副作用：lockedJob/lockRun/lockedSession 取得 `FOR UPDATE` 行锁；resolvePreparedSession 可将过期
 * authorized 会话更新为 rejected；其他转换函数仅在内存中校验/映射。
 * 安全边界：所有时效判断以数据库当前时间为准，finalize 必须同时绑定 Job、Run、worker、leaseId 和
 * attempt，并把对象 key、媒体类型、长度、SHA-256 全量匹配。缺少或不一致证据时调用方必须 fail-closed。
 */
import { and, eq, sql } from "drizzle-orm";
import { hasExactJobLease } from "../../common/contracts/index.js";
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

/**
 * DatabaseService.transaction 回调收到的 Drizzle 事务类型。
 * 调用方只能在同一个实例中组合行锁和状态写入，不能将它替换成独立数据库连接而丢失原子性。
 */
export type ArtifactTransaction = Parameters<
  Parameters<DatabaseService["database"]["transaction"]>[0]
>[0];

/**
 * finalize 路径锁定 Job 后使用的最小快照，附带同一事务内从数据库读取的权威当前时间。
 * 它不包含 payload、Worker 凭据或对象存储位置；lease 验证必须只使用这里的 attempt 与数据库时间。
 */
export type LockedJob = Pick<
  typeof jobs.$inferSelect,
  | "attemptCount"
  | "leaseExpiresAt"
  | "leaseId"
  | "leaseOwnerId"
  | "runId"
  | "status"
> & { now: Date };

/**
 * 锁定一个 Job 并读取 Artifact finalize 所需的最小 lease 快照。
 *
 * @param transaction 当前 Artifact 事务；行锁在提交或回滚前持续有效。
 * @param jobId 已由上游 DTO/路由解析的 Job 标识。
 * @returns 找到时返回带数据库当前时间的 LockedJob；未找到返回 undefined，调用方映射为稳定业务错误。
 * @sideEffect 对 jobs 行执行 `FOR UPDATE`，防止并发 finalize、lease 回收或 attempt 变化交错通过校验。
 */
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

/**
 * 锁定 Job 所属 Run，建立 Artifact 与 Run 状态变更的共同事务边界。
 * @param transaction 与 lockedJob 相同的事务，不能在另一个连接上调用。
 * @param runId 从锁定 Job 读取的归属 Run 标识。
 * @throws ARTIFACT_RUN_INVARIANT_FAILED 当 Job 指向不存在 Run，说明持久化不变量已损坏。
 * @sideEffect 对 runs 行执行 `FOR UPDATE`；不更新 Run，也不创建 Artifact。
 */
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

/**
 * 锁定一个 Artifact 上传会话，供 prepare/finalize 流程读取或转换其状态。
 * @param transaction 与 Job/Run 锁共享的事务。
 * @param uploadId Worker 提交、已由上游 schema 校验的上传会话标识。
 * @returns 会话数据库行或 undefined；调用方必须继续检查它是否属于相同 Job、Run、worker、lease 和 attempt。
 * @sideEffect 对 artifact_upload_sessions 行执行 `FOR UPDATE`，不直接改变状态。
 */
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

/**
 * 在已锁定的上下文中判断上传会话能否用于 finalize，并将已过期 authorized 会话原子地拒绝。
 *
 * 步骤 1：确认会话属于当前 Job 和 Run；步骤 2：确认 Worker、leaseId、attempt 与本次请求完全一致；
 * 步骤 3：finalized 会话走幂等读取，authorized 会话检查数据库时钟，其他终态一律拒绝；步骤 4：
 * 仅在授权会话过期时写入 rejected，避免 finalize 继续接受过期对象。
 *
 * @param transaction 当前包含 Job、Run、session 行锁的事务。
 * @param jobId 已锁定 Job 的标识，用于隔离跨 Job uploadId。
 * @param runId 已锁定 Run 的标识，用于隔离跨 Run uploadId。
 * @param row lockedSession 返回的数据库行；undefined 表示无法找到会话。
 * @param lease Worker 请求中的 worker/lease/attempt 绑定，不可信，必须逐项比较。
 * @param now 从数据库读取的当前时间，不能用 Worker 或服务进程本机时间代替。
 * @returns PrepareArtifactFinalizeResult，明确区分不存在、lease 不匹配、幂等 finalized、终态、过期和可接受。
 * @sideEffect 仅在 authorized 会话已经过期时更新其状态为 rejected；其他返回分支不写入。
 */
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

/**
 * 判断锁定 Job 是否仍由本次 finalize 请求的 Worker 在相同 attempt 内持有有效 lease。
 * @param job 同一事务中锁定且含数据库当前时间的 Job 快照。
 * @param lease Worker 提交的 finalize 绑定数据。
 * @returns 只有 worker、leaseId、attempt 和数据库时效全部精确匹配时返回 true。
 * @remarks false 不是可重试授权；调用方必须拒绝该 finalize，避免旧 Worker 或旧 attempt 写入新 Artifact。
 */
export function hasExactLease(
  job: LockedJob,
  lease: FinalizeArtifactUploadInput,
): boolean {
  return hasExactJobLease(
    {
      ...job,
      leaseExpiresAt: job.leaseExpiresAt ? dateValue(job.leaseExpiresAt) : null,
    },
    lease,
    job.now,
  );
}

/**
 * 比较对象存储读取到的实际 evidence 与服务器预先授权的上传会话承诺。
 * @param session 由数据库会话行映射出的预期 object key、媒体类型、长度和 SHA-256。
 * @param evidence 对象存储 HEAD/验证接口返回的实际元数据，不信任 Worker 报告。
 * @returns 所有身份与内容字段完全匹配时返回 true；哈希比较忽略字母大小写但不忽略任何值。
 * @remarks true 只证明存储对象符合本次会话承诺，不证明 Artifact 已在数据库 finalized 或可被下载。
 */
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

/**
 * 把对象存储等基础设施可能返回的总数转换为安全非负整数。
 * @param value 字符串、数字或缺失总数；缺失值按 0 处理，不能把 NaN、浮点或负数静默当配额。
 * @returns 可用于配额比较的非负安全整数。
 * @throws ARTIFACT_QUOTA_TOTAL_INVALID 当基础设施返回无法安全表达的总数时抛出，调用方必须 fail-closed。
 */
export function numericTotal(value: string | number | undefined): number {
  const total = Number(value ?? 0);
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new Error("ARTIFACT_QUOTA_TOTAL_INVALID");
  }
  return total;
}

/**
 * 从 MySQL 获取毫秒精度的权威当前时间。
 * @param transaction 当前事务，确保时效比较与同一 finalize 状态变更使用同一个数据库视角。
 * @returns 已转换为 Date 的数据库 CURRENT_TIMESTAMP(3)。
 * @throws DATABASE_TIME_UNAVAILABLE 当数据库没有返回时间行时抛出，调用方不能退回服务进程本机时间。
 */
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

/**
 * 将 Artifact 持久化行映射为可向 API 返回的 ViewModel，并在读取边界重新验证 provenance JSON。
 * @param row artifacts 表中已查询到的单行；其 objectKey 等内部存储定位信息不会进入返回结果。
 * @returns 含规范化 SHA-256 和 ISO 时间的 ArtifactView。
 * @throws 当数据库 provenance 不再符合受限 schema 时抛出，避免损坏元数据被静默暴露给调用方。
 */
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

/**
 * 在当前事务内按 Artifact id 和 Run 归属读取已 finalized 的幂等结果。
 * @param transaction 包含 upload session 行锁的事务。
 * @param artifactId finalized session 保存的 Artifact 标识。
 * @param runId 当前 Job 所属 Run，防止跨 Run 复用 id。
 * @returns 匹配归属时的 ArtifactView，否则 undefined。
 */
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

/**
 * 将上传会话数据库行转换为 finalize 流程使用的受限记录，并重新验证 provenance/status JSON 语义。
 * @param row 锁定或查询到的 artifact_upload_sessions 行。
 * @returns 只含会话绑定、预期 evidence、状态和时间的 ArtifactUploadSessionRecord。
 * @throws 当数据库 JSON/status 不符合契约时抛出，避免对损坏会话继续授权。
 */
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

/**
 * 统一 Drizzle/MySQL 返回的 Date 或字符串时间值。
 * @param value 数据库时间字段，不能来自 Worker 或客户端。
 * @returns 可用于同一事务内比较和 ViewModel 序列化的 Date。
 */
function dateValue(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
