/**
 * @fileoverview 将同一 Run 的全部 Job 状态聚合为终态；不查询数据库、不更新 Run、不写事件或 outbox。
 * @module modules/job/run-status
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：JobRepository 在同一事务内完成/回收 Job 后调用 aggregateRunStatus，再决定是否将 Run 写为
 * 终态并追加权威事件。纯函数不拥有行锁，调用方必须确保状态读取与写入处于正确事务边界。
 * 输入输出：输入是一组 jobs.status 字符串，输出是 terminal status 或 undefined；不返回 Job/Run 数据库行。
 * 副作用：纯内存聚合，无数据库、网络、Worker、事件或调度副作用。
 * 安全边界：只要存在 queued/leased/未知状态或没有 Job 就不能终结 Run；终态优先级为 failed > blocked >
 * passed，防止失败被安全阻断或成功状态掩盖。
 */
export type TerminalRunStatus = "passed" | "failed" | "blocked";

/** 允许参与终态聚合的 Job 状态集合；新状态必须显式加入而不是被默认为完成。 */
const terminalJobStatuses = new Set<TerminalRunStatus>([
  "passed",
  "failed",
  "blocked",
]);

/**
 * 聚合同一 Run 的 Job 状态。
 * @param jobStatuses 由当前 Run 的全部 Job 读取的状态；调用方不能只传局部页或单个 Job。
 * @returns 仅当所有 Job 都为已知终态时返回 passed/failed/blocked，否则 undefined。
 * @remarks 返回 undefined 是“继续等待”的明确结果，不应被调用方转换为成功或空 Run 已完成。
 */
export function aggregateRunStatus(
  jobStatuses: readonly string[],
): TerminalRunStatus | undefined {
  if (
    jobStatuses.length === 0 ||
    jobStatuses.some(
      (status) => !terminalJobStatuses.has(status as TerminalRunStatus),
    )
  ) {
    return undefined;
  }
  if (jobStatuses.includes("failed")) return "failed";
  if (jobStatuses.includes("blocked")) return "blocked";
  return "passed";
}
