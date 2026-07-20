/**
 * @fileoverview 验证 Image Attempt 在写入前拒绝缺失或跨 Run 证据，不连接数据库。
 * @module image
 * @author AI生成
 * @created 2026-07-20
 * @relatedPlan /memories/session/plan.md Phase 1 evidence ownership
 */
import { ConflictException, NotFoundException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CreateImageAttemptInput } from "./image.contracts.js";
import { ImageService } from "./image.service.js";

describe("ImageService evidence ownership", () => {
  const repository = {
    create: vi.fn(),
    findArtifactRunId: vi.fn(),
    findModelCallRunId: vi.fn(),
  };
  const runs = { get: vi.fn() };
  let service: ImageService;

  beforeEach(() => {
    vi.resetAllMocks();
    service = new ImageService(repository, runs);
    runs.get.mockResolvedValue({ id: "run-a" });
  });

  it("拒绝不存在的模型调用", async () => {
    repository.findModelCallRunId.mockResolvedValue(undefined);
    await expect(
      service.create("run-a", imageInput({ modelCallId: crypto.randomUUID() })),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it("拒绝其他 Run 的输出 Artifact", async () => {
    repository.findArtifactRunId.mockResolvedValue("run-b");
    await expect(
      service.create(
        "run-a",
        imageInput({ outputArtifactId: crypto.randomUUID() }),
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(repository.create).not.toHaveBeenCalled();
  });

  it("同 Run 证据通过后写入", async () => {
    const modelCallId = crypto.randomUUID();
    const outputArtifactId = crypto.randomUUID();
    const input = imageInput({ modelCallId, outputArtifactId });
    const expected = { id: crypto.randomUUID(), runId: "run-a", ...input };
    repository.findModelCallRunId.mockResolvedValue("run-a");
    repository.findArtifactRunId.mockResolvedValue("run-a");
    repository.create.mockResolvedValue(expected);

    await expect(service.create("run-a", input)).resolves.toBe(expected);
  });
});

function imageInput(
  references: { modelCallId?: string; outputArtifactId?: string } = {},
): CreateImageAttemptInput {
  return {
    promptSha256: "A".repeat(64),
    inputSnapshotSha256: "B".repeat(64),
    generationConfigSha256: "C".repeat(64),
    adapterIdentity: "runtime-adapter",
    status: "planned" as const,
    directRuntimeUseAllowed: false as const,
    ...references,
  };
}
