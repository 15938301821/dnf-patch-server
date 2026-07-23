/**
 * @fileoverview 验证 Job lease fencing 的首次 attempt 兼容、重领升级、owner/token/过期拒绝规则；不连接
 * MySQL、不领取或完成 Job、不启动 Worker，也不验证真实系统时钟。
 * @module modules/job/lease.spec
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：Vitest 直接调用纯函数 validateLeaseMutation，没有 JobRepository、JobService、Controller 或
 * WorkerTokenGuard。fixture 模拟已锁定 Job 与数据库时间的最小快照。
 * 输入输出：输入是内存 lease 状态、Worker 身份/token 与固定时间；输出是有限 mutation 状态；不证明真实
 * MySQL `FOR UPDATE`、数据库时间查询、并发 claim 或 HTTP 错误映射。
 * 副作用：无数据库、网络、对象存储、本机工具或计时器副作用。
 * 安全边界：测试防止旧 Worker 在重领后凭缺失/旧 token 续期或完成 Job，首 attempt 的兼容不能扩展到重试。
 */
import { describe, expect, it } from "vitest";
import { type JobLeaseState, validateLeaseMutation } from "./job-lease.js";

/** 作为 Repository 数据库时间的固定替身，避免依赖测试运行机的本地时钟。 */
const now = new Date("2026-01-01T00:00:00.000Z");

/**
 * 构造最小有效 leased Job 快照。
 * @param overrides 覆盖单一 lease 字段以测试拒绝边界。
 * @returns 不含 payload/数据库行细节的 JobLeaseState fixture。
 */
function activeLease(overrides: Partial<JobLeaseState> = {}): JobLeaseState {
  return {
    status: "leased",
    leaseOwnerId: "worker-a",
    leaseId: "lease-current",
    leaseExpiresAt: new Date("2026-01-01T00:01:00.000Z"),
    attemptCount: 1,
    ...overrides,
  };
}

describe("validateLeaseMutation", () => {
  it("暂时兼容首次 attempt 未提交 leaseId", () => {
    expect(
      validateLeaseMutation(activeLease(), { workerId: "worker-a" }, now),
    ).toBe("accepted");
  });

  it("重领后要求 Worker 升级 fencing 协议", () => {
    expect(
      validateLeaseMutation(
        activeLease({ attemptCount: 2 }),
        { workerId: "worker-a" },
        now,
      ),
    ).toBe("protocol-upgrade-required");
  });

  it("拒绝旧 token、错误 owner 和过期租约", () => {
    expect(
      validateLeaseMutation(
        activeLease({ attemptCount: 2 }),
        { workerId: "worker-a", leaseId: "lease-stale" },
        now,
      ),
    ).toBe("lease-mismatch");
    expect(
      validateLeaseMutation(
        activeLease(),
        { workerId: "worker-b", leaseId: "lease-current" },
        now,
      ),
    ).toBe("lease-mismatch");
    expect(
      validateLeaseMutation(
        activeLease({ leaseExpiresAt: now }),
        { workerId: "worker-a", leaseId: "lease-current" },
        now,
      ),
    ).toBe("lease-mismatch");
  });

  it("只接受当前有效 token", () => {
    expect(
      validateLeaseMutation(
        activeLease({ attemptCount: 2 }),
        { workerId: "worker-a", leaseId: "lease-current" },
        now,
      ),
    ).toBe("accepted");
  });
});
