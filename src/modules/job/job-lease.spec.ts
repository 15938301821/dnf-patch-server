import { describe, expect, it } from "vitest";
import { type JobLeaseState, validateLeaseMutation } from "./job-lease.js";

const now = new Date("2026-01-01T00:00:00.000Z");

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
