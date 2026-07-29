/**
 * @fileoverview 验证 Package V3 报告 Controller 的路由适配和 DTO 委托；不测试 Guard、数据库事务或
 * Artifact 证据真实性。
 * @module modules/job/style-package-production-controller-spec
 * @author AI生成
 * @created 2026-07-25
 * @relatedPlan N/A - Package V3 报告接收与 attempt 证据持久化
 *
 * Mock 边界：Nest testing module 只实例化 Controller 和 fake Service；测试证明 V3 使用独立 Controller，
 * 不代表 Worker capability 已注册或真实 packager/validator 存在。
 */
import { describe, expect, it, vi } from "vitest";
import { StylePackageProductionController } from "../../../src/modules/job/style-package-production.controller.js";
import type { StylePackageProductionService } from "../../../src/modules/job/style-package-production.service.js";
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

describe("StylePackageProductionController", () => {
  it("delegates V3 package reports to the dedicated service", async () => {
    const service = { report: vi.fn().mockResolvedValue(undefined) };
    const controller = new StylePackageProductionController(
      service as unknown as StylePackageProductionService,
    );

    await expect(controller.report(jobId, report)).resolves.toEqual({
      status: "accepted",
    });
    expect(service.report).toHaveBeenCalledWith(jobId, report);
  });
});
