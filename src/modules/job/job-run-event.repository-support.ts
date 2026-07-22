/**
 * @fileoverview 提供 Job 事务内的数据库时间与权威 Run 事件写入；不执行 Job 状态转换或 WebSocket 广播。
 * @module job
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-001-SHARED-FX
 */
import { max, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import type { DatabaseService } from "../../common/db/database.service.js";
import {
  jobs,
  manualReviews,
  outboxEvents,
  runEvents,
} from "../../common/db/schema.js";
import type { RunEventView } from "../run/run.contracts.js";

export type JobTransaction = Parameters<
  Parameters<DatabaseService["database"]["transaction"]>[0]
>[0];

/** 使用数据库时间，避免 Worker 或 Nest 进程时钟影响租约与事件顺序。 */
export async function databaseNow(transaction: JobTransaction): Promise<Date> {
  const [row] = await transaction
    .select({ value: sql<Date>`CURRENT_TIMESTAMP(3)` })
    .from(jobs)
    .limit(1);
  if (!row) throw new Error("DATABASE_TIME_UNAVAILABLE");
  return row.value instanceof Date ? row.value : new Date(row.value);
}

/**
 * 在调用方已锁定 Run 的同一事务中追加权威事件及 outbox，确保客户端可按 sequence 恢复。
 * evidenceArtifactId 仅接受已由调用方验证为同 Run 的 Artifact，不从 Worker 自报哈希构造。
 */
export async function appendJobRunEvent(
  transaction: JobTransaction,
  runId: string,
  level: RunEventView["level"],
  stage: string,
  message: string,
  now: Date,
  evidenceArtifactId?: string,
): Promise<RunEventView> {
  const [sequenceRow] = await transaction
    .select({ sequence: max(runEvents.sequence) })
    .from(runEvents)
    .where(eq(runEvents.runId, runId));
  const event: RunEventView = {
    runId,
    sequence: (sequenceRow?.sequence ?? -1) + 1,
    level,
    stage,
    message,
    ...(evidenceArtifactId ? { evidenceArtifactId } : {}),
    createdAtUtc: now.toISOString(),
  };
  await transaction.insert(runEvents).values({
    id: randomUUID(),
    runId,
    sequence: event.sequence,
    level,
    stage,
    message,
    ...(evidenceArtifactId ? { evidenceArtifactId } : {}),
    createdAt: now,
  });
  await transaction.insert(outboxEvents).values({
    id: randomUUID(),
    topic: "run.event",
    aggregateId: runId,
    payload: { ...event },
    createdAt: now,
  });
  return event;
}

/**
 * 创建或复用当前 Run 的待审核记录。既有审核只能保留同一验证 Artifact，不能由 Worker 覆盖或重置。
 */
export async function ensurePendingSharedFxReview(
  transaction: JobTransaction,
  runId: string,
  evidenceArtifactId: string,
  now: Date,
): Promise<"accepted" | "review-conflict"> {
  const [existing] = await transaction
    .select({
      status: manualReviews.status,
      evidenceArtifactId: manualReviews.evidenceArtifactId,
    })
    .from(manualReviews)
    .where(eq(manualReviews.runId, runId))
    .limit(1)
    .for("update");
  if (existing) {
    return existing.status === "pending" &&
      existing.evidenceArtifactId === evidenceArtifactId
      ? "accepted"
      : "review-conflict";
  }
  await transaction.insert(manualReviews).values({
    id: randomUUID(),
    runId,
    status: "pending",
    evidenceArtifactId,
    createdAt: now,
  });
  return "accepted";
}
