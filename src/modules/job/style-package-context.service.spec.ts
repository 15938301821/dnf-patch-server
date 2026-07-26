/**
 * @fileoverview 验证 Package V3 context Service 的成功透传与有限状态错误映射；不经过 Guard、
 * 数据库、Artifact 或封包工具。
 * @module modules/job/style-package-context-service-spec
 * @author AI生成
 * @created 2026-07-25
 * @relatedPlan N/A - Package V3 首个纵向协议切片
 */
import { ConflictException, NotFoundException } from "@nestjs/common";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { StylePackageContextRepository } from "./style-package-context.repository.js";
import { StylePackageContextService } from "./style-package-context.service.js";
import type { RequestStylePackageContextV3 } from "./style-package-production.contracts.js";

const jobId = "11111111-1111-4111-8111-111111111111";
const input: RequestStylePackageContextV3 = {
  workerId: "22222222-2222-4222-8222-222222222222",
  leaseId: "33333333-3333-4333-8333-333333333333",
  attempt: 2,
};

describe("StylePackageContextService", () => {
  const resolve = vi.fn();
  let service: StylePackageContextService;

  beforeEach(() => {
    vi.resetAllMocks();
    service = new StylePackageContextService({
      resolve,
    } as unknown as StylePackageContextRepository);
  });

  it("returns the accepted envelope without adding fields", async () => {
    const envelope = { context: {}, contextSha256: "A".repeat(64) };
    resolve.mockResolvedValue({ status: "accepted", envelope });

    await expect(service.get(jobId, input)).resolves.toBe(envelope);
    expect(resolve).toHaveBeenCalledWith(jobId, input);
  });

  it.each([
    ["lease-mismatch", ConflictException, "JOB_LEASE_MISMATCH"],
    ["job-kind-mismatch", ConflictException, "STYLE_PACKAGE_JOB_KIND_REQUIRED"],
    [
      "job-integrity-failed",
      ConflictException,
      "STYLE_PACKAGE_JOB_INTEGRITY_FAILED",
    ],
    ["package-not-found", NotFoundException, "STYLE_PACKAGE_NOT_FOUND"],
    [
      "package-evidence-incomplete",
      ConflictException,
      "STYLE_PACKAGE_INPUT_EVIDENCE_INCOMPLETE",
    ],
  ] as const)(
    "maps %s to a stable response",
    async (status, ExceptionType, code) => {
      resolve.mockResolvedValue({ status });

      try {
        await service.get(jobId, input);
        throw new Error("TEST_EXPECTED_EXCEPTION");
      } catch (error) {
        expect(error).toBeInstanceOf(ExceptionType);
        expect((error as ConflictException).getResponse()).toMatchObject({
          code,
        });
      }
    },
  );
});
