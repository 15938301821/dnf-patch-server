/**
 * @fileoverview 验证 Worker 新任务能力门禁会排除离线注册记录；不连接真实 MySQL，也不验证租约回收。
 * @module worker
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - 真实运行查漏补缺
 *
 * 调用关系：测试直接调用 WorkerService，并用最小 Drizzle 查询替身返回数据库行。
 * 输入输出：输入注册能力与心跳时间，断言新任务能力查询的布尔结果。
 * 副作用：无数据库写入；固定系统时间仅作用于当前测试。
 * 安全边界：缺失或过期心跳必须 fail-closed，不能让历史注册记录证明 Worker 当前在线。
 */
import type { DatabaseService } from "../../common/db/database.service.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkerService } from "./worker.service.js";

interface CapabilityRow {
  capabilities: string[];
  lastHeartbeatAt: Date | null;
}

function serviceWithRows(rows: CapabilityRow[]): WorkerService {
  const where = vi.fn().mockResolvedValue(rows);
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  const connection = {
    database: { select },
  } as unknown as DatabaseService;
  return new WorkerService(connection);
}

describe("WorkerService.hasEnabledCapability", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("仅接受最近一分钟内仍有心跳且声明目标能力的 Worker", async () => {
    // Drizzle 替身只验证 Service 的 fail-closed 分支；真实 MySQL 查询仍由运行门禁单独证明。
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-23T12:00:00.000Z"));
    const service = serviceWithRows([
      {
        capabilities: ["inventory"],
        lastHeartbeatAt: new Date("2026-07-23T11:58:59.000Z"),
      },
      {
        capabilities: ["inventory"],
        lastHeartbeatAt: null,
      },
      {
        capabilities: ["profession"],
        lastHeartbeatAt: new Date("2026-07-23T11:59:30.000Z"),
      },
    ]);

    await expect(service.hasEnabledCapability("inventory")).resolves.toBe(
      false,
    );
    await expect(service.hasEnabledCapability("profession")).resolves.toBe(
      true,
    );
  });
});
