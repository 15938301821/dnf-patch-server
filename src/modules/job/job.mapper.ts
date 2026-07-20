/**
 * @fileoverview 将 Job 数据库行映射为公开视图，不执行状态转换或数据库写入。
 * @module job
 * @author AI生成
 * @created 2026-07-20
 * @relatedPlan /memories/session/plan.md Phase 1 job integrity
 */
import type { jobs } from "../../common/db/schema.js";
import type { JobView } from "./job.contracts.js";

/** 将已校验的 Job 数据库行映射为 API/Worker 视图。 */
export function toJobView(row: typeof jobs.$inferSelect): JobView {
  return {
    id: row.id,
    runId: row.runId,
    kind: row.kind as JobView["kind"],
    status: row.status,
    payload: row.payload,
    payloadSha256: row.payloadSha256,
    ...(row.leaseOwnerId ? { leaseOwnerId: row.leaseOwnerId } : {}),
    ...(row.leaseId ? { leaseId: row.leaseId } : {}),
    ...(row.leaseExpiresAt
      ? { leaseExpiresAtUtc: row.leaseExpiresAt.toISOString() }
      : {}),
    attemptCount: row.attemptCount,
    maxAttempts: row.maxAttempts,
    createdAtUtc: row.createdAt.toISOString(),
    updatedAtUtc: row.updatedAt.toISOString(),
  };
}
