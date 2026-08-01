/**
 * @fileoverview 验证V6单帧生成Controller的Worker Guard、精确委托和响应脱敏；不覆盖真实模型、
 * MySQL行锁、对象存储或图片正规化，这些行为由Service聚焦测试与后续真实集成验证承担。
 * @module modules/job/profession-target-frame-generation-controller-spec
 * @author AI生成
 * @created 2026-07-31
 * @relatedPlan N/A - 用户要求执行真实数据测试
 *
 * Mock边界：Vitest直接实例化Controller，以fake Service替代业务层。测试证明认证元数据和严格
 * ViewModel边界存在，不证明Worker token、lease、官方PNG或外部模型配置真实有效。
 */
import { GUARDS_METADATA } from "@nestjs/common/constants.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerTokenGuard } from "../../../src/common/security/worker-token.guard.js";
import type { GenerateProfessionTargetFrameInput } from "../../../src/modules/job/profession-target-frame-generation.contracts.js";
import { ProfessionTargetFrameGenerationController } from "../../../src/modules/job/profession-target-frame-generation.controller.js";
import type { ProfessionTargetFrameGenerationService } from "../../../src/modules/job/profession-target-frame-generation.service.js";

const jobId = "11111111-1111-4111-8111-111111111111";
const input: GenerateProfessionTargetFrameInput = {
  workerId: "22222222-2222-4222-8222-222222222222",
  leaseId: "33333333-3333-4333-8333-333333333333",
  attempt: 2,
  skillId: "44444444-4444-4444-8444-444444444444",
  entryIndex: 3,
  frameIndex: 7,
};
const passed = {
  schemaVersion: 1 as const,
  status: "passed" as const,
  skillId: input.skillId,
  entryIndex: input.entryIndex,
  frameIndex: input.frameIndex,
  modelCallId: "55555555-5555-4555-8555-555555555555",
  imageAttemptId: "66666666-6666-4666-8666-666666666666",
  targetArtifactId: "77777777-7777-4777-8777-777777777777",
  mediaType: "image/png" as const,
  width: 64,
  height: 48,
  byteLength: 512,
  sha256: "A".repeat(64),
  sourceAlphaSha256: "B".repeat(64),
  normalizationAlgorithm:
    "centered-exact-aspect-lanczos3-source-alpha-v1" as const,
};

describe("ProfessionTargetFrameGenerationController", () => {
  const generate = vi.fn();
  let controller: ProfessionTargetFrameGenerationController;

  beforeEach(() => {
    vi.resetAllMocks();
    controller = new ProfessionTargetFrameGenerationController({
      generate,
    } as unknown as ProfessionTargetFrameGenerationService);
  });

  it("要求Worker认证并原样委托当前lease与帧坐标", async () => {
    generate.mockResolvedValue(passed);

    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      ProfessionTargetFrameGenerationController,
    ) as unknown[] | undefined;
    expect(guards).toContain(WorkerTokenGuard);
    await expect(controller.generate(jobId, input)).resolves.toEqual(passed);
    expect(generate).toHaveBeenCalledWith(jobId, input);
  });

  it("Service响应夹带对象key时严格响应schema fail-closed", async () => {
    generate.mockResolvedValue({
      ...passed,
      objectKey: "artifacts/private-target-frame.png",
    });

    await expect(controller.generate(jobId, input)).rejects.toMatchObject({
      name: "ZodError",
    });
  });
});
