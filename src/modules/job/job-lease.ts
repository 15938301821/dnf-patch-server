export type LeaseMutationStatus =
  | "accepted"
  | "lease-mismatch"
  | "protocol-upgrade-required";

export interface JobLeaseState {
  status: string;
  leaseOwnerId: string | null;
  leaseId: string | null;
  leaseExpiresAt: Date | null;
  attemptCount: number;
}

export interface LeaseMutationInput {
  workerId: string;
  leaseId?: string | undefined;
}

/**
 * 首次 attempt 暂时兼容未携带 leaseId 的 v1 Worker；发生重领后必须使用
 * 最新 fencing token，避免旧 Worker 心跳或提交覆盖新 attempt。
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
