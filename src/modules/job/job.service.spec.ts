/**
 * @fileoverview 验证 Job Service 将共享特效完成门禁映射为稳定 HTTP 错误；不访问数据库。
 * @module job
 * @author AI生成
 * @created 2026-07-22
 * @relatedPlan plan/jobs/JOB-001-SHARED-FX
 */
import { ConflictException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CompleteJobInput } from "./job.contracts.js";
import type { JobRepository } from "./job.repository.js";
import { JobService } from "./job.service.js";

const jobId = "11111111-1111-4111-8111-111111111111";
const completeInput: CompleteJobInput = {
  workerId: "22222222-2222-4222-8222-222222222222",
  leaseId: "33333333-3333-4333-8333-333333333333",
  status: "passed",
  resultSha256: "A".repeat(64),
};

describe("JobService shared-fx completion", () => {
  const complete = vi.fn();
  let service: JobService;

  beforeEach(() => {
    vi.resetAllMocks();
    service = new JobService(
      { complete } as unknown as JobRepository,
      {} as never,
    );
  });

  it.each([
    ["shared-fx-evidence-incomplete", "SHARED_FX_EVIDENCE_INCOMPLETE"],
    ["shared-fx-review-conflict", "SHARED_FX_REVIEW_CONFLICT"],
  ] as const)("maps %s to %s", async (status, code) => {
    complete.mockResolvedValue({ status });

    const error = await service
      .complete(jobId, completeInput)
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ConflictException);
    if (!(error instanceof ConflictException)) throw error;
    expect(error.getResponse()).toMatchObject({ code });
    expect(complete).toHaveBeenCalledWith(jobId, completeInput);
  });
});
