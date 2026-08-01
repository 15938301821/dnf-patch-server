/**
 * @fileoverview 验证 V6 target-frame prepare Controller 的 Worker Guard、精确委托和响应脱敏；
 * 不覆盖 Service 对象复读、Repository 事务或真实 HTTP 认证执行。
 * @module modules/job/profession-target-frame-prepare-controller-spec
 * @author AI生成
 * @created 2026-07-30
 * @relatedPlan N/A - 用户直接要求 V6 按官方帧尺寸生成目标图
 *
 * Mock 边界：Vitest 直接实例化 Controller，以 fake Service 替代业务层；测试证明 Guard 元数据和
 * 严格 ViewModel 边界存在，不证明 Worker token 值、lease 或 Artifact 真实有效。
 */
import { GUARDS_METADATA } from "@nestjs/common/constants.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkerTokenGuard } from "../../../src/common/security/worker-token.guard.js";
import type {
  PrepareProfessionTargetFramesInput,
  RegisterProfessionTargetFrameSourceInput,
} from "../../../src/modules/job/profession-target-frame-prepare.contracts.js";
import { ProfessionTargetFramePrepareController } from "../../../src/modules/job/profession-target-frame-prepare.controller.js";
import type { ProfessionTargetFramePrepareService } from "../../../src/modules/job/profession-target-frame-prepare.service.js";
import type { ProfessionTargetFrameSourceService } from "../../../src/modules/job/profession-target-frame-source.service.js";

const jobId = "11111111-1111-4111-8111-111111111111";
const input: PrepareProfessionTargetFramesInput = {
  workerId: "22222222-2222-4222-8222-222222222222",
  leaseId: "33333333-3333-4333-8333-333333333333",
  attempt: 2,
  skillId: "44444444-4444-4444-8444-444444444444",
  manifestArtifactId: "55555555-5555-4555-8555-555555555555",
  manifestMediaType: "application/json",
  manifestByteLength: 256,
  manifestSha256: "A".repeat(64),
};
const preparation = {
  schemaVersion: 1 as const,
  status: "prepared" as const,
  skillId: input.skillId,
  manifestArtifactId: input.manifestArtifactId,
  frameCount: 3,
  targetFrameCount: 1,
  targetPixelCount: 12,
};
const sourceInput: RegisterProfessionTargetFrameSourceInput = {
  workerId: input.workerId,
  leaseId: input.leaseId,
  attempt: input.attempt,
  skillId: input.skillId,
  entryIndex: 0,
  frameIndex: 1,
  sourceArtifactId: "66666666-6666-4666-8666-666666666666",
  sourceMediaType: "image/png",
  sourceByteLength: 512,
  sourceSha256: "B".repeat(64),
};

describe("ProfessionTargetFramePrepareController", () => {
  const prepare = vi.fn();
  const register = vi.fn();
  let controller: ProfessionTargetFramePrepareController;

  beforeEach(() => {
    vi.resetAllMocks();
    controller = new ProfessionTargetFramePrepareController(
      {
        prepare,
      } as unknown as ProfessionTargetFramePrepareService,
      {
        register,
      } as unknown as ProfessionTargetFrameSourceService,
    );
  });

  it("要求 Worker 认证并原样委托 exact lease DTO", async () => {
    prepare.mockResolvedValue(preparation);

    const guards = Reflect.getMetadata(
      GUARDS_METADATA,
      ProfessionTargetFramePrepareController,
    ) as unknown[] | undefined;
    expect(guards).toContain(WorkerTokenGuard);
    await expect(controller.prepare(jobId, input)).resolves.toEqual(
      preparation,
    );
    expect(prepare).toHaveBeenCalledWith(jobId, input);
  });

  it("Service 响应夹带对象 key 时严格响应 schema fail-closed", async () => {
    prepare.mockResolvedValue({
      ...preparation,
      objectKey: "artifacts/private-target-manifest.json",
    });

    await expect(controller.prepare(jobId, input)).rejects.toMatchObject({
      name: "ZodError",
    });
  });

  it("逐帧 source 登记只委托已校验身份并返回脱敏回执", async () => {
    const source = {
      schemaVersion: 1 as const,
      status: "registered" as const,
      skillId: sourceInput.skillId,
      entryIndex: sourceInput.entryIndex,
      frameIndex: sourceInput.frameIndex,
      sourceArtifactId: sourceInput.sourceArtifactId,
      sourceByteLength: sourceInput.sourceByteLength,
      sourceSha256: sourceInput.sourceSha256,
    };
    register.mockResolvedValue(source);

    await expect(
      controller.registerSource(jobId, sourceInput),
    ).resolves.toEqual(source);
    expect(register).toHaveBeenCalledWith(jobId, sourceInput);
  });
});
