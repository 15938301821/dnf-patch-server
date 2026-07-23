/**
 * @fileoverview 验证跨领域证据写入的精确租约 fencing；不测试 Job 心跳兼容协议。
 * @module common/contracts
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - Worker Inventory 直接实施需求
 *
 * 调用关系：Vitest 用内存对象直接调用纯函数，不经过 Guard、DTO、Repository 或 MySQL。
 * 输入是固定测试时刻与伪造租约，输出是布尔判定；无数据库或网络副作用。
 * 安全边界：覆盖旧 attempt、错误 fencing 编号、过期与非 leased 状态；未证明真实 transaction
 * 行锁、数据库时间或 Worker 认证，相关运行语义仍需 MySQL 集成测试。
 */
import { describe, expect, it } from "vitest";
import {
  hasExactJobLease,
  type ExactJobLeaseInput,
  type ExactJobLeaseState,
} from "./job-lease.js";

/** 固定比较时刻，避免测试依赖机器时钟；不是租约生产配置。 */
const now = new Date("2026-07-23T00:00:00.000Z");

describe("hasExactJobLease", () => {
  // 防止旧 Worker attempt 或伪造 leaseId 向当前 Run 写入证据。
  it("accepts only the current owner, fencing token and attempt", () => {
    expect(hasExactJobLease(activeLease(), currentLease(), now)).toBe(true);
    expect(
      hasExactJobLease(activeLease(), { ...currentLease(), attempt: 1 }, now),
    ).toBe(false);
    expect(
      hasExactJobLease(
        activeLease(),
        { ...currentLease(), leaseId: "other-lease" },
        now,
      ),
    ).toBe(false);
  });

  // 到期或终态 Job 必须拒绝，且纯函数拒绝路径不会产生任何持久化副作用。
  it("rejects expired and non-leased jobs", () => {
    expect(
      hasExactJobLease(
        { ...activeLease(), leaseExpiresAt: now },
        currentLease(),
        now,
      ),
    ).toBe(false);
    expect(
      hasExactJobLease(
        { ...activeLease(), status: "passed" },
        currentLease(),
        now,
      ),
    ).toBe(false);
  });
});

/** @returns 模拟数据库当前行的第二次有效租约；不代表真实行锁已建立。 */
function activeLease(): ExactJobLeaseState {
  return {
    status: "leased",
    leaseOwnerId: "worker-a",
    leaseId: "lease-a",
    leaseExpiresAt: new Date("2026-07-23T00:01:00.000Z"),
    attemptCount: 2,
  };
}

/** @returns 模拟已通过 DTO 校验的当前 Worker 写入声明。 */
function currentLease(): ExactJobLeaseInput {
  return { workerId: "worker-a", leaseId: "lease-a", attempt: 2 };
}
