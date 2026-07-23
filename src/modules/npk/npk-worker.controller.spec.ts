/**
 * @fileoverview 验证 Worker Inventory HTTP 边界的守卫和委托；不覆盖事务持久化。
 * @module npk
 * @author AI生成
 * @created 2026-07-23
 * @relatedPlan N/A - Worker Inventory 直接实施需求
 */
import { GUARDS_METADATA } from "@nestjs/common/constants.js";
import { describe, expect, it, vi } from "vitest";
import { WorkerTokenGuard } from "../../common/security/worker-token.guard.js";
import type { NpkService } from "./npk.service.js";
import { NpkWorkerController } from "./npk-worker.controller.js";

describe("NpkWorkerController", () => {
  it("requires the Worker token guard", () => {
    const guards = Reflect.getMetadata(GUARDS_METADATA, NpkWorkerController) as
      | unknown[]
      | undefined;

    expect(guards).toContain(WorkerTokenGuard);
  });

  it("delegates without accepting project or run identifiers", async () => {
    const createFromWorker = vi.fn().mockResolvedValue({ id: "inventory-id" });
    const controller = new NpkWorkerController({
      createFromWorker,
    } as unknown as NpkService);
    const input = {
      workerId: "11111111-1111-4111-8111-111111111111",
      leaseId: "22222222-2222-4222-8222-222222222222",
      attempt: 1,
      inventoryArtifactId: "33333333-3333-4333-8333-333333333333",
      sourceLabel: "verified-source",
      sourceLength: 1,
      sourceSha256: "A".repeat(64),
      entries: [
        {
          internalPath: "fx/frame.png",
          imgVersion: 1,
          frameCount: 1,
          metadataSha256: "B".repeat(64),
        },
      ],
    };

    await expect(controller.create("job-id", input)).resolves.toEqual({
      id: "inventory-id",
    });
    expect(createFromWorker).toHaveBeenCalledWith("job-id", input);
    expect(input).not.toHaveProperty("projectId");
    expect(input).not.toHaveProperty("runId");
  });
});
