/**
 * @fileoverview 验证 Profession 多技能进度 HTTP 边界沿用 Worker Guard、精确委托并严格过滤响应；
 * 不访问数据库、不执行模型、本机工具或 Artifact I/O。
 * @module modules/job/profession-production-progress-controller-spec
 * @author AI生成
 * @created 2026-07-24
 * @relatedPlan N/A - 当前 Profession Worker 纵向闭环直接需求
 */
import { GUARDS_METADATA } from "@nestjs/common/constants.js";
import { describe, expect, it, vi } from "vitest";
import { WorkerTokenGuard } from "../../common/security/worker-token.guard.js";
import { JobController } from "./job.controller.js";
import type { JobService } from "./job.service.js";
import type { PatchTaskService } from "./patch-task.service.js";
import type { SharedFxStageEvidenceService } from "./shared-fx-stage-evidence.service.js";

const jobId = "11111111-1111-4111-8111-111111111111";
const input = {
  workerId: "22222222-2222-4222-8222-222222222222",
  leaseId: "33333333-3333-4333-8333-333333333333",
  attempt: 2,
};
const progress = {
  schemaVersion: 1 as const,
  skills: [
    {
      skillId: "44444444-4444-4444-8444-444444444444",
      status: "pending" as const,
    },
  ],
};

describe("JobController Profession production progress", () => {
  it("requires Worker authentication and delegates the exact lease DTO", async () => {
    const resolveProfessionProductionProgress = vi
      .fn()
      .mockResolvedValue(progress);
    const controller = createController(resolveProfessionProductionProgress);

    const guards = Reflect.getMetadata(GUARDS_METADATA, JobController) as
      | unknown[]
      | undefined;
    expect(guards).toContain(WorkerTokenGuard);
    await expect(
      controller.professionProductionProgress(jobId, input),
    ).resolves.toEqual(progress);
    expect(resolveProfessionProductionProgress).toHaveBeenCalledWith(
      jobId,
      input,
    );
  });

  it("fails closed when the Service response exposes evidence internals", async () => {
    const resolveProfessionProductionProgress = vi.fn().mockResolvedValue({
      ...progress,
      modelCallId: "55555555-5555-4555-8555-555555555555",
    });
    const controller = createController(resolveProfessionProductionProgress);

    await expect(
      controller.professionProductionProgress(jobId, input),
    ).rejects.toMatchObject({ name: "ZodError" });
  });
});

function createController(
  resolveProfessionProductionProgress: ReturnType<typeof vi.fn>,
): JobController {
  return new JobController(
    {} as JobService,
    { resolveProfessionProductionProgress } as unknown as PatchTaskService,
    {} as SharedFxStageEvidenceService,
  );
}
