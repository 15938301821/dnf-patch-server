/**
 * @fileoverview 在 Job complete 事务中准备 Profession 专属终态：passed 时复核全部技能证据与
 * Server 摘要，非 passed 时关闭当前 attempt 尚未完成的模型执行，并在完成后收口未生成的 package；
 * 不更新 Job、attempt 或 Run。
 * @module modules/job/job-profession-completion-repository-support
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 当前 Profession Worker 纵向闭环直接需求
 *
 * 调用关系：JobRepository 已锁定 Job/Run 并验证当前 lease 后调用；accepted 时由调用方继续写终态，
 * evidence-incomplete 时必须原样返回且零写入。事务与锁由调用方拥有，所有操作随 complete 原子提交。
 */
import { and, eq, inArray } from "drizzle-orm";
import { stylePackages } from "../../common/db/style-package-schema.js";
import type { jobs } from "../../common/db/schema.js";
import { invalidateProfessionModelExecutions } from "./job-attempt-close.repository-support.js";
import type { CompleteJobInput } from "./job.contracts.js";
import type { JobTransaction } from "./job-run-event.repository-support.js";
import { resolveProfessionCompletionInTransaction } from "./profession-completion.repository-support.js";

/** Profession 完成准备结果；accepted 的摘要只能来自 Server 持久化证据复算。 */
export type PrepareProfessionCompletionResult =
  | { status: "accepted"; resultSha256?: string }
  | { status: "evidence-incomplete" };

/**
 * 为当前 Job 终态执行 Profession 专属前置动作。
 * @param transaction 调用方已持有 Job 与 Run 行锁的 complete 事务。
 * @param job 当前锁定 Job；非 profession 时无操作接受。
 * @param input 已通过 DTO 与精确 lease 校验的 Worker 完成请求。
 * @param now 同一事务读取的数据库时间，供非 passed 模型执行失效使用。
 * @returns passed 证据完整时返回 Server 摘要；摘要缺失/漂移返回 evidence-incomplete；其他 kind 无摘要。
 */
export async function prepareProfessionCompletion(
  transaction: JobTransaction,
  job: typeof jobs.$inferSelect,
  input: CompleteJobInput,
  now: Date,
): Promise<PrepareProfessionCompletionResult> {
  if (job.kind !== "profession") return { status: "accepted" };
  if (input.status !== "passed") {
    await invalidateProfessionModelExecutions(transaction, job, now);
    return { status: "accepted" };
  }
  const completion = await resolveProfessionCompletionInTransaction(
    transaction,
    job,
  );
  if (
    completion.status !== "accepted" ||
    completion.progress.resultSha256 === undefined ||
    completion.progress.resultSha256 !== input.resultSha256?.toUpperCase()
  ) {
    return { status: "evidence-incomplete" };
  }
  return {
    status: "accepted",
    resultSha256: completion.progress.resultSha256,
  };
}

/**
 * 将当前没有最终 package 证据的 Profession 聚合行收口为终态。
 * @param transaction 调用方已持有 Job 与 Run 行锁的 complete 事务。
 * @param job 当前锁定 Job；非 profession 时不写入。
 * @param jobStatus 已通过精确 lease 和完成证据门禁的 Job 终态。
 * @param now 同一事务读取的数据库时间。
 * @returns package 更新完成后结算；既有 package 终态不会被覆盖。
 * @remarks `passed` 只证明逐技能双 Artifact 完整；在没有 package Handler 的当前架构中必须把
 * 未完成 package 标为 blocked，不能让浏览器显示 100% 排队中或伪造可下载产物。
 */
export async function closeProfessionPackageWithoutArtifact(
  transaction: JobTransaction,
  job: typeof jobs.$inferSelect,
  jobStatus: CompleteJobInput["status"],
  now: Date,
): Promise<void> {
  if (job.kind !== "profession") return;
  await transaction
    .update(stylePackages)
    .set({
      status: jobStatus === "passed" ? "blocked" : jobStatus,
      updatedAt: now,
      finishedAt: now,
    })
    .where(
      and(
        eq(stylePackages.runId, job.runId),
        inArray(stylePackages.status, ["queued", "building"]),
      ),
    );
}
