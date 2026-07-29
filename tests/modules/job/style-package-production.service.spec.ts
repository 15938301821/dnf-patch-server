/**
 * @fileoverview 验证 Package V3 报告 Service 的稳定错误映射；不连接数据库、不读取对象存储、
 * 不证明真实封包工具可用。
 * @module modules/job/style-package-production-service-spec
 * @author AI生成
 * @created 2026-07-25
 * @relatedPlan N/A - Package V3 报告接收与 attempt 证据持久化
 *
 * Mock 边界：Repository 用最小 fake 替代，测试只证明 Service 将有限状态转换为稳定 HTTP 异常；
 * 事务、外键和 Artifact 证据需要 Repository 测试与 migration/MySQL 门禁覆盖。
 */
import { ConflictException, NotFoundException } from "@nestjs/common";
import { describe, expect, it, vi } from "vitest";
import type { StylePackageProductionRepository } from "../../../src/modules/job/style-package-production.repository.js";
import { StylePackageProductionService } from "../../../src/modules/job/style-package-production.service.js";
import type { ReportStylePackageProductionV3 } from "../../../src/modules/job/style-package-production.contracts.js";

const jobId = "00000000-0000-4000-8000-000000000000";
const report: ReportStylePackageProductionV3 = {
  workerId: "11111111-1111-4111-8111-111111111111",
  leaseId: "22222222-2222-4222-8222-222222222222",
  attempt: 2,
  packageContextSha256: "A".repeat(64),
  packageProfileSha256: "B".repeat(64),
  status: "building",
};

describe("StylePackageProductionService", () => {
  it("accepts a Repository accepted result", async () => {
    const repository = {
      report: vi.fn().mockResolvedValue({ status: "accepted" }),
    };
    const service = new StylePackageProductionService(
      repository as unknown as StylePackageProductionRepository,
    );

    await expect(service.report(jobId, report)).resolves.toBeUndefined();
    expect(repository.report).toHaveBeenCalledWith(jobId, report);
  });

  it("maps missing package plans to a stable not found response", async () => {
    const service = new StylePackageProductionService({
      report: vi.fn().mockResolvedValue({ status: "package-not-found" }),
    } as unknown as StylePackageProductionRepository);

    await expect(service.report(jobId, report)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("maps artifact drift to a stable conflict response", async () => {
    const service = new StylePackageProductionService({
      report: vi
        .fn()
        .mockResolvedValue({ status: "artifact-evidence-mismatch" }),
    } as unknown as StylePackageProductionRepository);

    await expect(service.report(jobId, report)).rejects.toMatchObject({
      response: {
        code: "STYLE_PACKAGE_ARTIFACT_EVIDENCE_MISMATCH",
      },
    });
    await expect(service.report(jobId, report)).rejects.toBeInstanceOf(
      ConflictException,
    );
  });
});
