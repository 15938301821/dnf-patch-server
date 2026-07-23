/**
 * @fileoverview 定义 Worker 对已领取 Job 执行心跳/完成时的租约 fencing 校验；不查询数据库、不签发 lease、
 * 不改变 Job/Run 状态或执行 Worker 工具。
 * @module modules/job/lease
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：JobRepository 在事务中锁定 Job、读取数据库当前时间后调用 validateLeaseMutation；
 * JobService 将返回状态映射为稳定的 Worker HTTP 冲突错误。claim 路径生成 leaseId，本文件只验证它。
 * 输入输出：输入是锁定 Job 的最小 lease 快照、Worker 提交的 workerId/可选 leaseId 与数据库时间；输出是
 * 有限状态码，不返回 Job payload、数据库行、Worker token 或本机执行配置。
 * 副作用：纯内存判断，无数据库、网络、事件、outbox 或 Worker 副作用。
 * 安全边界：lease fencing 指同一 attempt 只能由持有当前 token 的 Worker 改动；首次 attempt 暂时兼容
 * v1 未传 token，重领后必须携带最新 leaseId，避免旧 Worker 的心跳/完成覆盖新 attempt。
 */
export type LeaseMutationStatus =
  | "accepted"
  | "lease-mismatch"
  | "protocol-upgrade-required";

/**
 * 进行 lease mutation 前从锁定 jobs 行取得的最小状态。
 * 时间必须来自同一数据库事务而非 Worker 或应用服务器本机时钟，否则过期判断会产生竞态。
 */
export interface JobLeaseState {
  status: string;
  leaseOwnerId: string | null;
  leaseId: string | null;
  leaseExpiresAt: Date | null;
  attemptCount: number;
}

/** Worker 心跳/完成 DTO 中与 lease 相关的最小字段，不包含 Job payload 或结果数据。 */
export interface LeaseMutationInput {
  workerId: string;
  leaseId?: string | undefined;
}

/**
 * 判断当前 Worker 能否修改已领取 Job 的租约状态。
 *
 * 步骤 1：要求 Job 仍是 leased、owner 相同且数据库时间尚未达到 expiresAt；步骤 2：首次 attempt 允许
 * 历史 v1 Worker 省略 leaseId；步骤 3：第二次及之后 attempt 必须提供并精确匹配当前 fencing token。
 * 返回拒绝时上游不得续期、完成 Job 或更新 attempt 记录。
 *
 * @param job 同一事务内锁定的 Job lease 快照。
 * @param input Worker 提交的身份和可选 leaseId，均不可信，必须逐项对比。
 * @param now 由数据库读取的权威当前时间。
 * @returns accepted、lease-mismatch 或 protocol-upgrade-required。
 */
export function validateLeaseMutation(
  job: JobLeaseState,
  input: LeaseMutationInput,
  now: Date,
): LeaseMutationStatus {
  if (
    job.status !== "leased" ||
    job.leaseOwnerId !== input.workerId ||
    !job.leaseExpiresAt ||
    job.leaseExpiresAt.getTime() <= now.getTime()
  ) {
    return "lease-mismatch";
  }
  if (!input.leaseId) {
    return job.attemptCount === 1 ? "accepted" : "protocol-upgrade-required";
  }
  return job.leaseId === input.leaseId ? "accepted" : "lease-mismatch";
}
