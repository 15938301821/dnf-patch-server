/**
 * @fileoverview 验证共享特效阶段证据写入的稳定错误映射；不访问数据库或对象存储。
 * @module job
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-001-SHARED-FX
 */
import { ConflictException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  RecordSharedFxStageEvidenceInput,
  SharedFxStageEvidenceMutationResult,
  SharedFxStageEvidenceView,
} from "./shared-fx-stage-evidence.contracts.js";
import type { SharedFxStageEvidenceRepository } from "./shared-fx-stage-evidence.repository.js";
import { SharedFxStageEvidenceService } from "./shared-fx-stage-evidence.service.js";

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
  stage: "inventory",
  artifactId: input.artifactId,
  artifactSha256: "A".repeat(64),
  createdAtUtc: "2026-07-22T00:00:00.000Z",
};

describe("SharedFxStageEvidenceService", () => {
  const record =
    vi.fn<
      (
        jobId: string,
        input: RecordSharedFxStageEvidenceInput,
      ) => Promise<SharedFxStageEvidenceMutationResult>
    >();
  let service: SharedFxStageEvidenceService;

  beforeEach(() => {
    vi.resetAllMocks();
    record.mockResolvedValue({ status: "accepted", evidence });
    service = new SharedFxStageEvidenceService({
      record,
    } as unknown as SharedFxStageEvidenceRepository);
  });

  it("returns server-derived Artifact evidence after a successful write", async () => {
    await expect(service.record(jobId, input)).resolves.toEqual(evidence);
    expect(record).toHaveBeenCalledWith(jobId, input);
  });

  it.each([
    ["lease-mismatch", "JOB_LEASE_MISMATCH"],
    ["protocol-upgrade-required", "WORKER_PROTOCOL_UPGRADE_REQUIRED"],
    ["job-kind-mismatch", "SHARED_FX_JOB_REQUIRED"],
    ["artifact-not-finalized", "SHARED_FX_EVIDENCE_ARTIFACT_REQUIRED"],
    ["stage-conflict", "SHARED_FX_STAGE_EVIDENCE_CONFLICT"],
  ] as const)("maps %s to %s", async (status, code) => {
    record.mockResolvedValue({ status });

    const error = await service
      .record(jobId, input)
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ConflictException);
    if (!(error instanceof ConflictException)) throw error;
    expect(error.getResponse()).toMatchObject({ code });
  });
});
