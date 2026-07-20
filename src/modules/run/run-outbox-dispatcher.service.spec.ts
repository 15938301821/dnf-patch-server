/**
 * @fileoverview 验证 Run outbox 的严格 payload 校验、发布顺序与成功后条件标记。
 * @module run
 * @author AI生成
 * @created 2026-07-20
 * @relatedPlan /memories/session/plan.md Phase 2 transactional outbox
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RunOutboxDispatcherService } from "./run-outbox-dispatcher.service.js";
import type { PendingOutboxRow } from "./run-outbox.repository.js";

describe("RunOutboxDispatcherService", () => {
  const outbox = { listPending: vi.fn(), markPublished: vi.fn() };
  const publisher = { publishRunEvent: vi.fn() };
  const config = {
    getOrThrow: vi.fn((key: string) =>
      key === "OUTBOX_DISPATCH_BATCH_SIZE" ? 25 : 1_000,
    ),
  };
  let dispatcher: RunOutboxDispatcherService;

  beforeEach(() => {
    vi.resetAllMocks();
    dispatcher = new RunOutboxDispatcherService(outbox, publisher, config);
    outbox.markPublished.mockResolvedValue(true);
  });

  it("按顺序发布有效事件并在广播后标记完成", async () => {
    const first = pendingRow(0);
    const second = pendingRow(1);
    outbox.listPending.mockResolvedValue([first, second]);

    await expect(dispatcher.dispatchPending()).resolves.toBe(2);

    expect(publisher.publishRunEvent.mock.calls).toEqual([
      [first.aggregateId, first.payload],
      [second.aggregateId, second.payload],
    ]);
    expect(outbox.markPublished.mock.calls).toEqual([[first.id], [second.id]]);
    expect(publisher.publishRunEvent.mock.invocationCallOrder[0]).toBeLessThan(
      outbox.markPublished.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("拒绝 aggregateId 与 payload runId 不一致的 outbox", async () => {
    const row = pendingRow(0);
    outbox.listPending.mockResolvedValue([
      { ...row, aggregateId: crypto.randomUUID() },
    ]);

    await expect(dispatcher.dispatchPending()).rejects.toThrow(
      "RUN_OUTBOX_PAYLOAD_INVALID",
    );
    expect(publisher.publishRunEvent).not.toHaveBeenCalled();
    expect(outbox.markPublished).not.toHaveBeenCalled();
  });

  it("广播后标记失败时保留错误以便重试", async () => {
    const row = pendingRow(0);
    outbox.listPending.mockResolvedValue([row]);
    outbox.markPublished.mockResolvedValue(false);

    await expect(dispatcher.dispatchPending()).rejects.toThrow(
      "RUN_OUTBOX_STATE_CONFLICT",
    );
    expect(publisher.publishRunEvent).toHaveBeenCalledOnce();
  });
});

function pendingRow(sequence: number): PendingOutboxRow {
  const runId = crypto.randomUUID();
  return {
    id: crypto.randomUUID(),
    topic: "run.event",
    aggregateId: runId,
    payload: {
      runId,
      sequence,
      level: "info",
      stage: "worker",
      message: "Bounded runtime event.",
      createdAtUtc: new Date().toISOString(),
    },
  };
}
