/**
 * @fileoverview 关闭当前 Job attempt，并使同一 attempt 尚未完成的 Profession 模型执行失效；
 * 不领取新任务、不决定 Job/Run 终态，也不提交独立事务。
 * @module modules/job
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 当前 Profession 单技能真实生产链补全
 *
 * 调用关系：JobRepository 在已持有 Job 行锁的 claim/reaper 流程中调用；调用方提供现有
 * transaction，因此 attempt 与模型执行状态要么一并提交、要么一并回滚。
 * 输入输出：输入锁定的 Job 行、数据库时间和受限终态；完成后无返回值。
 * 安全边界：必须按精确 jobId + attempt 关闭 running attempt，并把同轮 prepared/egressing/
 * persisting 执行标记为 indeterminate，防止旧 lease 在重领后继续写入。
 */
import { and, eq, inArray } from "drizzle-orm";
import { jobAttempts } from "../../common/db/schema.js";
import type { jobs } from "../../common/db/schema.js";
import { professionSkillModelExecutions } from "../../common/db/profession-model-execution-schema.js";
import type { JobTransaction } from "./job-run-event.repository-support.js";

/**
 * 以受限终态关闭仍 running 的当前 attempt，并终结其未完成模型执行。
 *
 * @param transaction JobRepository 已建立的事务和 Job 行锁边界。
 * @param job 当前锁定 Job；attemptCount 为零时没有可关闭的领取记录。
 * @param now 从数据库读取的统一时间，供 attempt 与模型执行共享终结时间。
 * @param status 完整性失败使用 blocked，lease 过期使用 timed_out。
 * @param errorCode 与 status 对应的稳定原因，不包含数据库或 Worker 原始错误。
 * @returns 两组更新完成后 resolve；不会创建新 attempt 或直接重排 Job。
 */
export async function closeJobAttempt(
  transaction: JobTransaction,
  job: typeof jobs.$inferSelect,
  now: Date,
  status: "blocked" | "timed_out",
  errorCode: "JOB_INTEGRITY_FAILED" | "LEASE_EXPIRED",
): Promise<void> {
  if (job.attemptCount === 0) return;
  await transaction
    .update(jobAttempts)
    .set({ status, errorCode, finishedAt: now })
    .where(
      and(
        eq(jobAttempts.jobId, job.id),
        eq(jobAttempts.attempt, job.attemptCount),
        eq(jobAttempts.status, "running"),
      ),
    );
  await invalidateProfessionModelExecutions(transaction, job, now);
}

/**
 * 把当前 attempt 尚未完成的 Profession 模型执行标为不确定，阻止 Job 终态后继续持久化旧出站。
 * @param transaction 调用方持有 Job 行锁的事务；更新必须与 Job/attempt 终态原子提交。
 * @param job 当前锁定 Job，jobId 与 attemptCount 限定唯一执行轮次。
 * @param now 同一事务取得的数据库时间，供模型执行终态共享。
 */
export async function invalidateProfessionModelExecutions(
  transaction: JobTransaction,
  job: typeof jobs.$inferSelect,
  now: Date,
): Promise<void> {
  if (job.attemptCount === 0) return;
  await transaction
    .update(professionSkillModelExecutions)
    .set({
      status: "indeterminate",
      errorCode: "PROFESSION_EXECUTION_ATTEMPT_CLOSED",
      updatedAt: now,
      finishedAt: now,
    })
    .where(
      and(
        eq(professionSkillModelExecutions.jobId, job.id),
        eq(professionSkillModelExecutions.attempt, job.attemptCount),
        inArray(professionSkillModelExecutions.status, [
          "prepared",
          "egressing",
          "persisting",
        ]),
      ),
    );
}
