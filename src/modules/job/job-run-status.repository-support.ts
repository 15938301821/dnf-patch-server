/**
 * @fileoverview 在已锁定 Run 的 Job 事务中推进 Run 状态并追加权威事件；不领取、续租、完成或回收 Job。
 * @module modules/job/job-run-status-repository-support
 * @author AI生成
 * @created 2026-07-25
 * @relatedPlan N/A - Job Repository 职责收敛
 *
 * 调用关系：JobRepository 在 claim、complete 和 lease reaper 的同一事务中调用本文件。输入为已验证
 * 的 Run id 与数据库时间，输出为可选的权威 Run 事件。副作用：只更新 runs 并写入 run_events/outbox。
 * 安全边界：只允许 queued/running Run 的单向推进，状态必须从同 Run 全部 Job 的数据库终态聚合，
 * 不依赖 Worker 自报或内存状态。
 */
import { and, eq, inArray } from "drizzle-orm";
import { jobs, runs } from "../../common/db/schema.js";
import type { RunEventView } from "../run/run.contracts.js";
import {
  appendJobRunEvent,
  type JobTransaction,
} from "./job-run-event.repository-support.js";
import { aggregateRunStatus } from "./run-status.js";

/** 将仍 queued 的 Run 推进为 running，并追加首个 Worker 领取事件。 */
export async function markRunRunning(
  transaction: JobTransaction,
  runId: string,
  now: Date,
): Promise<RunEventView | undefined> {
  const result = await transaction
    .update(runs)
    .set({ status: "running", currentStage: "worker", updatedAt: now })
    .where(and(eq(runs.id, runId), eq(runs.status, "queued")));
  if (result[0].affectedRows !== 1) return undefined;
  return appendJobRunEvent(
    transaction,
    runId,
    "info",
    "worker",
    "Worker 已领取首个任务，Run 进入执行状态。",
    now,
  );
}

/** 仅当同一 Run 的全部 Job 已终态时，按失败优先级收口 Run 并记录权威事件。 */
export async function finalizeRunIfComplete(
  transaction: JobTransaction,
  runId: string,
  now: Date,
): Promise<RunEventView | undefined> {
  const rows = await transaction
    .select({ id: jobs.id, status: jobs.status })
    .from(jobs)
    .where(eq(jobs.runId, runId));
  const status = aggregateRunStatus(rows.map((row) => row.status));
  if (!status) return undefined;
  const updateResult = await transaction
    .update(runs)
    .set({ status, currentStage: status, updatedAt: now, finishedAt: now })
    .where(
      and(eq(runs.id, runId), inArray(runs.status, ["queued", "running"])),
    );
  if (updateResult[0].affectedRows !== 1) return undefined;
  const level =
    status === "failed" ? "error" : status === "blocked" ? "warning" : "info";
  return appendJobRunEvent(
    transaction,
    runId,
    level,
    status,
    runFinalMessage(status),
    now,
  );
}

function runFinalMessage(status: "passed" | "failed" | "blocked"): string {
  if (status === "passed") return "Run 的全部 Worker 任务已通过。";
  if (status === "blocked")
    return "Run 的 Worker 任务已完成，但至少一个任务被阻断。";
  return "Run 的 Worker 任务已完成，但至少一个任务失败。";
}
