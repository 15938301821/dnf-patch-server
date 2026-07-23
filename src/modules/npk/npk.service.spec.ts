/**
 * @fileoverview 验证 NPK Inventory 的 producing Run、Artifact 归属和路径规范化边界。
 * @module npk
 * @author AI生成
 * @created 2026-07-20
 * @relatedPlan /memories/session/plan.md Phase 1 evidence ownership
 */
import { ConflictException, NotFoundException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  normalizeNpkInternalPath,
  type CreateInventoryInput,
  type CreateWorkerInventoryInput,
} from "./npk.contracts.js";
import { NpkService } from "./npk.service.js";

describe("NpkService evidence ownership", () => {
  const inventories = {
    create: vi.fn(),
    createFromWorker: vi.fn(),
    list: vi.fn(),
    findLatest: vi.fn(),
    findByRun: vi.fn(),
    findEntryEvidence: vi.fn(),
  };
  const runs = { get: vi.fn() };
  const artifacts = { findRunId: vi.fn() };
  let service: NpkService;

  beforeEach(() => {
    vi.resetAllMocks();
    service = new NpkService(inventories, runs, artifacts);
    runs.get.mockResolvedValue({ id: "run-a", projectId: "project-a" });
    artifacts.findRunId.mockResolvedValue("run-a");
    inventories.create.mockResolvedValue({ id: "inventory-a" });
  });

  it("拒绝不属于目标项目的 producing Run", async () => {
    runs.get.mockResolvedValue({ id: "run-b", projectId: "project-b" });
    await expect(
      service.create("project-a", inventoryInput()),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(inventories.create).not.toHaveBeenCalled();
  });

  it("拒绝缺失或跨 Run 的来源 Artifact", async () => {
    artifacts.findRunId.mockResolvedValue(undefined);
    await expect(
      service.create("project-a", inventoryInput()),
    ).rejects.toBeInstanceOf(NotFoundException);

    artifacts.findRunId.mockResolvedValue("run-b");
    await expect(
      service.create("project-a", inventoryInput()),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("对路径使用确定性的分隔符、Unicode 和大小写规范化", () => {
    expect(normalizeNpkInternalPath("FX\\A\u0308/Frame.PNG")).toBe(
      "fx/ä/frame.png",
    );
  });

  it("同项目同 Run 的 inventory 可以持久化", async () => {
    await expect(
      service.create("project-a", inventoryInput()),
    ).resolves.toEqual({ id: "inventory-a" });
    expect(inventories.create).toHaveBeenCalledWith(
      "project-a",
      "run-a",
      expect.any(String),
      expect.any(Object),
    );
  });

  it("使用精确 Worker 租约回填 inventory", async () => {
    inventories.createFromWorker.mockResolvedValue({
      status: "accepted",
      inventory: { id: "inventory-worker" },
    });

    await expect(
      service.createFromWorker("job-id", workerInventoryInput()),
    ).resolves.toEqual({ id: "inventory-worker" });
    expect(inventories.createFromWorker).toHaveBeenCalledWith(
      "job-id",
      expect.any(String),
      workerInventoryInput(),
    );
  });

  it.each([
    ["lease-mismatch", "JOB_LEASE_MISMATCH"],
    ["job-kind-mismatch", "INVENTORY_JOB_REQUIRED"],
    ["artifact-not-finalized", "INVENTORY_ARTIFACT_REQUIRED"],
  ] as const)("将 Worker 仓储状态 %s 映射为 %s", async (status, code) => {
    inventories.createFromWorker.mockResolvedValue({ status });

    await expect(
      service.createFromWorker("job-id", workerInventoryInput()),
    ).rejects.toMatchObject({ response: { code } });
  });
});

function inventoryInput(): CreateInventoryInput {
  return {
    runId: "run-a",
    sourceLabel: "verified-source",
    sourceLength: 1,
    sourceSha256: "A".repeat(64),
    inventoryArtifactId: "artifact-a",
    entries: [
      {
        internalPath: "FX\\Frame.PNG",
        imgVersion: 1,
        frameCount: 1,
        metadataSha256: "B".repeat(64),
      },
    ],
  };
}

function workerInventoryInput(): CreateWorkerInventoryInput {
  const input = inventoryInput();
  return {
    inventoryArtifactId: "33333333-3333-4333-8333-333333333333",
    workerId: "11111111-1111-4111-8111-111111111111",
    leaseId: "22222222-2222-4222-8222-222222222222",
    attempt: 1,
    sourceLabel: input.sourceLabel,
    sourceLength: input.sourceLength,
    sourceSha256: input.sourceSha256,
    entries: input.entries,
  };
}
