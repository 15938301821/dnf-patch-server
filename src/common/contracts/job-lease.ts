/**
 * @fileoverview 定义跨领域持久化写入使用的精确 Job 租约判定；不提供首次 attempt 的旧协议兼容。
 * @module common/contracts
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - Worker Inventory 直接实施需求
 *
 * 调用关系：持久化证据的 Service/Repository 将数据库 Job 状态与已校验 Worker DTO 传给
 * hasExactJobLease。输入是当前权威租约、请求租约和数据库时间，输出仅为布尔决策，无副作用。
 * 安全边界：lease 是 Worker 对 Job 的限时执行权，leaseId 是阻止旧执行轮次写入的唯一 fencing
 * 编号；缺少或不匹配任一字段都必须 fail-closed，不得采用首次 attempt 的兼容放宽。
 */

/**
 * 从数据库 Job 行读取的精确租约状态；生产方必须在同一 transaction 中读取后再执行证据写入。
 */
export interface ExactJobLeaseState {
  /** 只有 `leased` 允许写入；终态或排队态不能复用旧凭据。 */
  status: string;
  /** 当前租约所属 Worker；必须与认证上下文中的稳定 Worker ID 一致。 */
  leaseOwnerId: string | null;
  /** 当前 attempt 的不可预测 fencing 编号；重领 Job 时必须变化。 */
  leaseId: string | null;
  /** 数据库记录的到期时间；必须严格晚于同源数据库当前时间。 */
  leaseExpiresAt: Date | null;
  /** Job 已被领取的轮次；必须与 Artifact 或其他证据声明的 attempt 相同。 */
  attemptCount: number;
}

/** 由严格 Worker DTO 与认证 Guard 共同生产的当前写入声明。 */
export interface ExactJobLeaseInput {
  /** 认证后的 Worker ID，不得取自任意业务 payload。 */
  workerId: string;
  /** DTO 中必填的当前 fencing 编号；证据写入不支持省略。 */
  leaseId: string;
  /** DTO 中的领取轮次，与 `leaseId` 共同绑定一次执行。 */
  attempt: number;
}

/**
 * 对带副作用的 Worker 证据写入强制校验 owner、fencing token、attempt 与数据库时间。
 * 与心跳兼容契约不同，此处不允许省略 leaseId，避免旧 attempt 写入新租约的 Run。
 *
 * @param job transaction 内读取的权威 Job 租约状态，尚未授权当前写入。
 * @param input 经 Worker token Guard 和 DTO schema 校验的请求身份、leaseId 与 attempt。
 * @param now 与 Job 查询同一数据库时间语义下的当前时刻，避免服务进程时钟漂移。
 * @returns 仅当状态、owner、编号、轮次和未过期条件全部成立时返回 true；不证明证据内容有效。
 */
export function hasExactJobLease(
  job: ExactJobLeaseState,
  input: ExactJobLeaseInput,
  now: Date,
): boolean {
  return (
    job.status === "leased" &&
    job.leaseOwnerId === input.workerId &&
    job.leaseId === input.leaseId &&
    job.attemptCount === input.attempt &&
    job.leaseExpiresAt !== null &&
    job.leaseExpiresAt.getTime() > now.getTime()
  );
}
