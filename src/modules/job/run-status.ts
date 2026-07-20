export type TerminalRunStatus = "passed" | "failed" | "blocked";

const terminalJobStatuses = new Set<TerminalRunStatus>([
  "passed",
  "failed",
  "blocked",
]);

/** 仅当全部任务都进入终态时聚合 Run；失败优先于阻断，阻断优先于通过。 */
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
