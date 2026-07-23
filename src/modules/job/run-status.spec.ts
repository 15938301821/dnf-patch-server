/**
 * @fileoverview 验证 Run 只在所有 Job 终态后聚合，并保持 failed > blocked > passed 的安全优先级；
 * 不连接数据库、不更新 Run、不写事件/outbox、不领取或完成 Worker Job。
 * @module modules/job/run-status.spec
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 用户直接需求
 *
 * 调用关系：Vitest 直接调用纯函数 aggregateRunStatus，没有 JobRepository、RunRepository 或数据库 mock。
 * 输入输出：输入是内存状态数组，输出是终态或 undefined；不证明真实事务锁、Job 查询完整性或事件顺序。
 * 副作用：无网络、数据库、对象存储、计时器、Worker 或进程副作用。
 * 安全边界：测试防止 queued/leased/空 Job 被过早标记完成，也防止 failed 被 blocked/passed 掩盖。
 */
import { describe, expect, it } from "vitest";
import { aggregateRunStatus } from "./run-status.js";

describe("aggregateRunStatus", () => {
  it("waits until every job reaches a terminal state", () => {
    expect(aggregateRunStatus([])).toBeUndefined();
    expect(aggregateRunStatus(["passed", "queued"])).toBeUndefined();
    expect(aggregateRunStatus(["passed", "leased"])).toBeUndefined();
  });

  it("passes only when every job passes", () => {
    expect(aggregateRunStatus(["passed", "passed"])).toBe("passed");
  });

  it("gives failure precedence over blocked jobs", () => {
    expect(aggregateRunStatus(["passed", "blocked"])).toBe("blocked");
    expect(aggregateRunStatus(["blocked", "failed"])).toBe("failed");
  });
});
