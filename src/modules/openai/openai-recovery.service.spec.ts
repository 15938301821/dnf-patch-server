/**
 * @fileoverview 验证启动恢复器按最大模型调用窗口回收 stale running 记录。
 * @module openai
 * @author AI生成
 * @created 2026-07-20
 * @relatedPlan /memories/session/plan.md Phase 2 model evidence
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAiRecoveryService } from "./openai-recovery.service.js";

describe("OpenAiRecoveryService", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses timeout multiplied by all provider attempts", async () => {
    const calls = { abandonStale: vi.fn().mockResolvedValue(2) };
    const config = {
      getOrThrow: vi.fn((key: string) =>
        key === "OPENAI_REQUEST_TIMEOUT_MS" ? 10_000 : 2,
      ),
    };
    const service = new OpenAiRecoveryService(calls, config);

    await service.onApplicationBootstrap();

    expect(calls.abandonStale).toHaveBeenCalledWith(30_000);
  });

  it("keeps degraded startup alive and retries after a database failure", async () => {
    vi.useFakeTimers();
    const calls = {
      abandonStale: vi
        .fn()
        .mockRejectedValueOnce(new Error("database unavailable"))
        .mockResolvedValueOnce(1),
    };
    const config = {
      getOrThrow: vi.fn((key: string) =>
        key === "OPENAI_REQUEST_TIMEOUT_MS" ? 10_000 : 2,
      ),
    };
    const service = new OpenAiRecoveryService(calls, config);

    await expect(service.onApplicationBootstrap()).resolves.toBeUndefined();
    expect(calls.abandonStale).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5_000);

    expect(calls.abandonStale).toHaveBeenCalledTimes(2);
    service.onModuleDestroy();
  });
});
