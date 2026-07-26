/**
 * @fileoverview 在 Job complete 事务中复核 npk-package attempt 已封存的 V3 三 Artifact 证据；
 * 不读取对象正文、不调用封包工具，也不处理 HTTP 错误映射。
 * @module modules/job/job-style-package-completion-repository-support
 * @author AI生成
 * @created 2026-07-25
 * @relatedPlan N/A - Package V3 报告接收与 attempt 证据持久化
 *
 * 调用关系：JobRepository.complete 已锁定 Job 与 Run 后调用本文件；accepted 时由调用方继续写 Job
 * 终态和 Run 聚合。输入输出：输入是当前 Job、complete DTO 和数据库时间，输出是 accepted 摘要或证据
 * 不完整状态。副作用：通过时只更新 style_packages 聚合行，详细 attempt 证据已由报告端点封存。
 * 安全边界：Worker 不能仅凭 complete.resultSha256 通过；必须存在当前 workerId/leaseId/attempt 的
 * passed evidence，且候选 NPK、manifest、validation 三 Artifact/上传会话已由报告事务持久化。
 */
import { and, eq, inArray } from "drizzle-orm";
import {
  stylePackageAttemptEvidences,
  stylePackages,
} from "../../common/db/style-package-schema.js";
import type { jobs } from "../../common/db/schema.js";
import type { CompleteJobInput } from "./job.contracts.js";
import type { JobTransaction } from "./job-run-event.repository-support.js";

/** Package complete 前置校验结果；accepted 的 resultSha256 必须来自 validation Artifact。 */
export type PrepareStylePackageCompletionResult =
  | { status: "accepted"; resultSha256?: string }
  | { status: "evidence-incomplete" };

/**
 * 在Package Job已不可重试时关闭仍处于queued/building的聚合行。
 * @param transaction 调用方已持有当前Job与Run行锁的事务。
 * @param job 被服务端终结的Job；非npk-package时不写入。
 * @param status 只能是服务端已决定的failed或blocked，不接受Worker自报passed。
 * @param now 同一事务读取的数据库时间，用于终态时间戳。
 */
export async function closeStylePackageForTerminalJob(
  transaction: JobTransaction,
  job: typeof jobs.$inferSelect,
  status: "failed" | "blocked",
  now: Date,
): Promise<void> {
  if (job.kind !== "npk-package") return;
  await transaction
    .update(stylePackages)
    .set({ status, updatedAt: now, finishedAt: now })
    .where(
      and(
        eq(stylePackages.runId, job.runId),
        inArray(stylePackages.status, ["queued", "building"]),
      ),
    );
}

/**
 * 在当前 complete transaction 内验证并收口 Package V3 聚合状态。
 * @param transaction 调用方已持有 Job/Run row lock 的事务。
 * @param job 当前锁定 Job；非 npk-package 不做任何写入。
 * @param input Worker complete DTO；passed 时 resultSha256 必须匹配 validation 摘要。
 * @param now 同一事务数据库时间，用于 package 聚合 finishedAt。
 * @returns accepted 或 evidence-incomplete；不返回 Artifact URL、对象 key 或 provenance 正文。
 */
export async function prepareStylePackageCompletion(
  transaction: JobTransaction,
  job: typeof jobs.$inferSelect,
  input: CompleteJobInput,
  now: Date,
): Promise<PrepareStylePackageCompletionResult> {
  if (job.kind !== "npk-package") return { status: "accepted" };
  if (input.status !== "passed") {
    await closeStylePackageForTerminalJob(transaction, job, input.status, now);
    return { status: "accepted" };
  }
  const [evidence] = await transaction
    .select({
      packageArtifactId: stylePackageAttemptEvidences.packageArtifactId,
      manifestSha256: stylePackageAttemptEvidences.manifestSha256,
      validationSha256: stylePackageAttemptEvidences.validationSha256,
      status: stylePackageAttemptEvidences.status,
    })
    .from(stylePackageAttemptEvidences)
    .where(
      and(
        eq(stylePackageAttemptEvidences.runId, job.runId),
        eq(stylePackageAttemptEvidences.jobId, job.id),
        eq(stylePackageAttemptEvidences.workerId, input.workerId),
        ...(input.leaseId === undefined
          ? []
          : [eq(stylePackageAttemptEvidences.leaseId, input.leaseId)]),
        eq(stylePackageAttemptEvidences.attempt, job.attemptCount),
      ),
    )
    .limit(1)
    .for("update");
  if (!evidence || evidence.status !== "passed")
    return { status: "evidence-incomplete" };
  const packageArtifactId = evidence.packageArtifactId;
  const manifestSha256 = evidence.manifestSha256;
  const validationSha256 = evidence.validationSha256;
  if (
    packageArtifactId === null ||
    manifestSha256 === null ||
    validationSha256 === null
  ) {
    return { status: "evidence-incomplete" };
  }
  if (validationSha256.toUpperCase() !== input.resultSha256?.toUpperCase()) {
    return { status: "evidence-incomplete" };
  }
  await transaction
    .update(stylePackages)
    .set({
      status: "passed",
      packageArtifactId,
      manifestSha256: manifestSha256.toUpperCase(),
      updatedAt: now,
      finishedAt: now,
    })
    .where(eq(stylePackages.runId, job.runId));
  return {
    status: "accepted",
    resultSha256: validationSha256.toUpperCase(),
  };
}
