/**
 * @fileoverview 验证共享特效阶段证据 Worker HTTP 边界沿用 Worker guard 并委托受限 Service；不访问数据库。
 * @module job
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-001-SHARED-FX
 */
import { GUARDS_METADATA } from "@nestjs/common/constants.js";
import { describe, expect, it, vi } from "vitest";
import { WorkerTokenGuard } from "../../common/security/worker-token.guard.js";
import { JobController } from "./job.controller.js";
import type {
  RecordSharedFxStageEvidenceInput,
  SharedFxStageEvidenceView,
} from "./shared-fx-stage-evidence.contracts.js";
import type { JobService } from "./job.service.js";
import type { PatchTaskService } from "./patch-task.service.js";
import type { SharedFxStageEvidenceService } from "./shared-fx-stage-evidence.service.js";

const jobId = "11111111-1111-4111-8111-111111111111";
const input: RecordSharedFxStageEvidenceInput = {
  workerId: "22222222-2222-4222-8222-222222222222",
  leaseId: "33333333-3333-4333-8333-333333333333",
  attempt: 1,
  stage: "inventory",
  artifactId: "44444444-4444-4444-8444-444444444444",
};
const evidence: SharedFxStageEvidenceView = {
  jobId,
  stage: input.stage,
  artifactId: input.artifactId,
  artifactSha256: "A".repeat(64),
  createdAtUtc: "2026-07-22T00:00:00.000Z",
};

describe("JobController shared-fx stage evidence", () => {
  it("requires Worker authentication and delegates fixed evidence input", async () => {
    const record = vi.fn().mockResolvedValue(evidence);
    const controller = new JobController(
      {} as JobService,
      {} as PatchTaskService,
      { record } as unknown as SharedFxStageEvidenceService,
    );

    const guards = Reflect.getMetadata(GUARDS_METADATA, JobController) as
      | unknown[]
      | undefined;
    expect(guards).toContain(WorkerTokenGuard);
    await expect(
      controller.recordSharedFxStageEvidence(jobId, input),
    ).resolves.toEqual({ status: "accepted", data: evidence });
    expect(record).toHaveBeenCalledWith(jobId, input);
  });
});
