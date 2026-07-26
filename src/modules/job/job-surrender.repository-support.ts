/**
 * @fileoverview 以精确 lease 显式关闭瞬时失败的 Job attempt，并原子重排或终结 Job；
 * 不处理 HTTP、Worker 轮询、领域工具或模型调用。
 * @module modules/job/job-surrender-repository-support
 * @author AI生成
 * @created 2026-07-25
 * @relatedPlan N/A - Worker 瞬时错误显式 surrender
 *
 * 调用关系：JobRepository.surrender 委托本文件；WorkerHost 只在 Handler 抛出 429/5xx 且租约
 * 心跳仍可信时调用公开内部 endpoint。副作用均在单一数据库事务中完成。
 * 安全边界：必须按数据库时间复核 owner/leaseId/期限；旧 attempt、过期 lease 或不确定 complete
 * 不得重排。重试时间由 Server 固定，Worker 不能选择；耗尽时必须同步收口 Run 与 package。
 */
import { eq, sql } from "drizzle-orm";
import type { DatabaseService } from "../../common/db/database.service.js";
import { jobs, runs } from "../../common/db/schema.js";
import { closeJobAttempt } from "./job-attempt-close.repository-support.js";
import type { SurrenderJobInput } from "./job.contracts.js";
import { validateLeaseMutation } from "./job-lease.js";
import { databaseNow } from "./job-run-event.repository-support.js";
import { finalizeRunIfComplete } from "./job-run-status.repository-support.js";
import { advanceProfessionPackageStage } from "./job-profession-completion.repository-support.js";
import { prepareStylePackageCompletion } from "./job-style-package-completion.repository-support.js";

export type SurrenderJobResult =
  | { status: "lease-mismatch" | "protocol-upgrade-required" }
  | { status: "requeued" | "failed" };

/**
 * 关闭当前 attempt；未耗尽时按数据库时间延后重排，耗尽时将 Job/Run 收口为 failed。
 * @param connection 应用共享数据库连接；本函数自行建立事务与锁。
 * @param jobId 当前 leased Job UUID。
 * @param input 当前 Worker、必填 leaseId 与脱敏稳定错误码。
 * @returns requeued、failed 或 lease fencing 拒绝状态。
 */
export async function surrenderJobAttempt(
  connection: DatabaseService,
  jobId: string,
  input: SurrenderJobInput,
): Promise<SurrenderJobResult> {
  return connection.database.transaction(async (transaction) => {
    const [job] = await transaction
      .select()
      .from(jobs)
      .where(eq(jobs.id, jobId))
      .limit(1)
      .for("update");
    if (!job) return { status: "lease-mismatch" };
    const now = await databaseNow(transaction);
    const leaseStatus = validateLeaseMutation(job, input, now);
    if (leaseStatus !== "accepted") return { status: leaseStatus };

    const exhausted = job.attemptCount >= job.maxAttempts;
    if (exhausted) {
      await transaction
        .select({ id: runs.id })
        .from(runs)
        .where(eq(runs.id, job.runId))
        .limit(1)
        .for("update");
    }
    await closeJobAttempt(transaction, job, now, "failed", input.errorCode);
    await transaction
      .update(jobs)
      .set({
        status: exhausted ? "failed" : "queued",
        leaseOwnerId: null,
        leaseId: null,
        leaseExpiresAt: null,
        dispatchReadyAt: exhausted
          ? job.dispatchReadyAt
          : sql`DATE_ADD(${now}, INTERVAL 5 SECOND)`,
        updatedAt: now,
      })
      .where(eq(jobs.id, jobId));
    if (!exhausted) return { status: "requeued" };

    await advanceProfessionPackageStage(transaction, job, "failed", now);
    await prepareStylePackageCompletion(
      transaction,
      job,
      { ...input, status: "failed" },
      now,
    );
    await finalizeRunIfComplete(transaction, job.runId, now);
    return { status: "failed" };
  });
}
